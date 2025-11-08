import redis
import json
import uuid

redis_client = redis.StrictRedis(host="localhost", port=6379, db=0)

def push_to_queue(result_data, session_id=None):
    if not session_id:
        session_id = str(uuid.uuid4())

    payload = {
        "session_id": session_id,
        "result_data": result_data
    }

    redis_client.lpush("aegis:results", json.dumps(payload))
    return session_id


def fetch_processed_result(session_id):
    key = f"aegis:processed:{session_id}"
    data = redis_client.get(key)
    return json.loads(data) if data else None
