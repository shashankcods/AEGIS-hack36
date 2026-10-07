"""Synchronous detections with optional Redis analytics and processing."""

import base64
import binascii
import json
import math
import uuid

from django.conf import settings
from django.core.exceptions import RequestDataTooBig, TooManyFilesSent
from rest_framework.decorators import api_view
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.response import Response
from redis.exceptions import RedisError

from ml_service.contracts import normalize_detection
from ml_service.pii_detection import AnalysisError, analyze_input, get_model_status
from ml_service.redis_client import (
    fetch_processed_result,
    get_redis_client,
    push_to_queue,
)

SCORE_STREAM_KEY = "scores_stream"
STATS_BY_LABEL_KEY = "stats_by_label"
ANALYTICS_SNAPSHOT_KEY = "aegis:analytics:snapshot"
WORKER_KEYS = ["aegis:worker:consumer", "aegis:worker:analytics"]
GLOBAL_KEYS = [
    "current_average", "highest_score", "lowest_score", "total_scores",
    "unique_label_count", "percent_high_score", "count_low", "count_medium",
    "count_high",
]


def _request_limit():
    return getattr(settings, "AEGIS_MAX_INPUT_BYTES", 8 * 1024 * 1024)


def _number(value, name):
    if isinstance(value, bool):
        raise ValueError("{} must be a number between 0 and 1.".format(name))
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError("{} must be a number between 0 and 1.".format(name))
    if not math.isfinite(number) or not 0 <= number <= 1:
        raise ValueError("{} must be a finite number between 0 and 1.".format(name))
    return number


def _inputs(request):
    """Validate every input before invoking any model."""
    limit = _request_limit()
    try:
        content_length = int(request.META.get("CONTENT_LENGTH") or 0)
    except (TypeError, ValueError):
        raise AnalysisError("Invalid request length.", status_code=400)
    if content_length > limit:
        raise AnalysisError("Request exceeds the 8 MB input limit.", status_code=413)

    data = request.data
    if not hasattr(data, "get"):
        raise AnalysisError("Request must contain an object of input fields.", status_code=400)
    text = data.get("text", "")
    if not isinstance(text, str):
        raise AnalysisError("text must be a string.", status_code=400)
    text = text.strip()
    inputs = [text] if text else []
    total = len(text.encode("utf-8"))
    if total > limit:
        raise AnalysisError("Inputs exceed the 8 MB input limit.", status_code=413)

    for _, files in request.FILES.lists():
        for uploaded in files:
            if uploaded.size <= 0:
                raise AnalysisError("Uploaded files must not be empty.", status_code=400)
            total += uploaded.size
            if total > limit:
                raise AnalysisError("Inputs exceed the 8 MB input limit.", status_code=413)
            content = uploaded.read(limit + 1)
            if len(content) != uploaded.size or len(content) > limit:
                raise AnalysisError("Unable to read the complete uploaded file.", status_code=400)
            inputs.append(content)

    encoded = data.get("image_base64")
    if encoded is not None:
        if not isinstance(encoded, str):
            raise AnalysisError("image_base64 must be a base64 string.", status_code=400)
        if encoded:
            if encoded.startswith("data:"):
                header, separator, encoded = encoded.partition(",")
                if not separator or not header.endswith(";base64"):
                    raise AnalysisError("Invalid base64 image data URL.", status_code=400)
            if len(encoded) > ((limit + 2) // 3) * 4:
                raise AnalysisError("Inputs exceed the 8 MB input limit.", status_code=413)
            try:
                content = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError):
                raise AnalysisError("Invalid base64 image.", status_code=400)
            if not content:
                raise AnalysisError("Base64 image must not be empty.", status_code=400)
            total += len(content)
            if total > limit:
                raise AnalysisError("Inputs exceed the 8 MB input limit.", status_code=413)
            inputs.append(content)

    if not inputs:
        raise AnalysisError("Provide text or at least one image or PDF.", status_code=400)
    try:
        threshold = _number(data.get("threshold", 0.5), "threshold")
    except ValueError as exc:
        raise AnalysisError(str(exc), status_code=400)
    return inputs, threshold


def _merge_detections(results):
    by_label = {}
    for result in results:
        detections = result.get("detections")
        if not isinstance(detections, list):
            raise ValueError("Invalid model response.")
        for item in detections:
            current = normalize_detection(item)
            label = current["label"]
            previous = by_label.get(label)
            if previous is None:
                by_label[label] = current
            else:
                previous["sensitivity_score"] = max(
                    previous["sensitivity_score"], current["sensitivity_score"]
                )
                if "confidence" in current:
                    previous["confidence"] = max(
                        previous.get("confidence", 0), current["confidence"]
                    )
    return list(by_label.values())


