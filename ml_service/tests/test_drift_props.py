"""
Property-based tests for the Drift Detector.

Uses hypothesis to verify universal correctness properties of
rolling accuracy computation, baseline statistics, and drift classification.

**Validates: Requirements 5.1, 5.3, 5.4**
"""

import numpy as np
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from app.services.drift_detector import (
    DriftDetector,
    MIN_ROLLING_WINDOW,
    MIN_BASELINE_WINDOW,
    DRIFT_SIGMA_THRESHOLD,
)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

DIRECTIONS = ["up", "down", "flat"]


def direction_strategy():
    """Generate a random direction string from the valid set."""
    return st.sampled_from(DIRECTIONS)


def prediction_record_strategy():
    """Generate a single prediction record with predicted and actual directions."""
    return st.fixed_dictionaries({
        "predicted_direction": direction_strategy(),
        "actual_direction": direction_strategy(),
    })


def predictions_list_strategy(min_size: int, max_size: int = 200):
    """Generate a list of prediction records of a given minimum size."""
    return st.lists(
        prediction_record_strategy(),
        min_size=min_size,
        max_size=max_size,
    )


# ---------------------------------------------------------------------------
# Property 5: Rolling accuracy computation
# ---------------------------------------------------------------------------

class TestRollingAccuracyComputation:
    """
    Feature: continuous-learning-pipeline
    Property 5: Rolling accuracy computation

    *For any* sequence of at least 30 (predicted_direction, actual_direction)
    pairs for a given regime, the rolling 30-forecast accuracy SHALL equal
    the number of correct predictions in the most recent 30 entries divided
    by 30.

    **Validates: Requirements 5.1**
    """

    @given(predictions=predictions_list_strategy(min_size=30, max_size=200))
    @settings(max_examples=100)
    def test_rolling_accuracy_equals_correct_over_window(self, predictions):
        """Rolling accuracy must equal correct predictions in last 30 / 30."""
        window = MIN_ROLLING_WINDOW  # 30

        # Compute using the DriftDetector static method
        result = DriftDetector.compute_rolling_accuracy(predictions, window=window)

        # Independently compute the expected value
        recent = predictions[-window:]
        correct = sum(
            1 for r in recent
            if r["predicted_direction"] == r["actual_direction"]
        )
        expected = correct / window

        assert result == expected, (
            f"Rolling accuracy mismatch: got {result}, expected {expected}. "
            f"Correct predictions in last {window}: {correct}"
        )

    @given(predictions=predictions_list_strategy(min_size=30, max_size=200))
    @settings(max_examples=100)
    def test_rolling_accuracy_is_bounded_zero_to_one(self, predictions):
        """Rolling accuracy must always be in [0, 1]."""
        result = DriftDetector.compute_rolling_accuracy(predictions, window=MIN_ROLLING_WINDOW)

        assert 0.0 <= result <= 1.0, (
            f"Rolling accuracy {result} is outside [0, 1] range"
        )


# ---------------------------------------------------------------------------
# Property 6: Baseline statistics computation
# ---------------------------------------------------------------------------

class TestBaselineStatisticsComputation:
    """
    Feature: continuous-learning-pipeline
    Property 6: Baseline statistics computation

    *For any* sequence of at least 100 (predicted_direction, actual_direction)
    pairs for a given regime, the baseline accuracy SHALL equal the mean of
    rolling 30-forecast accuracies computed over the window, and sigma SHALL
    equal the standard deviation of those rolling accuracies.

    **Validates: Requirements 5.3**
    """

    @given(predictions=predictions_list_strategy(min_size=100, max_size=200))
    @settings(max_examples=100)
    def test_baseline_stats_match_manual_computation(self, predictions):
        """Baseline mean and sigma must match manual rolling window computation."""
        window = MIN_BASELINE_WINDOW  # 100

        # Compute using the DriftDetector static method
        mean_accuracy, sigma = DriftDetector.compute_baseline_stats(predictions, window=window)

        # Independently compute the expected values
        recent = predictions[-window:]
        rolling_accuracies = []
        for i in range(MIN_ROLLING_WINDOW, len(recent) + 1):
            window_slice = recent[i - MIN_ROLLING_WINDOW: i]
            correct = sum(
                1 for r in window_slice
                if r["predicted_direction"] == r["actual_direction"]
            )
            rolling_accuracies.append(correct / MIN_ROLLING_WINDOW)

        expected_mean = float(np.mean(rolling_accuracies))
        expected_sigma = float(np.std(rolling_accuracies, ddof=0))

        assert abs(mean_accuracy - expected_mean) < 1e-9, (
            f"Baseline mean mismatch: got {mean_accuracy}, expected {expected_mean}"
        )
        assert abs(sigma - expected_sigma) < 1e-9, (
            f"Baseline sigma mismatch: got {sigma}, expected {expected_sigma}"
        )

    @given(predictions=predictions_list_strategy(min_size=100, max_size=200))
    @settings(max_examples=100)
    def test_baseline_mean_is_bounded_zero_to_one(self, predictions):
        """Baseline mean accuracy must always be in [0, 1]."""
        mean_accuracy, sigma = DriftDetector.compute_baseline_stats(
            predictions, window=MIN_BASELINE_WINDOW
        )

        assert 0.0 <= mean_accuracy <= 1.0, (
            f"Baseline mean {mean_accuracy} is outside [0, 1] range"
        )
        assert sigma >= 0.0, (
            f"Baseline sigma {sigma} is negative"
        )


