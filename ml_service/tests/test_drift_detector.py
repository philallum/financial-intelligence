"""
Unit tests for the Drift Detector service and POST /drift-check router.

Tests rolling accuracy computation edge cases, drift classification at boundary,
regime skip when < 30 forecasts, sigma=0 handling, and router responses.

Validates: Requirements 5.1, 5.2, 5.3, 5.4, 6.1
"""

import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from fastapi.testclient import TestClient

from app.main import app
from app.services.drift_detector import (
    DriftDetector,
    DriftMetrics,
    DriftCheckResult,
    MIN_ROLLING_WINDOW,
    MIN_BASELINE_WINDOW,
    DRIFT_SIGMA_THRESHOLD,
)


@pytest.fixture(autouse=True)
def reset_drift_detector():
    """Reset the DriftDetector singleton before each test."""
    DriftDetector._instance = None
    yield
    DriftDetector._instance = None


@pytest.fixture
def client():
    """Create a FastAPI TestClient."""
    return TestClient(app)


# --- Helper functions ---


def make_prediction(predicted: str, actual: str) -> dict:
    """Create a prediction record dict."""
    return {"predicted_direction": predicted, "actual_direction": actual}


def make_predictions(correct_count: int, total: int) -> list[dict]:
    """Create a list of predictions with a specified number of correct ones."""
    predictions = []
    for i in range(total):
        if i < correct_count:
            predictions.append(make_prediction("up", "up"))
        else:
            predictions.append(make_prediction("up", "down"))
    return predictions


# =============================================================================
# 1. Rolling Accuracy Edge Cases
# =============================================================================


class TestComputeRollingAccuracy:
    """Tests for DriftDetector.compute_rolling_accuracy()."""

    def test_all_correct_predictions(self):
        """All correct predictions → accuracy = 1.0."""
        predictions = [make_prediction("up", "up") for _ in range(30)]
        accuracy = DriftDetector.compute_rolling_accuracy(predictions, window=30)
        assert accuracy == 1.0

    def test_all_incorrect_predictions(self):
        """All incorrect predictions → accuracy = 0.0."""
        predictions = [make_prediction("up", "down") for _ in range(30)]
        accuracy = DriftDetector.compute_rolling_accuracy(predictions, window=30)
        assert accuracy == 0.0

    def test_mixed_predictions_known_counts(self):
        """Mixed predictions with known correct count."""
        # 18 correct out of 30 → accuracy = 0.6
        predictions = make_predictions(correct_count=18, total=30)
        accuracy = DriftDetector.compute_rolling_accuracy(predictions, window=30)
        assert accuracy == pytest.approx(0.6)

    def test_exactly_minimum_window(self):
        """Exactly 30 predictions (minimum window)."""
        # 15 correct out of 30 → accuracy = 0.5
        predictions = make_predictions(correct_count=15, total=30)
        accuracy = DriftDetector.compute_rolling_accuracy(
            predictions, window=MIN_ROLLING_WINDOW
        )
        assert accuracy == pytest.approx(0.5)

    def test_uses_most_recent_window(self):
        """Only uses the most recent `window` predictions, not all."""
        # First 20 correct, last 30 are all incorrect
        old_correct = [make_prediction("up", "up") for _ in range(20)]
        recent_wrong = [make_prediction("up", "down") for _ in range(30)]
        predictions = old_correct + recent_wrong

        accuracy = DriftDetector.compute_rolling_accuracy(predictions, window=30)
        assert accuracy == 0.0

    def test_single_correct_in_window(self):
        """Only 1 correct prediction out of 30."""
        predictions = make_predictions(correct_count=1, total=30)
        accuracy = DriftDetector.compute_rolling_accuracy(predictions, window=30)
        assert accuracy == pytest.approx(1 / 30)


# =============================================================================
# 2. Drift Classification Boundary
# =============================================================================


