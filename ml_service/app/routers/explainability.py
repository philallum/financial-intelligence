"""
Explainability endpoints — return SHAP explanations for ML predictions.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.explainability import ExplainabilityService

router = APIRouter()

# Supported assets for explainability queries
SUPPORTED_ASSETS = ["EURUSD"]


# --- Response Models ---


class ShapFeature(BaseModel):
    """A single feature with its SHAP value."""
    feature: str
    shap_value: float


class ExplainResponse(BaseModel):
    """SHAP explanation for a prediction."""
    forecast_id: str
    asset: str
    timestamp_utc: str
    base_value: float
    shap_values: dict[str, float]
    top_features: list[ShapFeature]
    model_version: str


# --- Endpoints ---


@router.get(
    "/v1/forecast/{asset}/explain",
    response_model=ExplainResponse,
    tags=["explainability"],
)
async def get_explanation(asset: str):
    """
    Return the SHAP explanation for the most recent prediction
    for the specified asset.

    Returns 400 if the asset is not supported.
    Returns 404 if no explanation exists for the asset.
    """
    if asset not in SUPPORTED_ASSETS:
        supported_list = ", ".join(SUPPORTED_ASSETS)
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported asset: {asset}. Supported: {supported_list}",
        )

    service = ExplainabilityService.get_instance()
    record = await service.get_latest(asset)

    if record is None:
        raise HTTPException(
            status_code=404,
            detail=f"No explanation available for asset {asset}",
        )

    return ExplainResponse(
        forecast_id=record["forecast_id"],
        asset=record["asset"],
        timestamp_utc=record["timestamp_utc"],
        base_value=record["base_value"],
        shap_values=record["shap_values"],
        top_features=[
            ShapFeature(feature=f["feature"], shap_value=f["shap_value"])
            for f in record["top_features"]
        ],
        model_version=record["model_version"],
    )
