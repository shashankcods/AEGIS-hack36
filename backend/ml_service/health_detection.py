"""Compatibility helper using the same V2 health model as the application."""

from ml_service.pii_detection import analyze_input


def detect_disease(text):
    result = analyze_input(text)
    detection = next((item for item in result["detections"]
                      if item["label"] == "health_disclosure"), None)
    return {
        "label": "HEALTH_DISCLOSURE" if detection else "NO_HEALTH_DISCLOSURE",
        "confidence": detection["confidence"] if detection else None,
        "warnings": result["warnings"],
    }
