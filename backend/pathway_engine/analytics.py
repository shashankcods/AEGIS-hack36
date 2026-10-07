"""Portable analytics worker: ``python -m pathway_engine.analytics``.

Only one analytics worker (this module OR pipeline.py) may consume scores_stream.
Redis stores the aggregate and acknowledges each input in one atomic operation.
"""

import json
import logging
import signal
import time
import uuid
from contextlib import contextmanager

import redis

from ml_service.contracts import HIGH_THRESHOLD, LOW_THRESHOLD, normalize_detection
from ml_service.redis_client import get_redis_client

LOGGER = logging.getLogger(__name__)
SCORE_QUEUE = "scores_stream"
PROCESSING_QUEUE = "aegis:analytics:processing"
STATE_KEY = "aegis:analytics:state"
LOCK_KEY = "aegis:analytics:worker"
LOCK_TTL = 15
LEGACY_BACKUP_KEY = "aegis:analytics:legacy_snapshot"
HEARTBEAT_KEY = "aegis:worker:analytics"
HEARTBEAT_TTL = 10
SNAPSHOT_KEY = "aegis:analytics:snapshot"

# The dashboard's existing public keys remain compatible. The private state is
# durable across worker restarts; no Python process-local counter is authoritative.
UPDATE_AGGREGATE = r"""
local raw = ARGV[3]
if raw ~= '' then
    local found = false
    for _, item in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do
        if item == raw then found = true; break end
    end
    if not found then return 0 end
end

local score = tonumber(ARGV[2])
local low = tonumber(ARGV[4])
local high = tonumber(ARGV[5])
local label = ARGV[1]
local function fresh()
    return {version=1, total_scores=0, sum_scores=0, highest_score=0,
            lowest_score=1, count_low=0, count_medium=0, count_high=0, labels={}}
end
local function number_between(value, minimum, maximum)
    return type(value) == 'number' and value == value and value >= minimum and value <= maximum
end
local function count_valid(value)
    return number_between(value, 0, 1e15) and value == math.floor(value)
end
local function state_valid(state)
    if type(state) ~= 'table' or state.version ~= 1 or type(state.labels) ~= 'table' then return false end
    if not count_valid(state.total_scores) or not count_valid(state.count_low)
        or not count_valid(state.count_medium) or not count_valid(state.count_high) then return false end
    if state.count_low + state.count_medium + state.count_high ~= state.total_scores then return false end
    if not number_between(state.sum_scores, 0, state.total_scores + 0.000001)
        or not number_between(state.highest_score, 0, 1)
        or not number_between(state.lowest_score, 0, 1) then return false end
    if state.total_scores > 0 and state.lowest_score > state.highest_score then return false end
    local count = 0
    local sum = 0
    for name, item in pairs(state.labels) do
        if type(name) ~= 'string' or type(item) ~= 'table' or item.label ~= name
            or not count_valid(item.count) or item.count == 0
            or not number_between(item.sum_score, 0, item.count + 0.000001)
            or not number_between(item.min_score, 0, 1)
            or not number_between(item.max_score, 0, 1)
            or item.min_score > item.max_score then return false end
        count = count + item.count
        sum = sum + item.sum_score
    end
    return count == state.total_scores and math.abs(sum - state.sum_scores) <= 0.000001 * math.max(1, count)
end

local state_raw = redis.call('GET', KEYS[1])
local state
if state_raw then
    local ok, decoded = pcall(cjson.decode, state_raw)
    if not ok or not state_valid(decoded) then return redis.error_reply('Invalid persistent analytics state') end
    state = decoded
else
    state = fresh()
    -- Carry forward valid caches from the old worker. Out-of-range/stale caches
    -- are archived rather than blended into the new 0..1 aggregate.
    local names = {'total_scores', 'current_average', 'highest_score', 'lowest_score',
                   'count_low', 'count_medium', 'count_high', 'stats_by_label'}
    local values = redis.call('MGET', unpack(names))
    if values[1] then
        local candidate = fresh()
        candidate.total_scores = tonumber(values[1]) or -1
        candidate.sum_scores = (tonumber(values[2]) or -1) * candidate.total_scores
        candidate.highest_score = tonumber(values[3]) or -1
        candidate.lowest_score = tonumber(values[4]) or -1
        candidate.count_low = tonumber(values[5]) or -1
        candidate.count_medium = tonumber(values[6]) or -1
        candidate.count_high = tonumber(values[7]) or -1
        local ok, labels = pcall(cjson.decode, values[8] or '{}')
        if ok and type(labels) == 'table' then
            for name, item in pairs(labels) do
                if type(item) == 'table' then
                    item.sum_score = (tonumber(item.avg_score) or -1) * (tonumber(item.count) or -1)
                    candidate.labels[name] = item
                end
            end
        end
        if state_valid(candidate) then
            state = candidate
            state.legacy_carryover = true
        else
            local backup = {}
            for index, name in ipairs(names) do backup[name] = values[index] end
            redis.call('SET', KEYS[3], cjson.encode(backup), 'NX')
        end
    end
end

state.total_scores = state.total_scores + 1
state.sum_scores = state.sum_scores + score
state.highest_score = math.max(state.highest_score, score)
state.lowest_score = math.min(state.lowest_score, score)
if score <= low then state.count_low = state.count_low + 1
elseif score <= high then state.count_medium = state.count_medium + 1
else state.count_high = state.count_high + 1 end

local item = state.labels[label]
if not item then item = {label=label, count=0, sum_score=0, max_score=0, min_score=1} end
item.count = item.count + 1
item.sum_score = item.sum_score + score
item.max_score = math.max(item.max_score, score)
item.min_score = math.min(item.min_score, score)
state.labels[label] = item
local output = {}
local unique = 0
for name, stats in pairs(state.labels) do
    output[name] = {label=name, count=stats.count, avg_score=stats.sum_score / stats.count,
                    max_score=stats.max_score, min_score=stats.min_score}
    unique = unique + 1
end
local snapshot = {
    current_average=state.sum_scores / state.total_scores,
    highest_score=state.highest_score, lowest_score=state.lowest_score,
    total_scores=state.total_scores, unique_label_count=unique,
    percent_high_score=100 * state.count_high / state.total_scores,
    distribution={low=state.count_low, medium=state.count_medium, high=state.count_high},
    stats_by_label=output,
}
redis.call('MSET',
    KEYS[1], cjson.encode(state),
    'aegis:analytics:snapshot', cjson.encode(snapshot),
    'current_average', tostring(state.sum_scores / state.total_scores),
    'highest_score', tostring(state.highest_score), 'lowest_score', tostring(state.lowest_score),
    'total_scores', tostring(state.total_scores), 'unique_label_count', tostring(unique),
    'count_low', tostring(state.count_low), 'count_medium', tostring(state.count_medium),
    'count_high', tostring(state.count_high),
    'percent_high_score', tostring(100 * state.count_high / state.total_scores),
    'stats_by_label', cjson.encode(output))
if raw ~= '' then redis.call('LREM', KEYS[2], 1, raw) end
return state.total_scores
"""

