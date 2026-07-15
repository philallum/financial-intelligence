# Implementation Plan: Continuous Learning Pipeline

## Overview

This plan implements Tier 5 of the Enhancement Plan: probability calibration (isotonic regression), SHAP explainability, drift detection with auto-retraining, RAG-enhanced event context, and observability/dashboard extensions. The Python ML service gains three new services and routers; the TypeScript batch pipeline gains an event context service and diagnostics integration; two new database tables are created; and the dashboard gains a Continuous Learning card.

## Tasks

- [ ] 1. Database schema and shared types
  - [ ] 1.1 Create database migration for `prediction_explanations` and `drift_alerts` tables
    - Create SQL migration file with both CREATE TABLE statements and indexes
    - `prediction_explanations`: id, forecast_id (FK), asset, timestamp_utc, shap_values (JSONB), top_features (JSONB), base_value (float8), model_version (text)
    - `drift_alerts`: id, regime, detected_at, rolling_accuracy, baseline_accuracy, sigma, deviation_sigmas, retrain_triggered, retrain_outcome (JSONB nullable), resolved_at (nullable)
    - Add indexes: `idx_prediction_explanations_asset_ts` on (asset, timestamp_utc DESC), `idx_drift_alerts_regime_detected` on (regime, detected_at DESC)
    - _Requirements: 10.1, 10.2, 11.1, 11.2_

  - [ ] 1.2 Add `LearningPipelineDiagnostics` type and extend `BatchDiagnosticsPayload`
    - Add `LearningPipelineDiagnostics` interface to `src/services/observability/diagnostics-types.ts`
    - Add `learning_pipeline: LearningPipelineDiagnostics | null` field to `BatchDiagnosticsPayload`
    - Include all fields: calibration_applied, calibration_model_version, raw_probabilities, calibrated_probabilities, shap_computed, top_shap_features, event_context_applied, event_type, event_impact, failure_reason
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [ ] 1.3 Update ML service dependencies in `ml_service/requirements.txt`
    - Add `shap==0.46.0` and `joblib==1.4.2`
    - _Requirements: 3.1, 12.1_

- [ ] 2. Implement Calibration Service and router (Python)
  - [ ] 2.1 Implement `ml_service/app/services/calibration.py`
    - Create `CalibrationService` class with singleton pattern (matching `ModelStore`)
    - Implement `train()`: fetch research_evaluations via httpx, validate ≥50 records, train isotonic regression per class, compute pre/post calibration error, persist model
    - Implement `calibrate(probs)`: apply isotonic regression to [up, down, flat], renormalise to sum=1.0, return raw probs if no model loaded
    - Implement `is_loaded()`, `load_if_available()`, `save()` using joblib serialisation at `/tmp/fip_calibration_model.joblib` and `/tmp/fip_calibration_meta.json`
    - Handle edge cases: NaN/Inf fallback to raw probs, corrupted model file on load
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 12.1, 12.2, 12.3_

  - [ ]* 2.2 Write property tests for Calibration Service
    - **Property 1: Calibration training reduces error**
    - **Property 2: Calibration output is valid probability distribution**
    - **Property 10: Calibration model serialisation round-trip**
    - Create `ml_service/tests/test_calibration_props.py` using `hypothesis`
    - Use `@given` with strategies for probability vectors (floats 0..1 summing to 1) and outcome datasets (≥50 records)
    - Minimum 100 iterations per property
    - **Validates: Requirements 1.3, 2.1, 2.2, 12.1**

  - [ ] 2.3 Implement `ml_service/app/routers/calibration.py`
    - Create `POST /calibrate` endpoint: accept `{up, down, flat}`, return calibrated vector + `calibrated` flag + `model_version`
    - Create `POST /calibrate/train` endpoint: trigger training, return metrics or 400 if insufficient data
    - Define Pydantic request/response models matching design API specs
    - _Requirements: 1.5, 2.3, 2.4_

  - [ ] 2.4 Register calibration router and startup hook in `ml_service/app/main.py`
    - Import and include calibration router
    - Call `CalibrationService.get_instance().load_if_available()` in lifespan startup
    - _Requirements: 12.2, 12.3_

  - [ ]* 2.5 Write unit tests for calibration router
    - Test `POST /calibrate` with and without model loaded
    - Test `POST /calibrate/train` success and insufficient data cases
    - Create `ml_service/tests/test_calibration.py`
    - _Requirements: 1.2, 1.5, 2.3, 2.4_

