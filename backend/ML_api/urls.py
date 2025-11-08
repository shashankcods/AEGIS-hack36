from django.urls import path
<<<<<<< HEAD
from .views import analyze_endpoint

urlpatterns = [
    path("analyze/", analyze_endpoint, name="analyze"),
=======
from .views import analyze_text_endpoint

urlpatterns = [
    path('analyze/', analyze_text_endpoint, name='analyze_text'),
>>>>>>> feature/9-frontend-ml-endpoint
]