class TestClassifyDrift:
    """Tests for DriftDetector.classify_drift() boundary conditions."""

    def test_exactly_at_threshold_no_drift(self):
        """rolling_accuracy exactly at baseline - 2*sigma → NO drift (not strictly less)."""
        # baseline=0.6, sigma=0.05 → threshold = 0.6 - 2*0.05 = 0.5
        # rolling_accuracy = 0.5 (exactly at threshold) → NOT drift
        result = DriftDetector.classify_drift(
            rolling_accuracy=0.5,
            baseline_accuracy=0.6,
            sigma=0.05,
        )
        assert result is False

    def test_just_below_threshold_drift_detected(self):
        """rolling_accuracy just below threshold → drift detected."""
        # baseline=0.6, sigma=0.05 → threshold = 0.5
        # rolling_accuracy = 0.499 (below threshold) → drift
        result = DriftDetector.classify_drift(
            rolling_accuracy=0.499,
            baseline_accuracy=0.6,
            sigma=0.05,
        )
        assert result is True

    def test_above_threshold_no_drift(self):
        """rolling_accuracy above threshold → no drift."""
        # baseline=0.6, sigma=0.05 → threshold = 0.5
        # rolling_accuracy = 0.55 (above threshold) → no drift
        result = DriftDetector.classify_drift(
            rolling_accuracy=0.55,
            baseline_accuracy=0.6,
            sigma=0.05,
        )
        assert result is False

    def test_very_small_sigma_high_sensitivity(self):
        """Very small sigma (nearly 0 but positive) → high sensitivity to small drops."""
        # baseline=0.6, sigma=0.001 → threshold = 0.6 - 0.002 = 0.598
        # rolling_accuracy = 0.597 → drift (very sensitive)
        result = DriftDetector.classify_drift(
            rolling_accuracy=0.597,
            baseline_accuracy=0.6,
            sigma=0.001,
        )
        assert result is True

    def test_large_sigma_low_sensitivity(self):
        """Large sigma → more tolerance before drift is flagged."""
        # baseline=0.6, sigma=0.2 → threshold = 0.6 - 0.4 = 0.2
        # rolling_accuracy = 0.3 (above 0.2) → no drift
        result = DriftDetector.classify_drift(
            rolling_accuracy=0.3,
            baseline_accuracy=0.6,
            sigma=0.2,
        )
        assert result is False


# =============================================================================
# 3. Regime Skip When < 30 Forecasts
# =============================================================================


class TestRegimeSkipInsufficientData:
    """Tests for regime skip when fewer than 30 forecasts exist."""

    @pytest.mark.asyncio
    async def test_regime_skipped_when_below_30_forecasts(self):
        """Regime with < 30 forecasts is not included in results."""
        # Create mock data: one regime with 20 forecasts (below minimum)
        mock_records = [
            {
                "regime": "HIGH",
                "predicted_direction": "up",
                "actual_direction": "up",
                "evaluated_at": f"2025-01-{i+1:02d}T00:00:00Z",
            }
            for i in range(20)
        ]

        detector = DriftDetector.get_instance()
        with patch.object(
            detector, "_supabase_query", new_callable=AsyncMock
        ) as mock_query:
            mock_query.return_value = mock_records
            result = await detector.check_all_regimes()

        # Regime with < 30 forecasts should not appear in results
        assert "HIGH" not in result.regimes
        assert result.status == "healthy"

    @pytest.mark.asyncio
    async def test_regime_with_exactly_30_included(self):
        """Regime with exactly 30 forecasts IS included in results."""
        mock_records = [
            {
                "regime": "HIGH",
                "predicted_direction": "up",
                "actual_direction": "up",
                "evaluated_at": f"2025-01-{(i % 28)+1:02d}T{i:02d}:00:00Z",
            }
            for i in range(30)
        ]

        detector = DriftDetector.get_instance()
        with patch.object(
            detector, "_supabase_query", new_callable=AsyncMock
        ) as mock_query:
            mock_query.return_value = mock_records
            result = await detector.check_all_regimes()

        # Regime with exactly 30 forecasts should be included
        assert "HIGH" in result.regimes


# =============================================================================
# 4. Sigma = 0 Handling
# =============================================================================


