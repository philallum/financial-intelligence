"""Health check endpoint."""

from fastapi import APIRouter
from app.services.model_store import ModelStore

router = APIRouter()


@router.get("/health")
async def health():
    store = ModelStore.get_instance()
    return {
        "status": "healthy",
        "model_loaded": store.is_loaded(),
        "model_version": store.get_version(),
    }


@router.get("/model-status")
async def model_status():
    store = ModelStore.get_instance()
    return {
        "loaded": store.is_loaded(),
        "version": store.get_version(),
        "feature_count": store.get_feature_count(),
        "training_samples": store.get_training_samples(),
        "accuracy": store.get_accuracy(),
    }