@api_view(["POST"])
def analyze_endpoint(request):
    try:
        inputs, threshold = _inputs(request)
        results = [analyze_input(content, threshold=threshold) for content in inputs]
        detections = _merge_detections(results)
        for result in results:
            states = result.get("models")
            if not isinstance(states, dict) or any(
                states.get(name, {}).get("status") != "ready"
                for name in ("health", "self_harm")
            ):
                raise AnalysisError("Disclosure models are unavailable.", status_code=503)
        warnings = list(dict.fromkeys(
            warning for result in results for warning in result.get("warnings", [])
        ))
        models = {}
        state_priority = {"not_loaded": 0, "ready": 1, "unavailable": 2}
        for result in results:
            for component, state in result.get("models", {}).items():
                if component not in models or state_priority.get(state.get("status"), -1) > state_priority.get(
                    models[component].get("status"), -1
                ):
                    models[component] = state
        required_components = {"health", "self_harm", "pii"}
        if any(isinstance(content, bytes) for content in inputs):
            required_components.add("ocr")
        analysis_complete = not warnings and all(
            models.get(name, {}).get("status") == "ready"
            for name in required_components
        )
    except RequestDataTooBig:
        return Response({"error": "Request exceeds the 8 MB input limit."}, status=413)
    except TooManyFilesSent:
        return Response({"error": "Too many uploaded files. Upload at most 10 files per request.",
                         "analysis_complete": False}, status=400)
    except (ParseError, UnsupportedMediaType) as exc:
        return Response({"error": "Invalid request format."}, status=exc.status_code)
    except AnalysisError as exc:
        return Response({"error": str(exc), "analysis_complete": False}, status=exc.status_code)
    except Exception:
        # Model failures must not become empty results or expose submitted text.
        return Response(
            {"error": "Analysis failed. Please retry or check backend readiness.",
             "analysis_complete": False},
            status=503,
        )

    session_id = None
    queue_succeeded = False
    pathway_push_count = 0
    try:
        session_id = push_to_queue(detections)
        queue_succeeded = True
    except (RedisError, OSError, ValueError):
        warnings.append("Detections are available, but background processing could not be queued.")

    if detections:
        try:
            analytics = [json.dumps({
                "label": item["label"], "score": item["sensitivity_score"],
                **({"confidence": item["confidence"]} if "confidence" in item else {}),
            }, allow_nan=False) for item in detections]
            get_redis_client().rpush(SCORE_STREAM_KEY, *analytics)
            pathway_push_count = len(analytics)
        except (RedisError, OSError, ValueError):
            warnings.append("Detections are available, but analytics could not be updated.")

    return Response({
        "status": "queued" if queue_succeeded else "completed",
        "session_id": session_id,
        "pathway_pushed": pathway_push_count,
        "detections": detections,
        "warnings": list(dict.fromkeys(warnings)),
        "models": models,
        "analysis_complete": analysis_complete,
    })


@api_view(["GET"])
def get_results(request):
    session_id = request.GET.get("session_id")
    try:
        session_id = str(uuid.UUID(session_id))
    except (TypeError, ValueError, AttributeError):
        return Response({"error": "Provide a valid session_id."}, status=400)
    try:
        data = fetch_processed_result(session_id)
    except (RedisError, OSError, ValueError):
        return Response({"error": "Background processing is unavailable."}, status=503)
    if data is None:
        return Response({"status": "pending"}, status=202)
    if not isinstance(data, dict) or data.get("status") == "error" or "error" in data:
        return Response({"status": "error", "error": "Background processing failed."}, status=503)
    return Response({"status": "done", "session_id": session_id, "data": data})


@api_view(["POST"])
def submit_score(request):
    data = request.data
    if not isinstance(data, dict) or "label" not in data or "score" not in data:
        return Response({"error": "Provide label and score."}, status=400)
    try:
        item = normalize_detection({"label": data["label"], "score": data["score"],
                                   **({"confidence": data["confidence"]} if "confidence" in data else {})})
    except ValueError:
        return Response({"error": "label must be nonempty and score/confidence must be finite numbers from 0 to 1."}, status=400)
    payload = {"label": item["label"], "score": item["sensitivity_score"],
               **({"confidence": item["confidence"]} if "confidence" in item else {})}
    try:
        get_redis_client().rpush(SCORE_STREAM_KEY, json.dumps(payload, allow_nan=False))
    except (RedisError, OSError, ValueError):
        return Response({"error": "Analytics service is unavailable."}, status=503)
    return Response({"status": "queued", "data": payload}, status=202)


