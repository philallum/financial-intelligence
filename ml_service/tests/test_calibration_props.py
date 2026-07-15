"""
Property-based tests for the Calibration Service.

Uses hypothesis to verify universal correctness properties of
isotonic regression calibration.

**Validates: Requirements 1.3, 2.1, 2.2, 12.1**
"""

import os
import tempfile

import numpy as np
from hypothesis import given, settings, assume
from hypothesis import strategies as st
from sklearn.isotonic import IsotonicRegression

from app.services.calibration import CalibrationService, MODEL_PATH, METADATA_PATH


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

def probability_vector_strategy():
    """Generate a valid probability vector [up, down, flat] summing to 1.0."""
    return st.tuples(
        st.floats(min_value=0.01, max_value=0.98),
        st.floats(min_value=0.01, max_value=0.98),
    ).filter(
        lambda t: t[0] + t[1] < 0.99
    ).map(
        lambda t: (t[0], t[1], 1.0 - t[0] - t[1])
    )


def outcome_dataset_strategy(min_size=50, max_size=200):
    """
    Generate a dataset of (predicted_probability, actual_outcome) pairs.
    predicted ∈ [0, 1], outcome ∈ {0, 1}.
    Returns list of (pred, actual) tuples.
    """
    return st.lists(
        st.tuples(
            st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False),
            st.sampled_from([0.0, 1.0]),
        ),
        min_size=min_size,
        max_size=max_size,
    )


# ---------------------------------------------------------------------------
# Property 1: Calibration Training Reduces Error
# ---------------------------------------------------------------------------

class TestCalibrationTrainingReducesError:
    """
    Feature: continuous-learning-pipeline
    Property 1: Calibration training reduces error

    *For any* dataset of at least 50 (predicted_probability, actual_outcome)
    pairs drawn from valid ranges (predicted ∈ [0,1], outcome ∈ {0,1}),
    training isotonic regression on this dataset SHALL produce a
    post-training calibration error less than or equal to the pre-training
    calibration error.

    **Validates: Requirements 1.3**
    """

    @given(dataset=outcome_dataset_strategy(min_size=50, max_size=200))
    @settings(max_examples=100)
    def test_calibration_training_reduces_error(self, dataset):
        """Post-calibration error must be ≤ pre-calibration error.

        Isotonic regression minimises mean squared error subject to a
        monotonicity constraint.  The fitted values on training data are
        therefore guaranteed to have MSE ≤ that of the raw predictions
        (which are generally not monotone w.r.t. outcomes).  We verify
        this using MSE, which is the native loss function of isotonic
        regression and aligns with the calibration error metric in
        spirit (lower error = better calibration).
        """
        predictions = np.array([d[0] for d in dataset])
        actuals = np.array([d[1] for d in dataset])

        # Require meaningful variance in predictions so isotonic regression
        # has sufficient data points to fit a useful monotonic function.
        unique_preds = np.unique(predictions)
        assume(len(unique_preds) >= 10)
        assume(np.std(predictions) > 0.1)
        # Ensure both outcome classes are present
        assume(np.sum(actuals == 0.0) >= 5)
        assume(np.sum(actuals == 1.0) >= 5)

        # Pre-calibration error: mean squared error between raw predictions and outcomes
        pre_error = float(np.mean((predictions - actuals) ** 2))

        # Train isotonic regression
        model = IsotonicRegression(out_of_bounds="clip")
        model.fit(predictions, actuals)

        # Post-calibration error
        calibrated = model.predict(predictions)
        post_error = float(np.mean((calibrated - actuals) ** 2))

        # Isotonic regression on training data should not increase squared error
        assert post_error <= pre_error + 1e-9, (
            f"Post-calibration MSE ({post_error:.6f}) exceeded "
            f"pre-calibration MSE ({pre_error:.6f})"
        )


# ---------------------------------------------------------------------------
# Property 2: Calibration Output is Valid Probability Distribution
# ---------------------------------------------------------------------------