REFRESH_LOCK = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
"""
RELEASE_LOCK = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1], KEYS[2]) end
return 0
"""


class WorkerLease:
    def __init__(self, client, lock_key=LOCK_KEY, heartbeat_key=HEARTBEAT_KEY, role="analytics"):
        self.client = client
        self.lock_key = lock_key
        self.heartbeat_key = heartbeat_key
        self.role = role
        self.token = str(uuid.uuid4())
        self.acquired = False

    def refresh(self):
        if self.acquired and self.client.eval(REFRESH_LOCK, 1, self.lock_key, self.token, LOCK_TTL):
            self.client.set(self.heartbeat_key, "ready", ex=HEARTBEAT_TTL)
            return
        self.acquired = False
        if not self.client.set(self.lock_key, self.token, nx=True, ex=LOCK_TTL):
            raise RuntimeError(f"Another {self.role} worker is active; run only one worker for this queue")
        self.acquired = True
        self.client.set(self.heartbeat_key, "ready", ex=HEARTBEAT_TTL)

    def release(self):
        if self.acquired:
            self.client.eval(RELEASE_LOCK, 2, self.lock_key, self.heartbeat_key, self.token)
            self.acquired = False


@contextmanager
def worker_lease(client):
    lease = WorkerLease(client)
    try:
        lease.refresh()
        yield lease
    finally:
        try:
            lease.release()
        except redis.exceptions.RedisError:
            pass  # The short TTL releases the lease if Redis is unreachable.


def next_message(client):
    pending = client.lindex(PROCESSING_QUEUE, 0)
    return pending if pending is not None else client.lmove(SCORE_QUEUE, PROCESSING_QUEUE, "LEFT", "RIGHT")


def record_detection(client, detection, raw=None):
    detection = normalize_detection(detection)
    return client.eval(
        UPDATE_AGGREGATE, 3, STATE_KEY, PROCESSING_QUEUE, LEGACY_BACKUP_KEY,
        detection["label"], detection["sensitivity_score"], raw if raw is not None else "",
        LOW_THRESHOLD, HIGH_THRESHOLD,
    )


def process_message(client, raw):
    try:
        detection = normalize_detection(json.loads(raw))
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        LOGGER.warning("Ignoring malformed analytics job: %s", exc)
        client.lrem(PROCESSING_QUEUE, 1, raw)
        return False
    record_detection(client, detection, raw)
    return True


def install_stop_handler():
    # Process launchers send SIGTERM. Treat it like Ctrl+C so the worker releases
    # its own lease and heartbeat before an immediate local restart.
    def stop(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    install_stop_handler()
    client = get_redis_client()
    LOGGER.info("Portable analytics worker listening on %s", SCORE_QUEUE)
    # Reconnect on startup or mid-job. Pending jobs stay in Redis until the atomic
    # aggregate+ack script succeeds, including across an abrupt worker restart.
    lease = WorkerLease(client)
    try:
        while True:
            try:
                lease.refresh()
                raw = next_message(client)
                if raw is None:
                    time.sleep(0.2)
                    continue
                process_message(client, raw)
            except redis.exceptions.ResponseError:
                LOGGER.exception("Invalid Redis analytics state or schema; preserving pending job for repair")
                raise
            except redis.exceptions.RedisError as exc:
                LOGGER.warning("Redis unavailable; retrying analytics worker: %s", exc)
                time.sleep(1)
    except KeyboardInterrupt:
        LOGGER.info("Analytics worker stopped")
    finally:
        try:
            lease.release()
        except redis.exceptions.RedisError:
            pass


if __name__ == "__main__":
    main()