def _stat_number(value, integer=False, upper=None):
    if value is None:
        return 0
    if isinstance(value, bool):
        raise ValueError("Invalid analytics value.")
    number = float(value)
    if not math.isfinite(number) or number < 0 or (upper is not None and number > upper):
        raise ValueError("Invalid analytics value.")
    if integer and not number.is_integer():
        raise ValueError("Invalid analytics count.")
    return int(number) if integer else number


def _normalize_stats(data):
    if not isinstance(data, dict):
        raise ValueError("Invalid analytics snapshot.")
    response = {
        key: _stat_number(data[key], integer=key in ("total_scores", "unique_label_count"),
                          upper=1 if key in ("current_average", "highest_score", "lowest_score")
                          else 100 if key == "percent_high_score" else None)
        for key in GLOBAL_KEYS[:6]
    }
    distribution = data["distribution"]
    response["distribution"] = {
        name: _stat_number(distribution[name], integer=True)
        for name in ("low", "medium", "high")
    }
    stats_by_label = data["stats_by_label"]
    if not isinstance(stats_by_label, dict):
        raise ValueError("Invalid per-label analytics.")
    for label, row in stats_by_label.items():
        if not isinstance(label, str) or not isinstance(row, dict):
            raise ValueError("Invalid per-label analytics.")
        for name in ("average_score", "avg_score", "highest_score", "lowest_score", "total_scores", "count"):
            if name in row:
                is_count = name in ("total_scores", "count")
                row[name] = _stat_number(row[name], integer=is_count, upper=None if is_count else 1)
    response["stats_by_label"] = stats_by_label
    response["score_scale"] = "0..1"
    return response


@api_view(["GET"])
def get_all_stats(request):
    try:
        client = get_redis_client()
        raw_snapshot = client.get(ANALYTICS_SNAPSHOT_KEY)
        if raw_snapshot:
            data = json.loads(raw_snapshot)
        else:
            # Compatibility for already-running older analytics workers.
            global_data = dict(zip(GLOBAL_KEYS, client.mget(GLOBAL_KEYS)))
            raw_labels = client.get(STATS_BY_LABEL_KEY)
            data = {key: global_data[key] for key in GLOBAL_KEYS[:6]}
            data["distribution"] = {
                name: global_data["count_" + name] for name in ("low", "medium", "high")
            }
            data["stats_by_label"] = json.loads(raw_labels) if raw_labels else {}
        return Response(_normalize_stats(data))
    except (RedisError, OSError, ValueError, TypeError, KeyError):
        return Response({"error": "Analytics service is unavailable or contains invalid results."}, status=503)


@api_view(["GET"])
def health_endpoint(request):
    include_ocr = request.GET.get("ocr") == "1"
    try:
        models = get_model_status(
            load=request.GET.get("load") == "1",
            include_ocr=include_ocr,
        )
    except Exception:
        return Response({"status": "unavailable", "error": "Model readiness check failed."}, status=503)
    try:
        client = get_redis_client()
        client.ping()
        consumer_heartbeat, analytics_heartbeat = client.mget(WORKER_KEYS)
        redis_status = "ready"
        consumer_ready = bool(consumer_heartbeat)
        analytics_ready = bool(analytics_heartbeat)
    except (RedisError, OSError, ValueError):
        redis_status = "unavailable"
        consumer_ready = analytics_ready = False
    unavailable = any(state.get("status") == "unavailable"
                      for name, state in models.items() if name != "ocr" or include_ocr)
    text_ready = bool(models) and all(
        state.get("status") == "ready"
        for name, state in models.items() if name != "ocr"
    )
    return Response({
        "status": "unavailable" if unavailable else ("ready" if text_ready else "not_loaded"),
        "text_analysis_ready": text_ready,
        "models": models,
        "redis": {"status": redis_status},
        "workers": {
            "consumer": {"status": "ready" if consumer_ready else "unavailable"},
            "analytics": {"status": "ready" if analytics_ready else "unavailable"},
        },
        "background_processing_ready": consumer_ready,
        "analytics_ready": analytics_ready,
    }, status=503 if unavailable else 200)
