from gliner import GLiNER
from transformers import pipeline
from paddleocr import PaddleOCR
from PIL import Image, ImageEnhance
from pdf2image import convert_from_bytes
import numpy as np
import io
import re
import magic
import torch
import tempfile, os, time

# ==============================
# Model Setup
# ==============================

# Device setup
device = "cuda" if torch.cuda.is_available() else "cpu"

# ------------------------------
# Load GLiNER PII Model
# ------------------------------
print("Loading GLiNER PII model...")
LOCAL_GLINER_PATH = os.path.join(os.path.dirname(__file__), "gliner-pii")

def load_gliner_model():
    try:
        # Check if local model exists and has weights
        weight_path = os.path.join(LOCAL_GLINER_PATH, "pytorch_model.bin")
        if os.path.exists(weight_path):
            print(f"✅ Found local GLiNER model at: {LOCAL_GLINER_PATH}")
            model = GLiNER.from_pretrained(LOCAL_GLINER_PATH, local_files_only=True).to(device)
            print("✅ Local GLiNER model loaded successfully.")
            return model
        else:
            raise FileNotFoundError("Local GLiNER model files missing.")
    except Exception as e:
        print(f"⚠️ Local load failed ({e}). Falling back to cloud...")
        model = GLiNER.from_pretrained("nvidia/gliner-pii").to(device)
        print("☁️ Cloud GLiNER model loaded successfully.")
        return model

gliner_model = load_gliner_model()


# PII Labels
LABELS = [
    "name", "given_name", "surname",
    "date_of_birth", "age", "email", "phone_number",
    "address", "city", "state", "zip_code", "ip_address", "url",
    "account_number", "credit_card_number", "bank_name", "pan_number", "ssn",
    "passport_number", "driver_license_number", "aadhar_number", "national_id_number",
    "medical_record_number", "diagnosis", "treatment", "doctor_name",
    "organization_name", "employer_name", "occupation",
    "api_key", "access_token", "secret_key", "auth_token"
]


# ------------------------------
# Load Mental Health Classifier
# ------------------------------
print("Loading Mental-health classifier...")
LOCAL_MENTAL_PATH = os.path.join(os.path.dirname(__file__), "mental-health-model")

def load_mental_health_model():
    try:
        config_path = os.path.join(LOCAL_MENTAL_PATH, "config.json")
        weights_path = os.path.join(LOCAL_MENTAL_PATH, "model.safetensors")

        if os.path.exists(config_path) and os.path.exists(weights_path):
            print(f"✅ Found local Mental-health model at: {LOCAL_MENTAL_PATH}")
            model = pipeline(
                "text-classification",
                model=LOCAL_MENTAL_PATH,
                tokenizer=LOCAL_MENTAL_PATH,
                top_k=None
            )
            print("✅ Local Mental-health classifier loaded successfully.")
            return model
        else:
            raise FileNotFoundError("Mental model files missing locally.")
    except Exception as e:
        print(f"⚠️ Local model not found or failed ({e}). Falling back to cloud...")
        model = pipeline(
            "text-classification",
            model="Akashpaul123/bert-suicide-detection",
            tokenizer="Akashpaul123/bert-suicide-detection",
            top_k=None
        )
        print("☁️ Cloud Mental-health classifier loaded successfully.")
        return model

mental_health_model = load_mental_health_model()

MENTAL_LABEL_MAP = {
    "LABEL_0": "non_suicidal",
    "LABEL_1": "suicidal",
    "label_0": "non_suicidal",
    "label_1": "suicidal"
}


# ------------------------------
# OCR Engine
# ------------------------------
print("Initializing PaddleOCR...")
ocr = PaddleOCR(use_textline_orientation=True, lang='en')


# ==============================
# Helper Functions
# ==============================
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


# ==============================
# Analysis Logic
# ==============================
def analyze_text(text: str, threshold: float = 0.5) -> dict:
    pii_entities = gliner_model.predict_entities(text, LABELS, threshold=threshold)
    results = [{"label": e["label"], "score": round(e["score"], 3)} for e in pii_entities]

    sentences = [s.strip() for s in re.split(r'[.!?]', text) if s.strip()]
    for sentence in sentences:
        mhm_results_raw = mental_health_model(sentence)
        if isinstance(mhm_results_raw, list) and isinstance(mhm_results_raw[0], list):
            mhm_results_raw = mhm_results_raw[0]

        for r in mhm_results_raw:
            label = MENTAL_LABEL_MAP.get(r["label"])
            if label and r["score"] >= threshold and label == "suicidal":
                results.append({"label": label, "score": round(r["score"], 3)})

    return results


# ==============================
# Unified Detection Function
# ==============================
def detect_pii(input_data, threshold: float = 0.5, max_pages: int = 2):
    try:
        # Case 1: Text
        if isinstance(input_data, str):
            cleaned_text = clean_ocr_text(input_data)
            return analyze_text(cleaned_text, threshold)

        # Case 2: File (image/pdf)
        elif isinstance(input_data, (bytes, bytearray)):
            file_type = (magic.from_buffer(input_data[:2048], mime=True) or "").lower()
            extracted_text = ""

            if "image" in file_type:
                img = Image.open(io.BytesIO(input_data))
                img = preprocess_image(img)
                extracted_text = extract_text_from_image(img)

            elif "pdf" in file_type:
                pages = convert_from_bytes(input_data, dpi=150, first_page=1, last_page=max_pages, fmt="jpeg")
                extracted_text = " ".join(extract_text_from_image(preprocess_image(p)) for p in pages)

            else:
                return {"error": f"Unsupported file type: {file_type or 'unknown'}"}

            if not extracted_text.strip():
                return {"error": "No text detected in file."}

            return analyze_text(clean_ocr_text(extracted_text), threshold)

        else:
            return {"error": "Unsupported input type. Must be string or bytes."}

    except Exception as e:
        return {"error": str(e)}


# ==============================
# Test Run
# ==============================
if __name__ == "__main__":
    sample_text = "My name is Harish Raju, I live in Lucknow, and I feel really depressed lately."
    print("\n TEXT RESULT:")
    print(detect_pii(sample_text))
