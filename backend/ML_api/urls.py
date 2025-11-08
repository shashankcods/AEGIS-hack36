# ML_api/urls.py
from django.urls import path
from . import views

urlpatterns = [
    # --- Core ML APIs ---
    path("analyze/", views.analyze_endpoint, name="analyze"),
    path("get_results/", views.get_results, name="get_results"),

    # --- Pathway + Redis Analytics APIs ---
    path("score/", views.submit_score, name="submit_score"),
    path("stats/", views.get_all_stats, name="get_all_stats"),
]
