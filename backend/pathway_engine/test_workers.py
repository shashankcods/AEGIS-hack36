"""Contract tests and isolated real-Redis worker checks (no existing DB is used)."""

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import redis
from redis.backoff import NoBackoff
from redis.retry import Retry

from ml_service.contracts import normalize_detection, severity_for_score, summarize_detections
from pathway_engine import analytics, consumer


class DetectionContractTests(unittest.TestCase):
    def test_current_and_legacy_score_fields(self):
        expected = {"label": "health_disclosure", "sensitivity_score": 0.7}
        self.assertEqual(normalize_detection({"label": " health_disclosure ", "score": 0.7}), expected)
        self.assertEqual(normalize_detection({"label": "health_disclosure", "sensitivity_score": 0.7, "score": 99}), expected)

    def test_scores_and_confidence_are_finite_probabilities(self):
        for value in (float("nan"), float("inf"), 10 ** 400, -0.1, 1.1, True, "0.7", None):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    normalize_detection({"label": "email", "sensitivity_score": value})
                with self.assertRaises(ValueError):
                    normalize_detection({"label": "email", "score": 0.7, "confidence": value})
        result = normalize_detection({"label": "email", "score": 1, "confidence": 0})
        self.assertEqual(result["confidence"], 0.0)

    def test_shapes_and_error_payloads_are_rejected(self):
        for item in (None, [], {}, {"label": "", "score": 0.4}, {"label": 7, "score": 0.4},
                     {"error": "model unavailable", "label": "email", "score": 0.4}):
            with self.subTest(item=item), self.assertRaises(ValueError):
                normalize_detection(item)
        with self.assertRaises(ValueError):
            summarize_detections({"error": "model unavailable"})

    def test_summary_uses_average_sensitivity_not_confidence(self):
        result = summarize_detections([
            {"label": "email", "sensitivity_score": 0.5, "confidence": 0.99},
            {"label": "email", "score": 0.7},
            {"label": "health_disclosure", "score": 0.9},
        ])
        self.assertEqual(result["labels"], ["email", "health_disclosure"])
        self.assertAlmostEqual(result["avg_score"], 0.7)
        self.assertEqual(result["severity"], "medium")
        self.assertTrue(math.isfinite(result["timestamp"]))
        self.assertEqual(summarize_detections([])["avg_score"], 0)

    def test_severity_boundaries(self):
        self.assertEqual(severity_for_score(0.5), "low")
        self.assertEqual(severity_for_score(0.8), "medium")
        self.assertEqual(severity_for_score(0.800001), "high")


