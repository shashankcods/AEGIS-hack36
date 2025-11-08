from django.urls import path
from .views import analyze_endpoint

urlpatterns = [
    path("analyze/", analyze_endpoint, name="analyze"),
]
