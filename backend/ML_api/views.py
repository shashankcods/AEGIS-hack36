from django.http import JsonResponse
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework import status
from ml_service.pii_detection import detect_pii

@api_view(['POST'])
def analyze_endpoint(request):
    """
    Endpoint: /api/analyze/
    Accepts:
      - text: string
      - image: file (optional)
    Returns:
      - entities: [{label, score}, ...]
    """
    try:
        data = request.data
        text = data.get("text", "").strip()
        image = request.FILES.get("image", None)

        # Case 1: Text-based analysis
        if text:
            entities = detect_pii(text)
            return JsonResponse(entities, safe=False)


        # Case 2: Image-based analysis (optional future use)
        elif image:
            # optional: hook your OCR model here later
            return Response({"type": "image", "message": "Image analysis not yet implemented"}, status=status.HTTP_200_OK)

        else:
            return Response({"error": "No text or image provided."}, status=status.HTTP_400_BAD_REQUEST)

    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
