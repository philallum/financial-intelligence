# Requirements Document

## Introduction

The Financial Intelligence Platform is a cost-efficient, batch-driven system that models 4-hour FX market behaviour using deterministic market fingerprints, similarity-based historical retrieval, probabilistic outcome distributions, calibrated forecasting, statistically bounded confidence scoring, and runtime tradeability filtering. The platform operates on a strict two-layer architecture: a Batch Intelligence Layer (running every 4 hours) and a Runtime Execution Layer (running per API request). The system is designed for multi-customer B2B delivery, internal research, and API resale, with a hard infrastructure cost ceiling of £50/month for the MVP.

## Glossary

- **Platform**: The Financial Intelligence Platform system as a whole
- **Batch_Layer**: The subsystem that runs every 4 hours to compute fingerprints, similarities, outcomes, forecasts, and confidence scores
- **Runtime_Layer**: The subsystem that runs per API request to evaluate tradeability using live market conditions
- **Fingerprint_Engine**: The component that produces deterministic 4H market state representations from OHLC data
- **Fingerprint**: A canonical, immutable representation of a 4-hour market state including OHLC, return profile, regime classification, 5-vector model, quantile version reference, and session mapping
- **Similarity_Engine**: The component that retrieves the Top N historically similar fingerprints using vector search
- **Outcome_Engine**: The component that transforms matched fingerprints into empirical outcome distributions
- **Forecast_Engine**: The component that converts outcome distributions into directional probabilities and expected move
- **Confidence_Engine**: The component that calculates a statistically bounded confidence reliability score
- **Tradeability_Engine**: The runtime component that evaluates whether a forecast is executable given current market conditions
- **Cached_Forecast_Store**: The database table storing pre-computed forecast responses with a TTL equal to the remaining 4H window
- **OHLC**: Open, High, Low, Close price data for a given period
- **Regime**: A classification of the current market state (e.g., trending, ranging, volatile)
- **HNSW**: Hierarchical Navigable Small World graph index used for approximate nearest neighbour vector search
- **pgvector**: PostgreSQL extension enabling vector similarity search
- **FLAT_Threshold**: The pip threshold (±2 pips for EURUSD MVP) below which a return is classified as FLAT
- **Confidence_Raw**: The unmodified confidence score before dampening and regime adjustment
- **Confidence_Final**: The adjusted confidence score after applying sample size dampener and regime consistency factor
- **Sample_Size_Dampener**: A scaling function S(N) that penalises confidence when sample size N is below 30
- **Regime_Consistency**: A factor R representing how consistent the regime classification is across matched historical periods
- **Tradeability_Score**: A numeric score (0–1) indicating how suitable current conditions are for trade execution
- **TTL**: Time To Live; the duration a cached forecast remains valid (equal to the remaining time in the current 4H window)
- **Batch_ID**: A unique identifier for each batch processing cycle
- **Engine_Version**: A semantic version identifier for each processing engine
- **Quantile_Table_Version**: A version identifier for the quantile reference tables used in fingerprint computation
- **Platform_Integrators**: A customer segment with API-first access, embeddable intelligence capabilities, multi-asset coverage, and SLA-backed service guarantees operating under custom contracts or white-label licensing
- **Response_Mode**: A request parameter specifying the format and depth of API response data; one of "raw", "forecast", "explain", "trade", or "research"
- **Product_Layer**: The presentation and commercial logic layer responsible for audience adaptation, response filtering, tier enforcement, monetisation rules, and all customer-specific behaviour

## System-Wide Constraints

### Constraint 1: Engine Responsibility Boundaries

THE Platform SHALL enforce that each engine treats its input as a complete black box contract and SHALL NOT infer meaning beyond its defined schema fields. This prevents hidden feature leakage, implicit statistical coupling, and soft logic sharing across layers.

### Constraint 2: FLAT Classification Ownership

FLAT classification MUST be defined exclusively in the Outcome_Engine and reused verbatim by all downstream engines without reinterpretation. No downstream engine SHALL redefine, modify, or independently compute FLAT thresholds.

### Constraint 3: No Cross-Engine Memory

No engine SHALL persist intermediate reasoning state across batch cycles unless explicitly stored in a versioned table. This prevents hidden state accumulation and pseudo-learning systems forming unintentionally.

### Constraint 4: Product Layer Isolation

