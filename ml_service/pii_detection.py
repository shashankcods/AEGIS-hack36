from gliner import GLiNER
from transformers import pipeline
import re


# Loading PII model
print("Loading GLiNER PII model...")
gliner_model = GLiNER.from_pretrained("nvidia/gliner-pii")

# PII labels to detect
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


# Loading Mental-health classifier
print("Loading Mental-health classifier...")
mental_health_model = pipeline(
    "text-classification",
    model="Akashpaul123/bert-suicide-detection",
    tokenizer="Akashpaul123/bert-suicide-detection",
    top_k=None
)

# Mental-health labeling
MENTAL_LABEL_MAP = {
    "LABEL_0": "non_suicidal",
    "LABEL_1": "suicidal",
    "label_0": "non_suicidal",
    "label_1": "suicidal"
}


# Main function
def detect_pii(text: str, threshold: float = 0.5) -> dict:
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
            if label and r["score"] >= threshold and label == "suicidal":
                results.append({"label": label, "score": round(r["score"], 3)})


    return results

# Testing
if __name__ == "__main__":
    sample_text = "feeling very sad and lonely, feeling to end myself"
    result = detect_pii(sample_text)
    print(result)