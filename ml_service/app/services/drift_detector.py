"""
Drift Detector — monitors rolling forecast accuracy per regime and triggers
automatic retraining when performance degrades beyond 2 standard deviations.

Singleton pattern: one detector instance shared across requests.
Uses Supabase REST API for data queries and drift alert persistence.
"""

import os
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

import httpx
import numpy as np

logger = logging.getLogger(__name__)

# Minimum forecasts required for rolling accuracy computation
MIN_ROLLING_WINDOW = 30
# Minimum forecasts required for baseline statistics
MIN_BASELINE_WINDOW = 100
# Drift detection threshold in standard deviations
DRIFT_SIGMA_THRESHOLD = 2.0


@dataclass
class DriftMetrics:
    """Per-regime drift detection metrics."""

    rolling_accuracy: float
    baseline_accuracy: float
    sigma: float
    drift: bool
    deviation_sigmas: Optional[float] = None


@dataclass
class DriftCheckResult:
    """Result of drift check across all regimes."""

    status: str  # "healthy" or "drift_detected"
    regimes: dict[str, DriftMetrics] = field(default_factory=dict)
    retrain_triggered: bool = False
    retrain_outcome: Optional[dict] = None


class DriftDetector:
    """Detects model performance drift and triggers retraining."""

    _instance: Optional["DriftDetector"] = None

    @classmethod
    def get_instance(cls) -> "DriftDetector":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def _supabase_query(self, table: str, params: str) -> list[dict]:
        """Query Supabase REST API directly with httpx."""
        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

        if not url or not key:
            raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(
                f"{url}/rest/v1/{table}?{params}",
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
            )
            response.raise_for_status()
            return response.json()

    async def _supabase_insert(self, table: str, data: dict) -> dict:
        """Insert a record into Supabase via REST API."""
        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

        if not url or not key:
            raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{url}/rest/v1/{table}",
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                    "Prefer": "return=representation",
                },
                json=data,
            )
            response.raise_for_status()
            result = response.json()
            return result[0] if isinstance(result, list) and result else result

    async def _supabase_update(self, table: str, record_id: str, data: dict) -> None:
        """Update a record in Supabase via REST API."""
        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

        if not url or not key:
            raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.patch(
                f"{url}/rest/v1/{table}?id=eq.{record_id}",
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
                json=data,
            )
            response.raise_for_status()

    @staticmethod
    def compute_rolling_accuracy(
        predictions: list[dict], window: int = MIN_ROLLING_WINDOW
    ) -> float:
        """
        Compute accuracy over the most recent `window` forecasts.

        Each record must have 'predicted_direction' and 'actual_direction' fields.
        Returns fraction of correct predictions in the window.
        """
        recent = predictions[-window:]
        correct = sum(
            1
            for r in recent
            if r.get("predicted_direction") == r.get("actual_direction")
        )
        return correct / window

    @staticmethod
    def compute_baseline_stats(
        predictions: list[dict], window: int = MIN_BASELINE_WINDOW
    ) -> tuple[float, float]:
        """
        Compute baseline accuracy mean and standard deviation from the most recent
        `window` forecasts using rolling 30-forecast windows.

        Returns (mean_accuracy, sigma).
        """
        recent = predictions[-window:]

        # Compute rolling 30-forecast accuracies over the baseline window
        rolling_accuracies = []
        for i in range(MIN_ROLLING_WINDOW, len(recent) + 1):
            window_slice = recent[i - MIN_ROLLING_WINDOW : i]
            correct = sum(
                1
                for r in window_slice
                if r.get("predicted_direction") == r.get("actual_direction")
            )
            rolling_accuracies.append(correct / MIN_ROLLING_WINDOW)

        if not rolling_accuracies:
            return 0.0, 0.0

        mean_accuracy = float(np.mean(rolling_accuracies))
        sigma = float(np.std(rolling_accuracies, ddof=0))

        return mean_accuracy, sigma

    @staticmethod
    def classify_drift(
        rolling_accuracy: float, baseline_accuracy: float, sigma: float
    ) -> bool:
        """
        Classify whether drift is detected.

        Drift is flagged when rolling_accuracy < baseline_accuracy - 2 * sigma.
        """
        return rolling_accuracy < baseline_accuracy - DRIFT_SIGMA_THRESHOLD * sigma

    async def check_all_regimes(self) -> DriftCheckResult:
        """
        For each regime:
        - Compute rolling 30-forecast accuracy
        - Compute baseline (100-forecast) mean and sigma
        - Flag drift if rolling < baseline - 2*sigma
        Returns per-regime status.
        """
        logger.info("[DriftDetector] Starting drift check for all regimes...")

        # Fetch research_evaluations ordered by evaluated_at
        records = await self._supabase_query(
            "research_evaluations",
            "select=regime,predicted_direction,actual_direction,evaluated_at"
            "&order=evaluated_at.asc",
        )

        logger.info(
            f"[DriftDetector] Fetched {len(records)} evaluation records"
        )

        # Group by regime
        regimes: dict[str, list[dict]] = {}
        for record in records:
            regime = record.get("regime", "UNKNOWN")
            if regime not in regimes:
                regimes[regime] = []
            regimes[regime].append(record)

        result = DriftCheckResult(status="healthy")
        drift_detected_regimes: list[tuple[str, DriftMetrics]] = []

        for regime, predictions in regimes.items():
            # Skip regimes with insufficient data for rolling window
            if len(predictions) < MIN_ROLLING_WINDOW:
                logger.info(
                    f"[DriftDetector] Skipping regime '{regime}': "
                    f"only {len(predictions)} forecasts (need {MIN_ROLLING_WINDOW})"
                )
                continue

            # Compute rolling accuracy (most recent 30)
            rolling_accuracy = self.compute_rolling_accuracy(predictions)

            # Compute baseline stats (need at least 100 for meaningful baseline)
            if len(predictions) < MIN_BASELINE_WINDOW:
                # Use all available data for baseline if < 100 but >= 30
                baseline_accuracy, sigma = self.compute_baseline_stats(
                    predictions, window=len(predictions)
                )
            else:
                baseline_accuracy, sigma = self.compute_baseline_stats(predictions)

            # Skip drift classification if sigma is 0 (no variability)
            if sigma == 0.0:
                logger.info(
                    f"[DriftDetector] Skipping drift check for regime '{regime}': "
                    f"sigma=0 (no variability in baseline)"
                )
                metrics = DriftMetrics(
                    rolling_accuracy=round(rolling_accuracy, 6),
                    baseline_accuracy=round(baseline_accuracy, 6),
                    sigma=0.0,
                    drift=False,
                )
                result.regimes[regime] = metrics
                continue

            # Classify drift
            drift = self.classify_drift(rolling_accuracy, baseline_accuracy, sigma)

            # Compute deviation in sigmas
            deviation_sigmas = None
            if drift:
                deviation_sigmas = round(
                    (baseline_accuracy - rolling_accuracy) / sigma, 2
                )

            metrics = DriftMetrics(
                rolling_accuracy=round(rolling_accuracy, 6),
                baseline_accuracy=round(baseline_accuracy, 6),
                sigma=round(sigma, 6),
                drift=drift,
                deviation_sigmas=deviation_sigmas,
            )
            result.regimes[regime] = metrics

            if drift:
                drift_detected_regimes.append((regime, metrics))
                logger.warning(
                    f"[DriftDetector] DRIFT DETECTED in regime '{regime}': "
                    f"rolling={rolling_accuracy:.4f}, "
                    f"baseline={baseline_accuracy:.4f}, "
                    f"sigma={sigma:.4f}, "
                    f"deviation={deviation_sigmas}σ"
                )

        # Handle drift if detected in any regime
        if drift_detected_regimes:
            result.status = "drift_detected"
            # Trigger retraining once for all drifted regimes
            for regime, metrics in drift_detected_regimes:
                await self.handle_drift(regime, metrics)
            result.retrain_triggered = True

            # Get retrain outcome from the last handled drift
            # (retraining is triggered once, outcome applies to all)
            result.retrain_outcome = self._last_retrain_outcome
        else:
            logger.info("[DriftDetector] All regimes healthy — no retraining needed")

        return result

    async def handle_drift(self, regime: str, metrics: DriftMetrics) -> None:
        """
        Insert drift_alerts record, trigger POST /train.
        Log outcome (success/failure) to drift alert.
        """
        logger.info(
            f"[DriftDetector] Handling drift for regime '{regime}' — "
            f"inserting alert and triggering retrain"
        )

        # Insert drift alert record
        alert_id = str(uuid4())
        alert_data = {
            "id": alert_id,
            "regime": regime,
            "detected_at": datetime.now(timezone.utc).isoformat(),
            "rolling_accuracy": metrics.rolling_accuracy,
            "baseline_accuracy": metrics.baseline_accuracy,
            "sigma": metrics.sigma,
            "deviation_sigmas": metrics.deviation_sigmas or 0.0,
            "retrain_triggered": True,
            "retrain_outcome": None,
        }

        try:
            await self._supabase_insert("drift_alerts", alert_data)
            logger.info(
                f"[DriftDetector] Drift alert inserted: id={alert_id}"
            )
        except Exception as e:
            logger.error(
                f"[DriftDetector] Failed to insert drift alert: {e}"
            )
            # Continue to attempt retraining even if alert insert fails

        # Trigger POST /train
        retrain_outcome = await self._trigger_retrain()
        self._last_retrain_outcome = retrain_outcome

        # Update drift alert with retrain outcome
        try:
            await self._supabase_update(
                "drift_alerts",
                alert_id,
                {"retrain_outcome": retrain_outcome},
            )
            logger.info(
                f"[DriftDetector] Updated drift alert {alert_id} with retrain outcome"
            )
        except Exception as e:
            logger.error(
                f"[DriftDetector] Failed to update drift alert with outcome: {e}"
            )

    async def _trigger_retrain(self) -> dict:
        """
        Trigger model retraining via POST /train on the local ML service.
        Returns the outcome dict with status and details.
        """
        # The ML service hosts /train on itself; use localhost or service URL
        ml_service_url = os.environ.get(
            "ML_SERVICE_URL", "http://localhost:8000"
        )

        logger.info("[DriftDetector] Triggering POST /train...")

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    f"{ml_service_url}/train",
                    json={},
                    headers={"Content-Type": "application/json"},
                )
                response.raise_for_status()
                result = response.json()

            logger.info(
                f"[DriftDetector] Retraining succeeded: "
                f"accuracy={result.get('accuracy', 'N/A')}"
            )
            return {
                "status": "trained",
                "accuracy": result.get("accuracy"),
                "model_version": result.get("model_version"),
                "training_samples": result.get("training_samples"),
            }

        except httpx.HTTPStatusError as e:
            logger.error(
                f"[DriftDetector] Retraining failed (HTTP {e.response.status_code}): "
                f"{e.response.text}"
            )
            return {
                "status": "failed",
                "error": f"HTTP {e.response.status_code}",
                "detail": e.response.text[:500],
            }
        except Exception as e:
            logger.error(f"[DriftDetector] Retraining failed: {e}")
            return {
                "status": "failed",
                "error": str(e),
            }

    # Internal state for last retrain outcome (shared across handle_drift calls)
    _last_retrain_outcome: Optional[dict] = None
