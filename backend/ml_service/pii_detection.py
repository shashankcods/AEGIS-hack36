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


# Loading PII model
print("Loading GLiNER PII model...")
# Local model path
LOCAL_MODEL_PATH = os.path.join(os.path.dirname(__file__), "gliner-pii")

# Device setup
device = "cuda" if torch.cuda.is_available() else "cpu"

# Try local load first, fallback to cloud
try:
    if os.path.exists(LOCAL_MODEL_PATH) and os.path.isdir(LOCAL_MODEL_PATH):
        print(f"Attempting to load local GLiNER model from: {LOCAL_MODEL_PATH}")
        gliner_model = GLiNER.from_pretrained(LOCAL_MODEL_PATH, local_files_only=True).to(device)
        print("✅ Local GLiNER model loaded successfully.")
    else:
        raise FileNotFoundError
except Exception as e:
    print(f"⚠️ Local model not found or failed ({e}). Falling back to cloud.")
    gliner_model = GLiNER.from_pretrained("nvidia/gliner-pii").to(device)
    print("☁️ Cloud model loaded successfully.")

# PII labels to detect
LABELS = [
    "name", "surname",
    "date_of_birth", "age", "email", "phone_number",
    "address", "city", "state", "zip_code", "ip_address", "url",
    "account_number", "credit_card_number", "bank_name", "pan_number", "ssn",
    "passport_number", "driver_license_number", "aadhar_number", "national_id_number",
    "medical_record_number", "diagnosis", "treatment", "doctor_name",
    "organization_name", "employer_name", "occupation",
    "api_key", "access_token", "secret_key", "auth_token"
]


# Loading Mental-health classifier
print("Loading Mental-health classifier...")
# Define path for local copy
MENTAL_MODEL_PATH = os.path.join(os.path.dirname(__file__), "mental-health-model")

try:
    if os.path.exists(MENTAL_MODEL_PATH) and os.path.isdir(MENTAL_MODEL_PATH):
        print(f"Attempting to load local Mental-health model from: {MENTAL_MODEL_PATH}")
        mental_health_model = pipeline(
            "text-classification",
            model=MENTAL_MODEL_PATH,
            tokenizer=MENTAL_MODEL_PATH,
            top_k=None
        )
        print("✅ Local Mental-health classifier loaded successfully.")
    else:
        raise FileNotFoundError("Local model path not found.")
except Exception as e:
    print(f"⚠️ Local model not found or failed ({e}). Falling back to cloud.")
    mental_health_model = pipeline(
        "text-classification",
        model="Akashpaul123/bert-suicide-detection",
        tokenizer="Akashpaul123/bert-suicide-detection",
        top_k=None
    )
    print("☁️ Cloud Mental-health classifier loaded successfully.")

# Mental-health labeling
MENTAL_LABEL_MAP = {
    "LABEL_0": "non_emotional_distress",
    "LABEL_1": "emotional_distress",
    "label_0": "non_emotional_distress",
    "label_1": "emotional_distress"
}


# Initializing PaddleOCR for image-text
print("Initializing PaddleOCR...")
ocr = PaddleOCR(use_textline_orientation=True, lang='en')


# Helper Functions for processing of images
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

# Text-analysing function
def analyze_text(text: str, threshold: float = 0.5) -> dict:
    pii_entities = gliner_model.predict_entities(text, LABELS, threshold=threshold)
    pii_results = [{"label": e["label"], "score": round(e["score"], 3)} for e in pii_entities]
    results = pii_results

    sentences = [s.strip() for s in re.split(r'[.!?]', text) if s.strip()]
    for sentence in sentences:
        mhm_results_raw = mental_health_model(sentence)
        if isinstance(mhm_results_raw, list) and isinstance(mhm_results_raw[0], list):
            mhm_results_raw = mhm_results_raw[0]

        for r in mhm_results_raw:
            label = MENTAL_LABEL_MAP.get(r["label"])
            if label and r["score"] >= threshold and label == "emotional_distress":
                results.append({"label": label, "score": round(r["score"], 3)})


    return results

# Main function
def detect_pii(input_data, threshold: float = 0.5, max_pages: int = 2):
    try:
        # Case 1: Plain Text
        if isinstance(input_data, str):
            cleaned_text = clean_ocr_text(input_data)
            analysis = analyze_text(cleaned_text, threshold)
            return analysis

        # Case 2: File Bytes (image/pdf)
        elif isinstance(input_data, (bytes, bytearray)):
            file_type = (magic.from_buffer(input_data[:2048], mime=True) or "").lower()
            extracted_text = ""

            if "image" in file_type:
                img = Image.open(io.BytesIO(input_data))
                img = preprocess_image(img)
                extracted_text = extract_text_from_image(img)

            elif "pdf" in file_type:
                with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
                    tmp.write(input_data)
                    tmp_path = tmp.name

                pages = convert_from_bytes(input_data, dpi=150, first_page=1, last_page=max_pages, fmt="jpeg")
                page_texts = []
                for page in pages:
                    processed = preprocess_image(page)
                    page_texts.append(extract_text_from_image(processed))
                extracted_text = " ".join(page_texts)

                try:
                    os.remove(tmp_path)
                except Exception:
                    pass

            else:
                return {"error": f"Unsupported file type: {file_type or 'unknown'}"}

            if not extracted_text.strip():
                return {"error": "No text detected in file."}

            cleaned_text = clean_ocr_text(extracted_text)
            analysis = analyze_text(cleaned_text, threshold)

            return analysis

        else:
            return {"error": "Unsupported input type. Must be string or bytes."}

    except Exception as e:
        return {"error": str(e)}



# Testing
if __name__ == "__main__":
    '''
    # --- TEXT TEST ---
    sample_text = "feeling very sad and lonely, feeling to end myself"
    text_result = detect_pii(sample_text)
    print("\n TEXT RESULT:")
    print(text_result)
    '''

    # --- IMAGE TEST ---
    image_path = "id_card.pdf"
    with open(image_path, "rb") as f:
        file_bytes = f.read()

    image_result = detect_pii(file_bytes)
    print("\n IMAGE RESULT:")
    print(image_result)
