# Requirements Document

## Introduction

The Research Platform Evolution Programme transforms the Financial Intelligence Platform from a forecasting application into a deterministic financial research platform. The platform's purpose is to produce, preserve, evaluate, and explain probabilistic predictions derived exclusively from historical market observations. Every output is permanent, reproducible, explainable, and independently verifiable. The programme spans eight phases, each governed by constitutional mathematical guarantees that cannot be violated regardless of implementation approach.

## Glossary

- **Platform**: The Financial Intelligence Platform — the complete system including Batch Layer, Runtime Layer, database, and engines
- **Batch_Layer**: The scheduled batch pipeline (ingestion → fingerprint → similarity → outcome → forecast → confidence → cache_write) executing every 4 hours as a Cloud Run Job
- **Runtime_Layer**: The Express API serving cached forecasts with real-time tradeability evaluation via Cloud Run Service
- **Research_Namespace**: A dedicated codebase domain (src/research/) grouping forecasts, evaluations, similarity archives, and future experiments under a coherent research module
- **Research_Archive**: The complete, immutable collection of all platform outputs (forecasts, evaluations, similarity results, traces) preserved permanently for analysis
- **Forecast_Engine**: The engine converting OutcomeDistribution into directional probabilities and expected move
- **Evaluation_Engine**: A batch engine that statistically compares historical predictions against realised market outcomes
- **Similarity_Engine**: The engine retrieving top-N historically similar fingerprints using regime-weighted vector comparison
- **Confidence_Engine**: The engine computing a statistically bounded confidence score reflecting forecast reliability
- **Fingerprint_Engine**: The engine transforming OHLC and market context into a deterministic market state fingerprint
- **Regime_Engine**: The component classifying market regime (volatility, trend, session) from fingerprint data
- **Trace_Emitter**: The observability component emitting structured execution traces after every engine run
- **Forecast_Record**: A persisted, immutable row in the research archive containing all forecast metadata and provenance
- **Evaluation_Record**: A persisted, immutable row containing accuracy metrics for a matured forecast
- **Similarity_Archive**: The persisted, immutable collection of all similarity match results per batch
- **Deterministic_Output**: An output that is bit-identical given identical inputs — no randomness, no learned state, no external non-determinism
- **Point_In_Time_Correctness**: The guarantee that no future information is used when constructing any output — only data available at the forecast timestamp contributes
- **Empirical_Distribution**: A probability distribution derived solely from observed historical outcomes with no synthetic observations or weighting adjustments
- **Additive_Schema_Change**: A database migration that adds columns or tables without modifying or removing existing structures
- **Engine_Version**: A frozen, immutable version identifier for any engine's algorithm, configuration, and dependencies
- **Historical_Replay**: The ability to re-execute any historical batch using the same engine versions and input data to reproduce identical outputs
- **Support_Resistance_Topology**: A deterministic model representing price levels, their strength, and interaction history
- **Rich_Market_Context**: Additional deterministic features (trend, ATR, volatility regime, session stats, correlations, macro, sentiment) added to the fingerprint
- **Calibration_Bucket**: A discrete confidence interval range (e.g., 0.6–0.7) used to group predictions for calibration measurement

---

## Requirements

### Requirement 1: Empirical Purity

**User Story:** As a research analyst, I want all statistical outputs derived solely from historical observations, so that the platform's research conclusions are mathematically sound and free from synthetic contamination.

#### Acceptance Criteria

1. THE Platform SHALL compute Empirical_Distributions using only observed historical market outcomes sourced from the data provider fallback chain — no interpolated, extrapolated, model-generated, or otherwise synthetic observations SHALL be introduced into the matched outcome set
2. THE Platform SHALL weight all matched fingerprints equally at 1/N (where N is the count of matched observations) when computing direction probabilities, means, medians, and percentiles — no similarity-score weighting, recency weighting, or performance-based weighting SHALL be applied
3. THE Platform SHALL enforce immutability on ingested historical observations by rejecting any operation that would UPDATE or DELETE a record in the raw_candles or market_outcomes tables after initial insertion — the only permitted write operation on historical data SHALL be the initial INSERT (or UPSERT for Sunday-Monday candle merging at ingestion time)
4. THE Platform SHALL enforce Point_In_Time_Correctness by ensuring that every Fingerprint is constructed using only data with a timestamp_utc strictly less than or equal to the Fingerprint's own timestamp_utc — no data point with a later timestamp SHALL be referenced during fingerprint construction, similarity matching, or outcome distribution computation
5. EVERY statistical output (mean, median, probability, percentile) SHALL be derived solely from the set of matched historical observations available at computation time, with no smoothing, interpolation between observations, or distribution fitting applied to the raw empirical values
6. IF the count of matched historical observations is fewer than 1, THEN THE Platform SHALL reject the computation and return an error indicating insufficient empirical data — no statistical output SHALL be produced from an empty observation set
7. THE Platform SHALL record an immutable execution trace for each outcome distribution computation that includes the input_hash (SHA-256 of matched fingerprint IDs), output_hash, and sample_size, enabling independent auditors to verify empirical purity by reproducing identical outputs from identical inputs

