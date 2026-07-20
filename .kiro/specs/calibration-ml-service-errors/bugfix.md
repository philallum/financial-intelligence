# Bugfix Requirements Document

## Introduction

The dashboard's Developer View shows two related errors in the Continuous Learning Pipeline card:
1. "Calibration not applied — predictions are using raw uncalibrated probabilities"
2. `failure_reason: "ml_service_unavailable"`

The root cause is that the `ML_SERVICE_URL` environment variable is not configured in the project's `.env` file or `.env.example`, so the batch pipeline (`src/batch-entry.ts`) cannot reach the ML service to obtain XGBoost predictions or apply calibration. When `ML_SERVICE_URL` is undefined, the pipeline records `calibration_applied: false` and `failure_reason: 'ml_service_unavailable'` in the `batch_diagnostics` table. The dashboard reads this data and displays the error alerts.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the batch pipeline runs locally without `ML_SERVICE_URL` set in the environment THEN the system records `calibration_applied: false` and `failure_reason: "ml_service_unavailable"` in batch diagnostics, causing permanent error display on the dashboard

1.2 WHEN `ML_SERVICE_URL` is not documented in `.env.example` THEN developers have no guidance on how to configure the ML service connection, leading to the unconfigured state being the default

1.3 WHEN the ML service is running locally (e.g., on port 5000) but `ML_SERVICE_URL` is not set THEN the batch pipeline skips the ML prediction and calibration entirely rather than attempting to connect to a default local URL

1.4 WHEN the batch pipeline cannot reach the ML service (network timeout, service down) THEN the dashboard shows a permanent red "Calibration not applied" alert with no actionable guidance for the operator on how to resolve the issue

### Expected Behavior (Correct)

2.1 WHEN the batch pipeline runs locally THEN the system SHALL use a default `ML_SERVICE_URL` value (e.g., `http://localhost:5000`) if the environment variable is not explicitly set, allowing connection to a locally running ML service

2.2 WHEN configuring the project environment THEN `.env.example` SHALL document the `ML_SERVICE_URL` variable with its default value and purpose, so developers know how to configure ML service connectivity

2.3 WHEN `ML_SERVICE_URL` is configured and the ML service is reachable but has no calibration model loaded THEN the dashboard SHALL display an informational (non-error) status indicating calibration is pending training, distinguishing this from a connectivity failure

2.4 WHEN the ML service is temporarily unreachable THEN the dashboard SHALL display an actionable message indicating the ML service is not running and suggest starting it, rather than showing a generic "ml_service_unavailable" failure

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the ML service is reachable and has a trained calibration model THEN the system SHALL CONTINUE TO apply isotonic regression calibration to ensemble probabilities and record `calibration_applied: true`

3.2 WHEN the ML service is reachable but returns a non-OK HTTP response from `/predict` THEN the system SHALL CONTINUE TO fall back to similarity-only forecast without crashing

3.3 WHEN the ML service calibration endpoint returns `calibrated: false` (no model loaded) THEN the system SHALL CONTINUE TO use raw ensemble probabilities and record `calibration_applied: false` in diagnostics

3.4 WHEN the batch pipeline diagnostics recording fails THEN the system SHALL CONTINUE TO complete the pipeline without halting (diagnostics are non-blocking)

3.5 WHEN the ML service is unreachable in production (Cloud Run deployment) THEN the system SHALL CONTINUE TO degrade gracefully by using similarity-only forecasts
