"""
Prediction endpoint — takes a feature vector and returns direction probabilities.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import numpy as np

from app.services.model_store import ModelStore

router = APIRouter()


class PredictRequest(BaseModel):
    """Feature vector for prediction."""
    # Core state layer features (extracted from fingerprint)
    market_structure: list[float]   # 16 dims (L1)
    volatility_profile: list[float] # 12 dims (L2)
    macro_context: list[float]      # 8 dims (L4)
    sentiment_pressure: list[float] # 6 dims (L5)

    # Session features
    session_london: float  # 0 or 1
    session_ny: float      # 0 or 1
    session_asia: float    # 0 or 1

    # Volatility regime
    volatility_regime_high: float  # 0 or 1
    volatility_regime_low: float   # 0 or 1

    # Extended features (optional)
    rolling_trend: Optional[float] = None
    atr_percentile: Optional[float] = None
    volatility_regime_score: Optional[float] = None


class PredictResponse(BaseModel):
    """Direction probabilities from XGBoost."""
    up: float
    down: float
    flat: float
    model_version: str
    feature_count: int


@router.post("/predict", response_model=PredictResponse)
async def predict(request: PredictRequest):
    store = ModelStore.get_instance()

    if not store.is_loaded():
        raise HTTPException(
            status_code=503,
            detail="No model loaded. Call POST /train first.",
        )

    # Assemble feature vector in the same order as training
    features = _build_feature_vector(request)

    # Predict probabilities
    probs = store.predict(features)

    return PredictResponse(
        up=round(float(probs[0]), 6),
        down=round(float(probs[1]), 6),
        flat=round(float(probs[2]), 6),
        model_version=store.get_version() or "unknown",
        feature_count=len(features),
    )


def _build_feature_vector(request: PredictRequest) -> np.ndarray:
    """
    Assemble the feature vector from the request.
    Order must match the training feature order exactly.

    Features (45 total):
    - L1 market_structure: 16 dims → compressed to 4 (mean, std, min, max)
    - L2 volatility_profile: 12 dims → compressed to 4
    - L4 macro_context: 8 dims (all)
    - L5 sentiment_pressure: 6 dims (all)
    - Session one-hot: 3 features
    - Volatility regime one-hot: 2 features
    - Extended: 3 features (rolling_trend, atr_percentile, vol_regime_score)

    Total: 4 + 4 + 8 + 6 + 3 + 2 + 3 = 30 features
    """
    features = []

    # L1 compressed: mean, std, min, max
    l1 = np.array(request.market_structure)
    features.extend([float(l1.mean()), float(l1.std()), float(l1.min()), float(l1.max())])

    # L2 compressed: mean, std, min, max
    l2 = np.array(request.volatility_profile)
    features.extend([float(l2.mean()), float(l2.std()), float(l2.min()), float(l2.max())])

    # L4 macro_context: all 8 dimensions
    features.extend(request.macro_context)

    # L5 sentiment_pressure: all 6 dimensions
    features.extend(request.sentiment_pressure)

    # Session one-hot
    features.extend([
        request.session_london,
        request.session_ny,
        request.session_asia,
    ])

    # Volatility regime
    features.extend([
        request.volatility_regime_high,
        request.volatility_regime_low,
    ])

    # Extended features (use 0.5 neutral for missing)
    features.extend([
        request.rolling_trend if request.rolling_trend is not None else 0.5,
        request.atr_percentile if request.atr_percentile is not None else 0.5,
        request.volatility_regime_score if request.volatility_regime_score is not None else 0.5,
    ])

    return np.array(features, dtype=np.float32)
