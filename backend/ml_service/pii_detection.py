from gliner import GLiNER
from transformers import pipeline, RobertaTokenizerFast, RobertaForSequenceClassification
from paddleocr import PaddleOCR
from PIL import Image, ImageEnhance
from pdf2image import convert_from_bytes
import numpy as np
import io
import os
import re
import magic
import tempfile
import time

# ------------------------------
# Helper: Text Chunking
# ------------------------------
def chunk_text(text, tokenizer, max_tokens=512, overlap=50):
    if not isinstance(text, str):
        text = str(text or "")
    text = text.strip()
    if not text:
        return []

    try:
        tokens = tokenizer.encode(text, add_special_tokens=False)
    except Exception as e:
        print(f"[Tokenizer error] {e}")
        tokens = []

    if not tokens:
        return [text]

    chunks = []
    start = 0
    while start < len(tokens):
        end = min(start + max_tokens - 2, len(tokens))
        chunk = tokens[start:end]
        if not chunk:
            break
        try:
            chunk_text = tokenizer.decode(chunk, skip_special_tokens=True).strip()
        except Exception as e:
            print(f"[Decode error] {e}")
            chunk_text = ""
        if chunk_text:
            chunks.append(chunk_text)
        start += max_tokens - overlap

    return chunks


def analyze_long_text(text, detector, tokenizer, threshold=0.5):
    chunks = chunk_text(text, tokenizer)
    if not chunks:
        return []

    results = []
    for i, chunk in enumerate(chunks):
        try:
            preds = detector(chunk)
            if isinstance(preds[0], list):
                preds = preds[0]
            for p in preds:
                if p["score"] >= threshold:
                    results.append(p)
        except Exception as e:
            print(f"[Chunk {i} skipped: {e}]")
            continue

    aggregated = {}
    for r in results:
        label = r["label"]
        aggregated[label] = aggregated.get(label, 0) + r["score"]

    for label in aggregated:
        aggregated[label] /= max(len(chunks), 1)

    return [{"label": label, "score": round(score, 3)} for label, score in aggregated.items()]


# ------------------------------
# Load Models with Error Handling
# ------------------------------

# PII model
print("Loading GLiNER PII model...")
try:
    gliner_model = GLiNER.from_pretrained("nvidia/gliner-pii")
    print("GLiNER PII model loaded successfully.")
except Exception as e:
    print(f"Failed to load GLiNER PII model: {e}")
    gliner_model = None

LABELS = [
    "name", "date_of_birth", "age", "email", "phone_number",
    "address", "city", "state", "zip_code", "ip_address", "url",
    "account_number", "credit_card_number", "bank_name", "pan_number", "ssn",
    "passport_number", "driver_license_number", "aadhar_number", "national_id_number",
    "medical_record_number", "diagnosis", "treatment", "doctor_name",
    "organization_name", "employer_name", "occupation",
    "api_key", "access_token", "secret_key", "auth_token"
]


# Self-Harm Model
print("Loading Self-Harm Detection model...")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SELFHARM_MODEL_PATH = os.path.join(BASE_DIR, "models", "selfharm_model")

try:
    tokenizer_selfharm = RobertaTokenizerFast.from_pretrained(
        SELFHARM_MODEL_PATH,
        vocab_file=os.path.join(SELFHARM_MODEL_PATH, "vocab.json"),
        merges_file=os.path.join(SELFHARM_MODEL_PATH, "merges.txt")
    )
    model_selfharm = RobertaForSequenceClassification.from_pretrained(SELFHARM_MODEL_PATH)
    selfharm_detector = pipeline(
        "text-classification",
        model=model_selfharm,
        tokenizer=tokenizer_selfharm
    )
    print("Self-Harm model loaded successfully.")
except Exception as e:
    print(f"Failed to load Self-Harm model: {e}")
    selfharm_detector = None
    tokenizer_selfharm = None


# Disease Model
print("Loading Disease Detection model...")
DISEASE_MODEL_PATH = os.path.join(BASE_DIR, "models", "diseases_model")

try:
    tokenizer = RobertaTokenizerFast.from_pretrained(
        DISEASE_MODEL_PATH,
        vocab_file=os.path.join(DISEASE_MODEL_PATH, "vocab.json"),
        merges_file=os.path.join(DISEASE_MODEL_PATH, "merges.txt")
    )
    model = RobertaForSequenceClassification.from_pretrained(DISEASE_MODEL_PATH)
    disease_detector = pipeline("text-classification", model=model, tokenizer=tokenizer)
    print("Disease Detection model loaded successfully.")
except Exception as e:
    print(f"Failed to load Disease model: {e}")
    disease_detector = None
    tokenizer = None


# OCR Init
print("Initializing PaddleOCR...")
try:
    ocr = PaddleOCR(use_textline_orientation=True, lang='en')
    print("PaddleOCR initialized successfully.")
except Exception as e:
    print(f"PaddleOCR initialization failed: {e}")
    ocr = None