No customer-specific logic SHALL exist inside the forecasting engine. All audience adaptation, response filtering, and commercial logic MUST be confined exclusively to the product layer.

## Requirements

### Requirement 1: Deterministic Fingerprint Generation

**User Story:** As a platform operator, I want deterministic market fingerprints generated every 4 hours, so that all downstream engines receive consistent, reproducible inputs.

#### Acceptance Criteria

1. WHEN a 4H batch cycle is triggered, THE Fingerprint_Engine SHALL produce a Fingerprint for each configured asset using strictly UTC-aligned 4H candle boundaries (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC) and SHALL complete processing for all configured assets within 120 seconds of cycle trigger
2. THE Fingerprint_Engine SHALL produce identical output given identical input OHLC data regardless of execution time or environment
3. WHEN generating a Fingerprint, THE Fingerprint_Engine SHALL include OHLC, return profile, regime classification, 5-vector model, quantile version reference, and session mapping in the output
4. THE Fingerprint_Engine SHALL store each Fingerprint as an immutable record that is never modified after creation
5. THE Fingerprint_Engine SHALL resample raw price data deterministically without dependency on any specific broker data feed
6. WHEN a Fingerprint is stored, THE Fingerprint_Engine SHALL record the fingerprint_id, asset, timestamp_utc, ohlc, regime, vectors, quantile_table_version, and market_state_version, where fingerprint_id is a unique identifier derived deterministically from the asset and the UTC candle timestamp
7. IF raw price data for a configured asset is incomplete or unavailable for a 4H candle boundary, THEN THE Fingerprint_Engine SHALL skip fingerprint generation for that asset and candle, log the gap with the asset identifier and expected candle timestamp, and resume processing remaining assets without interruption
8. IF fingerprint generation for any asset exceeds 120 seconds or fails due to a computation error, THEN THE Fingerprint_Engine SHALL record the failure with the asset identifier and error indication, and SHALL continue processing remaining configured assets

### Requirement 2: Similarity-Based Historical Retrieval

**User Story:** As a platform operator, I want to retrieve historically similar market states for each new fingerprint, so that outcome distributions can be computed from relevant historical data.

#### Acceptance Criteria

1. WHEN a new Fingerprint is created, THE Similarity_Engine SHALL retrieve the top 50 most similar historical fingerprints (excluding the query fingerprint itself) using partitioned pgvector HNSW indexes with cosine distance
2. THE Similarity_Engine SHALL pre-filter candidate fingerprints by asset, timeframe, and regime metadata before performing vector similarity search
3. THE Similarity_Engine SHALL store each match with fingerprint_id, match_fingerprint_id, similarity_score (0.0 to 1.0 inclusive, 6 decimal places), rank (1 to N), and batch_id
4. THE Similarity_Engine SHALL NOT compute outcome statistics, apply performance-based weighting, inject distribution logic, or introduce any form of bias into retrieval results
5. THE Similarity_Engine SHALL NOT adjust filtering thresholds dynamically based on dataset density, market regime, or historical performance distribution
6. WHEN the same Fingerprint is queried against the same historical dataset with the same HNSW index parameters, THE Similarity_Engine SHALL return identical ranked results
7. IF fewer than 50 matching historical fingerprints exist after pre-filtering, THEN THE Similarity_Engine SHALL return all available matches and record the actual match count alongside the batch_id

### Requirement 3: Empirical Outcome Distribution Computation

**User Story:** As a platform operator, I want empirical outcome distributions computed from matched historical fingerprints, so that forecasts are grounded in statistical truth.

#### Acceptance Criteria

1. WHEN similarity results are available for a Fingerprint, THE Outcome_Engine SHALL compute an empirical outcome distribution by collecting the forward 4H returns of each matched historical fingerprint and treating each match with equal weight
2. THE Outcome_Engine SHALL output mean return (arithmetic mean of forward 4H returns), directional probabilities (UP, DOWN, FLAT computed as count of returns in each direction divided by total sample size), volatility behaviour profile (standard deviation and max absolute return of the forward 4H returns), and sample size (total number of matched fingerprints used)
3. THE Outcome_Engine SHALL classify returns as FLAT when the absolute return is less than or equal to the FLAT_Threshold (±2 pips for EURUSD MVP), as UP when the return exceeds the FLAT_Threshold, and as DOWN when the return is below the negative FLAT_Threshold
4. THE Outcome_Engine SHALL NOT apply similarity-score weighting, ranking influence, or any bias to the distribution computation
5. THE Outcome_Engine SHALL store results with fingerprint_id, mean_return, direction_probs, volatility_profile, sample_size, batch_id, and engine_version
6. IF the number of matched historical fingerprints is zero, THEN THE Outcome_Engine SHALL not produce a distribution and SHALL record a failure indicating insufficient sample size for the given fingerprint_id

