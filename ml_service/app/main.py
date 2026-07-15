"""
Financial Intelligence Platform — ML Service

FastAPI application providing XGBoost-based directional probability predictions.
Called by the batch pipeline via HTTP during each 4H cycle.

Endpoints:
  POST /predict       — Predict direction probabilities from feature vector
  POST /train         — Train/retrain model from historical data
  GET  /health        — Health check with model status
  GET  /model-status  — Current model metadata
"""

from fastapi import FastAPI
from contextlib import asynccontextmanager

from app.routers import predict, train, health, calibration, explainability, drift
from app.services.model_store import ModelStore
from app.services.calibration import CalibrationService


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model on startup if available."""
    store = ModelStore.get_instance()
    store.load_if_available()
    cal_service = CalibrationService.get_instance()
    cal_service.load_if_available()
    yield


app = FastAPI(
    title="FIP ML Service",
    description="XGBoost classification for EUR/USD 4H directional prediction",
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(health.router)
app.include_router(predict.router)
app.include_router(train.router)
app.include_router(calibration.router)
app.include_router(explainability.router)
app.include_router(drift.router)