@unittest.skipUnless(shutil.which("redis-server"), "redis-server is required for isolated worker tests")
class RedisWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="aegis-worker-tests-")
        cls.socket = str(Path(cls.directory.name) / "redis.sock")
        cls.server = subprocess.Popen([
            shutil.which("redis-server"), "--port", "0", "--unixsocket", cls.socket,
            "--unixsocketperm", "700", "--save", "", "--appendonly", "no",
            "--dir", cls.directory.name,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.client = redis.Redis(unix_socket_path=cls.socket, decode_responses=True, retry=Retry(NoBackoff(), 0))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                cls.client.ping()
                return
            except redis.exceptions.RedisError:
                time.sleep(0.05)
        cls.server.terminate()
        cls.server.wait(timeout=5)
        cls.directory.cleanup()
        raise RuntimeError("Isolated Redis server failed to start")

    @classmethod
    def tearDownClass(cls):
        try:
            cls.client.shutdown(nosave=True)
        finally:
            cls.server.wait(timeout=5)
            cls.directory.cleanup()

    def setUp(self):
        # This socket belongs to this test class's private temporary Redis server.
        self.client.flushdb()

    def snapshot(self):
        return json.loads(self.client.get(analytics.SNAPSHOT_KEY))

    def queue_score(self, detection):
        raw = json.dumps(detection)
        self.client.rpush(analytics.SCORE_QUEUE, raw)
        self.assertEqual(analytics.next_message(self.client), raw)
        analytics.process_message(self.client, raw)
        return raw

    def test_consumer_current_legacy_and_empty_results(self):
        for data, expected in (([{"label": "health_disclosure", "sensitivity_score": 0.7}], "medium"),
                               ([{"label": "self_harm_disclosure", "score": 0.9}], "high"), ([], "low")):
            with self.subTest(data=data):
                raw = json.dumps({"session_id": "test-session", "result_data": data})
                self.client.lpush(consumer.PROCESSING_QUEUE, raw)
                self.assertTrue(consumer.process_message(self.client, raw))
                result = json.loads(self.client.get("aegis:processed:test-session"))
                self.assertEqual(result["severity"], expected)
                self.assertGreater(self.client.ttl("aegis:processed:test-session"), 0)
                self.assertEqual(self.client.llen(consumer.PROCESSING_QUEUE), 0)

    def test_consumer_malformed_job_does_not_block_following_job(self):
        for raw in ("not json", "[]", "[" * 2000 + "]" * 2000, '{"session_id":null}',
                    '{"session_id":"test-session","result_data":{"error":"OCR failed"}}'):
            self.client.lpush(consumer.PROCESSING_QUEUE, raw)
            consumer.process_message(self.client, raw)
            self.assertEqual(self.client.llen(consumer.PROCESSING_QUEUE), 0)
        result = json.loads(self.client.get("aegis:processed:test-session"))
        self.assertIn("error", result)
        self.assertNotIn("severity", result)
        self.assertTrue(consumer.process_message(self.client, '{"session_id":"test-session","result_data":[]}'))

    def test_analytics_canonical_buckets_and_label_stats(self):
        self.queue_score({"label": "email", "score": 0.5})
        self.queue_score({"label": "email", "sensitivity_score": 0.8})
        self.queue_score({"label": "self_harm_disclosure", "sensitivity_score": 0.81})
        stats = self.snapshot()
        self.assertEqual(stats["distribution"], {"low": 1, "medium": 1, "high": 1})
        self.assertEqual(stats["total_scores"], 3)
        self.assertEqual(stats["unique_label_count"], 2)
        self.assertAlmostEqual(stats["current_average"], 2.11 / 3)
        self.assertAlmostEqual(stats["percent_high_score"], 100 / 3)
        self.assertAlmostEqual(stats["stats_by_label"]["email"]["avg_score"], 0.65)

    def test_restart_recovers_pending_event_and_ack_is_idempotent(self):
        raw = json.dumps({"label": "health_disclosure", "sensitivity_score": 0.7})
        self.client.rpush(analytics.SCORE_QUEUE, raw)
        self.assertEqual(analytics.next_message(self.client), raw)
        restarted = redis.Redis(unix_socket_path=self.socket, decode_responses=True)
        self.assertEqual(analytics.next_message(restarted), raw)
        analytics.process_message(restarted, raw)
        # A response lost after Redis commits must not increment the count twice.
        analytics.process_message(restarted, raw)
        self.assertEqual(self.snapshot()["total_scores"], 1)
        self.assertEqual(restarted.llen(analytics.PROCESSING_QUEUE), 0)
        # Two separate identical user events should still be counted twice.
        self.queue_score({"label": "health_disclosure", "score": 0.7})
        self.assertEqual(self.snapshot()["total_scores"], 2)
        self.assertAlmostEqual(self.snapshot()["current_average"], 0.7)

    def test_invalid_analytics_events_do_not_pollute_stats(self):
        self.queue_score({"label": "email", "score": 0.6})
        for detection in ([{"label": "email", "score": 0.5}], {"label": "email", "score": float("nan")},
                          {"label": "email", "score": 10 ** 400}, {"label": "email", "score": 50},
                          {"error": "failed"}, {"label": None, "score": 0.6}):
            raw = json.dumps(detection)
            self.client.rpush(analytics.SCORE_QUEUE, raw)
            self.assertFalse(analytics.process_message(self.client, analytics.next_message(self.client)))
        self.assertEqual(self.snapshot()["total_scores"], 1)
        self.assertEqual(self.client.llen(analytics.PROCESSING_QUEUE), 0)

    def test_valid_old_cache_is_carried_forward(self):
        old = {"label": "email", "count": 1, "avg_score": 0.7, "max_score": 0.7, "min_score": 0.7}
        self.client.mset({"total_scores": 1, "current_average": 0.7, "highest_score": 0.7, "lowest_score": 0.7,
                          "count_low": 0, "count_medium": 1, "count_high": 0, "stats_by_label": json.dumps({"email": old})})
        self.queue_score({"label": "self_harm_disclosure", "score": 0.9})
        self.assertEqual(self.snapshot()["total_scores"], 2)
        self.assertEqual(self.snapshot()["distribution"], {"low": 0, "medium": 1, "high": 1})
        self.assertAlmostEqual(self.snapshot()["current_average"], 0.8)

    def test_out_of_scale_old_cache_is_archived(self):
        self.client.mset({"total_scores": 1, "current_average": 70, "highest_score": 70, "lowest_score": 70})
        self.queue_score({"label": "email", "score": 0.6})
        self.assertEqual(self.snapshot()["total_scores"], 1)
        self.assertEqual(json.loads(self.client.get(analytics.LEGACY_BACKUP_KEY))["current_average"], "70")

    def test_corrupt_durable_state_is_not_silently_reset(self):
        self.client.set(analytics.STATE_KEY, "bad json")
        raw = json.dumps({"label": "email", "score": 0.6})
        self.client.rpush(analytics.SCORE_QUEUE, raw)
        with self.assertRaises(redis.exceptions.ResponseError):
            analytics.process_message(self.client, analytics.next_message(self.client))
        self.assertEqual(self.client.get(analytics.STATE_KEY), "bad json")
        self.assertEqual(self.client.llen(analytics.PROCESSING_QUEUE), 1)

    def test_single_worker_lease_and_fresh_heartbeat(self):
        first = analytics.WorkerLease(self.client)
        second = analytics.WorkerLease(self.client)
        first.refresh()
        self.assertEqual(self.client.get(analytics.HEARTBEAT_KEY), "ready")
        self.assertGreater(self.client.ttl(analytics.HEARTBEAT_KEY), 0)
        with self.assertRaises(RuntimeError):
            second.refresh()
        # Reconnection after a long outage can reacquire an expired lease.
        self.client.delete(analytics.LOCK_KEY)
        first.refresh()
        first.release()
        self.assertIsNone(self.client.get(analytics.HEARTBEAT_KEY))
        second.refresh()
        second.release()

    def test_real_workers_publish_heartbeat_process_jobs_and_restart_cleanly(self):
        environment = dict(os.environ, AEGIS_REDIS_URL="unix://" + self.socket)
        backend = str(Path(__file__).resolve().parents[1])
        processes = []

        def start(module):
            process = subprocess.Popen([sys.executable, "-m", module], cwd=backend, env=environment,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            processes.append(process)
            return process

        def wait_for(predicate):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if predicate():
                    return
                time.sleep(0.05)
            self.fail("Worker did not reach the expected state")

        try:
            result_worker = start("pathway_engine.consumer")
            analytics_worker = start("pathway_engine.analytics")
            wait_for(lambda: all(self.client.mget(consumer.HEARTBEAT_KEY, analytics.HEARTBEAT_KEY)))
            self.client.lpush(consumer.RESULT_QUEUE, "bad json")
            self.client.lpush(consumer.RESULT_QUEUE, json.dumps({"session_id": "process-test", "result_data": []}))
            self.client.rpush(analytics.SCORE_QUEUE, "bad json")
            self.client.rpush(analytics.SCORE_QUEUE, '{"label":"health_disclosure","sensitivity_score":0.7}')
            wait_for(lambda: self.client.exists("aegis:processed:process-test", analytics.SNAPSHOT_KEY) == 2)
            self.assertEqual(self.snapshot()["total_scores"], 1)
            self.assertEqual(json.loads(self.client.get("aegis:processed:process-test"))["labels"], [])
            self.assertIsNone(result_worker.poll())
            self.assertIsNone(analytics_worker.poll())
            for process in processes:
                process.terminate()
                process.wait(timeout=5)
            self.assertEqual(self.client.mget(consumer.HEARTBEAT_KEY, analytics.HEARTBEAT_KEY), [None, None])
            start("pathway_engine.analytics")
            wait_for(lambda: self.client.get(analytics.HEARTBEAT_KEY))
            self.client.rpush(analytics.SCORE_QUEUE, '{"label":"self_harm_disclosure","score":0.9}')
            wait_for(lambda: self.snapshot()["total_scores"] == 2)
            self.assertAlmostEqual(self.snapshot()["current_average"], 0.8)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