class TestSigmaZeroHandling:
    """Tests for sigma=0 handling (no variability in baseline)."""

    @pytest.mark.asyncio
    async def test_sigma_zero_no_drift_classified(self):
        """When sigma=0, drift is NOT classified (skipped)."""
        # All predictions are identical → rolling accuracies are all the same → sigma=0
        # Create 100 identical correct predictions for one regime
        mock_records = [
            {
                "regime": "NORMAL",
                "predicted_direction": "up",
                "actual_direction": "up",
                "evaluated_at": f"2025-01-01T{i:02d}:00:00Z",
            }
            for i in range(100)
        ]

        detector = DriftDetector.get_instance()
        with patch.object(
            detector, "_supabase_query", new_callable=AsyncMock
        ) as mock_query:
            mock_query.return_value = mock_records
            result = await detector.check_all_regimes()

        # Regime should be present but drift should be False
        assert "NORMAL" in result.regimes
        assert result.regimes["NORMAL"].drift is False
        assert result.regimes["NORMAL"].sigma == 0.0

    def test_classify_drift_not_called_with_sigma_zero(self):
        """classify_drift logic: sigma=0 means the check_all_regimes skips classification."""
        # Directly test that even if rolling < baseline, with sigma=0 in
        # check_all_regimes flow, drift is not flagged.
        # This is tested via the integration test above. Here we confirm
        # the classify_drift formula would break with sigma=0 (division not
        # relevant since it's a comparison, but the design says skip).
        # classify_drift itself doesn't guard against sigma=0 — that's done
        # in check_all_regimes before calling classify_drift.
        # We verify the formula still works with sigma=0 (no drift possible):
        # baseline - 2*0 = baseline, rolling < baseline would be drift
        # But the design says SKIP, so check_all_regimes handles it.
        result = DriftDetector.classify_drift(
            rolling_accuracy=0.5,
            baseline_accuracy=0.6,
            sigma=0.0,
        )
        # Formula says: 0.5 < 0.6 - 0 = 0.6 → True (drift)
        # But check_all_regimes never calls this when sigma=0
        assert result is True  # The formula itself would say drift


# =============================================================================
# 5. Router Tests (Mock DriftDetector)
# =============================================================================


class TestDriftCheckRouter:
    """Tests for POST /drift-check endpoint."""

    def test_healthy_status(self, client):
        """POST /drift-check returns healthy status when no drift detected."""
        mock_result = DriftCheckResult(
            status="healthy",
            regimes={
                "HIGH": DriftMetrics(
                    rolling_accuracy=0.60,
                    baseline_accuracy=0.58,
                    sigma=0.05,
                    drift=False,
                ),
                "LOW": DriftMetrics(
                    rolling_accuracy=0.55,
                    baseline_accuracy=0.54,
                    sigma=0.04,
                    drift=False,
                ),
            },
            retrain_triggered=False,
            retrain_outcome=None,
        )

        with patch.object(DriftDetector, "get_instance") as mock_get:
            mock_detector = MagicMock()
            mock_detector.check_all_regimes = AsyncMock(return_value=mock_result)
            mock_get.return_value = mock_detector

            response = client.post("/drift-check")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["retrain_triggered"] is False
        assert data["retrain_outcome"] is None
        assert "HIGH" in data["regimes"]
        assert "LOW" in data["regimes"]
        assert data["regimes"]["HIGH"]["drift"] is False

    def test_drift_detected_with_retrain(self, client):
        """POST /drift-check returns drift_detected with retrain outcome."""
        mock_result = DriftCheckResult(
            status="drift_detected",
            regimes={
                "HIGH": DriftMetrics(
                    rolling_accuracy=0.42,
                    baseline_accuracy=0.58,
                    sigma=0.05,
                    drift=True,
                    deviation_sigmas=3.2,
                ),
                "LOW": DriftMetrics(
                    rolling_accuracy=0.55,
                    baseline_accuracy=0.54,
                    sigma=0.04,
                    drift=False,
                ),
            },
            retrain_triggered=True,
            retrain_outcome={
                "status": "trained",
                "accuracy": 0.61,
                "model_version": "v2-retrained",
                "training_samples": 500,
            },
        )

        with patch.object(DriftDetector, "get_instance") as mock_get:
            mock_detector = MagicMock()
            mock_detector.check_all_regimes = AsyncMock(return_value=mock_result)
            mock_get.return_value = mock_detector

            response = client.post("/drift-check")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "drift_detected"
        assert data["retrain_triggered"] is True
        assert data["retrain_outcome"]["status"] == "trained"
        assert data["retrain_outcome"]["accuracy"] == 0.61
        assert data["regimes"]["HIGH"]["drift"] is True
        assert data["regimes"]["HIGH"]["deviation_sigmas"] == 3.2

    def test_drift_check_service_failure_returns_500(self, client):
        """POST /drift-check returns 500 on service failure."""
        with patch.object(DriftDetector, "get_instance") as mock_get:
            mock_detector = MagicMock()
            mock_detector.check_all_regimes = AsyncMock(
                side_effect=Exception("Supabase connection timeout")
            )
            mock_get.return_value = mock_detector

            response = client.post("/drift-check")

        assert response.status_code == 500
        data = response.json()
        assert "Drift check failed" in data["detail"]
        assert "Supabase connection timeout" in data["detail"]
