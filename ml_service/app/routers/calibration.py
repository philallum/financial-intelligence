"""
Calibration endpoints — apply isotonic regression calibration to raw probabilities
and trigger calibration model training.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.services.calibration import CalibrationService, InsufficientDataError

router = APIRouter()


# --- Request/Response Models ---


class CalibrateRequest(BaseModel):
    """Raw probability vector to calibrate."""
    up: float
    down: float
    flat: float


class CalibrateResponse(BaseModel):
    """Calibrated probability vector with metadata."""
    up: float
    down: float
    flat: float
    calibrated: bool
    model_version: Optional[str] = None


class CalibrateTrainResponse(BaseModel):
    """Training result metrics."""
    status: str
    sample_count: int
    pre_calibration_error: float
    post_calibration_error: float
    model_version: str


# --- Endpoints ---


@router.post("/calibrate", response_model=CalibrateResponse, tags=["calibration"])
async def calibrate(request: CalibrateRequest):
    """
    Apply isotonic regression calibration to a raw probability vector.

    If no calibration model is loaded, returns the raw probabilities
    unchanged with `calibrated: false`.
    """
    service = CalibrationService.get_instance()

    result = service.calibrate({
        "up": request.up,
        "down": request.down,
        "flat": request.flat,
    })

    return CalibrateResponse(
        up=result["up"],
        down=result["down"],
        flat=result["flat"],
        calibrated=result["calibrated"],
        model_version=result["model_version"],
    )


@router.post("/calibrate/train", response_model=CalibrateTrainResponse, tags=["calibration"])
async def calibrate_train():
    """
    Train the isotonic regression calibration model from research_evaluations.

    Returns training metrics on success. Returns 400 if fewer than 50
    evaluation records are available.
    """
    service = CalibrationService.get_instance()

    try:
        result = await service.train()
    except InsufficientDataError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Calibration training failed: {str(e)}")

    return CalibrateTrainResponse(
        status="trained",
        sample_count=result.sample_count,
        pre_calibration_error=result.pre_calibration_error,
        post_calibration_error=result.post_calibration_error,
        model_version=result.model_version,
    )
