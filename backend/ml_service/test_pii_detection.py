import io
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from ml_service import pii_detection as ml


class Tokenizer:
    model_max_length = 512

    def num_special_tokens_to_add(self, pair=False):
        return 2

    def encode(self, text, **kwargs):
        return list(text)

    def decode(self, tokens, **kwargs):
        return "".join(tokens)


class DetectorTests(unittest.TestCase):
    def test_v2_model_paths_and_semantic_labels(self):
        self.assertEqual(ml.HEALTH_MODEL_PATH.name, "disease_model_v2")
        self.assertEqual(ml.SELFHARM_MODEL_PATH.name, "self_harm_model_v2")
        self.assertEqual(ml._CLASSIFIERS["health"][1], "HEALTH_DISCLOSURE")
        self.assertEqual(ml._CLASSIFIERS["self_harm"][1], "SELF_HARM_DISCLOSURE")

    def test_chunk_coverage_overlap_and_special_token_budget(self):
        text = "".join(chr(0x400 + index) for index in range(650))
        chunks = ml.chunk_text(text, Tokenizer())
        self.assertEqual([len(chunk) for chunk in chunks], [254, 254, 242])
        self.assertEqual(chunks[0][-50:], chunks[1][:50])
        self.assertEqual(chunks[1][-50:], chunks[2][:50])
        self.assertEqual(chunks[0] + chunks[1][50:] + chunks[2][50:], text)

    def test_late_positive_chunk_is_not_diluted(self):
        def detector(text, **kwargs):
            self.assertEqual(kwargs["top_k"], None)
            return [{"label": "HEALTH_DISCLOSURE", "score": 0.9 if "Z" in text else 0.1},
                    {"label": "NO_HEALTH_DISCLOSURE", "score": 0.1 if "Z" in text else 0.9}]

        results = ml.analyze_long_text("x" * 620 + "Z", detector, Tokenizer())
        self.assertEqual(next(item["score"] for item in results if item["label"] == "HEALTH_DISCLOSURE"), 0.9)

    def test_semantic_positive_mapping_and_threshold(self):
        tokenizer = Tokenizer()

        def bundle(name):
            positive = ml._CLASSIFIERS[name][1]
            return (lambda text, **kwargs: [{"label": positive, "score": 0.8}], tokenizer)

        with patch.object(ml, "_load_component", side_effect=lambda name: None if name == "pii" else bundle(name)):
            result = ml.analyze_input("I am sharing information.", threshold=0.7)
            self.assertEqual({item["label"] for item in result["detections"]},
                             {"health_disclosure", "self_harm_disclosure"})
            self.assertTrue(result["warnings"])
            self.assertTrue(all(item["confidence"] == 0.8 for item in result["detections"]))
            self.assertEqual(ml.analyze_input("I am sharing information.", threshold=0.9)["detections"], [])

    def test_missing_classifier_is_not_empty_safe_result(self):
        with patch.object(ml, "_load_component", return_value=None):
            with self.assertRaises(ml.AnalysisError) as error:
                ml.analyze_input("Hello")
            self.assertEqual(error.exception.status_code, 503)

    def test_inference_failure_is_not_silently_skipped(self):
        def broken(*args, **kwargs):
            raise RuntimeError("model execution failure")

        with patch.object(ml, "_load_component", return_value=(broken, Tokenizer())):
            with self.assertLogs(ml.logger, level="ERROR"):
                with self.assertRaises(ml.AnalysisError) as error:
                    ml.analyze_input("Hello")
            self.assertEqual(error.exception.status_code, 503)

    def test_empty_or_invalid_predictions_are_not_empty_safe_results(self):
        for predictions in ([], [{"label": "HEALTH_DISCLOSURE", "score": float("nan")}],
                            [{"label": "HEALTH_DISCLOSURE", "score": 1.1}]):
            with self.subTest(predictions=predictions):
                detector = lambda *args, **kwargs: predictions
                with patch.object(ml, "_load_component", return_value=(detector, Tokenizer())):
                    with self.assertLogs(ml.logger, level="ERROR"):
                        with self.assertRaises(ml.AnalysisError) as error:
                            ml.analyze_input("Hello")
                self.assertEqual(error.exception.status_code, 503)

    def test_direct_text_preserves_unicode_and_punctuation(self):
        text = "José said: I don't take medication; 1O2 is my test value."
        with patch.object(ml, "_analyze_text", return_value=([], [])) as analyze:
            ml.analyze_input(text)
            analyze.assert_called_once_with(text, 0.5)
        self.assertEqual(ml.clean_ocr_text("José  1O2\nO'Brien"), "José 102 O'Brien")

    def test_no_sensitive_entity_values_in_response(self):
        gliner = SimpleNamespace(predict_entities=lambda *a, **k: [
            {"label": "email", "score": 0.9, "text": "secret@example.com", "start": 0, "end": 18}])
        detector = lambda *a, **k: [{"label": "NO_HEALTH_DISCLOSURE", "score": 0.95}]
        with patch.object(ml, "_load_component", side_effect=lambda name: gliner if name == "pii" else (detector, Tokenizer())):
            with patch.object(ml, "_pii_chunks", return_value=["secret@example.com"]):
                result = ml.analyze_input("secret@example.com")
        self.assertEqual(result["detections"], [{"label": "email", "confidence": 0.9, "sensitivity_score": 0.6}])

    def test_merge_categories_keeps_max_confidence(self):
        results = ml.merge_detections([
            {"label": "name", "confidence": 0.6, "sensitivity_score": 0.3},
            {"label": "name", "confidence": 0.9, "sensitivity_score": 0.3},
        ])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["confidence"], 0.9)

    def test_bad_input_threshold_and_size(self):
        for text in (None, 3, {}, " "):
            with self.subTest(text=text), self.assertRaises(ml.AnalysisError):
                ml.analyze_input(text)
        for threshold in (-0.1, 1.1, float("nan"), float("inf"), True):
            with self.subTest(threshold=threshold), self.assertRaises(ml.AnalysisError):
                ml.analyze_input("text", threshold)
        with self.assertRaises(ml.AnalysisError) as error:
            ml.analyze_input("x" * (ml.MAX_TEXT_CHARS + 1))
        self.assertEqual(error.exception.status_code, 413)

    def test_missing_weights_reported_before_loading(self):
        classifiers = dict(ml._CLASSIFIERS)
        classifiers["health"] = (Path("/nonexistent/aegis/model"), "HEALTH_DISCLOSURE", "NO_HEALTH_DISCLOSURE")
        with patch.object(ml, "_CLASSIFIERS", classifiers):
            self.assertEqual(ml.get_model_status()["health"]["status"], "unavailable")

    def test_unsupported_and_unreadable_files(self):
        with self.assertRaises(ml.AnalysisError):
            ml.analyze_input(b"not an image or PDF")
        from PIL import Image
        buffer = io.BytesIO()
        Image.new("RGB", (20, 20), "white").save(buffer, format="PNG")
        with patch.object(ml, "extract_text_from_image", return_value=""):
            with self.assertRaises(ml.AnalysisError) as error:
                ml.analyze_input(buffer.getvalue())
            self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