### Requirement 2: Determinism and Reproducibility

**User Story:** As a research analyst, I want every platform output to be exactly reproducible, so that research results can be independently verified and trusted.

#### Acceptance Criteria

1. THE Platform SHALL produce Deterministic_Output from every engine — identical inputs SHALL produce bit-identical outputs regardless of execution time, execution count, or system state
2. THE Platform SHALL never introduce machine learning, self-learning systems, or adaptive algorithms that modify behaviour based on prior outputs or accumulated state
3. IF the same Engine_Version, input data, and configuration are provided, THEN THE Platform SHALL produce a bit-identical forecast including direction_probabilities, expected_move_pips, and confidence scores
4. IF the same query fingerprint and candidate corpus are provided, THEN THE Platform SHALL produce identical ranked similarity matches with identical scores and identical ordering — including deterministic tie-breaking by fingerprint_id when similarity scores are equal
5. THE Platform SHALL never introduce randomness, stochastic sampling, or non-deterministic ordering into any computation path — all collection iterations, sort operations, and aggregations SHALL use deterministic ordering guarantees
6. THE Platform SHALL ensure that all database query results used as computation inputs are ordered by a deterministic key (e.g., fingerprint_id or timestamp) so that result set ordering does not vary between executions

### Requirement 3: Immutability and Auditability

**User Story:** As a research analyst, I want all research data to be permanently immutable once written, so that the historical archive is trustworthy and forms a reliable basis for longitudinal analysis.

#### Acceptance Criteria

1. THE Platform SHALL never issue UPDATE or DELETE statements against persisted Forecast_Record, Evaluation_Record, or Similarity_Archive records through any application-layer code path
2. THE Platform SHALL enforce immutability at the database level using constraints or policies that prevent modification of Research_Archive records, so that immutability does not depend solely on application code discipline
3. EVERY persisted Research_Archive record SHALL include: the batch_id that produced the record, the complete engine_versions snapshot (mapping each engine name to its version string), and a created_at timestamp in ISO-8601 UTC recording when the record was persisted
4. THE Platform SHALL preserve every Forecast_Record indefinitely — no TTL, expiration policy, or scheduled purge SHALL apply to Research_Archive tables
5. THE Platform SHALL preserve every Evaluation_Record indefinitely — no TTL, expiration policy, or scheduled purge SHALL apply to Research_Archive tables
6. THE Platform SHALL preserve every Similarity_Archive record indefinitely — no TTL, expiration policy, or scheduled purge SHALL apply to Research_Archive tables
7. IF a write to the Research_Archive encounters a duplicate key conflict (same batch_id and record identifier), THEN THE Platform SHALL reject the duplicate write without modifying the existing record and log the conflict

### Requirement 4: Research Archive and Permanence

**User Story:** As a research analyst, I want the platform to function as a permanent research archive, so that all outputs contribute to a growing body of verifiable financial research.

#### Acceptance Criteria

1. THE Platform SHALL persist every forecast produced by the Batch_Layer as a permanent Forecast_Record in the Research_Archive
2. THE Platform SHALL persist every evaluation produced by the Evaluation_Engine as a permanent Evaluation_Record in the Research_Archive
3. THE Platform SHALL persist every similarity search result produced by the Similarity_Engine as a permanent record in the Similarity_Archive
4. THE Research_Archive SHALL support querying by batch_id, asset, timeframe, forecast_timestamp date range, engine_version, and regime classification — where date range filters on the forecast_timestamp field using inclusive start and end boundaries
5. THE Platform SHALL support Historical_Replay — re-executing any historical batch using the engine_versions snapshot recorded in the corresponding batch_runs record and the raw input data preserved in raw_candles to reproduce Deterministic_Output (bit-identical results given identical engine versions and inputs)
6. IF a Historical_Replay is requested and the required input data or engine version record is unavailable, THEN THE Platform SHALL reject the replay request with an error indication specifying which prerequisite is missing (input data or engine version) without modifying any existing archive records
7. WHEN an engine comparison is executed, THE Platform SHALL run the specified engine versions against the same input batch, persist each version's output as a separate record in the Research_Archive tagged with its respective engine_version, and make all version outputs queryable by the shared batch_id and input fingerprint_id
8. THE Platform SHALL retain all raw input data (raw_candles) and engine version records permanently so that Historical_Replay remains possible for any previously completed batch

### Requirement 5: Experimentation and Comparison

**User Story:** As a research analyst, I want the platform to support offline experimentation and A/B engine testing, so that I can evaluate improvements against historical baselines before activation.

#### Acceptance Criteria

1. THE Platform SHALL support A/B engine testing by allowing at least 2 engine versions to process the same input data (identical asset, timeframe, and date range) and persisting both result sets tagged with their respective Engine_Version identifiers and a shared experiment_id
2. THE Platform SHALL support offline experimentation — running new engine versions against historical data — with production isolation enforced by writing experiment outputs exclusively to experiment-namespaced records that are never read by the live Batch_Layer or Runtime_Layer
3. THE Platform SHALL support side-by-side comparison of outputs from different engine versions by exposing per-record differences in direction_probabilities, expected_move_pips, confidence_final, and sample_size for the same input fingerprint and time period
4. WHEN a new engine version is developed, THE Platform SHALL support backtesting against historical inputs with results persisted in experiment-tagged records that include the experiment_id, engine_versions snapshot, batch_id of the original production run, and timestamp of the experiment execution
5. IF an experiment run fails during execution, THEN THE Platform SHALL record the failure (failed stage and error detail) against the experiment_id and preserve any partial results already persisted without affecting production data
6. THE Platform SHALL execute experiment runs within the same 15-minute Cloud Run timeout limit that applies to production batch runs

