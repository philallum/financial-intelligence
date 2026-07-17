# Requirements Document

## Introduction

The Pipeline Computation Calibration Framework provides a systematic process for evaluating and adjusting the mathematical computations across all 14 pipeline stages of the Financial Intelligence Platform. Currently, while the ML model gets retrained periodically, the deterministic engine parameters (similarity weights, FLAT threshold, regime rules, confidence calibration, topology weight, etc.) remain fixed at their initial development values. This framework enables continuous improvement by tracking per-stage contributions to prediction outcomes, identifying underperforming parameters, running counterfactual analyses, and producing concrete adjustment recommendations — all driven by observed forecast accuracy data.

## Glossary

- **Calibration_Engine**: The component responsible for analysing forecast accuracy data, computing per-stage contributions, and generating parameter adjustment recommendations
- **Stage_Contribution_Tracker**: The component that decomposes evaluated forecasts into per-stage influence scores
- **Threshold_Analyser**: The component that runs counterfactual "what-if" scenarios against archived forecast data to evaluate alternative parameter values
- **Signal_Noise_Evaluator**: The component that computes correlation between each fingerprint layer's similarity contribution and actual outcome accuracy
- **Calibration_Monitor**: The component that tracks confidence calibration drift over rolling time windows
- **Recommendation_Engine**: The component that synthesises analysis results into concrete parameter adjustment recommendations with supporting evidence
- **Scheduler**: The component that triggers calibration analyses on a defined cadence or when sufficient new evaluations accumulate
- **Pipeline_Stage**: One of the 14 deterministic computation stages in the batch pipeline (e.g., Sentiment Engine, Similarity Engine, Outcome Engine)
- **Evaluated_Forecast**: A forecast that has matured and been scored against the realised market outcome, stored in `research_evaluations`
- **Layer_Contribution**: The per-layer similarity score breakdown (L1-L5) recorded for each similarity match in `research_similarity_archive`
- **Regime_Weight_Matrix**: The frozen weight set that determines how much each fingerprint layer contributes to similarity scoring for a given regime type
- **Counterfactual_Result**: The outcome of re-running a historical forecast with an alternative parameter value
- **Calibration_Window**: A rolling time period (default 30 days) over which confidence calibration is measured
- **Parameter_Snapshot**: A versioned record of all tuneable parameter values at a point in time

## Requirements

### Requirement 1: Stage Contribution Decomposition

**User Story:** As a platform operator, I want each evaluated forecast decomposed into per-stage contributions, so that I can identify which pipeline stages are adding signal versus noise to predictions.

#### Acceptance Criteria

1. WHEN an evaluated forecast is processed, THE Stage_Contribution_Tracker SHALL compute a contribution score for each Pipeline_Stage by correlating the stage output with the forecast outcome accuracy
2. WHEN a similarity match is archived with per-layer breakdown, THE Stage_Contribution_Tracker SHALL record which fingerprint layer (L1 through L5) contributed most to the composite similarity score using the layer_breakdown values
3. WHEN macro context or sentiment data was present during a forecast, THE Stage_Contribution_Tracker SHALL compute the marginal accuracy difference between forecasts with and without that data to determine signal versus noise contribution
4. THE Stage_Contribution_Tracker SHALL persist all contribution records to a `calibration_stage_contributions` table with foreign keys to the evaluation record and batch diagnostic record
5. WHEN fewer than 10 evaluated forecasts exist for a given asset and regime combination, THE Stage_Contribution_Tracker SHALL mark contribution results as low-confidence and exclude them from recommendation inputs

### Requirement 2: Regime Accuracy Breakdown

**User Story:** As a platform operator, I want to see direction accuracy broken down by regime type and asset, so that I can identify which regime classifications produce unreliable predictions.

#### Acceptance Criteria

