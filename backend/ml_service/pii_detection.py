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
import tempfile, os, time
import torch

device = "cuda" if torch.cuda.is_available() else "cpu"

# Loading PII model
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

# PII labels to detect
LABELS = [
    "name", "date_of_birth", "age", "email", "phone_number",
    "address", "city", "state", "zip_code", "ip_address", "url",
    "account_number", "credit_card_number", "bank_name", "pan_number", "ssn",
    "passport_number", "driver_license_number", "aadhar_number", "national_id_number",
    "medical_record_number", "diagnosis", "treatment", "doctor_name",
    "organization_name", "employer_name", "occupation",
    "api_key", "access_token", "secret_key", "auth_token"
]


# Loading Mental-health classifier
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

# Mental-health labeling
MENTAL_LABEL_MAP = {
    "LABEL_0": "non_suicidal",
    "LABEL_1": "emotional_distress",
    "label_0": "non_suicidal",
    "label_1": "emotional_distress"
}


# Loading Disease-detection model
print("Loading Disease Detection model...")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DISEASE_MODEL_PATH = os.path.join(BASE_DIR, "models", "diseases_model")

# --- FIX: manually load tokenizer to avoid JSON corruption issue ---
tokenizer = RobertaTokenizerFast.from_pretrained(
    DISEASE_MODEL_PATH,
    vocab_file=os.path.join(DISEASE_MODEL_PATH, "vocab.json"),
    merges_file=os.path.join(DISEASE_MODEL_PATH, "merges.txt")
)
model = RobertaForSequenceClassification.from_pretrained(DISEASE_MODEL_PATH)

disease_detector = pipeline(
    "text-classification",
    model=model,
    tokenizer=tokenizer
)


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

# Sensitivity scores (0–1 range, where 1 = highly sensitive)
SENSITIVITY_SCORES = {
    # Personal Identifiers
    "name": 0.3,
    "surname": 0.3,
    "date_of_birth": 0.6,
    "age": 0.6,
    "email": 0.6,
    "phone_number": 0.7,
    "address": 0.8,
    "city": 0.3,
    "state": 0.2,
    "zip_code": 0.4,

    # Financial Information
    "account_number": 1.0,
    "credit_card_number": 1.0,
    "bank_name": 0.6,
    "pan_number": 1.0,

    # Government IDs
    "passport_number": 1.0,
    "driver_license_number": 0.9,
    "aadhar_number": 1.0,
    "national_id_number": 1.0,

    # Medical
    "medical_record_number": 0.9,
    "diagnosis": 0.7,
    "treatment": 0.7,
    "doctor_name": 0.6,

    # Work / Organization
    "organization_name": 0.7,
    "employer_name": 0.7,
    "occupation": 0.5,

    # Technical Keys
    "api_key": 1.0,
    "access_token": 1.0,
    "secret_key": 1.0,
    "auth_token": 1.0,

    # Mental Health / Risk
    "emotional_distress": 1.0,
    "ditected_disease": 0.6
}


# Text-analysing function
def analyze_text(text: str, threshold: float = 0.5) -> dict:

    #Gliner model
    pii_entities = gliner_model.predict_entities(text, LABELS, threshold=threshold)
    pii_results = [{
            "label": e["label"],
            "sensitivity_score": SENSITIVITY_SCORES.get(e["label"], 0.7)
        } for e in pii_entities]
    results = pii_results


    # Mental-health Detection
    sentences = [s.strip() for s in re.split(r'[.!?]', text) if s.strip()]
    for sentence in sentences:
        mhm_results_raw = mental_health_model(sentence)
        if isinstance(mhm_results_raw, list) and isinstance(mhm_results_raw[0], list):
            mhm_results_raw = mhm_results_raw[0]

        for r in mhm_results_raw:
            label = MENTAL_LABEL_MAP.get(r["label"])
            if label and r["score"] >= threshold and label == "emotional_distress":
                results.append({
                    "label": label,
                    "sensitivity_score": SENSITIVITY_SCORES.get(label, 1.0)
                })



    # Disease Detection (fine-tuned model)
    disease_result = disease_detector(text)[0]
    if disease_result["label"] == "LABEL_1":  # Only add if disease is detected
        results.append({
            "label": "detected_disease",
            "sensitivity_score": SENSITIVITY_SCORES.get("detected_disease", 0.6)
        })



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
    
    # --- TEXT TEST ---
    sample_text = "feeling sad and lonely, i want to kill myself"
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
    '''
