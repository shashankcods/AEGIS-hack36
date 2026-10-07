"""The shared, JSON-safe result format used by inference, APIs and workers."""

import math
import time
from collections.abc import Mapping
from numbers import Real

LOW_THRESHOLD = 0.5
HIGH_THRESHOLD = 0.8


def _score(value, name):
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(f"{name} must be a number between 0 and 1")
    try:
        value = float(value)
    except (OverflowError, TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be finite and between 0 and 1") from exc
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError(f"{name} must be finite and between 0 and 1")
    return value


def normalize_detection(item):
    """Validate a detection; accept the old ``score`` field on queued jobs."""
    if not isinstance(item, Mapping) or "error" in item:
        raise ValueError("A detection must be an object containing a label and score")
    label = item.get("label")
    if not isinstance(label, str) or not label.strip():
        raise ValueError("A detection label must be a nonempty string")
    field = "sensitivity_score" if "sensitivity_score" in item else "score"
    if field not in item:
        raise ValueError("A detection requires sensitivity_score")
    normalized = {"label": label.strip(), "sensitivity_score": _score(item[field], field)}
    if "confidence" in item:
        normalized["confidence"] = _score(item["confidence"], "confidence")
    return normalized


def severity_for_score(score):
    score = _score(score, "score")
    return "high" if score > HIGH_THRESHOLD else "medium" if score > LOW_THRESHOLD else "low"


def summarize_detections(detections):
    """Average category sensitivity, retaining each label once in display order."""
    if not isinstance(detections, list):
        raise ValueError("Detection results must be a list")
    normalized = [normalize_detection(item) for item in detections]
    average = sum(item["sensitivity_score"] for item in normalized) / len(normalized) if normalized else 0.0
    return {
        "labels": list(dict.fromkeys(item["label"] for item in normalized)),
        "avg_score": average,
        "severity": severity_for_score(average),
        "timestamp": time.time(),
    }