1. THE Calibration_Engine SHALL compute direction accuracy as a percentage for each combination of regime type (9 types), asset (EURUSD, GBPUSD), and prediction direction (UP, DOWN, FLAT)
2. WHEN a regime-asset combination has 30 or more evaluated forecasts, THE Calibration_Engine SHALL classify the combination as statistically significant and include it in regime accuracy reporting
3. WHEN the direction accuracy for a regime-asset combination falls below 40%, THE Calibration_Engine SHALL flag the combination as underperforming and include it in the next recommendation cycle
4. THE Calibration_Engine SHALL persist regime accuracy breakdown results to a `calibration_regime_accuracy` table partitioned by analysis run timestamp
5. WHEN a new analysis run completes, THE Calibration_Engine SHALL compute the accuracy delta compared to the previous run for each regime-asset combination to track improvement or degradation over time

### Requirement 3: Threshold Sensitivity Analysis

**User Story:** As a platform operator, I want to run "what-if" scenarios testing alternative parameter values against historical data, so that I can identify better parameter settings before applying them.

#### Acceptance Criteria

1. WHEN a counterfactual analysis is requested, THE Threshold_Analyser SHALL re-evaluate archived forecasts using alternative parameter values while holding all other parameters constant
2. THE Threshold_Analyser SHALL support counterfactual analysis for the following parameters: FLAT_THRESHOLD (pip range 1-5), TOPOLOGY_SIMILARITY_WEIGHT (range 0.0-0.30), and individual regime weight matrix values (range 0.0-1.0 summing to 1.0)
3. WHEN a counterfactual scenario is executed, THE Threshold_Analyser SHALL compute direction accuracy, Brier score, and calibration error for the alternative parameter value and compare them to the baseline (current parameter) metrics
4. THE Threshold_Analyser SHALL execute counterfactual analysis only against forecasts in `research_similarity_archive` where the full per-layer breakdown is available
5. IF a counterfactual parameter combination produces regime weight matrix values that do not sum to 1.0 (within 0.001 tolerance), THEN THE Threshold_Analyser SHALL reject the combination and return a validation error
6. THE Threshold_Analyser SHALL persist counterfactual results to a `calibration_counterfactuals` table including the parameter name, baseline value, alternative value, sample size, and accuracy delta

### Requirement 4: Layer Signal-to-Noise Measurement

**User Story:** As a platform operator, I want to measure the correlation between each fingerprint layer's similarity contribution and actual outcome accuracy, so that I can reduce the weight of layers that add noise.

#### Acceptance Criteria

1. THE Signal_Noise_Evaluator SHALL compute Pearson correlation between each layer's similarity score (from `research_similarity_archive.layer_breakdown`) and the binary direction accuracy (0 or 1) of the corresponding evaluated forecast
2. WHEN a layer's correlation coefficient is below 0.05 over a minimum sample of 50 evaluated forecasts, THE Signal_Noise_Evaluator SHALL classify the layer as low-signal for that regime-asset combination
3. WHEN a layer's correlation coefficient exceeds 0.20 over a minimum sample of 50 evaluated forecasts, THE Signal_Noise_Evaluator SHALL classify the layer as high-signal for that regime-asset combination
4. THE Signal_Noise_Evaluator SHALL compute signal-to-noise measurements separately for each regime type and asset to account for regime-specific layer relevance
5. THE Signal_Noise_Evaluator SHALL persist signal-to-noise results to a `calibration_layer_signals` table including the layer name, regime, asset, correlation coefficient, sample size, and classification

### Requirement 5: Confidence Calibration Monitoring

**User Story:** As a platform operator, I want to monitor whether confidence scores remain well-calibrated over time, so that I can detect and correct calibration drift before it degrades user trust.

#### Acceptance Criteria

1. THE Calibration_Monitor SHALL compute observed accuracy for each confidence bucket (0.0-0.1, 0.1-0.2, ... 0.9-1.0) over a rolling Calibration_Window of 30 days
2. WHEN the absolute difference between a confidence bucket's nominal midpoint and observed accuracy exceeds 0.15, THE Calibration_Monitor SHALL flag the bucket as miscalibrated
3. WHEN 3 or more confidence buckets are flagged as miscalibrated in the same analysis run, THE Calibration_Monitor SHALL generate a recalibration alert with severity "high"
4. THE Calibration_Monitor SHALL compute the Expected Calibration Error (ECE) as the weighted average of per-bucket calibration gaps, weighted by sample count per bucket
5. WHEN the ECE exceeds 0.10, THE Calibration_Monitor SHALL flag the overall confidence system as requiring recalibration
6. THE Calibration_Monitor SHALL persist calibration monitoring results to a `calibration_confidence_drift` table including per-bucket accuracy, ECE, alert severity, and analysis timestamp