### Requirement 4: Probabilistic Forecast Generation

**User Story:** As a platform operator, I want directional probability forecasts generated from outcome distributions, so that customers receive calibrated market predictions.

#### Acceptance Criteria

1. WHEN an outcome distribution is computed, THE Forecast_Engine SHALL convert the distribution into directional probabilities (up, down, flat) and expected move in pips, where each probability is a value between 0.00 and 1.00 rounded to two decimal places
2. THE Forecast_Engine SHALL NOT redefine the FLAT threshold and SHALL reference the FLAT classification exclusively as defined by the Outcome_Engine (absolute return less than or equal to FLAT_Threshold)
3. THE Forecast_Engine SHALL output a forecast object containing up probability, down probability, flat probability, and expected_move_pips, where the three directional probabilities sum to exactly 1.00
4. THE Forecast_Engine SHALL store forecasts with fingerprint_id, direction_probabilities, expected_move, confidence_raw, and confidence_final
5. IF the outcome distribution provided to the Forecast_Engine contains fewer than 1 sample or is empty, THEN THE Forecast_Engine SHALL reject the input and return an error indication specifying that the distribution has insufficient data for probability translation

### Requirement 5: Statistically Bounded Confidence Scoring

**User Story:** As a platform operator, I want confidence scores that reflect statistical reliability, so that customers can assess forecast trustworthiness.

#### Acceptance Criteria

1. WHEN a forecast is generated, THE Confidence_Engine SHALL calculate Confidence_Final using the formula: C_final = C_raw × S(N) × R where S(N) is the Sample_Size_Dampener (range 0.0 to 1.0), R is Regime_Consistency (range 0.0 to 1.0), and C_raw is in the range 0.0 to 1.0, such that C_final is bounded between 0.0 and 1.0
2. THE Confidence_Engine SHALL compute Regime_Consistency exclusively from Fingerprint regime metadata alignment across matched historical fingerprints and SHALL NOT use outcome data, forecast results, or any downstream engine output in its computation
3. IF the sample size N is less than 30, THEN THE Confidence_Engine SHALL apply the Sample_Size_Dampener such that S(N) does not exceed 0.5, resulting in Confidence_Final being reduced to at most 50% of the undampened value
4. THE Confidence_Engine SHALL produce identical confidence scores given identical inputs
5. THE Confidence_Engine SHALL record both Confidence_Raw and Confidence_Final with each forecast
6. IF the sample size N is 0 or any input value (C_raw, S(N), R) falls outside the range 0.0 to 1.0, THEN THE Confidence_Engine SHALL reject the calculation and return an error indication specifying which input is invalid

### Requirement 6: Cached Forecast Storage

**User Story:** As a platform operator, I want batch forecasts cached with a TTL aligned to the 4H window, so that API responses are served with minimal latency.

#### Acceptance Criteria

1. WHEN a forecast and confidence score are computed, THE Batch_Layer SHALL store the response payload containing fingerprint_id, direction_probabilities, expected_move, confidence_raw, confidence_final, and sample_size in the Cached_Forecast_Store with a TTL equal to the remaining time in the current 4H window
2. IF the remaining time in the current 4H window is less than 60 seconds at the point of cache storage, THEN THE Batch_Layer SHALL set the TTL to 0 and skip caching for that cycle
3. THE Cached_Forecast_Store SHALL serve pre-computed responses without triggering any batch computation at request time
4. WHEN the TTL expires, THE Cached_Forecast_Store SHALL remove the cached entry so that subsequent requests for that asset return no cached forecast
5. WHEN a new batch cycle produces a forecast for an asset that already has a cached entry, THE Batch_Layer SHALL overwrite the existing cached entry with the new response payload and a recalculated TTL equal to the remaining time in the new 4H window
6. THE Cached_Forecast_Store SHALL key cached entries by asset so that each configured asset has at most one active cached forecast at any time
7. Cached_Forecast entries SHALL only become valid after batch completion is fully confirmed for the corresponding 4H window, preventing partial pipeline exposure and mid-batch overwrite race conditions

