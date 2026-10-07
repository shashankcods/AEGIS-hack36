"""Shared, lazy Redis connection for API requests and background workers."""

import json
import os
import uuid
from functools import lru_cache

import redis
from redis.backoff import NoBackoff
from redis.retry import Retry

from ml_service.contracts import normalize_detection

RESULT_QUEUE_KEY = "aegis:results"


@lru_cache(maxsize=8)
def _client_for_url(url):
    # Creating a client does not contact Redis. The next operation reconnects
    # when the service starts, instead of preserving an offline import state.
    return redis.Redis.from_url(
        url,
        decode_responses=True,
        socket_connect_timeout=1,
        socket_timeout=2,
        retry_on_timeout=False,
        retry=Retry(NoBackoff(), 0),
    )


def get_redis_client():
    return _client_for_url(
        os.environ.get("AEGIS_REDIS_URL", "redis://127.0.0.1:6379/0")
    )


def push_to_queue(result_data, session_id=None):
    if not isinstance(result_data, list):
        raise ValueError("Result data must be a list of detections.")
    detections = [normalize_detection(item) for item in result_data]
    session_id = session_id or str(uuid.uuid4())
    payload = {"session_id": session_id, "result_data": detections}
    get_redis_client().lpush(RESULT_QUEUE_KEY, json.dumps(payload, allow_nan=False))
    return session_id


def fetch_processed_result(session_id):
    data = get_redis_client().get("aegis:processed:{}".format(session_id))
    return json.loads(data) if data else None
