"""Tests for feature engineering."""

import numpy as np
from app.services.feature_engineer import extract_features, FEATURE_NAMES, NEUTRAL


def test_extract_features_full_data():
    """Test feature extraction with complete fingerprint data."""
    fp = {
        "market_structure_vector": [0.3, 0.5, 0.7, 0.4, 0.6, 0.8, 0.2, 0.9,
                                     0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        "volatility_vector": [0.4, 0.6, 0.3, 0.7, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
        "macro_vector": [0.8, 0.4, 0.5, 0.6, 0.3, 0.35, 0.7, 0.55],
        "sentiment_vector": [0.72, 0.65, 0.15, 0.48, 0.22, 0.61],
        "regime": {"volatility_regime": "HIGH", "trend_regime": "BULLISH", "session": "LONDON"},
        "extended_state": {"rolling_trend": 0.7, "atr_percentile": 0.85, "volatility_regime_score": 0.9},
    }

    features = extract_features(fp)

    assert len(features) == len(FEATURE_NAMES)
    assert features.dtype == np.float32
    # Session should be London
    assert features[22] == 1.0  # session_london
    assert features[23] == 0.0  # session_ny
    assert features[24] == 0.0  # session_asia
    # Vol regime HIGH
    assert features[25] == 1.0  # vol_regime_high
    assert features[26] == 0.0  # vol_regime_low
    # Extended
    assert features[27] == 0.7  # rolling_trend
    assert features[28] == 0.85  # atr_percentile


def test_extract_features_missing_data():
    """Test feature extraction with missing vectors (should use neutral defaults)."""
    fp = {
        "market_structure_vector": None,
        "volatility_vector": None,
        "macro_vector": None,
        "sentiment_vector": None,
        "regime": None,
    }

    features = extract_features(fp)

    assert len(features) == len(FEATURE_NAMES)
    # L1 compressed should be neutral
    assert features[0] == NEUTRAL  # l1_mean
    # All macro should be neutral
    for i in range(8, 16):
        assert features[i] == NEUTRAL
    # Session should all be 0
    assert features[22] == 0.0
    assert features[23] == 0.0
    assert features[24] == 0.0


def test_extract_features_string_vectors():
    """Test that string-encoded vectors (from pgvector) are parsed correctly."""
    fp = {
        "market_structure_vector": "[0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]",
        "volatility_vector": "[0.4,0.4,0.4,0.4,0.4,0.4,0.4,0.4,0.4,0.4,0.4,0.4]",
        "macro_vector": "[0.8,0.4,0.5,0.6,0.3,0.35,0.7,0.55]",
        "sentiment_vector": "[0.72,0.65,0.15,0.48,0.22,0.61]",
        "regime": '{"volatility_regime": "NORMAL", "trend_regime": "RANGING", "session": "NY"}',
    }

    features = extract_features(fp)

    assert len(features) == len(FEATURE_NAMES)
    assert features[0] == 0.5  # l1_mean (all 0.5)
    assert features[23] == 1.0  # session_ny