### Requirement 7: Runtime Tradeability Evaluation

**User Story:** As an API consumer, I want a tradeability assessment with each forecast, so that I know whether current market conditions support acting on the prediction.

#### Acceptance Criteria

1. WHEN an API request is received, THE Tradeability_Engine SHALL evaluate tradeability by combining static batch data (forecast, confidence, expected move) with dynamic runtime data (current spread, trading session, news risk) and return the result within 500 milliseconds
2. THE Tradeability_Engine SHALL output a tradeability_score (0–1, rounded to two decimal places) and exactly one label from the set {"GO", "CONDITIONAL", "NO_GO"}, where score thresholds for label assignment SHALL be versioned and stored in a configuration artifact tied to engine_version and SHALL be immutable during a batch + runtime cycle, with no live tuning, no per-request adjustment, and no silent A/B behaviour permitted
3. THE Tradeability_Engine SHALL NOT modify forecast probabilities, confidence scores, or any batch-computed values
4. THE Tradeability_Engine SHALL operate exclusively at API request time within the Runtime_Layer
5. IF any dynamic runtime data source (spread, trading session, or news risk) is unavailable at request time, THEN THE Tradeability_Engine SHALL assign the label "NO_GO", set the tradeability_score to 0, and include an indication of which data source was unavailable

### Requirement 8: Forecast API Endpoint

**User Story:** As an API consumer, I want a single endpoint to retrieve the current forecast and tradeability assessment for an asset, so that I can integrate market intelligence into my trading workflow.

#### Acceptance Criteria

1. THE Platform SHALL expose a GET /forecast/{asset} endpoint that returns the cached forecast combined with a real-time tradeability evaluation
2. WHEN a request is received at GET /forecast/{asset}, THE Runtime_Layer SHALL fetch the cached forecast, inject runtime conditions, execute the Tradeability_Engine, and return a response containing: direction_probabilities (up, down, flat), expected_move_pips, confidence_final, tradeability_score, tradeability_label, and forecast_valid_until timestamp
3. WHILE serving requests on the cached path (no cold start, cached forecast available), THE Platform SHALL return API responses within 300 milliseconds at the 95th percentile
4. IF no cached forecast exists for the requested asset, THEN THE Platform SHALL return an error response indicating forecast unavailability, including the requested asset identifier and a message stating no forecast is currently available
5. IF the requested asset is not a configured asset supported by the Platform, THEN THE Platform SHALL return an error response indicating the asset is not supported

### Requirement 9: Batch-Runtime Boundary Enforcement

**User Story:** As a platform architect, I want strict separation between batch and runtime layers, so that system guarantees around reproducibility and cost efficiency are maintained.

#### Acceptance Criteria

1. THE Batch_Layer SHALL NOT access live market data, current spreads, or any real-time data source during computation
2. THE Runtime_Layer SHALL NOT compute historical statistics, outcome distributions, or any batch-layer computation
3. THE Platform SHALL enforce that the Fingerprint is the sole originating input to the batch pipeline, and that each downstream batch engine (Similarity_Engine, Outcome_Engine, Forecast_Engine, Confidence_Engine) receives only the output of its designated predecessor as defined in the pipeline sequence
4. THE Platform SHALL enforce that each engine performs only the responsibilities defined in its glossary entry and SHALL NOT duplicate or perform computation assigned to another engine
5. IF any component attempts to access a data source or perform a computation that violates the batch-runtime boundary, THEN THE Platform SHALL reject the operation and record the violation with the component name, violated boundary rule, and timestamp

### Requirement 10: Engine Versioning

**User Story:** As a platform operator, I want all engines and reference data versioned, so that outputs are traceable and reproducible across system updates.

#### Acceptance Criteria

1. THE Platform SHALL record engine_version, quantile_table_version, and fingerprint_schema_version with every individual engine output within a batch cycle, such that each stored record (fingerprint, similarity result, outcome distribution, forecast, confidence score) includes the version identifiers of the engine and reference data used to produce it
2. WHEN an engine algorithm is modified, THE Platform SHALL increment the corresponding engine_version before the next batch cycle executes
3. WHEN a quantile reference table is updated, THE Platform SHALL increment the quantile_table_version before the next batch cycle executes
4. WHEN the fingerprint canonical structure or field definitions are changed, THE Platform SHALL increment the fingerprint_schema_version before the next batch cycle executes
5. THE Platform SHALL guarantee that identical engine versions and identical inputs produce identical outputs
6. WHILE a batch cycle is in progress, THE Platform SHALL use a single consistent set of engine_version, quantile_table_version, and fingerprint_schema_version values for the entire batch execution, preventing mid-batch version changes from affecting outputs

