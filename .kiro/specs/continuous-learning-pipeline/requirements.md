# Requirements Document

## Introduction

This feature implements a continuous learning pipeline for the Financial Intelligence Platform's forecast system. It covers four capabilities from Tier 5 of the Enhancement Plan: probability calibration via isotonic regression, SHAP-based explainability for ML predictions, model drift detection with automatic retraining, and RAG-enhanced event context retrieval. Together, these ensure that forecast probabilities are well-calibrated, interpretable, self-monitoring for degradation, and enriched with historical event outcomes — enabling the system to improve its prediction accuracy over time. Additionally, it extends the existing batch_diagnostics observability layer (from the process-observation spec) to report on the success/failure of each learning pipeline component per batch cycle, providing confidence that predictions are using all available intelligence.

## Glossary

- **ML_Service**: The Python FastAPI application at `ml_service/` that hosts XGBoost classification models, calibration models, and explainability computation. Deployed as Cloud Run service "fip-ml".
- **Calibration_Service**: The component within ML_Service responsible for training and applying isotonic regression to map raw predicted probabilities to historically accurate probabilities.
- **Explainability_Service**: The component within ML_Service responsible for computing SHAP values that attribute prediction outcomes to individual input features.
- **Drift_Detector**: The component within ML_Service responsible for computing rolling accuracy metrics per regime and determining whether model performance has degraded beyond acceptable thresholds.
- **Event_Context_Service**: The component within the TypeScript batch pipeline responsible for retrieving historical instances of upcoming economic events and computing statistical summaries of their market impact.
- **Batch_Pipeline**: The TypeScript orchestration process (`src/batch-entry.ts`) that runs every 4 hours on Cloud Run to produce forecasts.
- **Forecast_Engine**: The subsystem that combines similarity-based and ML-based probabilities to produce the final directional forecast.
- **Isotonic_Regression**: A non-parametric monotonic regression technique that maps raw probabilities to calibrated probabilities based on observed historical frequency.
- **SHAP_Values**: SHapley Additive exPlanations values that quantify the contribution of each input feature to a specific prediction.
- **Regime**: A classification of current market conditions (e.g., LOW/NORMAL/HIGH volatility) used to stratify forecast accuracy tracking.
- **Baseline_Accuracy**: The rolling mean accuracy computed over the most recent 100 forecasts for a given regime, used as the reference point for drift detection.
- **Sigma**: The standard deviation of rolling accuracy within a regime window, used as the unit for measuring performance degradation.
- **Research_Evaluations**: The Supabase table containing historical forecast outcomes — predicted probabilities paired with actual directional results.
- **Prediction_Explanations**: A new Supabase table storing per-prediction SHAP values and feature contribution rankings.
- **Drift_Alerts**: A new Supabase table storing records of detected drift events including regime, accuracy drop, and recommended action.
- **Economic_Events**: The existing Supabase table containing scheduled macroeconomic events (NFP, ECB decisions, CPI releases, etc.).
- **Market_Outcomes**: The existing Supabase table storing observed market moves (direction, magnitude) following fingerprinted moments.
- **Event_Impact_Summary**: A computed object containing median_move_pips, direction_skew, and vol_expansion_ratio for historical instances of a given event type.
- **Cloud_Scheduler**: Google Cloud Scheduler used to trigger periodic jobs (retraining, drift checks).
- **DiagnosticsCollector**: The existing TypeScript module (from process-observation spec) that accumulates per-stage observations during a batch cycle and persists them to the `batch_diagnostics` table. Extended here to include learning pipeline status.
- **Learning_Pipeline_Diagnostics**: A new section within the `batch_diagnostics` JSONB payload that reports on the status of calibration, SHAP, event context, and drift detection for each batch cycle.

## Requirements

### Requirement 1: Isotonic Regression Calibration Model Training

**User Story:** As a platform operator, I want the system to train an isotonic regression model from historical forecast evaluations, so that raw probabilities can be mapped to well-calibrated probabilities.

