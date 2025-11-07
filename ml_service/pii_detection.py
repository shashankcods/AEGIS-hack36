from gliner import GLiNER

# Loading PII model
print("Loading GLiNER PII model...")
model = GLiNER.from_pretrained("nvidia/gliner-pii")

# PII labels to detect
LABELS = [
    "name", "user_name", "given_name", "surname",
    "date_of_birth", "age", "email", "phone_number",
    "address", "city", "state", "zip_code", "ip_address", "url",
    "account_number", "credit_card_number", "bank_name", "pan_number", "ssn",
    "passport_number", "driver_license_number", "aadhar_number", "national_id_number",
    "medical_record_number", "diagnosis", "treatment", "doctor_name",
    "organization_name", "employer_name", "occupation"
]

# Main function
def detect_pii(text: str, threshold: float = 0.5) -> dict:
    entities = model.predict_entities(text, LABELS, threshold=threshold)

    return [{"label": e["label"], "score": round(e["score"], 3)} for e in entities]

# Testing
if __name__ == "__main__":
    sample_text = "My name is Shabbeer and my Aadhaar number is 1234 5678 9101."
    result = detect_pii(sample_text)
    print(result)
