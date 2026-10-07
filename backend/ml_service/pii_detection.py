"""Local PII and V2 disclosure inference shared by the API and file analysis."""

import io
import logging
import math
import os
import re
import threading
from pathlib import Path

logger = logging.getLogger(__name__)
BASE_DIR = Path(__file__).resolve().parent
HEALTH_MODEL_PATH = Path(os.getenv(
    "AEGIS_HEALTH_MODEL_PATH", str(BASE_DIR / "notebooks" / "disease_model_v2")
)).expanduser().resolve()
SELFHARM_MODEL_PATH = Path(os.getenv(
    "AEGIS_SELFHARM_MODEL_PATH", str(BASE_DIR / "notebooks" / "self_harm_model_v2")
)).expanduser().resolve()
GLINER_MODEL = os.getenv("AEGIS_GLINER_MODEL", "nvidia/gliner-pii")
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_TEXT_CHARS = 100_000
CLASSIFIER_MAX_TOKENS = 256  # Matches V2 training.
MAX_IMAGE_PIXELS = 20_000_000

LABELS = [
    "name", "date_of_birth", "age", "email", "phone_number",
    "address", "city", "state", "zip_code", "ip_address", "url",
    "account_number", "credit_card_number", "bank_name", "pan_number", "ssn",
    "passport_number", "driver_license_number", "aadhar_number", "national_id_number",
    "medical_record_number", "diagnosis", "treatment", "doctor_name",
    "organization_name", "employer_name", "occupation",
    "api_key", "access_token", "secret_key", "auth_token",
]
SENSITIVITY_SCORES = {
    "name": 0.3, "date_of_birth": 0.6, "age": 0.6, "email": 0.6,
    "phone_number": 0.7, "address": 0.8, "city": 0.3, "state": 0.2,
    "zip_code": 0.4, "ip_address": 0.7, "url": 0.4, "ssn": 1.0,
    "account_number": 1.0, "credit_card_number": 1.0, "bank_name": 0.6,
    "pan_number": 1.0, "passport_number": 1.0, "driver_license_number": 0.9,
    "aadhar_number": 1.0, "national_id_number": 1.0, "medical_record_number": 0.9,
    "diagnosis": 0.7, "treatment": 0.7, "doctor_name": 0.6,
    "organization_name": 0.7, "employer_name": 0.7, "occupation": 0.5,
    "api_key": 1.0, "access_token": 1.0, "secret_key": 1.0, "auth_token": 1.0,
    "health_disclosure": 0.6, "self_harm_disclosure": 1.0,
}
_CLASSIFIERS = {
    "health": (HEALTH_MODEL_PATH, "HEALTH_DISCLOSURE", "NO_HEALTH_DISCLOSURE"),
    "self_harm": (SELFHARM_MODEL_PATH, "SELF_HARM_DISCLOSURE", "NO_SELF_HARM_DISCLOSURE"),
}
_loaded = {}
_states = {}
_load_lock = threading.RLock()
_inference_lock = threading.RLock()


