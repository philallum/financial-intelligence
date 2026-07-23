"""
Training endpoint — fetches data from Supabase, trains XGBoost, stores model.
"""

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import Optional
import time

from app.services.trainer import train_model
from app.services.model_store import ModelStore

router = APIRouter()


class TrainRequest(BaseModel):
    """Training configuration."""
    test_split: float = 0.2  # Walk-forward: last 20% as test
    min_samples: int = 200   # Minimum training samples required
    n_estimators: int = 200  # XGBoost trees
    max_depth: int = 5       # Tree depth
    learning_rate: float = 0.05


class TrainResponse(BaseModel):
    """Training result metadata."""
    status: str
    training_samples: int
    test_samples: int
    accuracy: float
    f1_weighted: float
    per_class_accuracy: dict[str, float]
    training_time_ms: int
    model_version: str
    feature_count: int


@router.post("/train", response_model=TrainResponse)
async def train(request: TrainRequest):
    """
    Train XGBoost model from historical fingerprint + outcome data.

    Uses walk-forward validation: data sorted chronologically,
    last `test_split` fraction used for validation (no data leakage).
    """
    start = time.time()

    try:
        result = await train_model(
            test_split=request.test_split,
            min_samples=request.min_samples,
            n_estimators=request.n_estimators,
            max_depth=request.max_depth,
            learning_rate=request.learning_rate,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Training failed: {str(e)}")

    elapsed_ms = int((time.time() - start) * 1000)

    return TrainResponse(
        status="trained",
        training_samples=result["training_samples"],
        test_samples=result["test_samples"],
        accuracy=result["accuracy"],
        f1_weighted=result["f1_weighted"],
        per_class_accuracy=result["per_class_accuracy"],
        training_time_ms=elapsed_ms,
        model_version=result["model_version"],
        feature_count=result["feature_count"],
    )
