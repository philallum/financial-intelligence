"""
Unit tests for the explainability router endpoints.

Tests GET /v1/forecast/{asset}/explain with existing data,
missing data (404), and unsupported asset (400).

Validates: Requirements 4.1, 4.2, 4.3, 4.4
"""

import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from fastapi.testclient import TestClient

from app.main import app
from app.services.explainability import ExplainabilityService


@pytest.fixture(autouse=True)
def reset_explainability_service():
    """Reset the ExplainabilityService singleton before each test."""
    ExplainabilityService._instance = None
    yield
    ExplainabilityService._instance = None


@pytest.fixture
def client():
    """Create a FastAPI TestClient."""
    return TestClient(app)


@pytest.fixture
def valid_explanation():
    """Return a valid explanation dict as would be returned by get_latest."""
    return {
        "forecast_id": "abc-123",
        "asset": "EURUSD",
        "timestamp_utc": "2026-07-20T12:02:00+00:00",
        "base_value": 0.33,
        "shap_values": {"l1_mean": 0.05, "sent_0": -0.12, "macro_0": 0.08},
        "top_features": [
            {"feature": "sent_0", "shap_value": -0.12},
            {"feature": "macro_0", "shap_value": 0.08},
            {"feature": "l1_mean", "shap_value": 0.05},
            {"feature": "vol_regime_high", "shap_value": 0.04},
            {"feature": "session_london", "shap_value": 0.03},
        ],
        "model_version": "a1b2c3d4",
    }


class TestExplainEndpoint:
    """Tests for GET /v1/forecast/{asset}/explain endpoint."""

    def test_explain_with_existing_data(self, client, valid_explanation):
        """When explanation data exists, returns 200 with correct shape."""
        with patch.object(ExplainabilityService, "get_instance") as mock_get:
            mock_service = MagicMock()
            mock_service.get_latest = AsyncMock(return_value=valid_explanation)
            mock_get.return_value = mock_service

            response = client.get("/v1/forecast/EURUSD/explain")

        assert response.status_code == 200
        data = response.json()
        assert data["forecast_id"] == "abc-123"
        assert data["asset"] == "EURUSD"
        assert data["timestamp_utc"] == "2026-07-20T12:02:00+00:00"
        assert data["base_value"] == 0.33
        assert data["shap_values"] == {"l1_mean": 0.05, "sent_0": -0.12, "macro_0": 0.08}
        assert len(data["top_features"]) == 5
        assert data["top_features"][0] == {"feature": "sent_0", "shap_value": -0.12}
        assert data["model_version"] == "a1b2c3d4"

    def test_explain_no_data_404(self, client):
        """When no explanation exists for the asset, returns 404."""
        with patch.object(ExplainabilityService, "get_instance") as mock_get:
            mock_service = MagicMock()
            mock_service.get_latest = AsyncMock(return_value=None)
            mock_get.return_value = mock_service

            response = client.get("/v1/forecast/EURUSD/explain")

        assert response.status_code == 404
        data = response.json()
        assert "No explanation available" in data["detail"]

    def test_explain_unsupported_asset_400(self, client):
        """Unsupported asset returns 400 with descriptive message."""
        response = client.get("/v1/forecast/GBPJPY/explain")

        assert response.status_code == 400
        data = response.json()
        assert "Unsupported asset" in data["detail"]