### Requirement 6: Prediction Explainability

**User Story:** As a research analyst, I want every prediction to be fully explainable, so that I can trace the reasoning chain from market observation through to probabilistic forecast.

#### Acceptance Criteria

1. THE Platform SHALL record, for each forecast, the complete list of historical fingerprint_ids (up to 50) that contributed to the outcome distribution used to derive that forecast
2. THE Platform SHALL include, for each similarity match, the per-layer similarity scores (market_structure, volatility, liquidity, macro, sentiment) each as a value between 0.000000 and 1.000000, the regime weight matrix applied, and the primary_match_reason classification
3. THE Platform SHALL include, for each confidence score, the contributing factors: confidence_raw, sample_weight, and regime_stability each as a value between 0.0 and 1.0, along with the composition formula result (confidence_final = confidence_raw × sample_weight × regime_stability)
4. THE Platform SHALL store a batch_id on every forecast, similarity match, and outcome distribution record such that all records produced in the same pipeline run are linked by a shared batch_id
5. WHEN a trace request is made for a forecast, THE Platform SHALL return the linked chain: matched fingerprint_ids → per-match similarity breakdowns → forward returns used → outcome distribution statistics → directional probabilities, retrievable within 2000 milliseconds
6. IF any referenced fingerprint_id in a forecast's trace chain has no corresponding stored record, THEN THE Platform SHALL return the trace with the available links and indicate which fingerprint_ids are missing from the chain

### Requirement 7: Evaluation Engine

**User Story:** As a research analyst, I want every forecast automatically evaluated against realised market behaviour, so that the platform continuously measures its own accuracy without human intervention.

#### Acceptance Criteria

