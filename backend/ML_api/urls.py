from django.urls import path
from .views import analyze_text_endpoint

urlpatterns = [
    path('analyze/', analyze_text_endpoint, name='analyze_text'),
]
