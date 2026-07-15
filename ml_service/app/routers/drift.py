"""
Drift detection endpoint — triggers drift check across all regimes and
returns per-regime metrics, overall status, and retraining outcome.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.services.drift_detector import DriftDetector

router = APIRouter()


# --- Response Models ---


class RegimeStatus(BaseModel):
    """Per-regime drift detection metrics."""

    rolling_accuracy: float
    baseline_accuracy: float
    sigma: float
    drift: bool
    deviation_sigmas: Optional[float] = None


class RetrainOutcome(BaseModel):
    """Outcome of an automatic retrain triggered by drift."""

    status: str
    accuracy: Optional[float] = None
    model_version: Optional[str] = None
    training_samples: Optional[int] = None
    error: Optional[str] = None
    detail: Optional[str] = None


class DriftCheckResponse(BaseModel):
    """Response for POST /drift-check."""

    status: str  # "healthy" or "drift_detected"
    regimes: dict[str, RegimeStatus]
    retrain_triggered: bool
    retrain_outcome: Optional[RetrainOutcome] = None


# --- Endpoints ---


@router.post("/drift-check", response_model=DriftCheckResponse, tags=["drift"])
async def drift_check():
    """
    Execute drift detection for all regimes.

    Computes rolling 30-forecast accuracy per regime, compares against
    baseline statistics, and flags drift when performance degrades beyond
    2 standard deviations. Automatically triggers retraining if drift is
    detected.
    """
    try:
        detector = DriftDetector.get_instance()
        result = await detector.check_all_regimes()
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Drift check failed: {str(e)}"
        )

    # Convert DriftCheckResult dataclass to response model
    regimes = {}
    for regime_name, metrics in result.regimes.items():
        regimes[regime_name] = RegimeStatus(
            rolling_accuracy=metrics.rolling_accuracy,
            baseline_accuracy=metrics.baseline_accuracy,
            sigma=metrics.sigma,
            drift=metrics.drift,
            deviation_sigmas=metrics.deviation_sigmas,
        )

    retrain_outcome = None
    if result.retrain_outcome is not None:
        retrain_outcome = RetrainOutcome(**result.retrain_outcome)

    return DriftCheckResponse(
        status=result.status,
        regimes=regimes,
        retrain_triggered=result.retrain_triggered,
        retrain_outcome=retrain_outcome,
    )
