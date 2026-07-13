"""
Model Store — holds the trained XGBoost model in memory.

Singleton pattern: one model loaded at a time.
"""

import xgboost as xgb
import numpy as np
from typing import Optional
import uuid
import json
import os

MODEL_PATH = "/tmp/fip_model.xgb"
METADATA_PATH = "/tmp/fip_model_meta.json"


class ModelStore:
    _instance: Optional["ModelStore"] = None

    def __init__(self):
        self._model: Optional[xgb.XGBClassifier] = None
        self._version: Optional[str] = None
        self._feature_count: int = 0
        self._training_samples: int = 0
        self._accuracy: float = 0.0

    @classmethod
    def get_instance(cls) -> "ModelStore":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def is_loaded(self) -> bool:
        return self._model is not None

    def get_version(self) -> Optional[str]:
        return self._version

    def get_feature_count(self) -> int:
        return self._feature_count

    def get_training_samples(self) -> int:
        return self._training_samples

    def get_accuracy(self) -> float:
        return self._accuracy

    def load_if_available(self):
        """Load model from disk if previously saved."""
        if os.path.exists(MODEL_PATH) and os.path.exists(METADATA_PATH):
            try:
                self._model = xgb.XGBClassifier()
                self._model.load_model(MODEL_PATH)
                with open(METADATA_PATH, "r") as f:
                    meta = json.load(f)
                self._version = meta.get("version")
                self._feature_count = meta.get("feature_count", 0)
                self._training_samples = meta.get("training_samples", 0)
                self._accuracy = meta.get("accuracy", 0.0)
                print(f"[ModelStore] Loaded model v{self._version} ({self._feature_count} features)")
            except Exception as e:
                print(f"[ModelStore] Failed to load model: {e}")
                self._model = None

    def store(
        self,
        model: xgb.XGBClassifier,
        feature_count: int,
        training_samples: int,
        accuracy: float,
    ):
        """Store a newly trained model."""
        version = str(uuid.uuid4())[:8]
        self._model = model
        self._version = version
        self._feature_count = feature_count
        self._training_samples = training_samples
        self._accuracy = accuracy

        # Persist to disk for cold-start recovery
        model.save_model(MODEL_PATH)
        with open(METADATA_PATH, "w") as f:
            json.dump({
                "version": version,
                "feature_count": feature_count,
                "training_samples": training_samples,
                "accuracy": accuracy,
            }, f)

        print(f"[ModelStore] Stored model v{version} ({feature_count} features, {training_samples} samples, acc={accuracy:.4f})")

    def predict(self, features: np.ndarray) -> np.ndarray:
        """
        Predict class probabilities.
        Returns array of [P(up), P(down), P(flat)].
        """
        if self._model is None:
            raise RuntimeError("No model loaded")

        X = features.reshape(1, -1)
        probs = self._model.predict_proba(X)[0]
        return probs
