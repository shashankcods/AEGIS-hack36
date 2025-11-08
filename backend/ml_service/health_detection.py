from transformers import AutoTokenizer, AutoModelForSequenceClassification, pipeline

MODEL_PATH = "backend/ml_service/models/disease_model"

print("Loading Disease Detection model...")
disease_detector = pipeline("text-classification", model=MODEL_PATH, tokenizer=MODEL_PATH)

def detect_disease(text: str):
    """Run disease detection on input text."""
    result = disease_detector(text)[0]
    label = "Disease Detected" if result["label"] == "LABEL_1" else "No Disease"
    score = round(result["score"], 3)
    return {"text": text, "label": label, "score": score}
