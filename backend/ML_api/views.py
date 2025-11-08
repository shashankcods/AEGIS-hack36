from django.http import JsonResponse
from rest_framework.decorators import api_view
from ml_service.pii_detection import detect_pii

@api_view(["POST"])
def analyze_text_endpoint(request):
    text = request.data.get("text", "")
    if not text:
        return JsonResponse({"error": "No text provided"}, status=400)

    # Call the ML model
    entities = detect_pii(text)
    return JsonResponse({"entities": entities}, status=200)