# ---------------------------------------------------------------------------
# Property 7: Drift classification formula
# ---------------------------------------------------------------------------

class TestDriftClassificationFormula:
    """
    Feature: continuous-learning-pipeline
    Property 7: Drift classification formula

    *For any* triple (rolling_accuracy, baseline_accuracy, sigma) where all
    values are valid floats and sigma > 0, drift SHALL be classified as true
    if and only if rolling_accuracy < baseline_accuracy - 2 × sigma.

    **Validates: Requirements 5.4**
    """

    @given(
        rolling_accuracy=st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False),
        baseline_accuracy=st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False),
        sigma=st.floats(min_value=0.001, max_value=0.5, allow_nan=False, allow_infinity=False),
    )
    @settings(max_examples=100)
    def test_drift_iff_rolling_below_threshold(self, rolling_accuracy, baseline_accuracy, sigma):
        """Drift is true if and only if rolling_accuracy < baseline_accuracy - 2 * sigma."""
        result = DriftDetector.classify_drift(rolling_accuracy, baseline_accuracy, sigma)

        threshold = baseline_accuracy - DRIFT_SIGMA_THRESHOLD * sigma
        expected = rolling_accuracy < threshold

        assert result == expected, (
            f"Drift classification mismatch: "
            f"rolling={rolling_accuracy}, baseline={baseline_accuracy}, sigma={sigma}, "
            f"threshold={threshold}, got={result}, expected={expected}"
        )

    @given(
        baseline_accuracy=st.floats(min_value=0.2, max_value=0.8, allow_nan=False, allow_infinity=False),
        sigma=st.floats(min_value=0.01, max_value=0.2, allow_nan=False, allow_infinity=False),
    )
    @settings(max_examples=100)
    def test_drift_boundary_just_below(self, baseline_accuracy, sigma):
        """Rolling accuracy just below threshold must trigger drift."""
        threshold = baseline_accuracy - DRIFT_SIGMA_THRESHOLD * sigma
        # Set rolling accuracy slightly below threshold
        rolling_accuracy = threshold - 1e-10

        assume(rolling_accuracy >= 0.0)  # Ensure valid range

        result = DriftDetector.classify_drift(rolling_accuracy, baseline_accuracy, sigma)
        assert result is True, (
            f"Expected drift=True when rolling ({rolling_accuracy}) < threshold ({threshold})"
        )

    @given(
        baseline_accuracy=st.floats(min_value=0.2, max_value=0.8, allow_nan=False, allow_infinity=False),
        sigma=st.floats(min_value=0.01, max_value=0.2, allow_nan=False, allow_infinity=False),
    )
    @settings(max_examples=100)
    def test_drift_boundary_at_or_above(self, baseline_accuracy, sigma):
        """Rolling accuracy at or above threshold must NOT trigger drift."""
        threshold = baseline_accuracy - DRIFT_SIGMA_THRESHOLD * sigma
        # Set rolling accuracy at the threshold
        rolling_accuracy = threshold

        assume(rolling_accuracy >= 0.0 and rolling_accuracy <= 1.0)

        result = DriftDetector.classify_drift(rolling_accuracy, baseline_accuracy, sigma)
        assert result is False, (
            f"Expected drift=False when rolling ({rolling_accuracy}) == threshold ({threshold})"
        )