1. THE Evaluation_Engine SHALL compare every matured forecast against the realised market outcome for the same asset and timeframe, where a forecast is matured when its forecast_expiry timestamp has passed
2. WHEN the forecast_expiry timestamp has passed AND the corresponding market outcome is available in the market_outcomes table, THE Evaluation_Engine SHALL evaluate that forecast within the next scheduled batch cycle (within 4 hours of outcome availability)
3. IF the forecast_expiry timestamp has passed AND the corresponding market outcome is not available after 2 consecutive batch cycles (8 hours), THEN THE Evaluation_Engine SHALL mark the forecast as "outcome_unavailable" and skip evaluation without halting processing of other forecasts
4. THE Evaluation_Engine SHALL calculate the following metrics: direction_accuracy (1 if predicted direction matches realised direction, 0 otherwise — where predicted direction is the direction with the highest probability in direction_probabilities, and realised direction is derived from net_return_pips using the FLAT_THRESHOLD of 2 pips), expected_move_error (predicted expected_move_pips minus realised net_return_pips), absolute_error (absolute value of expected_move_error), rmse_contribution (squared expected_move_error for aggregation), brier_score (mean squared error between predicted probability vector and one-hot realised direction vector), confidence_calibration_score (difference between confidence_final and observed direction_accuracy for calibration tracking), and calibration_bucket (the discrete confidence interval range containing the forecast's confidence_final, with bucket width defined by the Evaluation_Engine version configuration)
5. THE Evaluation_Engine SHALL calculate forecast_success as true when the predicted direction (highest probability direction) matches the realised direction, and false otherwise
6. THE Evaluation_Engine SHALL calculate tradeability_success as true when forecast_success is true AND the realised absolute move in pips exceeds the expected_move_pips by no more than 50% error (absolute_error <= 0.5 * absolute value of realised net_return_pips), and false otherwise
7. THE Evaluation_Engine SHALL execute as a batch process within the Batch_Layer — NOT as part of Runtime_Layer API handlers — running after the main 7-stage pipeline completes in each batch cycle
8. THE Evaluation_Engine SHALL produce Deterministic_Output given identical forecast and market outcome inputs — the same forecast record and the same market outcome record SHALL always produce the identical Evaluation_Record
9. THE Platform SHALL never overwrite or delete an Evaluation_Record once persisted
10. THE Evaluation_Engine SHALL be versioned — evaluation algorithm changes SHALL produce a new Engine_Version record in the engine_versions table, and each Evaluation_Record SHALL reference the engine_version that produced it
11. THE Evaluation_Engine SHALL maintain a complete audit trail — every Evaluation_Record SHALL reference the forecast_id of the forecast it assessed, the outcome_id of the market outcome it measured against, the batch_id of the evaluation batch, and the engine_version used

### Requirement 8: Calibration Measurement

**User Story:** As a research analyst, I want calibration accuracy measured systematically, so that I can verify whether stated confidence levels match observed accuracy rates.

#### Acceptance Criteria

1. THE Evaluation_Engine SHALL assign each evaluated forecast to a Calibration_Bucket based on its confidence_final score using 10 uniform buckets: [0.0–0.1), [0.1–0.2), [0.2–0.3), [0.3–0.4), [0.4–0.5), [0.5–0.6), [0.6–0.7), [0.7–0.8), [0.8–0.9), [0.9–1.0]
2. THE Platform SHALL measure calibration accuracy per bucket as the absolute deviation between the bucket midpoint confidence and the observed success rate (forecast_success = true ratio) within that bucket
3. THE Platform SHALL support calibration analysis filtered by: asset, timeframe, regime classification, engine_version, and date range (forecast_timestamp boundaries)
4. THE Calibration_Bucket boundaries SHALL be deterministic and versioned as part of the Evaluation_Engine version configuration — not dynamically adjusted based on data distribution
5. IF a Calibration_Bucket contains fewer than 10 evaluated forecasts, THEN THE Platform SHALL flag that bucket as having insufficient sample size and exclude it from aggregate calibration metrics
6. THE Platform SHALL compute an overall calibration score as the mean absolute deviation across all buckets with sufficient sample size (≥10 forecasts)

### Requirement 9: Forecast Research Archive

**User Story:** As a research analyst, I want every batch forecast persisted with complete metadata, so that the research archive contains all information needed for future evaluation and analysis.

#### Acceptance Criteria

1. WHEN the Forecast_Engine produces a forecast during a batch run, THE Platform SHALL persist a Forecast_Record to the research archive containing: fingerprint_id, batch_id, asset, timeframe, forecast_timestamp (ISO-8601 UTC time of record creation), forecast_expiry (the valid_until value computed for the corresponding cached_forecasts entry), direction_probabilities (up, down, flat as decimal values summing to 1.00), expected_move_pips, confidence_raw, confidence_final, tradeability_placeholder (stored as null until the Tradeability Engine is implemented), engine_versions snapshot (frozen key-value map of engine_name to engine_version captured at batch start), quantile_table_version, regime classification (volatility_regime, trend_regime, session), and sample_size
2. THE Platform SHALL continue writing to cached_forecasts with no changes to that table's schema, write logic, or TTL computation — the research archive is an additional write target, not a replacement for the serving layer
3. WHEN the cache write to cached_forecasts succeeds for a given forecast, THE Platform SHALL persist the corresponding Forecast_Record to the research archive within 30 seconds of cache write completion, so that cache serving latency is never increased by research persistence
4. IF persistence of a Forecast_Record to the research archive fails after a single write attempt, THEN THE Platform SHALL log the failure including batch_id, fingerprint_id, and the error reason, and continue the batch run without halting or retrying downstream operations
5. THE research archive table SHALL be a new table that does not modify the existing cached_forecasts table or any other existing table schema
6. THE Platform SHALL enforce a uniqueness constraint on (fingerprint_id, batch_id) in the research archive table so that duplicate records are rejected on batch retries

### Requirement 10: Similarity Persistence

**User Story:** As a research analyst, I want all similarity matching results persisted permanently, so that I can audit which historical fingerprints drove each forecast and trace the full reasoning chain.

#### Acceptance Criteria

1. WHEN the Similarity_Engine produces matches during a batch run, THE Platform SHALL persist all match results (up to 50 per query fingerprint) to the Similarity_Archive within the same batch transaction, before the outcome stage begins
2. THE similarity match record SHALL contain: fingerprint_id, match_fingerprint_id, similarity_score (NUMERIC 6 decimal places, range 0.000000 to 1.000000), layer_breakdown (market_structure, volatility, liquidity, macro, sentiment scores each as NUMERIC 6 decimal places), match_explanation (matched_layers, mismatched_layers, primary_match_reason), rank (1-indexed integer, 1 to 50), batch_id, and engine_versions snapshot (record mapping each engine name to its active version string at batch start)
3. THE Similarity_Engine SHALL continue operating exactly as today — no changes to its matching algorithm, scoring logic, or weight matrices
4. THE Similarity_Archive SHALL support future explainability queries by preserving the complete per-layer breakdown and match_explanation for every match, indexed by fingerprint_id and batch_id
5. THE Platform SHALL never delete or overwrite similarity archive records once persisted; each batch run produces new records distinguished by their unique (fingerprint_id, match_fingerprint_id, batch_id) combination
6. IF the Similarity_Engine produces zero matches for a query fingerprint during a batch run, THEN THE Platform SHALL persist no archive records for that fingerprint and batch_id, and the downstream pipeline stages SHALL proceed with an empty match set
7. IF persistence to the Similarity_Archive fails during a batch run, THEN THE Platform SHALL halt downstream pipeline stages, mark the batch as failed with a failure detail message indicating the archive write error, and discard partial output for that batch

### Requirement 11: Evidence-Based Confidence Redesign

**User Story:** As a research analyst, I want the confidence model redesigned using empirical evidence, so that confidence scores reflect measured prediction accuracy rather than theoretical dampening.

#### Acceptance Criteria

1. THE redesigned Confidence_Engine SHALL use the Evaluation_Engine dataset to derive frozen calibration parameters from: observed prediction_accuracy grouped by regime classification, observed success_rate per Calibration_Bucket, observed accuracy variation by sample_size (minimum 30 evaluated forecasts per grouping required), and observed accuracy variation by regime classification
2. THE redesigned Confidence_Engine SHALL produce Deterministic_Output given identical inputs — identical calibration parameters and identical ConfidenceInput values SHALL produce bit-identical confidence scores
3. THE redesigned Confidence_Engine SHALL be versioned as a new Engine_Version — the v1.0.0 algorithm SHALL remain available for comparison and both versions SHALL be loadable via the VersionService
4. THE Platform SHALL support historical comparison between Confidence_Engine v1 and the redesigned version by retaining both version records and supporting side-by-side execution against the same ConfidenceInput data
5. THE redesigned Confidence_Engine SHALL remain bounded to [0.0, 1.0] output range with 6 decimal places of precision
6. THE redesigned Confidence_Engine SHALL not introduce any machine learning, self-learning, or adaptive behaviour — calibration parameters SHALL be frozen per Engine_Version and SHALL only change via a new versioned release
7. THE confidence score output SHALL expose its contributing factors as named numeric components including: the calibration-adjusted base score, the regime-specific accuracy modifier, the sample-density modifier, and the final composed score — each individually bounded to [0.0, 1.0]
8. IF the Evaluation_Engine dataset contains fewer than 30 evaluated forecasts for a given regime or Calibration_Bucket, THEN THE redesigned Confidence_Engine SHALL fall back to the global calibration parameters derived from all evaluated forecasts and SHALL flag the output as using fallback calibration
9. WHEN calibration parameters are frozen for a new Confidence_Engine version, THE Platform SHALL persist the complete parameter set as part of the Engine_Version config record so that the calibration is reproducible and auditable

### Requirement 12: Structured Execution Traces

**User Story:** As a platform operator, I want every engine execution to emit structured traces with complete execution metadata, so that pipeline behaviour is fully auditable and supports future monitoring dashboards.

#### Acceptance Criteria

1. WHEN any engine executes during a batch run, THE engine SHALL emit a structured trace containing: batch_id, engine_name, engine_version, input_hash (SHA-256 hex digest of JSON-serialised input), output_hash (SHA-256 hex digest of JSON-serialised output), execution_time_ms (wall-clock milliseconds as integer), sample_size (nullable integer), status ("success" or "error"), error_detail (nullable string present when status is "error"), and timestamp_utc (ISO-8601 UTC timestamp of trace emission)
2. WHEN a structured trace is emitted, THE Platform SHALL persist it to the execution_traces table within 5 seconds of engine completion
3. IF trace emission or persistence fails, THEN THE Platform SHALL log the failure to console.error including the engine_name and error message, and continue pipeline execution without halting or affecting the engine's return value
4. THE Platform SHALL not introduce third-party monitoring platforms or external observability services
5. THE execution_traces table SHALL be indexed on (batch_id, engine_name) to support queries filtering by batch run and engine without requiring schema modification for per-batch or per-engine trace retrieval
6. THE Platform SHALL remain within the £50/month infrastructure cost ceiling after observability is enabled, with trace storage not exceeding 100 MB per calendar month based on 6 batch runs per day and up to 7 engine traces per run
7. IF an engine execution completes with status "error", THEN THE trace SHALL record the error message string in the error_detail field and set output_hash to the SHA-256 digest of an empty string

### Requirement 13: Deterministic Topology Model

**User Story:** As a research analyst, I want a deterministic Support and Resistance model representing price level topology, so that the platform captures structural market levels as an additional research feature and similarity layer.

#### Acceptance Criteria

1. THE Platform SHALL compute a deterministic Support_Resistance_Topology for each fingerprint containing a maximum of 20 levels, where each level includes: price, type (support | resistance | flip_zone), strength (normalised 0 to 1 representing rejection frequency relative to total touches), touch_count, rejection_count, breakout_count, age_in_candles (number of 4H candles since level was first established), distance_from_current_price_pips (absolute distance in pips from the candle close), and relative_importance (strength multiplied by inverse of distance_from_current_price_pips normalised across all levels in the set to sum to 1.0)
2. THE Support_Resistance_Topology SHALL be stored in a separate topology table referenced by fingerprint_id and asset as a foreign key to market_fingerprints — not embedded as large objects inside fingerprint vectors
3. THE Support_Resistance_Topology SHALL be represented as a fixed-length normalised vector (values in 0 to 1) available to the Similarity_Engine as an additional weighted layer for cosine-distance comparison alongside existing L1-L5 layers
4. THE existing forecasting logic SHALL not change as a result of topology introduction — topology is research-only in this phase and the Similarity_Engine SHALL treat the topology layer weight as 0.0 in all regime weight matrices until explicitly activated in a future release
5. WHEN the Platform computes the Support_Resistance_Topology, THE Platform SHALL use the most recent 120 candles (480 hours) of price history for the same asset and timeframe as input, and SHALL produce bit-identical output given identical ordered price history inputs
6. THE topology table SHALL use an Additive_Schema_Change that does not modify existing fingerprint, similarity_matches, or forecast tables and does not alter any existing column, constraint, or index
7. IF fewer than 30 candles of price history are available for a given fingerprint, THEN THE Platform SHALL store an empty topology (zero levels) for that fingerprint and set a flag indicating insufficient_history

### Requirement 14: Expanded Fingerprint Features

**User Story:** As a research analyst, I want the fingerprint enriched with additional deterministic research features, so that the platform captures richer market state for improved similarity matching and future analysis.

#### Acceptance Criteria

1. THE Fingerprint_Engine SHALL support additional deterministic features stored within the extended_state JSONB field: rolling_trend (computed from 50 most recent 4H candles for the same asset), atr_percentile (normalised to [0.0, 1.0]), volatility_regime_score (normalised to [0.0, 1.0]), session_statistics (candle count and average range per session within the lookback window), correlated_markets (alignment scores for up to 5 configured correlated instruments, each normalised to [0.0, 1.0]), economic_calendar_summary (binary high-impact event flag and hours-to-next-event count), macro_state (composite of MacroContext fields normalised to [0.0, 1.0]), and sentiment_summary (composite sentiment score normalised to [0.0, 1.0])
2. EACH additional feature SHALL be independently enableable via the engine_versions config object — a feature is computed only when its key is set to true in the active Fingerprint_Engine version configuration
3. IF a data provider for a feature is unavailable OR any data required for a feature is missing, THEN THE Fingerprint_Engine SHALL substitute the neutral default value of 0.5 for scalar fields and mid-range neutral arrays for vector fields, log a warning in the execution trace warnings array, and continue batch execution without halting
4. IF fewer than 50 historical candles are available for rolling_trend computation, THEN THE Fingerprint_Engine SHALL compute rolling_trend using all available candles (minimum 1) and record the actual candle count used in the feature metadata
5. WHEN a new feature is added to the extended_state schema, THE Platform SHALL increment fingerprint_schema_version following the existing semver format managed by the VersionService
6. THE additional features SHALL produce Deterministic_Output given identical inputs and provider responses — all normalised values SHALL be rounded to 6 decimal places using the same fixed-precision rounding as existing state layers
7. THE existing fingerprint schema SHALL remain backwards compatible — all additions SHALL be new keys within the existing extended_state JSONB field, and no existing columns, state_layers dimensions, or extended_state keys SHALL be removed or renamed

### Requirement 15: Enhanced Regime Model

**User Story:** As a research analyst, I want regime classification redesigned using the richer fingerprint data, so that classification captures more nuanced market states with full explainability and no black-box logic.

#### Acceptance Criteria

1. THE Regime_Engine v2 SHALL support classification into: trend, ranging, expansion, contraction, macro_driven, breakout, reversal, accumulation, and distribution regimes, assigning exactly one primary regime and up to two secondary regimes per fingerprint, where each secondary regime includes a relevance score normalised to [0.0, 1.0]
2. THE Regime_Engine v2 SHALL use deterministic rules for classification — no black-box classifiers, no neural networks, no opaque statistical models — where each regime is defined by explicit threshold-based conditions over fingerprint state layer values and enriched features from Requirement 14
3. THE Regime_Engine v2 SHALL be versioned as a new Engine_Version, retaining Regime_Engine v1 records for comparison, and SHALL persist its classification output separately from the existing RegimeClassification fields (volatility_regime, trend_regime, session) which remain unchanged
4. WHILE both Regime_Engine v1 and v2 are active in the engine_versions table, THE Platform SHALL persist both classification results for every batch-produced fingerprint, enabling side-by-side comparison until Regime_Engine v1 is explicitly deactivated via a version record update
5. THE Regime_Engine v2 SHALL produce Deterministic_Output given identical fingerprint inputs — identical state_layers, extended_state, and enriched feature values SHALL yield bit-identical regime classification and explanation output
6. THE Regime_Engine v2 SHALL provide a structured explanation for each classification decision containing: (a) the list of rule identifiers that fired, (b) the fingerprint features evaluated with their values, (c) the threshold conditions each rule tested, and (d) which features satisfied or failed each rule — enabling independent verification of the classification logic
7. IF enriched fingerprint features from Requirement 14 contain neutral default values due to data provider unavailability, THEN THE Regime_Engine v2 SHALL still produce a valid classification using only available non-default features, and SHALL indicate in the explanation output which features were unavailable and excluded from rule evaluation

### Requirement 16: Comprehensive Versioning

**User Story:** As a platform operator, I want every algorithmic component, configuration, and schema versioned immutably, so that any historical output can be exactly reproduced.

#### Acceptance Criteria

1. THE Platform SHALL maintain version records in the engine_versions table for each of the following component types: engine algorithms, similarity weight profiles, regime classification rules, Support_Resistance_Topology model, fingerprint feature schema, quantile tables, and evaluation algorithms, each identified by a semantic version string in MAJOR.MINOR.PATCH format (maximum 10 characters)
2. WHEN any versioned component is modified (algorithm logic change, configuration value change, schema structure change, or reference data update), THE Platform SHALL insert a new version record with is_active set to true and deactivate the previous record, without updating or deleting the previous record's content
3. WHEN a batch run starts, THE Platform SHALL snapshot all active version identifiers — including engine_version, quantile_table_version, and fingerprint_schema_version for every registered engine — and store the complete snapshot in the batch_runs.engine_versions JSONB column
4. THE Platform SHALL include the batch_id (which references the version snapshot in batch_runs) in every output record written to similarity_results, forecasts, and execution_traces tables during that batch run
5. WHEN a reproduction request is issued for a historical output, THE Platform SHALL load the version snapshot stored in the batch_runs record associated with that output and configure all engines to use the exact component versions specified in that snapshot, such that identical inputs processed with the loaded snapshot produce identical outputs
6. THE Platform SHALL enforce immutability of historical version records by never issuing DELETE or UPDATE operations against content columns (engine_version, quantile_table_version, fingerprint_schema_version, config) of existing engine_versions rows; only the is_active flag may be updated
7. IF a batch run starts and no active version record exists for one or more registered engine components, THEN THE Platform SHALL abort the batch run and record a failure indicating which component lacks an active version

### Requirement 17: Input Data Integrity

**User Story:** As a platform operator, I want all ingested market data validated for integrity, so that the research archive is built on trustworthy observations.

#### Acceptance Criteria

1. WHEN OHLC candle data is ingested, THE Platform SHALL validate: high >= max(open, close), low <= min(open, close), high >= low, and all prices are positive (greater than 0) — using the NUMERIC(10,5) precision of the raw_candles table
2. THE Platform SHALL reject duplicate timestamps for the same asset and timeframe using the existing UNIQUE constraint on (asset, timeframe, timestamp_utc) — no two candles SHALL share an identical timestamp for the same asset and timeframe
3. THE Platform SHALL detect gaps in the expected UTC 4H interval sequence (hours 0, 4, 8, 12, 16, 20) and log a warning including the asset, timeframe, and missing timestamp for each gap detected
4. IF a data provider returns data that fails OHLC validation, THEN THE Platform SHALL quarantine the invalid records (log the raw response without persisting to raw_candles) and attempt the next provider in the fallback chain (Twelve Data → Massive API → Yahoo Finance) with a 10-second timeout per provider
5. IF all providers in the fallback chain return invalid data for the same candle, THEN THE Platform SHALL record a critical warning in the execution trace and skip that candle without halting the batch run
6. THE Platform SHALL never persist a candle to raw_candles that fails any OHLC integrity check — the INSERT SHALL be rejected at application level before reaching the database

### Requirement 18: Performance Boundaries

**User Story:** As a platform operator, I want explicit performance boundaries, so that the platform remains responsive, cost-efficient, and operationally viable as complexity grows.

#### Acceptance Criteria

1. WHILE the Runtime_Layer is handling requests on a warm instance, THE Runtime_Layer SHALL respond to API requests within 300ms at the 95th percentile measured over each 4-hour batch cycle
2. THE Batch_Layer SHALL complete all pipeline stages within 900 seconds (the Cloud Run timeout limit), including after new computation phases are added
3. THE Platform SHALL remain within the £50/month infrastructure cost ceiling as measured by the sum of all Google Cloud and third-party service invoices at the end of each calendar month
4. WHEN a new computation phase is added, THE Platform SHALL execute that phase exclusively in the Batch_Layer without adding computation to the Runtime_Layer request path
5. THE Platform SHALL not exceed 10 concurrent database connections from all services combined during a batch cycle (within the Supabase free-tier pooler limit of 20 concurrent connections)
6. THE Platform SHALL maintain query response times of 200ms or less at the 95th percentile on archive tables when total database storage is at or below 400MB (80% of the Supabase free-tier 500MB limit)
7. IF total database storage exceeds 400MB, THEN THE Platform SHALL execute a retention or archival process that reduces storage below 400MB before the next batch cycle completes
8. WHILE the Runtime_Layer instance is cold-starting, THE Runtime_Layer SHALL complete startup and respond to the first request within 10 seconds

### Requirement 19: API and Schema Stability

**User Story:** As an API consumer, I want all existing API endpoints to continue functioning without regressions throughout the evolution programme, so that current integrations are never broken.

#### Acceptance Criteria

1. THE Platform SHALL maintain all existing API endpoints (GET /v1/forecast/:asset, GET /v1/similarity/:asset, GET /v1/state/:asset) such that every response field present in the current schema (field names, JSON types, and nesting structure) remains present and type-compatible in all subsequent releases — new fields MAY be added but existing fields SHALL NOT be removed, renamed, or have their type changed
2. WHEN database schema changes are applied, THE Platform SHALL use additive-only migrations that add new columns (nullable or with defaults), new tables, or new indexes — migrations SHALL NOT remove, rename, or change the type of any existing column or table
3. THE Platform SHALL preserve the cached_forecasts table with its existing columns (asset, fingerprint_id, payload, batch_id, valid_from, valid_until, created_at) — new nullable columns MAY be added but existing columns SHALL NOT be removed, renamed, or have their type changed
4. WHILE any phase is being deployed, THE Platform SHALL respond to GET /v1/forecast/:asset, GET /v1/similarity/:asset, and GET /v1/state/:asset with either a valid response (HTTP 200/400/404 as per existing behaviour) or HTTP 503 within 5 seconds — at no point SHALL all instances be unavailable simultaneously
5. WHEN a phase implementation is completed, THE Platform SHALL pass the full existing test suite (vitest --run) with zero test failures before that phase is merged into the main branch

### Requirement 20: Comprehensive Testing Per Phase

**User Story:** As a platform developer, I want each phase to include comprehensive tests including property-based tests for mathematical guarantees, so that the platform maintains correctness as complexity grows.

#### Acceptance Criteria

1. WHEN any phase is completed, THE Platform SHALL include: at least one unit test per new public function or method, at least one integration test per new module or service boundary, at least one property-based test per new engine or mathematical computation, migration tests for every new database migration, and regression tests covering any modified behaviour
2. THE Platform SHALL maintain or increase line coverage as measured by vitest --coverage — the line coverage percentage reported after a phase is completed SHALL be greater than or equal to the line coverage percentage reported before the phase began
3. THE existing test suite SHALL continue passing without modification unless tests are explicitly updated for intentional behaviour changes
4. WHEN a new engine is introduced, THE Platform SHALL include property-based tests (using fast-check with a minimum of 100 iterations per property) verifying: determinism (invoking the engine twice with identical inputs produces bit-identical outputs), output bounds (all numeric outputs fall within the engine's documented min/max range as defined in its type interface), and mathematical invariants (e.g., probability sets sum to exactly 1.0, scores remain within [0.0, 1.0])
5. WHEN a database migration is introduced, THE Platform SHALL include migration tests verifying: the migration applies without errors to a database containing representative seed data, all pre-existing table row counts remain unchanged after migration, and all pre-existing columns remain accessible with their original data types
6. IF any property-based test or migration test fails, THEN THE Platform SHALL treat the phase as incomplete — the phase SHALL NOT be considered done until all test categories pass

### Requirement 21: Codebase Organisation

**User Story:** As a platform developer, I want all research-related modules grouped under a dedicated Research namespace from Phase 1 onward, so that the codebase maintains clear domain boundaries as the platform evolves.

#### Acceptance Criteria

1. THE Platform SHALL organise forecast persistence, evaluation, similarity archival, and experiment modules under the Research_Namespace (src/research/) with dedicated subdirectories: persistence/, evaluation/, archival/, and experimentation/
2. THE Research_Namespace SHALL export its public API surface exclusively through a single barrel file (src/research/index.ts), and other platform modules (src/engines/, src/services/, src/api/) SHALL import only from this barrel file, not from internal Research_Namespace paths
3. WHEN a new module is added that performs forecast storage, forecast evaluation, historical-match archival, or experimental hypothesis testing, THE Platform SHALL place the module within the Research_Namespace under the appropriate subdirectory
4. THE Research_Namespace SHALL not introduce circular dependencies with existing src/engines/ or src/services/ directories; dependency direction SHALL flow one-way such that src/research/ may import from src/engines/, src/services/, src/types/, and src/utils/, but src/engines/ and src/services/ SHALL NOT import from src/research/
5. THE Research_Namespace SHALL contain each subdirectory (persistence/, evaluation/, archival/, experimentation/) as a self-contained domain with its own internal index.ts that re-exports only the symbols intended for the namespace-level barrel file
6. WHEN the TypeScript compiler (tsc --noEmit) is run against the project, THE Platform SHALL produce zero circular-dependency errors involving the Research_Namespace, verifiable via the project's existing strict compilation or a dedicated import-boundary lint rule

### Requirement 22: Phase Deployability

**User Story:** As a platform operator, I want each phase to leave the platform in a deployable state with updated documentation, so that the evolution never renders the system inoperable.

#### Acceptance Criteria

1. WHEN any phase is completed, THE Platform SHALL pass all deployment-readiness checks: TypeScript compilation (tsc) completes with zero errors, the test suite (vitest --run) passes with zero failures, and both Docker images (Dockerfile.api, Dockerfile.batch) build successfully
2. WHEN any phase is completed, THE Platform SHALL be deployable to the existing Cloud Run infrastructure by running gcloud builds submit --config=cloudbuild.yaml without additional manual steps
3. WHEN a phase introduces new database tables or schema changes, THE Platform SHALL provide migration scripts in supabase/migrations/ using the naming format YYYYMMDDNNNNNN_descriptive_name.sql where the numeric prefix is sequentially greater than the previous migration
4. WHEN a phase introduces new database tables or schema changes, THE Platform SHALL ensure migration scripts are additive (no DROP or destructive ALTER on existing tables with data) so that existing data is preserved
5. WHEN a phase is completed, THE Platform SHALL update CURRENT-STATE.md to reflect all new or changed tables (in the "Database State" section), engines (in the "File Structure" or "What's Built" sections), configuration (in the "Infrastructure" section), and API interfaces (in the "API Endpoints" section)
6. WHEN a phase is completed, THE Platform SHALL ensure all existing API endpoints listed in CURRENT-STATE.md continue to return HTTP 200 responses with their documented response structure
