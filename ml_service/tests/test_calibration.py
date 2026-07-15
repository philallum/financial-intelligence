"""
Unit tests for the calibration router endpoints.

Tests POST /calibrate (with and without model loaded) and
POST /calibrate/train (success and insufficient data cases).

Validates: Requirements 1.2, 1.5, 2.3, 2.4
"""

import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from fastapi.testclient import TestClient

from app.main import app
from app.services.calibration import CalibrationService, InsufficientDataError, CalibrationTrainResult


@pytest.fixture(autouse=True)
def reset_calibration_service():
    """Reset the CalibrationService singleton before each test."""
    CalibrationService._instance = None
    yield
    CalibrationService._instance = None


@pytest.fixture
def client():
    """Create a FastAPI TestClient."""
    return TestClient(app)


class TestCalibrateEndpoint:
    """Tests for POST /calibrate endpoint."""

    def test_calibrate_no_model_loaded(self, client):
        """When no calibration model is loaded, returns raw probs with calibrated=false."""
        # Service with no model loaded returns raw probs
        with patch.object(CalibrationService, "get_instance") as mock_get:
            mock_service = MagicMock()
            mock_service.calibrate.return_value = {
                "up": 0.5,
                "down": 0.3,
                "flat": 0.2,
                "calibrated": False,
                "model_version": None,
            }
            mock_get.return_value = mock_service

            response = client.post("/calibrate", json={"up": 0.5, "down": 0.3, "flat": 0.2})

        assert response.status_code == 200
        data = response.json()
        assert data["up"] == 0.5
        assert data["down"] == 0.3
        assert data["flat"] == 0.2
        assert data["calibrated"] is False
        assert data["model_version"] is None

    def test_calibrate_model_loaded(self, client):
        """When calibration model is loaded, returns calibrated probs with calibrated=true."""
        with patch.object(CalibrationService, "get_instance") as mock_get:
            mock_service = MagicMock()
            mock_service.calibrate.return_value = {
                "up": 0.55,
                "down": 0.25,
                "flat": 0.20,
                "calibrated": True,
                "model_version": "cal-v1-2025-01-15",
            }
            mock_get.return_value = mock_service

            response = client.post("/calibrate", json={"up": 0.5, "down": 0.3, "flat": 0.2})

        assert response.status_code == 200
        data = response.json()
        assert data["up"] == 0.55
        assert data["down"] == 0.25
        assert data["flat"] == 0.20
        assert data["calibrated"] is True
        assert data["model_version"] == "cal-v1-2025-01-15"

    def test_calibrate_passes_correct_probs_to_service(self, client):
        """Verifies the endpoint passes the request body correctly to the service."""
        with patch.object(CalibrationService, "get_instance") as mock_get:
            mock_service = MagicMock()
            mock_service.calibrate.return_value = {
                "up": 0.6,
                "down": 0.2,
                "flat": 0.2,
                "calibrated": False,
                "model_version": None,
            }
            mock_get.return_value = mock_service

            client.post("/calibrate", json={"up": 0.6, "down": 0.2, "flat": 0.2})

        mock_service.calibrate.assert_called_once_with({
            "up": 0.6,
            "down": 0.2,
            "flat": 0.2,
        })

    def test_calibrate_invalid_request_missing_field(self, client):
        """Missing required field returns 422 validation error."""
        response = client.post("/calibrate", json={"up": 0.5, "down": 0.3})
        assert response.status_code == 422


class TestCalibrateTrainEndpoint:
    """Tests for POST /calibrate/train endpoint."""

    def test_train_success(self, client):
        """Successful training returns metrics with status 200."""
        train_result = CalibrationTrainResult(
            sample_count=100,
            pre_calibration_error=0.15,
            post_calibration_error=0.08,
            model_version="cal-v1-2025-01-15",
        )

        with patch.object(CalibrationService, "get_instance") as mock_get:
            mock_service = MagicMock()
            mock_service.train = AsyncMock(return_value=train_result)
            mock_get.return_value = mock_service

            response = client.post("/calibrate/train")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "trained"
        assert data["sample_count"] == 100
        assert data["pre_calibration_error"] == 0.15
        assert data["post_calibration_error"] == 0.08
        assert data["model_version"] == "cal-v1-2025-01-15"

    def test_train_insufficient_data(self, client):
        """Insufficient data (< 50 records) returns 400 error."""
        with patch.object(CalibrationService, "get_instance") as mock_get:
            mock_service = MagicMock()
            mock_service.train = AsyncMock(
                side_effect=InsufficientDataError(
                    "Insufficient evaluation data: 25 records (minimum 50 required)"
                )
            )
            mock_get.return_value = mock_service

            response = client.post("/calibrate/train")

        assert response.status_code == 400
        data = response.json()
        assert "Insufficient evaluation data" in data["detail"]
        assert "25 records" in data["detail"]

    def test_train_internal_error(self, client):
        """Unexpected error during training returns 500."""
        with patch.object(CalibrationService, "get_instance") as mock_get:
            mock_service = MagicMock()
            mock_service.train = AsyncMock(
                side_effect=Exception("Connection timeout")
            )
            mock_get.return_value = mock_service

            response = client.post("/calibrate/train")

        assert response.status_code == 500
        data = response.json()
        assert "Calibration training failed" in data["detail"]
