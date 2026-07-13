"""
Feature Engineering — extracts ML features from fingerprint data.

Transforms the 5-layer fingerprint state vectors into a flat feature array
suitable for XGBoost classification.

Feature vector (30 dimensions):
  - L1 market_structure summary: 4 (mean, std, min, max)
  - L2 volatility_profile summary: 4 (mean, std, min, max)
  - L4 macro_context: 8 (all dimensions directly)
  - L5 sentiment_pressure: 6 (all dimensions directly)
  - Session one-hot: 3 (london, ny, asia)
  - Volatility regime one-hot: 2 (high, low)
  - Extended scalars: 3 (rolling_trend, atr_percentile, vol_regime_score)
"""

import numpy as np
import json
from typing import Any

# Feature names in order — must match prediction endpoint
FEATURE_NAMES = [
    "l1_mean", "l1_std", "l1_min", "l1_max",
    "l2_mean", "l2_std", "l2_min", "l2_max",
    "macro_event_proximity", "macro_surprise", "macro_rate_diff",
    "macro_high_impact_count", "macro_medium_impact_count",
    "macro_event_density", "macro_upcoming_intensity", "macro_composite",
    "sent_aggregate", "sent_bullish", "sent_bearish",
    "sent_volume", "sent_dispersion", "sent_momentum",
    "session_london", "session_ny", "session_asia",
    "vol_regime_high", "vol_regime_low",
    "ext_rolling_trend", "ext_atr_percentile", "ext_vol_regime_score",
]

NEUTRAL = 0.5


def parse_vector(v: Any) -> list[float]:
    """Parse a vector from DB (could be string, list, or None)."""
    if v is None:
        return []
    if isinstance(v, list):
        return [float(x) for x in v]
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
            if isinstance(parsed, list):
                return [float(x) for x in parsed]
        except (json.JSONDecodeError, ValueError):
            pass
    return []


def extract_features(fingerprint: dict[str, Any]) -> np.ndarray:
    """
    Extract a 30-dimensional feature vector from a fingerprint record.

    Args:
        fingerprint: Dict with keys from market_fingerprints table including
                     market_structure_vector, volatility_vector, macro_vector,
                     sentiment_vector, regime, extended_state (optional)

    Returns:
        numpy array of shape (30,)
    """
    features = []

    # ─── L1: Market Structure (compress 16 → 4) ────────────────────────────
    l1 = parse_vector(fingerprint.get("market_structure_vector"))
    if len(l1) >= 4:
        arr = np.array(l1)
        features.extend([float(arr.mean()), float(arr.std()), float(arr.min()), float(arr.max())])
    else:
        features.extend([NEUTRAL, 0.0, NEUTRAL, NEUTRAL])

    # ─── L2: Volatility Profile (compress 12 → 4) ──────────────────────────
    l2 = parse_vector(fingerprint.get("volatility_vector"))
    if len(l2) >= 4:
        arr = np.array(l2)
        features.extend([float(arr.mean()), float(arr.std()), float(arr.min()), float(arr.max())])
    else:
        features.extend([NEUTRAL, 0.0, NEUTRAL, NEUTRAL])

    # ─── L4: Macro Context (all 8 dims) ────────────────────────────────────
    l4 = parse_vector(fingerprint.get("macro_vector"))
    if len(l4) == 8:
        features.extend(l4)
    else:
        features.extend([NEUTRAL] * 8)

    # ─── L5: Sentiment Pressure (all 6 dims) ───────────────────────────────
    l5 = parse_vector(fingerprint.get("sentiment_vector"))
    if len(l5) == 6:
        features.extend(l5)
    else:
        features.extend([NEUTRAL] * 6)

    # ─── Session One-Hot ────────────────────────────────────────────────────
    regime = fingerprint.get("regime") or {}
    if isinstance(regime, str):
        try:
            regime = json.loads(regime)
        except (json.JSONDecodeError, ValueError):
            regime = {}

    session = regime.get("session", "").upper()
    features.append(1.0 if session == "LONDON" else 0.0)
    features.append(1.0 if session == "NY" else 0.0)
    features.append(1.0 if session == "ASIA" else 0.0)

    # ─── Volatility Regime One-Hot ──────────────────────────────────────────
    vol_regime = regime.get("volatility_regime", "").upper()
    features.append(1.0 if vol_regime == "HIGH" else 0.0)
    features.append(1.0 if vol_regime == "LOW" else 0.0)

    # ─── Extended Features (from extended_state if available) ───────────────
    extended = fingerprint.get("extended_state") or {}
    if isinstance(extended, str):
        try:
            extended = json.loads(extended)
        except (json.JSONDecodeError, ValueError):
            extended = {}

    features.append(float(extended.get("rolling_trend", NEUTRAL)))
    features.append(float(extended.get("atr_percentile", NEUTRAL)))
    features.append(float(extended.get("volatility_regime_score", NEUTRAL)))

    assert len(features) == len(FEATURE_NAMES), (
        f"Feature count mismatch: got {len(features)}, expected {len(FEATURE_NAMES)}"
    )

    return np.array(features, dtype=np.float32)
