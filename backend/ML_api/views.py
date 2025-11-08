from django.http import JsonResponse
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework import status
from ml_service.pii_detection import detect_pii
import base64

@api_view(['POST'])
def analyze_endpoint(request):
    """
    Endpoint: /api/analyze/
    Accepts:
      - text: string
      - image: file (optional)
      - image_base64: optional fallback (for base64 screenshots)
    Returns:
      - entities: [{label, score}, ...]
    """
    try:
        data = request.data
        text = data.get("text", "").strip()
        image = request.FILES.get("image", None)
        image_base64 = data.get("image_base64", None)

        # 🧠 Case 1: Plain text input
        if text:
            entities = detect_pii(text)
            return JsonResponse(entities, safe=False)

        # 🖼️ Case 2: Image upload (via <input type="file"> or extension blob)
        elif image:
            image_bytes = image.read()
            entities = detect_pii(image_bytes)
            return JsonResponse(entities, safe=False)

        # 🧩 Case 3: Base64 encoded image (used by screenshot captures)
        elif image_base64:
            try:
                # Handle data URI prefix like "data:image/png;base64,...."
                if "," in image_base64:
                    image_base64 = image_base64.split(",", 1)[1]
                image_bytes = base64.b64decode(image_base64)
                entities = detect_pii(image_bytes)
                return JsonResponse(entities, safe=False)
            except Exception as e:
                return Response({"error": f"Invalid base64 image: {e}"}, status=status.HTTP_400_BAD_REQUEST)

        # 🚫 Case 4: Empty request
        else:
            return Response({"error": "No text or image provided."}, status=status.HTTP_400_BAD_REQUEST)

    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