class AnalysisError(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def _has_weights(path):
    return (path / "config.json").is_file() and any(
        (path / filename).is_file() for filename in ("model.safetensors", "pytorch_model.bin")
    )


def _load_component(name):
    with _load_lock:
        if name in _loaded:
            return _loaded[name]
        if _states.get(name, {}).get("status") == "unavailable":
            return None
        try:
            if name in _CLASSIFIERS:
                from transformers import AutoModelForSequenceClassification, AutoTokenizer, pipeline
                import torch

                path, positive, negative = _CLASSIFIERS[name]
                if not _has_weights(path):
                    raise ValueError("V2 weights are missing. Train/save the V2 notebook or set its model path.")
                torch.set_num_threads(max(1, int(os.getenv("AEGIS_TORCH_THREADS", "4"))))
                tokenizer = AutoTokenizer.from_pretrained(str(path), local_files_only=True)
                model = AutoModelForSequenceClassification.from_pretrained(str(path), local_files_only=True)
                if set(model.config.id2label.values()) != {positive, negative}:
                    raise ValueError("Model label mapping does not match the V2 disclosure task.")
                model.eval()
                value = (pipeline("text-classification", model=model, tokenizer=tokenizer, device=-1), tokenizer)
            elif name == "pii":
                from gliner import GLiNER

                try:
                    value = GLiNER.from_pretrained(GLINER_MODEL, local_files_only=True)
                except (OSError, FileNotFoundError):
                    if os.getenv("AEGIS_ALLOW_MODEL_DOWNLOAD", "1") != "1":
                        raise
                    value = GLiNER.from_pretrained(GLINER_MODEL)
                value.eval()
            elif name == "ocr":
                from paddleocr import PaddleOCR

                value = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
            else:
                raise ValueError("Unknown model component")
            _loaded[name] = value
            _states[name] = {"status": "ready"}
            logger.info("AEGIS %s component loaded", name)
            return value
        except Exception:
            logger.exception("Could not load AEGIS %s component", name)
            _states[name] = {"status": "unavailable", "error": f"{name} component could not load; check the server log and model files."}
            return None


def get_model_status(load=False, include_ocr=False):
    if load:
        for name in ["health", "self_harm", "pii"] + (["ocr"] if include_ocr else []):
            _load_component(name)
    statuses = {}
    for name in ["health", "self_harm", "pii", "ocr"]:
        state = dict(_states.get(name, {"status": "not_loaded"}))
        if name in _CLASSIFIERS:
            path, positive, negative = _CLASSIFIERS[name]
            state.update(version="v2", labels=[negative, positive], weights_present=_has_weights(path))
            if not state["weights_present"]:
                state.update(status="unavailable", error="V2 model weights are missing.")
        elif name == "pii":
            state["model"] = GLINER_MODEL
        statuses[name] = state
    return statuses


def chunk_text(text, tokenizer, max_tokens=CLASSIFIER_MAX_TOKENS, overlap=50):
    """Cover all tokens with a true overlap, reserving room for special tokens."""
    if not isinstance(text, str):
        raise AnalysisError("Text must be a string.")
    if not text.strip():
        return []
    width = min(max_tokens, tokenizer.model_max_length) - tokenizer.num_special_tokens_to_add(pair=False)
    if width <= 0 or not 0 <= overlap < width:
        raise ValueError("Invalid chunk size or overlap")
    tokens = tokenizer.encode(text, add_special_tokens=False)
    chunks = []
    for start in range(0, len(tokens), width - overlap):
        chunk = tokenizer.decode(tokens[start:start + width], skip_special_tokens=True,
                                 clean_up_tokenization_spaces=False).strip()
        if chunk:
            chunks.append(chunk)
        if start + width >= len(tokens):
            break
    return chunks


def analyze_long_text(text, detector, tokenizer, threshold=0.5):
    """Maximum confidence prevents a local disclosure being diluted by other chunks."""
    aggregated = {}
    for chunk in chunk_text(text, tokenizer):
        predictions = detector(chunk, top_k=None, truncation=True, max_length=CLASSIFIER_MAX_TOKENS)
        if predictions and isinstance(predictions[0], list):
            predictions = predictions[0]
        if not isinstance(predictions, list) or not predictions:
            raise ValueError("Classifier returned no valid predictions")
        for prediction in predictions:
            label, score = prediction["label"], float(prediction["score"])
            if not isinstance(label, str) or not label or not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError("Classifier returned an invalid label or confidence")
            if score >= threshold:
                aggregated[label] = max(aggregated.get(label, 0.0), score)
    return [{"label": label, "score": score} for label, score in aggregated.items()]


def _pii_chunks(text, model):
    words = list(model.data_processor.words_splitter(text))
    width = min(int(model.config.max_len), 256)
    for start in range(0, len(words), max(1, width - 32)):
        window = words[start:start + width]
        if window:
            yield text[window[0][1]:window[-1][2]]
        if start + width >= len(words):
            break


def merge_detections(detections):
    """One category per request; retain the strongest model confidence."""
    merged = {}
    for item in detections:
        label = item["label"]
        if label not in merged or item.get("confidence", 0) > merged[label].get("confidence", 0):
            merged[label] = dict(item)
    return list(merged.values())


def _analyze_text(text, threshold):
    detections, warnings = [], []
    for name in ["health", "self_harm"]:
        bundle = _load_component(name)
        if bundle is None:
            raise AnalysisError(f"The V2 {name.replace('_', '-')} model is unavailable. Check model setup.", 503)
        detector, tokenizer = bundle
        try:
            predictions = analyze_long_text(text, detector, tokenizer, threshold)
        except Exception:
            logger.exception("AEGIS %s inference failed", name)
            raise AnalysisError(f"The {name.replace('_', '-')} model could not analyze this input.", 503)
        positive = _CLASSIFIERS[name][1]
        label = f"{name}_disclosure"
        for prediction in predictions:
            if prediction["label"] == positive:
                detections.append({"label": label, "confidence": round(prediction["score"], 6),
                                   "sensitivity_score": SENSITIVITY_SCORES[label]})
    gliner_model = _load_component("pii")
    if gliner_model is None:
        warnings.append("PII detection is unavailable; only disclosure classifiers were used.")
    else:
        try:
            for chunk in _pii_chunks(text, gliner_model):
                for entity in gliner_model.predict_entities(chunk, LABELS, threshold=threshold):
                    detections.append({"label": entity["label"], "confidence": round(float(entity["score"]), 6),
                                       "sensitivity_score": SENSITIVITY_SCORES.get(entity["label"], 0.7)})
        except Exception:
            logger.exception("AEGIS PII inference failed")
            warnings.append("PII detection failed; these results only include disclosure classifiers.")
    return merge_detections(detections), warnings


def clean_ocr_text(text):
    # Correct OCR digits while preserving Unicode, apostrophes and punctuation.
    text = re.sub(r"(?<=\d)O(?=\d)", "0", text)
    return re.sub(r"\s+", " ", text).strip()


def preprocess_image(image):
    from PIL import ImageEnhance

    if image.width * image.height > MAX_IMAGE_PIXELS:
        raise AnalysisError("Image is too large (maximum 20 megapixels).", 413)
    image = image.convert("RGB")
    image.thumbnail((2400, 2400))
    return ImageEnhance.Brightness(ImageEnhance.Contrast(image).enhance(1.3)).enhance(1.1)


def extract_text_from_image(image):
    import numpy as np

    ocr = _load_component("ocr")
    if ocr is None:
        raise AnalysisError("OCR is unavailable. Check PaddleOCR setup.", 503)
    try:
        pages = ocr.ocr(np.asarray(preprocess_image(image)), cls=True)
        texts = []
        for page in pages or []:
            for item in page or []:
                if len(item) > 1 and isinstance(item[1], (list, tuple)) and isinstance(item[1][0], str):
                    texts.append(item[1][0])
        return clean_ocr_text(" ".join(texts))
    except AnalysisError:
        raise
    except Exception:
        logger.exception("AEGIS OCR failed")
        raise AnalysisError("OCR could not read this file.", 422)


def _file_text(data, max_pages):
    from PIL import Image, UnidentifiedImageError

    if len(data) > MAX_INPUT_BYTES:
        raise AnalysisError("Upload exceeds the 8 MB limit.", 413)
    if data.lstrip().startswith(b"%PDF-"):
        from pdf2image import convert_from_bytes, pdfinfo_from_bytes

        try:
            page_count = int(pdfinfo_from_bytes(data, timeout=30)["Pages"])
            if page_count > max_pages:
                raise AnalysisError(f"PDF exceeds the {max_pages}-page analysis limit.", 413)
            texts = []
            for page in range(1, page_count + 1):
                images = convert_from_bytes(data, dpi=150, first_page=page, last_page=page,
                                            fmt="jpeg", thread_count=1, timeout=30)
                for image in images:
                    texts.append(extract_text_from_image(image))
                    image.close()
            return " ".join(texts).strip()
        except AnalysisError:
            raise
        except Exception:
            logger.exception("AEGIS PDF extraction failed")
            raise AnalysisError("PDF could not be read. Check the file and Poppler installation.", 422)
    try:
        with Image.open(io.BytesIO(data)) as image:
            if getattr(image, "n_frames", 1) > 1:
                raise AnalysisError("Multi-frame images are unsupported; upload a single image or PDF.")
            return extract_text_from_image(image)
    except AnalysisError:
        raise
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise AnalysisError("Unsupported or invalid file. Upload an image or PDF.")


def analyze_input(input_data, threshold=0.5, max_pages=None):
    """Return categories, confidence and risk weights without raw sensitive entities."""
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise AnalysisError("Threshold must be a finite number between 0 and 1.")
    max_pages = max_pages if max_pages is not None else int(os.getenv("AEGIS_MAX_PDF_PAGES", "10"))
    if isinstance(max_pages, bool) or not isinstance(max_pages, int) or max_pages < 1:
        raise ValueError("PDF page limit must be a positive integer")
    with _inference_lock:
        if isinstance(input_data, str):
            text = input_data.strip()
        elif isinstance(input_data, (bytes, bytearray)):
            text = _file_text(bytes(input_data), max_pages)
            if not text:
                raise AnalysisError("No readable text was found in the file.", 422)
        else:
            raise AnalysisError("Input must be text or image/PDF bytes.")
        if not text:
            raise AnalysisError("Text must not be empty.")
        if len(text) > MAX_TEXT_CHARS:
            raise AnalysisError("Text exceeds the 100,000-character analysis limit.", 413)
        detections, warnings = _analyze_text(text, threshold)
        return {"detections": detections, "warnings": warnings, "models": get_model_status()}


def analyze_text(text, threshold=0.5):
    return analyze_input(text, threshold)["detections"]


def detect_pii(input_data, threshold=0.5, max_pages=None):
    """Compatibility entry point. Use analyze_input to receive availability warnings."""
    return analyze_input(input_data, threshold, max_pages)["detections"]


if __name__ == "__main__":
    print(analyze_input("My email is alex@example.com. I was diagnosed with diabetes."))
