"""
Explainability Service — computes SHAP values for ML predictions
and stores feature attributions for audit and API retrieval.

Singleton pattern: mirrors CalibrationService and ModelStore patterns.
Uses httpx for Supabase REST API queries. Enforces 5-second timeout
on SHAP computation. Never raises exceptions that would halt the pipeline.
"""

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
import numpy as np
import shap

from app.services.model_store import ModelStore

logger = logging.getLogger(__name__)

# The 30 features used by the predict router's _build_feature_vector
FEATURE_NAMES = [
    "l1_mean", "l1_std", "l1_min", "l1_max",
    "l2_mean", "l2_std", "l2_min", "l2_max",
    "macro_0", "macro_1", "macro_2", "macro_3",
    "macro_4", "macro_5", "macro_6", "macro_7",
    "sent_0", "sent_1", "sent_2", "sent_3", "sent_4", "sent_5",
    "session_london", "session_ny", "session_asia",
    "vol_regime_high", "vol_regime_low",
    "rolling_trend", "atr_percentile", "vol_regime_score",
]

SHAP_TIMEOUT_SECONDS = 5


class ExplainabilityService:
    """Computes and stores SHAP explanations for ML predictions."""

    _instance: Optional["ExplainabilityService"] = None

    def __init__(self):
        pass

    @classmethod
    def get_instance(cls) -> "ExplainabilityService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def compute_and_store(
        self,
        features: np.ndarray,
        forecast_id: str,
        asset: str,
    ) -> Optional[dict[str, Any]]:
        """
        Compute SHAP TreeExplainer values from features + loaded XGBoost model,
        extract top 5 features by absolute SHAP value, store to prediction_explanations
        via Supabase REST API. Enforces 5-second timeout on SHAP computation.

        Returns the explanation dict on success, or None on any failure.
        """
        model_store = ModelStore.get_instance()

        if not model_store.is_loaded():
            logger.warning("[ExplainabilityService] No model loaded — skipping SHAP computation")
            return None

        model = model_store._model
        model_version = model_store.get_version() or "unknown"

        # Compute SHAP values with timeout
        try:
            shap_values, base_value = await asyncio.wait_for(
                self._compute_shap(model, features),
                timeout=SHAP_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            logger.error(
                "[ExplainabilityService] SHAP computation timed out after %ds for asset=%s",
                SHAP_TIMEOUT_SECONDS, asset,
            )
            return None
        except Exception as e:
            logger.error(
                "[ExplainabilityService] SHAP computation failed (model incompatibility or runtime error): %s",
                e,
            )
            return None

        # Build SHAP values dict mapping feature names to values
        shap_values_dict: dict[str, float] = {}
        for i, name in enumerate(FEATURE_NAMES):
            if i < len(shap_values):
                shap_values_dict[name] = round(float(shap_values[i]), 6)

        # Extract top 5 features by absolute SHAP value
        sorted_features = sorted(
            shap_values_dict.items(),
            key=lambda x: abs(x[1]),
            reverse=True,
        )
        top_features = [
            {"feature": name, "shap_value": value}
            for name, value in sorted_features[:5]
        ]

        timestamp_utc = datetime.now(timezone.utc).isoformat()

        # Store to Supabase
        record = {
            "id": str(uuid.uuid4()),
            "forecast_id": forecast_id,
            "asset": asset,
            "timestamp_utc": timestamp_utc,
            "shap_values": shap_values_dict,
            "top_features": top_features,
            "base_value": round(float(base_value), 6),
            "model_version": model_version,
        }

        stored = await self._store_to_supabase(record)
        if not stored:
            return None

        return record

    async def get_latest(self, asset: str) -> Optional[dict[str, Any]]:
        """
        Query prediction_explanations for the most recent record by asset.
        Returns the record dict or None if not found or on error.
        """
        supabase_url = os.environ.get("SUPABASE_URL", "")
        supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

        if not supabase_url or not supabase_key:
            logger.error("[ExplainabilityService] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set")
            return None

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{supabase_url}/rest/v1/prediction_explanations",
                    params={
                        "select": "*",
                        "asset": f"eq.{asset}",
                        "order": "timestamp_utc.desc",
                        "limit": "1",
                    },
                    headers={
                        "apikey": supabase_key,
                        "Authorization": f"Bearer {supabase_key}",
                        "Content-Type": "application/json",
                    },
                )
                response.raise_for_status()
                records = response.json()

            if not records:
                return None

            return records[0]

        except Exception as e:
            logger.error("[ExplainabilityService] Failed to fetch latest explanation: %s", e)
            return None

    async def _compute_shap(
        self, model: Any, features: np.ndarray
    ) -> tuple[np.ndarray, float]:
        """
        Compute SHAP values using TreeExplainer. Runs in a thread executor
        to avoid blocking the event loop.
        """
        loop = asyncio.get_event_loop()

        def _run_shap():
            explainer = shap.TreeExplainer(model)
            X = features.reshape(1, -1)
            explanation = explainer(X)

            # explanation.values shape: (1, n_features) for binary or
            # (1, n_features, n_classes) for multiclass
            values = explanation.values[0]

            # For multiclass, use the first class (up) SHAP values
            if values.ndim > 1:
                values = values[:, 0]

            # Base value: scalar or array of base values per class
            base = explanation.base_values[0]
            if hasattr(base, "__len__"):
                base = float(base[0])
            else:
                base = float(base)

            return np.array(values, dtype=np.float64), base

        return await loop.run_in_executor(None, _run_shap)

    async def _store_to_supabase(self, record: dict[str, Any]) -> bool:
        """
        Store explanation record to prediction_explanations table via Supabase REST API.
        Returns True on success, False on failure.
        """
        supabase_url = os.environ.get("SUPABASE_URL", "")
        supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

        if not supabase_url or not supabase_key:
            logger.error("[ExplainabilityService] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set")
            return False

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(
                    f"{supabase_url}/rest/v1/prediction_explanations",
                    json=record,
                    headers={
                        "apikey": supabase_key,
                        "Authorization": f"Bearer {supabase_key}",
                        "Content-Type": "application/json",
                        "Prefer": "return=minimal",
                    },
                )
                response.raise_for_status()

            logger.info(
                "[ExplainabilityService] Stored explanation for asset=%s forecast_id=%s",
                record.get("asset"), record.get("forecast_id"),
            )
            return True

        except httpx.TimeoutException:
            logger.error(
                "[ExplainabilityService] Supabase insert timed out for asset=%s",
                record.get("asset"),
            )
            return False
        except Exception as e:
            logger.error(
                "[ExplainabilityService] Supabase insert failed: %s", e
            )
            return False
