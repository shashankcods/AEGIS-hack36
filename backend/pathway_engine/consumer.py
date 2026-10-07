"""Process per-session results: ``python -m pathway_engine.consumer``."""

import json
import logging
import time

import redis

from ml_service.contracts import summarize_detections
from ml_service.redis_client import get_redis_client
from pathway_engine.analytics import WorkerLease, install_stop_handler

LOGGER = logging.getLogger(__name__)
RESULT_QUEUE = "aegis:results"
PROCESSED_TTL = 300
PROCESSING_QUEUE = "aegis:results:processing"
HEARTBEAT_KEY = "aegis:worker:consumer"
LOCK_KEY = "aegis:results:worker"


def process_data(result_data):
    try:
        return summarize_detections(result_data)
    except ValueError as exc:
        return {"error": str(exc)}


def process_message(client, raw):
    """Store a success or an explicit error; malformed jobs never kill the worker."""
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("A queued result must be an object")
        session_id = payload.get("session_id")
        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("A queued result requires session_id")
        processed = process_data(payload.get("result_data"))
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        LOGGER.warning("Ignoring malformed result job: %s", exc)
        client.lrem(PROCESSING_QUEUE, 1, raw)
        return False
    with client.pipeline(transaction=True) as transaction:
        transaction.set(f"aegis:processed:{session_id}", json.dumps(processed, allow_nan=False), ex=PROCESSED_TTL)
        transaction.lrem(PROCESSING_QUEUE, 1, raw)
        transaction.execute()
    return True


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    install_stop_handler()
    client = get_redis_client()
    LOGGER.info("Listening for result jobs on %s", RESULT_QUEUE)
    lease = WorkerLease(client, LOCK_KEY, HEARTBEAT_KEY, "result")
    try:
        while True:
            try:
                lease.refresh()
                pending = client.lindex(PROCESSING_QUEUE, 0)
                if pending is None:
                    pending = client.rpoplpush(RESULT_QUEUE, PROCESSING_QUEUE)
                if pending is None:
                    time.sleep(0.2)
                    continue
                process_message(client, pending)
            except redis.exceptions.RedisError as exc:
                LOGGER.warning("Redis unavailable; retrying result job: %s", exc)
                time.sleep(1)
    except KeyboardInterrupt:
        LOGGER.info("Result worker stopped")
    finally:
        try:
            lease.release()
        except redis.exceptions.RedisError:
            pass


if __name__ == "__main__":
    main()
