import base64
import json
import os
from unittest.mock import Mock, patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings
from redis.exceptions import ConnectionError
from rest_framework.test import APIRequestFactory

from ML_api import views
from ml_service import redis_client
from ml_service.pii_detection import AnalysisError


READY_MODELS = {
    "health": {"status": "ready"},
    "self_harm": {"status": "ready"},
    "pii": {"status": "ready"},
    "ocr": {"status": "ready"},
}


def analysis(detections=None, warnings=None, models=None):
    return {"detections": detections or [], "warnings": warnings or [],
            "models": models or READY_MODELS}


class AnalysisAPITests(SimpleTestCase):
    def setUp(self):
        self.factory = APIRequestFactory()
        self.engine = patch("ML_api.views.analyze_input", return_value=analysis()).start()
        self.queue = patch("ML_api.views.push_to_queue", return_value="b5cd7b6c-03c1-47db-a7b0-d6d32c38b657").start()
        self.redis = Mock()
        self.redis.mget.return_value = [None, None]
        self.redis.get.return_value = None
        patch("ML_api.views.get_redis_client", return_value=self.redis).start()
        self.addCleanup(patch.stopall)

    def post(self, data, format="json"):
        return views.analyze_endpoint(self.factory.post("/api/analyze/", data, format=format))

    def test_combines_text_and_all_files_with_max_confidence(self):
        self.engine.side_effect = [
            analysis([{"label": "health_disclosure", "sensitivity_score": .8, "confidence": .81}]),
            analysis([{"label": "health_disclosure", "sensitivity_score": .8, "confidence": .96}]),
            analysis([{"label": "self_harm_disclosure", "sensitivity_score": 1, "confidence": .93}]),
        ]
        response = self.post({
            "text": "I have a private medical condition",
            "image": [SimpleUploadedFile("first.png", b"first-file"),
                      SimpleUploadedFile("second.pdf", b"second-file")],
        }, format="multipart")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([call.args[0] for call in self.engine.call_args_list],
                         ["I have a private medical condition", b"first-file", b"second-file"])
        self.assertEqual(response.data["detections"], [
            {"label": "health_disclosure", "sensitivity_score": .8, "confidence": .96},
            {"label": "self_harm_disclosure", "sensitivity_score": 1, "confidence": .93},
        ])
        self.assertTrue(response.data["analysis_complete"])
        self.assertEqual(response.data["pathway_pushed"], 2)
        stream_items = [json.loads(item) for item in self.redis.rpush.call_args.args[1:]]
        self.assertEqual(stream_items[0]["score"], .8)
        self.assertEqual(stream_items[0]["confidence"], .96)

    def test_redis_failure_keeps_immediate_detections(self):
        self.engine.return_value = analysis([{"label": "health_disclosure", "sensitivity_score": .8, "confidence": .95}])
        self.queue.side_effect = ConnectionError("internal host")
        self.redis.rpush.side_effect = ConnectionError("internal host")
        response = self.post({"text": "private disclosure"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["status"], "completed")
        self.assertIsNone(response.data["session_id"])
        self.assertEqual(len(response.data["detections"]), 1)
        self.assertEqual(len(response.data["warnings"]), 2)
        self.assertTrue(response.data["analysis_complete"])
        self.assertNotIn("internal host", str(response.data))

    def test_component_warning_marks_analysis_incomplete(self):
        self.engine.return_value = analysis(warnings=["PII detector unavailable."], models={
            **READY_MODELS, "pii": {"status": "unavailable"},
        })
        response = self.post({"text": "example"})
        self.assertFalse(response.data["analysis_complete"])
        self.assertIn("PII detector unavailable.", response.data["warnings"])

    def test_cold_mixed_upload_updates_ocr_state_after_text_analysis(self):
        self.engine.side_effect = [
            analysis(models={**READY_MODELS, "ocr": {"status": "not_loaded"}}),
            analysis(models=READY_MODELS),
        ]
        response = self.post({
            "text": "Review this upload",
            "image": SimpleUploadedFile("first.png", b"image-file"),
        }, format="multipart")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["models"]["ocr"]["status"], "ready")
        self.assertTrue(response.data["analysis_complete"])

    def test_unavailable_component_is_retained_across_mixed_results(self):
        self.engine.side_effect = [
            analysis(models={**READY_MODELS, "pii": {"status": "unavailable"}}),
            analysis(models=READY_MODELS),
        ]
        response = self.post({"text": "example", "image": SimpleUploadedFile("sample.png", b"image-file")}, format="multipart")
        self.assertEqual(response.data["models"]["pii"]["status"], "unavailable")
        self.assertFalse(response.data["analysis_complete"])

    def test_model_failure_is_not_a_success_or_queued(self):
        self.engine.side_effect = AnalysisError("Health model unavailable.", status_code=503)
        response = self.post({"text": "private disclosure"})
        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.data["analysis_complete"])
        self.queue.assert_not_called()

    def test_unexpected_model_error_does_not_leak_input(self):
        self.engine.side_effect = RuntimeError("secret input and stack path")
        response = self.post({"text": "secret input"})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("secret input", str(response.data))
        self.queue.assert_not_called()

    def test_malformed_model_result_is_not_an_empty_success(self):
        self.engine.return_value = {"error": "broken model"}
        self.assertEqual(self.post({"text": "example"}).status_code, 503)
        self.queue.assert_not_called()

    def test_unavailable_classifier_cannot_return_empty_success(self):
        self.engine.return_value = analysis(models={"health": {"status": "unavailable"}})
        self.assertEqual(self.post({"text": "example"}).status_code, 503)
        self.queue.assert_not_called()

    def test_text_analysis_does_not_depend_on_previous_ocr_failure(self):
        self.engine.return_value = analysis(models={**READY_MODELS, "ocr": {"status": "unavailable"}})
        response = self.post({"text": "example"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["analysis_complete"])

    def test_rejects_invalid_text_empty_input_and_invalid_thresholds(self):
        for payload in ({"text": 123}, {"text": None}, {}, {"text": "  "},
                        {"text": "example", "threshold": -1},
                        {"text": "example", "threshold": "nan"},
                        {"text": "example", "threshold": True}):
            with self.subTest(payload=payload):
                self.assertEqual(self.post(payload).status_code, 400)
        self.engine.assert_not_called()

    def test_strict_base64_and_combined_base64_text(self):
        self.assertEqual(self.post({"image_base64": "!!!"}).status_code, 400)
        self.assertEqual(self.post({"image_base64": 123}).status_code, 400)
        self.assertEqual(self.post({"image_base64": "data:image/png,AAAA"}).status_code, 400)
        encoded = base64.b64encode(b"image-file").decode("ascii")
        response = self.post({"text": "example", "image_base64": "data:image/png;base64," + encoded})
        self.assertEqual(response.status_code, 200)
        self.assertEqual([call.args[0] for call in self.engine.call_args_list], ["example", b"image-file"])

    @override_settings(AEGIS_MAX_INPUT_BYTES=64)
    def test_rejects_oversized_request_before_inference(self):
        response = self.post({"text": "x" * 65})
        self.assertEqual(response.status_code, 413)
        self.engine.assert_not_called()

    def test_excessive_file_count_is_a_client_error(self):
        response = self.post({"image": [
            SimpleUploadedFile("sample-{}.png".format(index), b"image-file")
            for index in range(11)
        ]}, format="multipart")
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.data["analysis_complete"])
        self.engine.assert_not_called()

    def test_invalid_json_returns_400(self):
        request = self.factory.post("/api/analyze/", b"{broken", content_type="application/json")
        self.assertEqual(views.analyze_endpoint(request).status_code, 400)

    def test_score_range_is_validated_and_redis_errors_are_503(self):
        for value in (-.1, 1.1, "nan", "inf", True, None):
            request = self.factory.post("/api/score/", {"label": "health_disclosure", "score": value}, format="json")
            with self.subTest(value=value):
                self.assertEqual(views.submit_score(request).status_code, 400)
        self.redis.rpush.assert_not_called()
        self.redis.rpush.side_effect = ConnectionError("internal host")
        request = self.factory.post("/api/score/", {"label": "health_disclosure", "score": .8}, format="json")
        self.assertEqual(views.submit_score(request).status_code, 503)

    def test_stats_numbers_and_offline_status(self):
        self.redis.mget.return_value = [".8", "1", ".5", "3", "2", "33.3", "1", "1", "1"]
        raw_labels = json.dumps({"health_disclosure": {"average_score": ".8", "total_scores": "2"}})
        self.redis.get.side_effect = lambda key: raw_labels if key == views.STATS_BY_LABEL_KEY else None
        response = views.get_all_stats(self.factory.get("/api/stats/"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["total_scores"], 3)
        self.assertEqual(response.data["distribution"], {"low": 1, "medium": 1, "high": 1})
        self.assertEqual(response.data["stats_by_label"]["health_disclosure"]["average_score"], .8)
        self.redis.mget.side_effect = ConnectionError("internal host")
        self.assertEqual(views.get_all_stats(self.factory.get("/api/stats/")).status_code, 503)

    def test_outdated_score_scale_does_not_masquerade_as_normalized_stats(self):
        self.redis.mget.return_value = ["80", "100", "50", "3", "2", "33.3", "1", "1", "1"]
        self.redis.get.return_value = None
        self.assertEqual(views.get_all_stats(self.factory.get("/api/stats/")).status_code, 503)

    def test_stats_reads_a_single_consistent_snapshot(self):
        self.redis.get.return_value = json.dumps({
            "current_average": .8, "highest_score": 1, "lowest_score": .5,
            "total_scores": 3, "unique_label_count": 2, "percent_high_score": 33.3,
            "distribution": {"low": 1, "medium": 1, "high": 1},
            "stats_by_label": {"health_disclosure": {"average_score": .8, "count": 2}},
        })
        response = views.get_all_stats(self.factory.get("/api/stats/"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["total_scores"], 3)
        self.redis.get.assert_called_once_with(views.ANALYTICS_SNAPSHOT_KEY)
        self.redis.mget.assert_not_called()

    def test_health_reports_lazy_and_explicit_loading(self):
        with patch("ML_api.views.get_model_status", return_value=READY_MODELS) as getter:
            self.redis.ping.side_effect = ConnectionError("offline")
            response = views.health_endpoint(self.factory.get("/api/health/?load=1&ocr=1"))
            getter.assert_called_once_with(load=True, include_ocr=True)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.data["text_analysis_ready"])
            self.assertFalse(response.data["background_processing_ready"])
        with patch("ML_api.views.get_model_status", return_value={"health": {"status": "unavailable"}}):
            self.assertEqual(views.health_endpoint(self.factory.get("/api/health/")).status_code, 503)

    def test_redis_connection_does_not_imply_workers_are_running(self):
        with patch("ML_api.views.get_model_status", return_value=READY_MODELS):
            response = views.health_endpoint(self.factory.get("/api/health/"))
            self.assertEqual(response.data["redis"]["status"], "ready")
            self.assertFalse(response.data["background_processing_ready"])
            self.assertFalse(response.data["analytics_ready"])
            self.redis.mget.return_value = ["consumer-alive", "analytics-alive"]
            response = views.health_endpoint(self.factory.get("/api/health/"))
            self.assertTrue(response.data["background_processing_ready"])
            self.assertTrue(response.data["analytics_ready"])
            self.redis.mget.assert_called_with(views.WORKER_KEYS)

    def test_results_validate_session_and_report_background_failures(self):
        self.assertEqual(views.get_results(self.factory.get("/api/get_results/?session_id=invalid")).status_code, 400)
        request = self.factory.get("/api/get_results/?session_id=b5cd7b6c-03c1-47db-a7b0-d6d32c38b657")
        with patch("ML_api.views.fetch_processed_result", side_effect=ConnectionError("offline")):
            self.assertEqual(views.get_results(request).status_code, 503)


class RedisContractTests(SimpleTestCase):
    def test_queue_preserves_confidence_and_normalizes_legacy_score(self):
        client = Mock()
        with patch("ml_service.redis_client.get_redis_client", return_value=client):
            session_id = redis_client.push_to_queue([
                {"label": "health_disclosure", "score": .8, "confidence": .97},
            ])
        payload = json.loads(client.lpush.call_args.args[1])
        self.assertEqual(payload["session_id"], session_id)
        self.assertEqual(payload["result_data"], [
            {"label": "health_disclosure", "sensitivity_score": .8, "confidence": .97},
        ])

    def test_error_payload_is_not_queued(self):
        with patch("ml_service.redis_client.get_redis_client") as getter:
            with self.assertRaises(ValueError):
                redis_client.push_to_queue({"error": "failed"})
            getter.assert_not_called()

    def test_connection_construction_is_lazy_and_env_shared(self):
        redis_client._client_for_url.cache_clear()
        with patch.dict(os.environ, {"AEGIS_REDIS_URL": "redis://127.0.0.1:6399/4"}):
            with patch("ml_service.redis_client.redis.Redis.from_url") as constructor:
                client = redis_client.get_redis_client()
                self.assertEqual(redis_client.get_redis_client(), client)
                constructor.assert_called_once()
                self.assertEqual(constructor.call_args.args[0], "redis://127.0.0.1:6399/4")
                client.ping.assert_not_called()
        redis_client._client_for_url.cache_clear()