### Requirement 6: Parameter Adjustment Recommendations

**User Story:** As a platform operator, I want concrete, evidence-based recommendations for parameter changes, so that I can make informed decisions about which adjustments to apply.

#### Acceptance Criteria

1. WHEN all analysis components (stage contributions, regime accuracy, threshold sensitivity, layer signals, calibration monitoring) have completed a run, THE Recommendation_Engine SHALL synthesise findings into ranked parameter adjustment recommendations
2. THE Recommendation_Engine SHALL include in each recommendation: the parameter name, current value, recommended value, supporting sample size, projected accuracy improvement (percentage points), and confidence level (low, medium, high)
3. WHEN a recommendation has fewer than 30 supporting evaluated forecasts, THE Recommendation_Engine SHALL assign confidence level "low"
4. WHEN a recommendation has 30-99 supporting evaluated forecasts, THE Recommendation_Engine SHALL assign confidence level "medium"
5. WHEN a recommendation has 100 or more supporting evaluated forecasts, THE Recommendation_Engine SHALL assign confidence level "high"
6. THE Recommendation_Engine SHALL never recommend changes that would set FLAT_THRESHOLD below 1 pip or above 5 pips, TOPOLOGY_SIMILARITY_WEIGHT below 0.0 or above 0.30, or any individual regime weight below 0.0 or above 1.0
7. THE Recommendation_Engine SHALL persist all recommendations to a `calibration_recommendations` table with status (pending, applied, rejected) and the analysis run identifier that produced them
8. WHEN a recommendation is generated, THE Recommendation_Engine SHALL include a human-readable explanation string (e.g., "Increase topology weight from 0.10 to 0.15 based on 45 evaluated forecasts showing +12% accuracy when topology similarity > 0.8")

### Requirement 7: Evaluation Cadence and Scheduling

**User Story:** As a platform operator, I want calibration analyses to run automatically on a schedule or when enough new data accumulates, so that recommendations stay current without manual intervention.

#### Acceptance Criteria

1. THE Scheduler SHALL trigger a full calibration analysis run when 50 or more new evaluated forecasts have accumulated since the last run
2. THE Scheduler SHALL trigger a full calibration analysis run at minimum once per 7 calendar days regardless of new evaluation count
3. WHEN a calibration analysis run is triggered, THE Scheduler SHALL record the run start time, end time, trigger reason (threshold or schedule), and evaluation count processed in a `calibration_runs` table
4. IF a calibration analysis run fails partway through, THEN THE Scheduler SHALL persist partial results from completed sub-analyses and record the failure stage and error detail
5. THE Scheduler SHALL ensure only one calibration analysis run executes at a time by acquiring a database advisory lock before starting

### Requirement 8: Analysis Result Persistence and Trend Tracking

**User Story:** As a platform operator, I want calibration analysis results persisted over time, so that I can observe whether parameter adjustments are improving prediction quality.

#### Acceptance Criteria

1. THE Calibration_Engine SHALL retain all historical analysis run results indefinitely for trend comparison
2. WHEN a new analysis run completes, THE Calibration_Engine SHALL compute a platform-level accuracy trend by comparing the current run's aggregate direction accuracy against the previous 5 runs
3. THE Calibration_Engine SHALL compute a per-stage improvement score by comparing each stage's contribution correlation before and after any applied parameter changes
4. WHEN a parameter recommendation with status "applied" exists, THE Calibration_Engine SHALL track the accuracy delta observed in the 30 days following application versus the 30 days preceding it
5. THE Calibration_Engine SHALL expose analysis results through a read-only query interface that supports filtering by asset, regime, date range, and analysis run identifier