### Requirement 11: Multi-Customer API Access

**User Story:** As a product manager, I want the platform to serve multiple customer segments through tiered API access, so that the system supports B2B, research, marketplace distribution, and platform integration partners.

#### Acceptance Criteria

1. THE Platform SHALL support retail FX users by returning probabilistic output limited to summary scores, directional indicators, and confidence percentages, excluding raw vectors and similarity matrices
2. THE Platform SHALL support developer API consumers by returning raw JSON responses including probability vectors, similarity scores, and source metadata
3. THE Platform SHALL support research clients by returning full historical distributions covering at minimum the most recent 12 months of available data
4. THE Platform SHALL support platform integrators by providing API-first access with embeddable intelligence components, multi-asset coverage across all configured assets, and SLA-backed service guarantees including uptime commitments and response time targets defined per integration contract
5. THE Platform SHALL support a RapidAPI marketplace layer with rate-limited API endpoints enforcing a maximum of 100 requests per minute per API key
6. IF a customer sends a request for data outside their tier permissions, THEN THE Platform SHALL reject the request and return an error response indicating insufficient tier access within 1 second, without exposing data from higher tiers
7. THE Platform SHALL authenticate each API request and resolve the caller's tier before processing, ensuring that responses contain only fields and data authorized for that tier
8. WHEN an API request includes a response mode parameter, THE Platform SHALL return data formatted according to exactly one of the following modes: "raw" (full machine dataset including all vectors, scores, and metadata), "forecast" (core prediction containing direction_probabilities, expected_move_pips, and confidence_final only), "explain" (prediction plus human-readable reasoning summary and contributing factors), "trade" (tradeability evaluation containing tradeability_score, tradeability_label, and supporting runtime conditions), or "research" (full historical dataset including matched fingerprints, outcome distributions, and time-series data)
9. IF an API request specifies a response mode that the caller's tier does not authorise, THEN THE Platform SHALL reject the request and return an error response indicating the requested mode is not available for the caller's access tier
10. THE Platform SHALL enforce that no customer-specific logic, audience adaptation, response filtering, or commercial rules exist within the Forecast_Engine, Outcome_Engine, Confidence_Engine, or Similarity_Engine; all such logic SHALL be confined exclusively to the product layer
11. THE Platform SHALL align monetisation strategy to customer segments such that: developer API consumers are billed on a usage-based model via RapidAPI or direct billing, research clients access data through subscription or dataset licensing agreements, retail FX users subscribe to a SaaS dashboard, and enterprise clients and platform integrators operate under custom contracts or white-label licensing arrangements
12. IF a response mode parameter is absent from an API request, THEN THE Platform SHALL default to the "forecast" response mode

### Requirement 12: Cost-Optimised Infrastructure

**User Story:** As a platform operator, I want infrastructure costs constrained to £50/month for the MVP, so that the platform remains commercially viable at early stage.

#### Acceptance Criteria

1. THE Platform SHALL use Google Cloud Run for both batch processing and API serving to avoid always-on compute costs
2. THE Platform SHALL use Cloud Scheduler to trigger batch cycles every 4 hours
3. THE Platform SHALL use Supabase Postgres with pgvector and partitioned tables (by asset and timeframe) as the primary datastore
4. THE Platform SHALL cache all batch-computed results with a 4-hour TTL so that API requests are served from pre-computed cached data without triggering additional batch computation
5. THE Platform SHALL NOT use streaming infrastructure or always-on services
6. THE Platform SHALL maintain total infrastructure costs at or below £50 per month for the MVP deployment, assuming up to 50 monitored assets and up to 1,000 API requests per day
7. THE Platform SHALL limit Cloud Run instance concurrency and maximum instance count such that auto-scaling cannot exceed the monthly cost ceiling of £50
8. IF a batch processing job has not completed within 15 minutes, THEN THE Platform SHALL terminate the job and log the timeout event

### Requirement 13: System Determinism and Reproducibility

**User Story:** As a platform operator, I want guaranteed determinism across all batch computations, so that forecasts are reproducible and auditable.

#### Acceptance Criteria