# ------------------------------
# Helper Functions
# ------------------------------
def preprocess_image(image: Image.Image) -> Image.Image:
    img = image.convert("RGB")
    img = ImageEnhance.Contrast(img).enhance(1.3)
    img = ImageEnhance.Brightness(img).enhance(1.1)
    return img


def clean_ocr_text(text: str) -> str:
    text = re.sub(r'(?<=\d)O(?=\d)', '0', text)
    text = re.sub(r'[^a-zA-Z0-9\s@.:/\-]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def extract_text_from_image(image: Image.Image) -> str:
    if ocr is None:
        print("OCR not available, skipping image extraction.")
        return ""
    try:
        result = ocr.ocr(np.array(image))
        texts = []
        if isinstance(result, list):
            for entry in result:
                if isinstance(entry, list):
                    for item in entry:
                        if isinstance(item, (list, tuple)) and len(item) > 1:
                            val = item[1]
                            if isinstance(val, (list, tuple)) and len(val) > 0 and isinstance(val[0], str):
                                texts.append(val[0])
                            elif isinstance(val, str):
                                texts.append(val)
        return " ".join(t.strip() for t in texts if isinstance(t, str) and t.strip())
    except Exception as e:
        print(f"OCR extraction error: {e}")
        return ""


# ------------------------------
# Sensitivity Scores
# ------------------------------
SENSITIVITY_SCORES = {
    "name": 0.3, "surname": 0.3, "date_of_birth": 0.6, "age": 0.6, "email": 0.6,
    "phone_number": 0.7, "address": 0.8, "city": 0.3, "state": 0.2, "zip_code": 0.4,
    "account_number": 1.0, "credit_card_number": 1.0, "bank_name": 0.6, "pan_number": 1.0,
    "passport_number": 1.0, "driver_license_number": 0.9, "aadhar_number": 1.0,
    "national_id_number": 1.0, "medical_record_number": 0.9, "diagnosis": 0.7,
    "treatment": 0.7, "doctor_name": 0.6, "organization_name": 0.7, "employer_name": 0.7,
    "occupation": 0.5, "api_key": 1.0, "access_token": 1.0, "secret_key": 1.0, "auth_token": 1.0,
    "emotional_distress": 1.0, "detected_disease": 0.6
}


# ------------------------------
# Text Analysis
# ------------------------------
def analyze_text(text: str, threshold: float = 0.5) -> dict:
    results = []

    # PII Detection
    if gliner_model:
        try:
            pii_entities = gliner_model.predict_entities(text, LABELS, threshold=threshold)
            for e in pii_entities:
                results.append({
                    "label": e["label"],
                    "sensitivity_score": SENSITIVITY_SCORES.get(e["label"], 0.7)
                })
        except Exception as e:
            print(f"PII analysis failed: {e}")

    # Self-Harm Detection
    if selfharm_detector and tokenizer_selfharm:
        try:
            selfharm_results = analyze_long_text(text, selfharm_detector, tokenizer_selfharm)
            for sr in selfharm_results:
                if sr["label"] == "LABEL_1":
                    results.append({"label": "self_harm_risk", "sensitivity_score": 1.0})
        except Exception as e:
            print(f"Self-harm analysis failed: {e}")

    # Disease Detection
    if disease_detector and tokenizer:
        try:
            disease_results = analyze_long_text(text, disease_detector, tokenizer)
            for dr in disease_results:
                if dr["label"] == "LABEL_1":
                    results.append({
                        "label": "detected_disease",
                        "sensitivity_score": SENSITIVITY_SCORES.get("detected_disease", 0.6)
                    })
        except Exception as e:
            print(f"Disease analysis failed: {e}")

    return results


# ------------------------------
# Main Function
# ------------------------------
def detect_pii(input_data, threshold: float = 0.5, max_pages: int = 2):
    try:
        if isinstance(input_data, str):
            cleaned_text = clean_ocr_text(input_data)
            return analyze_text(cleaned_text, threshold)

        elif isinstance(input_data, (bytes, bytearray)):
            file_type = (magic.from_buffer(input_data[:2048], mime=True) or "").lower()
            extracted_text = ""

            if "image" in file_type:
                img = Image.open(io.BytesIO(input_data))
                img = preprocess_image(img)
                extracted_text = extract_text_from_image(img)

            elif "pdf" in file_type:
                pages = convert_from_bytes(input_data, dpi=150, first_page=1, last_page=max_pages, fmt="jpeg")
                page_texts = [extract_text_from_image(preprocess_image(p)) for p in pages]
                extracted_text = " ".join(page_texts)
            else:
                return {"error": f"Unsupported file type: {file_type or 'unknown'}"}

            if not extracted_text.strip():
                return {"error": "No text detected in file."}

            cleaned_text = clean_ocr_text(extracted_text)
            return analyze_text(cleaned_text, threshold)

        else:
            return {"error": "Unsupported input type. Must be string or bytes."}
    except Exception as e:
        return {"error": str(e)}


# ------------------------------
# Testing
# ------------------------------
if __name__ == "__main__":
    sample_text = "My name is Arjun, I live in Mumbai, and I want to die. The doctor said I have depression."
    print("\nTEXT RESULT:")
    print(detect_pii(sample_text))