class TestCalibrationOutputValidDistribution:
    """
    Feature: continuous-learning-pipeline
    Property 2: Calibration output is valid probability distribution

    *For any* input probability vector [up, down, flat] where each
    component ∈ [0, 1] and the sum equals 1.0, applying calibration and
    renormalisation SHALL produce an output vector where each component ∈
    [0, 1] and the components sum to 1.0 (within floating-point tolerance
    of ±1e-9).

    **Validates: Requirements 2.1, 2.2**
    """

    @given(prob_vector=probability_vector_strategy())
    @settings(max_examples=100)
    def test_calibration_output_is_valid_probability_distribution(self, prob_vector):
        """Calibrated output must be a valid probability distribution."""
        up, down, flat = prob_vector

        # Set up a CalibrationService with trained models in memory
        service = CalibrationService()

        # Train simple isotonic models with synthetic known data
        # Use a range of probabilities to ensure the model can interpolate
        train_preds = np.linspace(0.0, 1.0, 100)
        # Outcomes roughly correlate with predictions (realistic calibration data)
        rng = np.random.default_rng(42)
        train_outcomes = (rng.random(100) < train_preds).astype(float)

        model_up = IsotonicRegression(out_of_bounds="clip")
        model_down = IsotonicRegression(out_of_bounds="clip")
        model_flat = IsotonicRegression(out_of_bounds="clip")

        model_up.fit(train_preds, train_outcomes)
        model_down.fit(train_preds, train_outcomes)
        model_flat.fit(train_preds, train_outcomes)

        service._models = {"up": model_up, "down": model_down, "flat": model_flat}
        service._version = "test-v1"

        # Apply calibration
        result = service.calibrate({"up": up, "down": down, "flat": flat})

        # If calibration was applied, check the output is valid
        if result["calibrated"]:
            cal_up = result["up"]
            cal_down = result["down"]
            cal_flat = result["flat"]

            # Each component must be in [0, 1]
            assert 0.0 <= cal_up <= 1.0, f"cal_up={cal_up} out of [0, 1]"
            assert 0.0 <= cal_down <= 1.0, f"cal_down={cal_down} out of [0, 1]"
            assert 0.0 <= cal_flat <= 1.0, f"cal_flat={cal_flat} out of [0, 1]"

            # Components must sum to 1.0 within tolerance.
            # The service rounds each component to 6 decimal places,
            # so the maximum deviation from 1.0 is 3 * 0.5e-6 = 1.5e-6.
            # We use a tolerance that accounts for this rounding.
            total = cal_up + cal_down + cal_flat
            assert abs(total - 1.0) < 2e-6, (
                f"Calibrated probabilities sum to {total}, expected 1.0"
            )
        else:
            # If calibration was not applied (e.g., all calibrated values
            # were zero leading to sum <= 0), the raw probs are returned —
            # which are already a valid distribution by construction
            pass


# ---------------------------------------------------------------------------
# Property 10: Calibration Model Serialisation Round-Trip
# ---------------------------------------------------------------------------

class TestCalibrationSerialisationRoundTrip:
    """
    Feature: continuous-learning-pipeline
    Property 10: Calibration model serialisation round-trip

    *For any* trained calibration model and any valid probability vector,
    serialising the model to disk and deserialising it SHALL produce a
    model that returns identical calibrated outputs for the same input
    vector.

    **Validates: Requirements 12.1**
    """

    @given(prob_vector=probability_vector_strategy())
    @settings(max_examples=100)
    def test_calibration_serialisation_round_trip(self, prob_vector):
        """Serialised and deserialised model produces identical outputs."""
        up, down, flat = prob_vector

        # Use a temporary directory to avoid conflicts with other tests
        with tempfile.TemporaryDirectory() as tmpdir:
            model_path = os.path.join(tmpdir, "calibration_model.joblib")
            meta_path = os.path.join(tmpdir, "calibration_meta.json")

            # Monkey-patch the module-level paths for this test
            import app.services.calibration as cal_module
            original_model_path = cal_module.MODEL_PATH
            original_meta_path = cal_module.METADATA_PATH
            cal_module.MODEL_PATH = model_path
            cal_module.METADATA_PATH = meta_path

            try:
                # Create and train a CalibrationService
                service_original = CalibrationService()

                train_preds = np.linspace(0.0, 1.0, 100)
                rng = np.random.default_rng(123)
                train_outcomes = (rng.random(100) < train_preds).astype(float)

                model_up = IsotonicRegression(out_of_bounds="clip")
                model_down = IsotonicRegression(out_of_bounds="clip")
                model_flat = IsotonicRegression(out_of_bounds="clip")

                model_up.fit(train_preds, train_outcomes)
                model_down.fit(train_preds, train_outcomes)
                model_flat.fit(train_preds, train_outcomes)

                service_original._models = {
                    "up": model_up,
                    "down": model_down,
                    "flat": model_flat,
                }
                service_original._version = "test-roundtrip-v1"
                service_original._sample_count = 100
                service_original._calibration_error = 0.05

                # Get calibration result before serialisation
                result_before = service_original.calibrate(
                    {"up": up, "down": down, "flat": flat}
                )

                # Serialise
                service_original.save()

                # Create a fresh service and deserialise
                service_loaded = CalibrationService()
                service_loaded.load_if_available()

                assert service_loaded.is_loaded(), "Model should be loaded after deserialisation"

                # Get calibration result after deserialisation
                result_after = service_loaded.calibrate(
                    {"up": up, "down": down, "flat": flat}
                )

                # Results must be identical
                assert result_before["up"] == result_after["up"], (
                    f"up mismatch: {result_before['up']} vs {result_after['up']}"
                )
                assert result_before["down"] == result_after["down"], (
                    f"down mismatch: {result_before['down']} vs {result_after['down']}"
                )
                assert result_before["flat"] == result_after["flat"], (
                    f"flat mismatch: {result_before['flat']} vs {result_after['flat']}"
                )
                assert result_before["calibrated"] == result_after["calibrated"], (
                    f"calibrated flag mismatch"
                )

            finally:
                # Restore original paths
                cal_module.MODEL_PATH = original_model_path
                cal_module.METADATA_PATH = original_meta_path