1. THE Platform SHALL guarantee that identical input data, engine_version, quantile_table_version, and fingerprint_schema_version produce bit-identical output across all batch engines regardless of execution time or host environment
2. THE Platform SHALL NOT include hidden learning loops or self-modifying weights; any change to algorithmic behaviour or model parameters SHALL require a corresponding engine_version increment before deployment
3. WHEN a batch cycle completes, THE Platform SHALL produce outputs that are independently reproducible by re-executing the same pipeline with the recorded Batch_ID's input data and version identifiers, yielding bit-identical results
4. THE Platform SHALL NOT use non-deterministic operations (such as unseeded random number generation, unordered parallel reductions, or execution-order-dependent floating-point accumulation) within any batch engine computation
5. IF a batch output differs from a prior output produced with identical inputs and version identifiers, THEN THE Platform SHALL flag the discrepancy by recording the Batch_ID, engine_version, affected asset, and a description of the deviation

### Requirement 14: Batch Processing Pipeline Orchestration

**User Story:** As a platform operator, I want a defined sequential pipeline for batch processing, so that each engine receives correct inputs from its predecessor.

#### Acceptance Criteria

1. WHEN a 4H batch cycle is triggered, THE Batch_Layer SHALL execute engines in the following strict sequential order: data ingestion, fingerprint generation, similarity retrieval, outcome computation, forecast generation, confidence scoring, and result caching, initiating each engine only after its predecessor has completed successfully
2. IF any engine in the pipeline fails to produce a valid output or exceeds its allocated execution timeout, THEN THE Batch_Layer SHALL halt all downstream engines, discard any partial output from the failed engine, and record the failure including batch_id, engine_name, engine_version, timestamp, and a description of the failure cause
3. THE Batch_Layer SHALL pass to each engine exclusively the complete output of its immediate predecessor, with the data ingestion engine receiving the raw 4H market data as its input
4. IF a new 4H batch cycle is triggered while a previous pipeline execution is still in progress, THEN THE Batch_Layer SHALL queue the new cycle and begin execution only after the in-progress pipeline completes or fails
5. WHEN all 7 engines in the pipeline complete successfully, THE Batch_Layer SHALL record the batch as complete with batch_id, total execution duration, and the timestamp of completion

### Requirement 15: Fingerprint Parsing and Serialisation

**User Story:** As a platform operator, I want fingerprints serialised to and parsed from a canonical format, so that they can be stored, retrieved, and transmitted consistently.

#### Acceptance Criteria

1. THE Fingerprint_Engine SHALL serialise Fingerprint objects into a canonical JSON format using lexicographic key ordering and consistent number formatting to ensure deterministic byte-level output
2. WHEN a stored JSON representation is provided, THE Fingerprint_Engine SHALL parse it back into a Fingerprint object containing all required fields: fingerprint_id, asset, timestamp_utc, ohlc, return profile, regime classification, 5-vector model, quantile_table_version, and session mapping
3. THE Fingerprint_Engine SHALL guarantee that serialising any valid Fingerprint object, then parsing the result, then serialising again produces byte-identical output to the first serialisation (round-trip property)
4. IF a JSON representation is provided with missing required fields, invalid field types, or malformed JSON syntax, THEN THE Fingerprint_Engine SHALL return a parsing error indicating which field is missing or invalid and the nature of the failure
5. IF a JSON representation contains unrecognised fields not present in the Fingerprint schema, THEN THE Fingerprint_Engine SHALL reject the input and return a parsing error indicating the unexpected field

### Requirement 16: Engine Observability Contract

**User Story:** As a platform operator, I want structured execution traces from every engine, so that I can debug pgvector issues, track costs, and validate reproducibility.

#### Acceptance Criteria

1. WHEN any engine completes execution, THE engine SHALL emit a structured execution trace containing: input_hash (SHA-256 hash of the serialised input), output_hash (SHA-256 hash of the serialised output), execution_time_ms (wall-clock milliseconds), engine_version, and sample_size (where applicable)
2. THE Platform SHALL store execution traces with batch_id, engine_name, and timestamp_utc so that each engine invocation within a batch cycle is independently auditable
3. THE Platform SHALL guarantee that execution traces are emitted for both successful completions and error conditions
4. IF an engine fails to emit an execution trace after completing or failing, THEN THE Platform SHALL record the missing trace event with engine_name, batch_id, and timestamp_utc