- [ ] 3. Checkpoint — Calibration service complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement Explainability Service and router (Python)
  - [ ] 4.1 Implement `ml_service/app/services/explainability.py`
    - Create `ExplainabilityService` class
    - Implement `compute_and_store()`: compute SHAP TreeExplainer values from features + loaded XGBoost model, extract top 5 features by abs value, store to `prediction_explanations` via httpx to Supabase REST API, enforce 5-second timeout
    - Implement `get_latest(asset)`: query `prediction_explanations` for most recent record by asset
    - Handle errors gracefully: timeout → log + return None, model incompatibility → log + return None, Supabase insert failure → log + return None
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1_

  - [ ]* 4.2 Write property tests for Explainability Service
    - **Property 3: SHAP value count equals feature count**
    - **Property 4: Top-K feature ranking correctness**
    - Create `ml_service/tests/test_explainability_props.py` using `hypothesis`
    - Generate random 30-dim feature vectors and random SHAP value dicts
    - Minimum 100 iterations per property
    - **Validates: Requirements 3.1, 4.2**

  - [ ] 4.3 Implement `ml_service/app/routers/explainability.py`
    - Create `GET /v1/forecast/{asset}/explain` endpoint
    - Return SHAP explanation for most recent prediction: forecast_id, asset, timestamp_utc, base_value, shap_values, top_features, model_version
    - Return 404 if no explanation exists, 400 if unsupported asset
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ] 4.4 Register explainability router in `ml_service/app/main.py`
    - Import and include explainability router
    - _Requirements: 4.1_

  - [ ]* 4.5 Write unit tests for explainability router
    - Test GET endpoint with existing data, missing data (404), invalid asset (400)
    - Create `ml_service/tests/test_explainability.py`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] 5. Implement Drift Detector and router (Python)
  - [ ] 5.1 Implement `ml_service/app/services/drift_detector.py`
    - Create `DriftDetector` class
    - Implement `check_all_regimes()`: fetch research_evaluations grouped by regime, compute rolling 30-forecast accuracy, compute baseline (100-forecast) mean and sigma, classify drift if rolling < baseline - 2*sigma, skip regimes with < 30 forecasts, handle sigma=0 by skipping
    - Implement `handle_drift(regime, metrics)`: insert record into drift_alerts via Supabase REST, trigger POST /train via httpx, update drift_alert with retrain outcome
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4_

  - [ ]* 5.2 Write property tests for Drift Detector
    - **Property 5: Rolling accuracy computation**
    - **Property 6: Baseline statistics computation**
    - **Property 7: Drift classification formula**
    - Create `ml_service/tests/test_drift_props.py` using `hypothesis`
    - Generate sequences of (predicted_direction, actual_direction) pairs
    - Minimum 100 iterations per property
    - **Validates: Requirements 5.1, 5.3, 5.4**

  - [ ] 5.3 Implement `ml_service/app/routers/drift.py`
    - Create `POST /drift-check` endpoint
    - Return per-regime status (rolling_accuracy, baseline_accuracy, sigma, drift flag, deviation_sigmas), overall status (healthy/drift_detected), retrain_triggered flag and retrain_outcome
    - _Requirements: 7.4, 5.4, 6.2_

  - [ ] 5.4 Register drift router in `ml_service/app/main.py`
    - Import and include drift router
    - _Requirements: 7.4_

  - [ ]* 5.5 Write unit tests for drift detector and router
    - Test rolling accuracy computation edge cases
    - Test drift classification at boundary (exactly 2σ deviation)
    - Test regime skip when < 30 forecasts
    - Test sigma=0 handling
    - Create `ml_service/tests/test_drift_detector.py`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1_

- [ ] 6. Checkpoint — ML service complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement Event Context Service (TypeScript)
  - [ ] 7.1 Implement `src/services/pipeline/event-context-service.ts`
    - Create `EventContextService` class with `getEventContext(asset, currentTime)` method
    - Query `economic_events` for upcoming high-impact events within 8 hours
    - For each upcoming event, query past instances of same event_type from `economic_events`
    - Join past event timestamps with `market_outcomes` via time proximity matching
    - Compute `EventImpactSummary`: median_move_pips (statistical median of abs move_pips), direction_skew (count up / total), vol_expansion_ratio (mean of post_event_atr / pre_event_atr)
    - Return null if no upcoming high-impact events or < 3 historical instances
    - Handle Supabase query failures gracefully (return null, log error)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2_

  - [ ]* 7.2 Write property tests for Event Context Service
    - **Property 8: Event impact summary statistics**
    - **Property 9: Feature vector augmentation with event context**
    - Create `src/services/pipeline/__tests__/event-context.property.test.ts` using `fast-check`
    - Generate arrays of historical event outcome records with move_pips, direction, pre/post ATR
    - Generate base 30-dim feature vectors and valid EventImpactSummary objects
    - Minimum 100 iterations per property
    - **Validates: Requirements 8.2, 9.1**

  - [ ]* 7.3 Write unit tests for Event Context Service
    - Test null return when no upcoming events
    - Test null return when < 3 historical instances
    - Test correct computation with known test data
    - Test graceful error handling on Supabase failures
    - Create `src/services/pipeline/__tests__/event-context-service.test.ts`
    - _Requirements: 8.1, 8.2, 8.3_

