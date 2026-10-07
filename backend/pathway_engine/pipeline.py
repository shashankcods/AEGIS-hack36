"""Optional Pathway analytics: ``python -m pathway_engine.pipeline``.

The portable analytics worker uses the same Redis result schema. Run only one
analytics implementation; a Redis lease prevents competing consumers.
"""

import json
import logging
import threading
import time

import redis

from ml_service.contracts import HIGH_THRESHOLD, LOW_THRESHOLD, normalize_detection
from ml_service.redis_client import get_redis_client
from pathway_engine.analytics import PROCESSING_QUEUE, install_stop_handler, next_message, record_detection, worker_lease

LOGGER = logging.getLogger(__name__)


def build_statistics(pw, scores):
    """Pathway reductions for the current run, using canonical 0..1 buckets."""
    global_stats = scores.groupby().reduce(
        average_score=pw.reducers.avg(pw.this.score),
        highest_score=pw.reducers.max(pw.this.score),
        lowest_score=pw.reducers.min(pw.this.score),
        total_scores=pw.reducers.count(),
        count_low=pw.reducers.sum(pw.if_else(pw.this.score <= LOW_THRESHOLD, 1, 0)),
        count_medium=pw.reducers.sum(pw.if_else(
            (pw.this.score > LOW_THRESHOLD) & (pw.this.score <= HIGH_THRESHOLD), 1, 0)),
        count_high=pw.reducers.sum(pw.if_else(pw.this.score > HIGH_THRESHOLD, 1, 0)),
    ).with_columns(
        percent_high_score=pw.if_else(
            pw.this.total_scores > 0, 100 * pw.this.count_high / pw.this.total_scores, 0.0),
    )
    label_stats = scores.groupby(pw.this.label).reduce(
        label=pw.this.label,
        count=pw.reducers.count(),
        avg_score=pw.reducers.avg(pw.this.score),
        max_score=pw.reducers.max(pw.this.score),
        min_score=pw.reducers.min(pw.this.score),
    )
    return global_stats, label_stats


def run_pipeline():
    try:
        import pathway as pw
    except ImportError as exc:
        raise SystemExit(
            "Optional Pathway runtime is unavailable. Use Python 3.10+ and "
            "requirements-pathway.txt, or run python -m pathway_engine.analytics."
        ) from exc

    client = get_redis_client()
    stopped = threading.Event()

    class ScoreSchema(pw.Schema):
        score: float
        label: str
        raw: str

    class RedisScoreReader(pw.io.python.ConnectorSubject):
        def __init__(self, lease):
            super().__init__()
            self.lease = lease

        def run(self):
            emitted = None
            while not stopped.is_set():
                try:
                    self.lease.refresh()
                    # Wait for observer acknowledgement before emitting the next
                    # row. Reconnects cannot re-emit an in-flight Pathway row.
                    if emitted is not None:
                        if client.lpos(PROCESSING_QUEUE, emitted) is not None:
                            stopped.wait(0.1)
                            continue
                        emitted = None
                    raw = next_message(client)
                    if raw is None:
                        stopped.wait(0.2)
                        continue
                    try:
                        detection = normalize_detection(json.loads(raw))
                    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
                        LOGGER.warning("Ignoring malformed analytics job: %s", exc)
                        client.lrem(PROCESSING_QUEUE, 1, raw)
                        continue
                    raw_text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
                    self.next(score=detection["sensitivity_score"], label=detection["label"], raw=raw_text)
                    emitted = raw
                except redis.exceptions.RedisError as exc:
                    LOGGER.warning("Redis unavailable; retrying Pathway reader: %s", exc)
                    stopped.wait(1)
            self.close()

    class DurableResultWriter(pw.io.python.ConnectorObserver):
        def on_change(self, key, row, time, is_addition):
            if not is_addition:
                return
            while not stopped.is_set():
                try:
                    record_detection(client, {"label": row["label"], "score": row["score"]}, row["raw"])
                    return
                except redis.exceptions.ResponseError:
                    LOGGER.exception("Invalid Redis analytics state; preserving pending job for repair")
                    raise
                except redis.exceptions.RedisError as exc:
                    LOGGER.warning("Redis unavailable; retrying Pathway output: %s", exc)
                    stopped.wait(1)

    class SnapshotWriter(pw.io.python.ConnectorObserver):
        """Current-run diagnostics; dashboard history comes from the durable writer."""
        def __init__(self, key, grouped=False):
            self.key = key
            self.grouped = grouped
            self.rows = {}

        def on_change(self, key, row, time, is_addition):
            if is_addition:
                self.rows[key] = row
            else:
                self.rows.pop(key, None)
            data = {item["label"]: item for item in self.rows.values()} if self.grouped else next(iter(self.rows.values()), {})
            while not stopped.is_set():
                try:
                    client.set(self.key, json.dumps(data, allow_nan=False))
                    return
                except redis.exceptions.RedisError as exc:
                    LOGGER.warning("Redis unavailable; retrying Pathway snapshot: %s", exc)
                    stopped.wait(1)

    # Redis remains the history store because list inputs are destructive and
    # cannot be replayed by Pathway persistence after being acknowledged.
    try:
        with worker_lease(client) as lease:
            scores = pw.io.python.read(RedisScoreReader(lease), schema=ScoreSchema, autocommit_duration_ms=100)
            classified = scores.with_columns(severity=pw.if_else(
                pw.this.score > HIGH_THRESHOLD, "high",
                pw.if_else(pw.this.score > LOW_THRESHOLD, "medium", "low"),
            ))
            global_stats, label_stats = build_statistics(pw, scores)
            pw.io.python.write(classified, DurableResultWriter())
            pw.io.python.write(global_stats, SnapshotWriter("aegis:pathway:live_global"))
            pw.io.python.write(label_stats, SnapshotWriter("aegis:pathway:live_by_label", grouped=True))
            LOGGER.info("Pathway analytics worker running")
            pw.run()
    finally:
        stopped.set()


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    install_stop_handler()
    while True:
        try:
            run_pipeline()
            return
        except redis.exceptions.RedisError as exc:
            LOGGER.warning("Redis unavailable; retrying Pathway startup: %s", exc)
            time.sleep(1)
        except KeyboardInterrupt:
            LOGGER.info("Pathway worker stopped")
            return


if __name__ == "__main__":
    main()