#### Acceptance Criteria

1. WHEN a calibration training request is received, THE Calibration_Service SHALL fetch all records from the research_evaluations table containing predicted probability and actual outcome pairs.
2. WHEN fewer than 50 evaluation records are available, THE Calibration_Service SHALL reject the training request and return an error indicating insufficient data.
3. WHEN sufficient evaluation data is available, THE Calibration_Service SHALL train an isotonic regression model mapping predicted probabilities to observed outcome frequencies.
4. WHEN training completes successfully, THE Calibration_Service SHALL persist the trained calibration model to the model store with a version identifier and training timestamp.
5. WHEN training completes successfully, THE Calibration_Service SHALL return training metrics including sample count, calibration error before training, and calibration error after training.

### Requirement 2: Probability Calibration Application

**User Story:** As a platform operator, I want calibrated probabilities applied to every forecast, so that "70% up" means the market actually moves up approximately 70% of the time.

#### Acceptance Criteria

1. WHEN a calibration model is loaded and a raw probability prediction is produced, THE Calibration_Service SHALL transform each directional probability (up, down, flat) through the isotonic regression model.
2. WHEN calibration is applied, THE Calibration_Service SHALL renormalise the calibrated probabilities so that they sum to 1.0.
3. WHEN no calibration model is available, THE Forecast_Engine SHALL use the raw uncalibrated probabilities and include a metadata flag indicating calibration was not applied.
4. THE Calibration_Service SHALL expose a `POST /calibrate` endpoint accepting raw probability vectors and returning calibrated probability vectors.

### Requirement 3: SHAP Value Computation

**User Story:** As a platform operator, I want to see which features drove each ML prediction, so that I can understand model behaviour and detect reliance on stale signals.

#### Acceptance Criteria

1. WHEN an ML prediction is produced, THE Explainability_Service SHALL compute SHAP values for each input feature using the TreeExplainer algorithm.
2. WHEN SHAP values are computed, THE Explainability_Service SHALL store the results in the prediction_explanations table including forecast_id, timestamp, per-feature SHAP values, and the top 5 contributing features ranked by absolute SHAP value.
3. WHEN SHAP computation fails due to model incompatibility or runtime error, THE Explainability_Service SHALL log the error and allow the prediction to proceed without explanation data.
4. THE Explainability_Service SHALL complete SHAP computation within 5 seconds per prediction to avoid delaying the batch pipeline.

### Requirement 4: Explainability API Endpoint

**User Story:** As an API consumer, I want to query the explanation for the latest forecast, so that I can understand what drove the prediction.

#### Acceptance Criteria

1. WHEN a GET request is received at `/v1/forecast/:asset/explain`, THE ML_Service SHALL return the SHAP explanation for the most recent prediction for the specified asset.
2. WHEN an explanation is returned, THE ML_Service SHALL include the feature names, SHAP values, base prediction value, and the top 5 features ranked by contribution magnitude.
3. WHEN no explanation exists for the specified asset, THE ML_Service SHALL return a 404 status with an error message indicating no explanation is available.
4. WHEN the asset parameter does not match a supported asset, THE ML_Service SHALL return a 400 status with an error message listing supported assets.

### Requirement 5: Rolling Accuracy Computation for Drift Detection

**User Story:** As a platform operator, I want the system to continuously track forecast accuracy per regime, so that performance degradation is detected early.

#### Acceptance Criteria

1. WHEN drift detection is triggered, THE Drift_Detector SHALL compute the rolling accuracy over the most recent 30 forecasts for each regime from the research_evaluations table.
2. WHEN fewer than 30 forecasts exist for a regime, THE Drift_Detector SHALL skip drift evaluation for that regime and log the insufficient data condition.
3. THE Drift_Detector SHALL compute the baseline accuracy and standard deviation from the most recent 100 forecasts per regime.
4. WHEN the rolling 30-forecast accuracy for a regime drops below the baseline accuracy by more than 2 standard deviations, THE Drift_Detector SHALL classify the regime as experiencing drift.