- [ ] 8. Implement DiagnosticsCollector extension and batch integration (TypeScript)
  - [ ] 8.1 Add `recordLearningPipeline()` method to `DiagnosticsCollector`
    - Add private `learningPipeline: LearningPipelineDiagnostics | null = null` field
    - Implement `recordLearningPipeline(data)` with try/catch (never throws)
    - Update `buildPayload()` to include `learning_pipeline` field
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [ ]* 8.2 Write property tests for Learning Pipeline Diagnostics
    - **Property 11: Learning pipeline diagnostics shape completeness**
    - **Property 12: Top-3 SHAP feature recording correctness**
    - **Property 13: Learning pipeline recording never throws**
    - Create `src/services/observability/__tests__/learning-pipeline-diagnostics.property.test.ts` using `fast-check`
    - Generate arbitrary LearningPipelineDiagnostics objects with valid/invalid/null fields
    - Minimum 100 iterations per property
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.5**

  - [ ]* 8.3 Write unit tests for DiagnosticsCollector learning pipeline extension
    - Test recordLearningPipeline stores data correctly
    - Test buildPayload includes learning_pipeline section
    - Test default null state when not called
    - Create `src/services/observability/__tests__/learning-pipeline-diagnostics.test.ts`
    - _Requirements: 13.1, 13.5_

- [ ] 9. Checkpoint — TypeScript services complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Dashboard Continuous Learning card
  - [ ] 10.1 Implement `renderContinuousLearningCard()` in `dashboard/index.html`
    - Add async function querying `batch_diagnostics` (latest 5 rows, learning_pipeline section) and `drift_alerts` (last 7 days)
    - Render component status grid: calibration (applied/not + model version), SHAP (computed/skipped + top features), event context (applied/not + event type), drift (healthy/detected)
    - Render warning indicator when calibration not applied
    - Render drift alert detail bar when drift detected within 7 days (regime, deviation, retrain status)
    - Render timeline of last 5 batch cycles with per-component pass/fail indicators
    - Handle missing data gracefully (display "no data available")
    - Invoke from `renderDeveloperView()` alongside existing `renderBatchDiagnosticsCard()`
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

  - [ ]* 10.2 Write property tests for dashboard Continuous Learning card
    - **Property 14: Dashboard renders all learning pipeline component statuses**
    - **Property 15: Dashboard drift alert detail rendering**
    - Create `dashboard/__tests__/continuous-learning-card.property.test.ts` using `fast-check`
    - Generate valid LearningPipelineDiagnostics and drift alert objects
    - Minimum 100 iterations per property
    - **Validates: Requirements 14.1, 14.4, 14.5**

  - [ ]* 10.3 Write unit tests for dashboard Continuous Learning card
    - Test warning indicator appears when calibration not applied
    - Test card renders gracefully with missing/null data
    - Test drift alert section hidden when no recent drift
    - Test backward compatibility with old data missing learning_pipeline field
    - Create `dashboard/__tests__/continuous-learning-card.test.ts`
    - _Requirements: 14.1, 14.3, 14.4_

- [ ] 11. Cloud Scheduler drift check job configuration
  - [ ] 11.1 Add weekly drift check job to `deploy/cloud-scheduler.yaml`
    - Add `fip-ml-drift-check-weekly` job: schedule `0 2 * * 0` (Sundays 02:00 UTC), POST to ML service `/drift-check` endpoint
    - Configure OIDC authentication with service account
    - Configure retry: 3 retries, 30s-120s exponential backoff, 600s attempt deadline
    - _Requirements: 7.1, 7.2, 7.3_

- [ ] 12. Integration wiring — connect all components in batch pipeline
  - [ ] 12.1 Wire Event Context Service and calibration calls into batch pipeline
    - Import and instantiate `EventContextService` in the batch entry flow
    - Call `getEventContext()` before forecast, pass summary to Forecast Engine as additional features (positions 30-32) or use neutral fill values (0.0, 0.5, 1.0) when null
    - Call `POST /calibrate` after ML prediction to get calibrated probabilities
    - Trigger SHAP computation (non-blocking) after prediction
    - Record all results via `diagnostics.recordLearningPipeline()` before `persist()`
    - _Requirements: 8.4, 9.1, 9.2, 9.3, 2.1, 2.3, 13.1_

  - [ ]* 12.2 Write integration tests for the complete learning pipeline flow
    - Test end-to-end: event context → calibration → SHAP → diagnostics recording
    - Test graceful degradation when ML service unavailable
    - Test backward compatibility of diagnostics payload
    - _Requirements: 8.4, 9.1, 13.1_

- [ ] 13. Final checkpoint — All components integrated
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Python property tests use `hypothesis`; TypeScript property tests use `fast-check`
- The ML service uses httpx for Supabase REST queries (matching existing trainer.py pattern)
- Calibration model persisted via joblib alongside XGBoost model in /tmp/

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "7.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "7.2", "7.3", "8.1"] },
    { "id": 3, "tasks": ["2.4", "2.5", "4.1", "8.2", "8.3"] },
    { "id": 4, "tasks": ["4.2", "4.3", "5.1"] },
    { "id": 5, "tasks": ["4.4", "4.5", "5.2", "5.3"] },
    { "id": 6, "tasks": ["5.4", "5.5", "11.1"] },
    { "id": 7, "tasks": ["10.1", "12.1"] },
    { "id": 8, "tasks": ["10.2", "10.3", "12.2"] }
  ]
}
```
