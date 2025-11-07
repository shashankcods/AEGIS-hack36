# core/urls.py
from django.contrib import admin
from django.urls import path
from django.http import JsonResponse

# --- simple inline view for now ---
def home(request):
    return JsonResponse({"message": "Welcome to Aegis Backend API 👋", "status": "OK"})

urlpatterns = [
    path("", home, name="home"),         
    path("admin/", admin.site.urls),
]