### Requirement 6: Drift Alert and Auto-Retraining Trigger

**User Story:** As a platform operator, I want the system to automatically respond when forecast accuracy degrades, so that the model recovers without manual intervention.

#### Acceptance Criteria

1. WHEN drift is detected for any regime, THE Drift_Detector SHALL insert a record into the drift_alerts table including regime, current accuracy, baseline accuracy, sigma value, and timestamp.
2. WHEN drift is detected, THE Drift_Detector SHALL trigger an automatic retraining of the XGBoost model by invoking the existing `POST /train` endpoint on the ML_Service.
3. WHEN automatic retraining completes, THE Drift_Detector SHALL log the retraining outcome (success/failure, new model accuracy) alongside the drift alert record.
4. WHEN automatic retraining fails, THE Drift_Detector SHALL log the failure and retain the current model without interrupting forecast production.

### Requirement 7: Scheduled Drift Check and Retraining

**User Story:** As a platform operator, I want drift detection and model retraining to occur on a regular schedule, so that the system remains current without manual triggers.

#### Acceptance Criteria

1. THE Cloud_Scheduler SHALL trigger the drift detection endpoint on the ML_Service on a weekly schedule (every Sunday at 02:00 UTC).
2. WHEN the scheduled drift check detects no drift in any regime, THE Drift_Detector SHALL log a healthy status and skip retraining.
3. WHEN the scheduled trigger fires and the ML_Service is unavailable, THE Cloud_Scheduler SHALL retry the request up to 3 times with exponential backoff.
4. THE ML_Service SHALL expose a `POST /drift-check` endpoint that executes the drift detection logic and returns the results for all regimes.

### Requirement 8: RAG-Enhanced Event Context Retrieval

**User Story:** As a platform operator, I want the system to retrieve historical market reactions to similar economic events, so that upcoming high-impact events are contextualised by past behaviour.

#### Acceptance Criteria

1. WHEN the Batch_Pipeline identifies an upcoming high-impact economic event within the next 8 hours, THE Event_Context_Service SHALL query the economic_events and market_outcomes tables for past instances of the same event type.
2. WHEN historical event instances are found, THE Event_Context_Service SHALL compute an Event_Impact_Summary containing median_move_pips, direction_skew (proportion of up vs down moves), and vol_expansion_ratio (average post-event ATR divided by pre-event ATR).
3. WHEN fewer than 3 historical instances of the event type exist, THE Event_Context_Service SHALL return a null context and log that insufficient historical data is available.
4. WHEN an Event_Impact_Summary is computed, THE Event_Context_Service SHALL pass the summary to the Forecast_Engine as additional context features for the current prediction cycle.

### Requirement 9: Event Context Integration with Forecast Engine

**User Story:** As a platform operator, I want event context to influence the forecast when relevant, so that predictions account for known upcoming catalysts.

#### Acceptance Criteria

1. WHEN an Event_Impact_Summary is available for the current prediction cycle, THE Forecast_Engine SHALL include the summary fields (median_move_pips, direction_skew, vol_expansion_ratio) as additional input features to the ML model.
2. WHEN no Event_Impact_Summary is available, THE Forecast_Engine SHALL proceed with the standard feature vector without event context features (using neutral fill values of 0.0 for median_move_pips, 0.5 for direction_skew, and 1.0 for vol_expansion_ratio).
3. THE Forecast_Engine SHALL record in the execution trace whether event context was applied for each prediction cycle.

### Requirement 10: Prediction Explanations Table Schema

**User Story:** As a platform operator, I want SHAP explanations persisted in a structured table, so that historical explanations can be queried and analysed for patterns.

#### Acceptance Criteria

1. THE prediction_explanations table SHALL contain columns: id (UUID primary key), forecast_id (foreign key to research_forecasts), asset (text), timestamp_utc (timestamptz), shap_values (JSONB mapping feature names to SHAP values), top_features (JSONB array of top 5 features by absolute contribution), base_value (float), and model_version (text).
2. THE prediction_explanations table SHALL have an index on (asset, timestamp_utc) for efficient retrieval of the most recent explanation per asset.

