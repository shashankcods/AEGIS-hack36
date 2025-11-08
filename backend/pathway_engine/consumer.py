import redis
import json
import time

r = redis.StrictRedis(host='localhost', port=6379, db=0)

def process_data(result_data):
    """
    Simplified risk scoring logic.
    Pathway can later replace this with complex stream analytics.
    """
    try:
        labels = [item["label"] for item in result_data]
        scores = [item["score"] for item in result_data]
        avg_score = sum(scores)/len(scores) if scores else 0

        severity = (
            "high" if avg_score > 0.8 else
            "medium" if avg_score > 0.5 else
            "low"
        )

        return {
            "labels": labels,
            "avg_score": avg_score,
            "severity": severity,
            "timestamp": time.time()
        }

    except Exception as e:
        return {"error": str(e)}


def main():
    print("[Pathway Engine] Listening for Redis queue jobs...")

    while True:
        msg = r.brpop("aegis:results", timeout=0)
        if not msg:
            continue

        _, raw = msg
        data = json.loads(raw)

        session_id = data["session_id"]
        result_data = data["result_data"]

        print(f"[Pathway Engine] Processing session {session_id}...")
        processed = process_data(result_data)

        r.set(f"aegis:processed:{session_id}", json.dumps(processed), ex=300)
        print(f"[Pathway Engine] ✔ Stored processed result for {session_id}")

if __name__ == "__main__":
    main()
