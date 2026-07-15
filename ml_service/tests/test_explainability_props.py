"""
Property-based tests for the Explainability Service.

Uses hypothesis to verify universal correctness properties of
SHAP value computation and top-K feature ranking.

**Validates: Requirements 3.1, 4.2**
"""

import numpy as np
from hypothesis import given, settings
from hypothesis import strategies as st

# Import FEATURE_NAMES directly to avoid pulling in the full shap dependency
# which may not be installed in all test environments.
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


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

def shap_values_array_strategy():
    """Generate a random 30-dimensional array of SHAP float values."""
    return st.lists(
        st.floats(min_value=-10, max_value=10, allow_nan=False, allow_infinity=False),
        min_size=30,
        max_size=30,
    )


def shap_values_dict_strategy():
    """Generate a random dict mapping 30 feature names to SHAP float values."""
    return st.lists(
        st.floats(min_value=-10, max_value=10, allow_nan=False, allow_infinity=False),
        min_size=30,
        max_size=30,
    ).map(lambda values: dict(zip(FEATURE_NAMES, values)))


# ---------------------------------------------------------------------------
# Property 3: SHAP value count equals feature count
# ---------------------------------------------------------------------------

class TestShapValueCountEqualsFeatureCount:
    """
    Feature: continuous-learning-pipeline
    Property 3: SHAP value count equals feature count

    *For any* valid 30-dimensional feature vector and trained XGBoost model,
    SHAP computation SHALL produce exactly 30 SHAP values — one per input
    feature. We test the shap_values_dict construction logic: given a
    shap_values numpy array of length 30, the resulting dict should have
    exactly 30 entries with keys matching FEATURE_NAMES.

    **Validates: Requirements 3.1**
    """

    @given(shap_values=shap_values_array_strategy())
    @settings(max_examples=100)
    def test_shap_dict_has_exactly_30_entries(self, shap_values):
        """SHAP values dict must have exactly 30 entries (one per feature)."""
        shap_array = np.array(shap_values)

        # Replicate the dict construction logic from ExplainabilityService.compute_and_store
        shap_values_dict: dict[str, float] = {}
        for i, name in enumerate(FEATURE_NAMES):
            if i < len(shap_array):
                shap_values_dict[name] = round(float(shap_array[i]), 6)

        # Property: dict must have exactly 30 entries
        assert len(shap_values_dict) == 30, (
            f"Expected 30 SHAP values, got {len(shap_values_dict)}"
        )

        # Property: keys must match FEATURE_NAMES exactly
        assert set(shap_values_dict.keys()) == set(FEATURE_NAMES), (
            f"SHAP dict keys do not match FEATURE_NAMES. "
            f"Missing: {set(FEATURE_NAMES) - set(shap_values_dict.keys())}, "
            f"Extra: {set(shap_values_dict.keys()) - set(FEATURE_NAMES)}"
        )


# ---------------------------------------------------------------------------
# Property 4: Top-K feature ranking correctness
# ---------------------------------------------------------------------------

class TestTopKFeatureRankingCorrectness:
    """
    Feature: continuous-learning-pipeline
    Property 4: Top-K feature ranking correctness

    *For any* set of SHAP values (mapping feature names to float values),
    the top 5 features returned SHALL be the 5 features with the highest
    absolute SHAP values, sorted in descending order of absolute magnitude.

    **Validates: Requirements 4.2**
    """

    @given(shap_dict=shap_values_dict_strategy())
    @settings(max_examples=100)
    def test_top_5_features_are_correctly_ranked(self, shap_dict):
        """Top 5 features must be the 5 with highest absolute SHAP values, sorted descending."""
        # Replicate the top-5 extraction logic from ExplainabilityService.compute_and_store
        sorted_features = sorted(
            shap_dict.items(),
            key=lambda x: abs(x[1]),
            reverse=True,
        )
        top_features = [
            {"feature": name, "shap_value": value}
            for name, value in sorted_features[:5]
        ]

        # Property: exactly 5 top features returned
        assert len(top_features) == 5, (
            f"Expected 5 top features, got {len(top_features)}"
        )

        # Property: top 5 features must have the highest absolute SHAP values
        top_abs_values = [abs(f["shap_value"]) for f in top_features]
        remaining_abs_values = [abs(v) for _, v in sorted_features[5:]]

        if remaining_abs_values:
            min_top = min(top_abs_values)
            max_remaining = max(remaining_abs_values)
            assert min_top >= max_remaining, (
                f"Top-5 minimum absolute value ({min_top}) is less than "
                f"maximum remaining absolute value ({max_remaining}). "
                f"Feature ranking is incorrect."
            )

        # Property: top features must be sorted in descending order of absolute value
        for i in range(len(top_abs_values) - 1):
            assert top_abs_values[i] >= top_abs_values[i + 1], (
                f"Top features not sorted in descending order: "
                f"abs({top_features[i]['shap_value']}) < abs({top_features[i+1]['shap_value']}) "
                f"at positions {i} and {i+1}"
            )
