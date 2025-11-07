from gliner import GLiNER
from transformers import pipeline

# Loading PII model
print("Loading GLiNER PII model...")
gliner_model = GLiNER.from_pretrained("nvidia/gliner-pii")

# PII labels to detect
LABELS = [
    "name", "user_name", "given_name", "surname",
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
    model="mental/mental-roberta-base",
    top_k=None
)
# Label mapping for human-readable output
LABEL_MAP = {
    "LABEL_0": "neutral",
    "LABEL_1": "mental_distress"
}


# Main function
def detect_pii(text: str, threshold: float = 0.5) -> dict:
    pii_entities = gliner_model.predict_entities(text, LABELS, threshold=threshold)
    pii_results = [{"label": e["label"], "score": round(e["score"], 3)} for e in pii_entities]

    mhm_results_raw = mental_health_model(text)
    if isinstance(mhm_results_raw, list) and isinstance(mhm_results_raw[0], list):
        mhm_results_raw = mhm_results_raw[0]

    mhm_results = []
    for r in mhm_results_raw:
        label = LABEL_MAP.get(r["label"], r["label"])
        if r["score"] >= threshold and label != "neutral":
            mhm_results.append({"label": label, "score": round(r["score"], 3)})
    
    return pii_results + mhm_results

# Testing
if __name__ == "__main__":
    sample_text = "my name is shabbeer, my aadhar number is 1234 1234 1234, i feel sad and lonely and thinking of ending myself"
    result = detect_pii(sample_text)
    print(result)
