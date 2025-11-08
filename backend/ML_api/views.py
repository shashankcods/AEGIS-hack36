# ML_api/views.py

from django.http import JsonResponse
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework import status
from ml_service.pii_detection import detect_pii
from ml_service.redis_client import push_to_queue, fetch_processed_result
import base64
import json, redis
from django.conf import settings
from django.views.decorators.csrf import csrf_exempt


# ------------------------------------
# 🔹 REDIS CONNECTION SETUP (shared)
# ------------------------------------
try:
    rd = redis.Redis(
        host=getattr(settings, "REDIS_HOST", "localhost"),
        port=getattr(settings, "REDIS_PORT", 6379),
        db=getattr(settings, "REDIS_DB", 0),
        decode_responses=True
    )
    rd.ping()
    print("[AEGIS Backend] ✅ Connected to Redis successfully.")
except Exception as e:
    print(f"[AEGIS Backend] ⚠️ Redis connection failed: {e}")
    rd = None


# Keys for different systems
SCORE_STREAM_KEY = "scores_stream"      # For Pathway analytics
RESULT_QUEUE_KEY = "aegis:results"      # For consumer.py engine
STATS_BY_LABEL_KEY = "stats_by_label"   # Analytics summary cache

GLOBAL_KEYS = [
    "current_average",
    "highest_score",
    "lowest_score",
    "total_scores",
    "unique_label_count",
    "percent_high_score",
    "count_low",
    "count_medium",
    "count_high",
]


# ------------------------------------
# 🔹 1. TEXT / IMAGE ANALYZE ENDPOINT
# ------------------------------------
@api_view(['POST'])
def analyze_endpoint(request):
    """
    Endpoint: /api/analyze/
    Accepts:
      - text: string
      - image: file (optional)
      - image_base64: optional fallback
    Returns:
      - {"status": "queued", "session_id": "...", "pathway_pushed": <n>}
    """

    if not rd:
        return Response(
            {"error": "Redis not connected"},
            status=status.HTTP_503_SERVICE_UNAVAILABLE
        )

    try:
        data = request.data
        text = data.get("text", "").strip()
        image = request.FILES.get("image", None)
        image_base64 = data.get("image_base64", None)
        result = None

        # 🧠 Case 1: Text
        if text:
            result = detect_pii(text)

        # 🖼️ Case 2: Uploaded image
        elif image:
            image_bytes = image.read()
            result = detect_pii(image_bytes)

        # 🧩 Case 3: Base64-encoded screenshot
        elif image_base64:
            try:
                if "," in image_base64:
                    image_base64 = image_base64.split(",", 1)[1]
                image_bytes = base64.b64decode(image_base64)
                result = detect_pii(image_bytes)
            except Exception as e:
                return Response(
                    {"error": f"Invalid base64 image: {e}"},
                    status=status.HTTP_400_BAD_REQUEST
                )

        # 🚫 Case 4: No input
        else:
            return Response(
                {"error": "No text or image provided."},
                status=status.HTTP_400_BAD_REQUEST
            )

        # 🧾 Queue to Consumer
        session_id = push_to_queue(result)

        # 🚀 Push each detection to Pathway stream
        pathway_push_count = 0
        if isinstance(result, list):
            for item in result:
                if isinstance(item, dict) and "label" in item and "score" in item:
                    rd.rpush(SCORE_STREAM_KEY, json.dumps(item))
                    pathway_push_count += 1

        return JsonResponse({
            "status": "queued",
            "session_id": session_id,
            "pathway_pushed": pathway_push_count,
            "detections": result
        }, status=200)

    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ------------------------------------
# 🔹 2. GET RESULT ENDPOINT (Consumer)
# ------------------------------------
@api_view(['GET'])
def get_results(request):
    session_id = request.GET.get("session_id")

    if not session_id:
        return Response(
            {"error": "Missing session_id"},
            status=status.HTTP_400_BAD_REQUEST
        )

    try:
        data = fetch_processed_result(session_id)

        if not data:
            return Response({"status": "pending"}, status=status.HTTP_202_ACCEPTED)

        return Response({
            "status": "done",
            "session_id": session_id,
            "data": data
        }, status=status.HTTP_200_OK)

    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ------------------------------------
# 🔹 3. PATHWAY ANALYTICS ENDPOINTS
# ------------------------------------
@csrf_exempt
def submit_score(request):
    """ POST /api/score/  → manually push data for testing """
    if request.method != "POST":
        return JsonResponse({"error": "Only POST allowed"}, status=405)
    if not rd:
        return JsonResponse({"error": "Redis not connected"}, status=503)

    try:
        data = json.loads(request.body)
        if "label" not in data or "score" not in data:
            return JsonResponse({"error": "Missing 'label' or 'score'"}, status=400)

        rd.rpush(SCORE_STREAM_KEY, json.dumps({
            "label": str(data["label"]),
            "score": float(data["score"])
        }))

        return JsonResponse({"status": "queued", "data": data}, status=202)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)


def get_all_stats(request):
    """ GET /api/stats/ → returns all Redis-stored analytics """
    if request.method != "GET":
        return JsonResponse({"error": "Only GET allowed"}, status=405)
    if not rd:
        return JsonResponse({"error": "Redis not connected"}, status=503)

    try:
        global_values = rd.mget(GLOBAL_KEYS)
        global_data = dict(zip(GLOBAL_KEYS, global_values))
        stats_by_label_raw = rd.get(STATS_BY_LABEL_KEY)
        stats_by_label = json.loads(stats_by_label_raw) if stats_by_label_raw else {}

        def to_num(val, num_type=float):
            try:
                return num_type(val) if val is not None else 0
            except:
                return 0

        response_data = {
            "current_average": to_num(global_data.get("current_average")),
            "highest_score": to_num(global_data.get("highest_score")),
            "lowest_score": to_num(global_data.get("lowest_score")),
            "total_scores": to_num(global_data.get("total_scores"), int),
            "unique_label_count": to_num(global_data.get("unique_label_count"), int),
            "percent_high_score": to_num(global_data.get("percent_high_score")),
            "distribution": {
                "low": to_num(global_data.get("count_low"), int),
                "medium": to_num(global_data.get("count_medium"), int),
                "high": to_num(global_data.get("count_high"), int),
            },
            "stats_by_label": stats_by_label
        }

        return JsonResponse(response_data, status=200)
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=500)
