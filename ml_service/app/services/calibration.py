"""
Calibration Service — trains isotonic regression to map raw probabilities
to historically accurate probabilities.

Singleton pattern: one calibration model loaded at a time.
Persists model via joblib and metadata as JSON.
"""

import json
import os
from datetime import datetime, timezone
from typing import Optional, Any

import httpx
import joblib
import numpy as np
from sklearn.isotonic import IsotonicRegression

MODEL_PATH = "/tmp/fip_calibration_model.joblib"
METADATA_PATH = "/tmp/fip_calibration_meta.json"

MIN_TRAINING_RECORDS = 50


class InsufficientDataError(Exception):
    """Raised when fewer than MIN_TRAINING_RECORDS evaluation records are available."""
    pass


class CalibrationTrainResult:
    """Result of a calibration training run."""

    def __init__(
        self,
        sample_count: int,
        pre_calibration_error: float,
        post_calibration_error: float,
        model_version: str,
    ):
        self.sample_count = sample_count
        self.pre_calibration_error = pre_calibration_error
        self.post_calibration_error = post_calibration_error
        self.model_version = model_version


class CalibrationService:
    """Manages isotonic regression calibration model."""

    _instance: Optional["CalibrationService"] = None

    def __init__(self):
        self._models: Optional[dict[str, IsotonicRegression]] = None
        self._version: Optional[str] = None
        self._sample_count: int = 0
        self._calibration_error: float = 0.0

    @classmethod
    def get_instance(cls) -> "CalibrationService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def is_loaded(self) -> bool:
        """Whether a calibration model is available."""
        return self._models is not None

    def get_version(self) -> Optional[str]:
        return self._version

    async def train(self) -> CalibrationTrainResult:
        """
        Fetch research_evaluations joined with research_forecasts,
        train isotonic regression.
        Returns metrics: sample_count, pre_calibration_error, post_calibration_error.
        Raises InsufficientDataError if < 50 evaluation records.
        """
        supabase_url = os.environ.get("SUPABASE_URL", "")
        supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

        if not supabase_url or not supabase_key:
            raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

        # Fetch evaluated research_evaluations joined with research_forecasts
        # to get predicted probabilities and actual outcomes
        print("[CalibrationService] Fetching evaluated research data...")
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get evaluations that have been completed (not outcome_unavailable)
            response = await client.get(
                f"{supabase_url}/rest/v1/research_evaluations"
                f"?select=forecast_id,direction_accuracy,brier_score,calibration_bucket,"
                f"research_forecasts!inner(direction_probabilities,asset)"
                f"&status=eq.evaluated&order=created_at.asc",
                headers={
                    "apikey": supabase_key,
                    "Authorization": f"Bearer {supabase_key}",
                    "Content-Type": "application/json",
                },
            )
            response.raise_for_status()
            records = response.json()

        print(f"[CalibrationService] Fetched {len(records)} evaluated records")

        if len(records) < MIN_TRAINING_RECORDS:
            raise InsufficientDataError(
                f"Insufficient evaluation data: {len(records)} records (minimum {MIN_TRAINING_RECORDS} required). "
                f"Evaluations accumulate as forecasts mature and outcomes are recorded."
            )

        # Parse predicted probabilities from the joined forecast data
        # and derive actual outcomes from direction_accuracy + highest predicted direction
        pred_up = []
        pred_down = []
        pred_flat = []
        actual_up = []
        actual_down = []
        actual_flat = []

        for record in records:
            forecast = record.get("research_forecasts", {})
            probs = forecast.get("direction_probabilities", {})

            p_up = float(probs.get("up", 0.0))
            p_down = float(probs.get("down", 0.0))
            p_flat = float(probs.get("flat", 0.0))

            # Determine predicted direction (highest probability)
            predicted_dir = max(
                [("up", p_up), ("down", p_down), ("flat", p_flat)],
                key=lambda x: x[1]
            )[0]

            # direction_accuracy: 1 = correct, 0 = incorrect
            correct = int(record.get("direction_accuracy", 0)) == 1

            # Derive actual direction: if correct, actual == predicted
            # If incorrect, we can't know exact actual direction from this field alone
            # Use brier_score as supplementary signal, but conservatively:
            # actual = predicted if correct, else distribute to other directions
            if correct:
                actual = predicted_dir
            else:
                # When wrong, assume the opposite of predicted for binary-like cases
                # For calibration this is a reasonable approximation
                if predicted_dir == "up":
                    actual = "down"
                elif predicted_dir == "down":
                    actual = "up"
                else:
                    actual = "down"  # flat wrong → could be either, default to down

            pred_up.append(p_up)
            pred_down.append(p_down)
            pred_flat.append(p_flat)
            actual_up.append(1.0 if actual == "up" else 0.0)
            actual_down.append(1.0 if actual == "down" else 0.0)
            actual_flat.append(1.0 if actual == "flat" else 0.0)

        pred_up_arr = np.array(pred_up)
        pred_down_arr = np.array(pred_down)
        pred_flat_arr = np.array(pred_flat)
        actual_up_arr = np.array(actual_up)
        actual_down_arr = np.array(actual_down)
        actual_flat_arr = np.array(actual_flat)

        # Compute pre-calibration error (mean absolute error across all classes)
        pre_error = float(np.mean([
            np.mean(np.abs(pred_up_arr - actual_up_arr)),
            np.mean(np.abs(pred_down_arr - actual_down_arr)),
            np.mean(np.abs(pred_flat_arr - actual_flat_arr)),
        ]))

        # Train isotonic regression per class
        print("[CalibrationService] Training isotonic regression models...")
        model_up = IsotonicRegression(out_of_bounds="clip")
        model_down = IsotonicRegression(out_of_bounds="clip")
        model_flat = IsotonicRegression(out_of_bounds="clip")

        model_up.fit(pred_up_arr, actual_up_arr)
        model_down.fit(pred_down_arr, actual_down_arr)
        model_flat.fit(pred_flat_arr, actual_flat_arr)

        # Compute post-calibration error
        cal_up = model_up.predict(pred_up_arr)
        cal_down = model_down.predict(pred_down_arr)
        cal_flat = model_flat.predict(pred_flat_arr)

        post_error = float(np.mean([
            np.mean(np.abs(cal_up - actual_up_arr)),
            np.mean(np.abs(cal_down - actual_down_arr)),
            np.mean(np.abs(cal_flat - actual_flat_arr)),
        ]))

        # Generate version identifier
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        version = f"cal-v1-{today}"

        # Store models in memory
        self._models = {
            "up": model_up,
            "down": model_down,
            "flat": model_flat,
        }
        self._version = version
        self._sample_count = len(records)
        self._calibration_error = post_error

        # Persist to disk
        self.save()

        print(
            f"[CalibrationService] Training complete: {len(records)} samples, "
            f"pre_error={pre_error:.4f}, post_error={post_error:.4f}, version={version}"
        )

        return CalibrationTrainResult(
            sample_count=len(records),
            pre_calibration_error=round(pre_error, 6),
            post_calibration_error=round(post_error, 6),
            model_version=version,
        )

    def calibrate(self, probs: dict[str, float]) -> dict[str, Any]:
        """
        Apply isotonic regression to raw [up, down, flat] probabilities.
        Renormalises output to sum to 1.0.
        Returns raw probs unchanged if no calibration model loaded.
        """
        raw_up = probs.get("up", 0.0)
        raw_down = probs.get("down", 0.0)
        raw_flat = probs.get("flat", 0.0)

        if not self.is_loaded():
            return {
                "up": raw_up,
                "down": raw_down,
                "flat": raw_flat,
                "calibrated": False,
                "model_version": None,
            }

        try:
            # Apply isotonic regression per class
            cal_up = float(self._models["up"].predict(np.array([raw_up]))[0])
            cal_down = float(self._models["down"].predict(np.array([raw_down]))[0])
            cal_flat = float(self._models["flat"].predict(np.array([raw_flat]))[0])

            # Check for NaN/Inf
            if (
                not np.isfinite(cal_up)
                or not np.isfinite(cal_down)
                or not np.isfinite(cal_flat)
            ):
                print("[CalibrationService] WARNING: Calibration produced NaN/Inf, falling back to raw probs")
                return {
                    "up": raw_up,
                    "down": raw_down,
                    "flat": raw_flat,
                    "calibrated": False,
                    "model_version": self._version,
                }

            # Renormalise to sum to 1.0
            total = cal_up + cal_down + cal_flat
            if total <= 0:
                # Edge case: all calibrated values are zero
                print("[CalibrationService] WARNING: Calibration sum <= 0, falling back to raw probs")
                return {
                    "up": raw_up,
                    "down": raw_down,
                    "flat": raw_flat,
                    "calibrated": False,
                    "model_version": self._version,
                }

            return {
                "up": round(cal_up / total, 6),
                "down": round(cal_down / total, 6),
                "flat": round(cal_flat / total, 6),
                "calibrated": True,
                "model_version": self._version,
            }

        except Exception as e:
            print(f"[CalibrationService] ERROR during calibration: {e}")
            return {
                "up": raw_up,
                "down": raw_down,
                "flat": raw_flat,
                "calibrated": False,
                "model_version": self._version,
            }

    def save(self) -> None:
        """Persist calibration model to disk."""
        if self._models is None:
            print("[CalibrationService] No model to save")
            return

        try:
            joblib.dump(self._models, MODEL_PATH)
            meta = {
                "version": self._version,
                "trained_at": datetime.now(timezone.utc).isoformat(),
                "sample_count": self._sample_count,
                "calibration_error": self._calibration_error,
            }
            with open(METADATA_PATH, "w") as f:
                json.dump(meta, f)
            print(f"[CalibrationService] Saved model v{self._version} to disk")
        except Exception as e:
            print(f"[CalibrationService] Failed to save model: {e}")

    def load_if_available(self) -> None:
        """Load persisted calibration model from disk on startup."""
        if os.path.exists(MODEL_PATH) and os.path.exists(METADATA_PATH):
            try:
                models = joblib.load(MODEL_PATH)
                with open(METADATA_PATH, "r") as f:
                    meta = json.load(f)

                # Validate loaded model structure
                if not isinstance(models, dict) or not all(
                    k in models for k in ("up", "down", "flat")
                ):
                    print("[CalibrationService] WARNING: Corrupted model file — invalid structure")
                    return

                self._models = models
                self._version = meta.get("version")
                self._sample_count = meta.get("sample_count", 0)
                self._calibration_error = meta.get("calibration_error", 0.0)
                print(
                    f"[CalibrationService] Loaded calibration model v{self._version} "
                    f"({self._sample_count} samples)"
                )
            except Exception as e:
                print(f"[CalibrationService] WARNING: Failed to load model: {e}")
                self._models = None
        else:
            print("[CalibrationService] No calibration model found on disk — operating in uncalibrated mode")
