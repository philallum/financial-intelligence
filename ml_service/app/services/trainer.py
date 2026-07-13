"""
Training Service — fetches data from Supabase, engineers features, trains XGBoost.

Walk-forward validation: data sorted chronologically, last N% as test.
No data leakage: train/test split is temporal, not random.
"""

import numpy as np
import xgboost as xgb
from sklearn.metrics import accuracy_score, f1_score, classification_report
import httpx
import os
from typing import Any

from app.services.model_store import ModelStore
from app.services.feature_engineer import extract_features, FEATURE_NAMES

# Direction classification thresholds (same as outcome engine)
# Using a fixed 2-pip threshold for training labels (dynamic threshold is runtime only)
FLAT_THRESHOLD_PIPS = 2.0


async def _supabase_query(table: str, params: str) -> list[dict]:
    """Query Supabase REST API directly with httpx."""
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

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


async def train_model(
    test_split: float = 0.2,
    min_samples: int = 500,
    n_estimators: int = 200,
    max_depth: int = 5,
    learning_rate: float = 0.05,
) -> dict[str, Any]:
    """
    Train XGBoost 3-class classifier on historical fingerprint data.

    Steps:
    1. Fetch fingerprints + outcomes from Supabase
    2. Extract feature vectors from state layers
    3. Label outcomes as UP/DOWN/FLAT based on forward returns
    4. Walk-forward split (last test_split% chronologically)
    5. Train XGBoost multi:softprob
    6. Evaluate on test set
    7. Store model

    Returns training metrics.
    """
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    if not supabase_url or not supabase_key:
        raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")

    # Fetch fingerprints with their forward outcomes using REST API
    print("[Trainer] Fetching fingerprints...")
    fingerprints = await _supabase_query(
        "market_fingerprints",
        "select=fingerprint_id,timestamp_utc,regime,market_structure_vector,volatility_vector,macro_vector,sentiment_vector,extended_state&order=timestamp_utc.asc&limit=15000"
    )

    if not fingerprints:
        raise ValueError("No fingerprints found in database")

    print(f"[Trainer] Fetched {len(fingerprints)} fingerprints")

    # Fetch outcomes
    print("[Trainer] Fetching outcomes...")
    outcome_data = await _supabase_query(
        "market_outcomes",
        "select=fingerprint_id,net_return_pips&limit=15000"
    )

    outcomes = {o["fingerprint_id"]: o["net_return_pips"] for o in outcome_data}
    print(f"[Trainer] Fetched {len(outcomes)} outcomes")

    # Build training dataset: only fingerprints that have outcomes
    X_list = []
    y_list = []
    skipped = 0

    for fp in fingerprints:
        fp_id = fp["fingerprint_id"]
        if fp_id not in outcomes:
            skipped += 1
            continue

        # Extract features from fingerprint
        try:
            features = extract_features(fp)
        except Exception:
            skipped += 1
            continue

        # Label based on forward return
        net_return = outcomes[fp_id]
        if abs(net_return) <= FLAT_THRESHOLD_PIPS:
            label = 2  # FLAT
        elif net_return > FLAT_THRESHOLD_PIPS:
            label = 0  # UP
        else:
            label = 1  # DOWN

        X_list.append(features)
        y_list.append(label)

    print(f"[Trainer] Built dataset: {len(X_list)} samples ({skipped} skipped)")

    if len(X_list) < min_samples:
        raise ValueError(
            f"Insufficient training data: {len(X_list)} samples (need {min_samples})"
        )

    X = np.array(X_list, dtype=np.float32)
    y = np.array(y_list, dtype=np.int32)

    # Walk-forward split: last test_split% is test data (temporal, no leakage)
    split_idx = int(len(X) * (1 - test_split))
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]

    print(f"[Trainer] Train: {len(X_train)}, Test: {len(X_test)}")

    # Train XGBoost
    model = xgb.XGBClassifier(
        objective="multi:softprob",
        num_class=3,
        n_estimators=n_estimators,
        max_depth=max_depth,
        learning_rate=learning_rate,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=5,
        reg_alpha=0.1,
        reg_lambda=1.0,
        eval_metric="mlogloss",
        use_label_encoder=False,
        verbosity=0,
        random_state=42,
    )

    model.fit(
        X_train, y_train,
        eval_set=[(X_test, y_test)],
        verbose=False,
    )

    # Evaluate
    y_pred = model.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)
    f1 = f1_score(y_test, y_pred, average="weighted")

    # Per-class accuracy
    class_names = ["up", "down", "flat"]
    per_class = {}
    for cls_idx, cls_name in enumerate(class_names):
        mask = y_test == cls_idx
        if mask.sum() > 0:
            per_class[cls_name] = float((y_pred[mask] == cls_idx).mean())
        else:
            per_class[cls_name] = 0.0

    print(f"[Trainer] Results: accuracy={accuracy:.4f}, f1={f1:.4f}")
    print(f"[Trainer] Per-class: {per_class}")

    # Store model
    store = ModelStore.get_instance()
    store.store(model, len(FEATURE_NAMES), len(X_train), accuracy)

    return {
        "training_samples": len(X_train),
        "test_samples": len(X_test),
        "accuracy": round(accuracy, 6),
        "f1_weighted": round(f1, 6),
        "per_class_accuracy": per_class,
        "model_version": store.get_version(),
        "feature_count": len(FEATURE_NAMES),
    }