### Requirement 11: Drift Alerts Table Schema

**User Story:** As a platform operator, I want drift events persisted for audit and analysis, so that I can review when and why retraining was triggered.

#### Acceptance Criteria

1. THE drift_alerts table SHALL contain columns: id (UUID primary key), regime (text), detected_at (timestamptz), rolling_accuracy (float), baseline_accuracy (float), sigma (float), deviation_sigmas (float), retrain_triggered (boolean), retrain_outcome (JSONB nullable), and resolved_at (timestamptz nullable).
2. THE drift_alerts table SHALL have an index on (regime, detected_at) for efficient querying of drift history per regime.

### Requirement 12: Calibration Model Persistence

**User Story:** As a platform operator, I want the calibration model to persist across service restarts, so that calibration is always applied without requiring retraining on every deployment.

#### Acceptance Criteria

1. WHEN a calibration model is trained, THE Calibration_Service SHALL serialise the model to a file in the model store directory alongside the XGBoost model.
2. WHEN the ML_Service starts up, THE Calibration_Service SHALL attempt to load a previously saved calibration model from the model store.
3. IF no calibration model file is found on startup, THEN THE Calibration_Service SHALL log a warning and operate in uncalibrated mode until training is triggered.

### Requirement 13: Pipeline Process Reporting via Batch Diagnostics

**User Story:** As a platform operator, I want to see whether calibration, SHAP, drift detection, and event context ran successfully in each batch cycle, so that I can be confident the prediction used all available intelligence and diagnose issues quickly.

#### Acceptance Criteria

1. WHEN the Batch_Pipeline completes a prediction cycle, THE DiagnosticsCollector SHALL record a `learning_pipeline` diagnostics section containing: calibration_applied (boolean), calibration_model_version (string or null), shap_computed (boolean), event_context_applied (boolean), and event_type (string or null).
2. WHEN calibration is applied during a prediction cycle, THE DiagnosticsCollector SHALL record the raw probabilities (before calibration) and the calibrated probabilities (after calibration) in the `learning_pipeline` diagnostics section.
3. WHEN event context is retrieved for the current cycle, THE DiagnosticsCollector SHALL record the Event_Impact_Summary values (median_move_pips, direction_skew, vol_expansion_ratio) in the `learning_pipeline` diagnostics section.
4. WHEN SHAP values are computed for the current cycle, THE DiagnosticsCollector SHALL record the top 3 contributing features and their SHAP values in the `learning_pipeline` diagnostics section.
5. WHEN any learning pipeline component fails (calibration unavailable, SHAP timeout, event context error), THE DiagnosticsCollector SHALL record the failure reason in the `learning_pipeline` diagnostics section without halting the pipeline.

### Requirement 14: Dashboard Continuous Learning Status Card

**User Story:** As a platform operator, I want to see the continuous learning pipeline status in the Developer View dashboard, so that I can quickly verify the system is learning and all components are operational.

#### Acceptance Criteria

1. THE Developer_View SHALL display a "Continuous Learning" card showing the latest status of each pipeline component: calibration (applied/not applied + model version), SHAP (computed/skipped), event context (applied/not applied + event type), and drift status (healthy/drift detected + last check time).
2. THE Developer_View SHALL query the `batch_diagnostics` table for the `learning_pipeline` section and the `drift_alerts` table for the most recent drift check result.
3. WHEN calibration was not applied in the latest batch cycle, THE Developer_View SHALL display a warning indicator next to the calibration status.
4. WHEN drift has been detected within the last 7 days, THE Developer_View SHALL display the drift alert details including affected regime, deviation from baseline, and whether retraining was triggered.
5. THE Developer_View SHALL display a timeline showing the last 5 batch cycles with pass/fail indicators for each learning pipeline component.
