# Implementation Plan: Research Platform Evolution

## Overview

Transform the Financial Intelligence Platform into a deterministic financial research platform across 8 phases. Implementation follows the phase dependency chain: Phase 1 (Prediction Persistence) enables Phases 2, 3, 5, and 7; Phase 2 enables Phase 4; Phase 3 enables Phase 6; Phase 7 enables Phase 8. All work stays within the £50/month budget, Supabase 500MB free tier, and 15-minute Cloud Run timeout. TypeScript throughout, matching the existing codebase.

## Tasks

- [ ] 1. Set up Research namespace and database migrations
  - [ ] 1.1 Create Research namespace directory structure and barrel files
    - Create `src/research/index.ts` (barrel file)
    - Create `src/research/persistence/index.ts`
    - Create `src/research/evaluation/index.ts`
    - Create `src/research/archival/index.ts`
    - Create `src/research/experimentation/index.ts`
    - Create type files for each subdomain (`types.ts` in each)
    - Ensure one-way dependency direction (research → engines/services/types, never reverse)
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6_

  - [ ] 1.2 Create database migration for research_forecasts table (Phase 1)
    - Create `supabase/migrations/20240101000005_research_forecasts.sql`
    - Include table definition with all columns per design (id, fingerprint_id, batch_id, asset, timeframe, forecast_timestamp, forecast_expiry, direction_probabilities, expected_move_pips, confidence_raw, confidence_final, tradeability_placeholder, engine_versions, quantile_table_version, regime, sample_size, created_at)
    - Add UNIQUE constraint on (fingerprint_id, batch_id)
    - Add indexes: idx_rf_batch, idx_rf_asset_time, idx_rf_expiry, idx_rf_regime
    - Add RLS policies to prevent UPDATE and DELETE (immutability enforcement)
    - _Requirements: 3.2, 4.1, 9.1, 9.5, 9.6, 19.2, 22.3, 22.4_

  - [ ] 1.3 Create database migration for research_evaluations table (Phase 2)
    - Create `supabase/migrations/20240101000006_research_evaluations.sql`
    - Include table definition per design (id, forecast_id FK, outcome_id FK, batch_id, engine_version, direction_accuracy, forecast_success, tradeability_success, expected_move_error, absolute_error, rmse_contribution, brier_score, confidence_calibration_score, calibration_bucket, status, created_at)
    - Add UNIQUE constraint on (forecast_id, batch_id)
    - Add indexes: idx_re_batch, idx_re_bucket, idx_re_engine
    - Add RLS policies to prevent UPDATE and DELETE
    - _Requirements: 3.2, 4.2, 7.9, 7.11, 19.2, 22.3, 22.4_

  - [ ] 1.4 Create database migration for research_similarity_archive table (Phase 3)
    - Create `supabase/migrations/20240101000007_research_similarity_archive.sql`
    - Include table definition per design (id, fingerprint_id, match_fingerprint_id, similarity_score, layer_breakdown, match_explanation, rank, batch_id, engine_versions, created_at)
    - Add UNIQUE constraint on (fingerprint_id, match_fingerprint_id, batch_id)
    - Add indexes: idx_rsa_fp_batch, idx_rsa_batch
    - Add RLS policies to prevent UPDATE and DELETE
    - _Requirements: 3.2, 4.3, 10.1, 10.2, 10.5, 19.2, 22.3, 22.4_

  - [ ] 1.5 Create database migration for fingerprint_topology table (Phase 6)
    - Create `supabase/migrations/20240101000008_fingerprint_topology.sql`
    - Include table definition per design (id, fingerprint_id, asset, levels JSONB, topology_vector vector(40), insufficient_history, candle_count_used, engine_version, created_at)
    - Add UNIQUE constraint on (fingerprint_id, asset)
    - Add FK to market_fingerprints(fingerprint_id, asset)
    - Add index: idx_topo_asset
    - _Requirements: 13.2, 13.6, 19.2, 22.3, 22.4_

  - [ ] 1.6 Create database migration for research_experiments table (Phase 5)
    - Create `supabase/migrations/20240101000009_research_experiments.sql`
    - Include table definition per design (id, experiment_id, engine_versions, original_batch_id, input_fingerprint_id, output JSONB, status, failure_detail, created_at)
    - Add UNIQUE constraint on (experiment_id, input_fingerprint_id)
    - Add index: idx_exp_id
    - _Requirements: 5.1, 5.2, 5.4, 19.2, 22.3, 22.4_

  - [ ]* 1.7 Write migration tests for all new tables
    - Verify each migration applies without errors
    - Verify pre-existing table row counts unchanged
    - Verify pre-existing columns accessible with original types
    - Verify new tables created with correct schema
    - _Requirements: 20.5, 22.3, 22.4_

- [ ] 2. Implement Phase 1 — Prediction Persistence (Research Archive Writer)
  - [ ] 2.1 Implement ResearchArchiveWriter in `src/research/persistence/research-archive-writer.ts`
    - Define `ResearchForecastRecord` interface per design
    - Implement `persistForecast(record)` function
    - Single INSERT to research_forecasts table
    - On duplicate key (fingerprint_id, batch_id) → reject silently, log warning
    - On failure → log error with batch_id + fingerprint_id, do NOT retry, do NOT halt batch
    - _Requirements: 4.1, 9.1, 9.3, 9.4, 3.1, 3.7_

  - [ ] 2.2 Wire Research Archive Writer into batch pipeline
    - Modify `src/batch-entry.ts` to import from `src/research/index.ts`
    - Call `persistForecast` after cache_write stage succeeds (within 30 seconds)
    - Assemble ResearchForecastRecord from pipeline context (fingerprint, forecast, confidence, batch_id, engine_versions snapshot)
    - Compute forecast_expiry from cached_forecasts valid_until
    - Ensure cache serving latency never increased by research persistence
    - _Requirements: 9.2, 9.3, 3.3, 6.4_

  - [ ]* 2.3 Write property test for Record Provenance Completeness
    - **Property 5: Record Provenance Completeness**
    - Generate random valid ResearchForecastRecords
    - Verify batch_id (UUID), engine_versions (non-empty), created_at (ISO-8601) are non-null
    - **Validates: Requirements 3.3, 7.11, 9.1, 10.2**

  - [ ]* 2.4 Write property test for Duplicate Rejection Idempotence
    - **Property 11: Duplicate Rejection Idempotence**
    - Generate records, persist twice with same key
    - Verify existing record unchanged after rejected write
    - **Validates: Requirements 3.7, 9.6**

  - [ ]* 2.5 Write unit tests for Research Archive Writer
    - Test successful persistence
    - Test duplicate key rejection (log warning, no error thrown)
    - Test write failure handling (log error, no throw, batch continues)
    - Test record shape matches expected schema
    - _Requirements: 20.1, 20.4_

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement Phase 2 — Evaluation Engine
  - [ ] 4.1 Implement Evaluation Engine in `src/research/evaluation/evaluation-engine.ts`
    - Define `EvaluationInput`, `EvaluationRecord` interfaces per design
    - Implement `evaluateMaturedForecasts(batchId)` function
    - Query research_forecasts for records where forecast_expiry < NOW()
    - Join against market_outcomes for realised return
    - Compute all metrics: direction_accuracy, expected_move_error, absolute_error, rmse_contribution, brier_score, confidence_calibration_score, forecast_success, tradeability_success
    - Use FLAT_THRESHOLD = 2 pips from constants
    - If outcome unavailable after 2 cycles (8h) → mark as `outcome_unavailable`
    - Deterministic: same inputs = identical evaluation record
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11_

  - [ ] 4.2 Implement Calibration Bucket Assignment in `src/research/evaluation/calibration.ts`
    - 10 uniform buckets: [0.0–0.1), [0.1–0.2), ..., [0.8–0.9), [0.9–1.0]
    - Assign each evaluated forecast to bucket based on confidence_final
    - Compute per-bucket calibration accuracy: |bucket_midpoint - observed_success_rate|
    - Compute overall calibration score: mean absolute deviation across buckets with ≥10 forecasts
    - Flag buckets with <10 forecasts as insufficient sample size
    - Support filtering by asset, timeframe, regime, engine_version, date range
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [ ] 4.3 Wire Evaluation Engine into batch pipeline as post-pipeline stage
    - Add evaluation stage after the 7-stage pipeline completes in batch-entry.ts
    - Execute within Batch_Layer only, NOT Runtime_Layer
    - Persist EvaluationRecords to research_evaluations table
    - Version evaluation engine in engine_versions table
    - _Requirements: 7.7, 7.10, 7.11_

  - [ ]* 4.4 Write property test for Evaluation Metrics Correctness
    - **Property 3: Evaluation Metrics Correctness**
    - Generate random forecast+outcome pairs
    - Verify: direction_accuracy, expected_move_error, absolute_error, brier_score, forecast_success, tradeability_success formulas
    - **Validates: Requirements 7.4, 7.5, 7.6**

  - [ ]* 4.5 Write property test for Calibration Bucket Assignment
    - **Property 6: Calibration Bucket Assignment**
    - Generate random confidence_final in [0, 1]
    - Verify deterministic bucket assignment, exactly one bucket
    - **Validates: Requirements 8.1, 8.4**

  - [ ]* 4.6 Write property test for Calibration Accuracy Computation
    - **Property 7: Calibration Accuracy Computation**
    - Generate random evaluation sets per bucket
    - Verify per-bucket formula and overall calibration score
    - **Validates: Requirements 8.2, 8.6**

  - [ ]* 4.7 Write unit tests for Evaluation Engine
    - Test matured forecast detection
    - Test outcome_unavailable marking after 2 cycles
    - Test all metric computations with known inputs
    - Test determinism (same input = same output)
    - _Requirements: 20.1, 20.4_

- [ ] 5. Implement Phase 3 — Similarity Archive
  - [ ] 5.1 Implement Similarity Archiver in `src/research/archival/similarity-archiver.ts`
    - Define `SimilarityArchiveRecord` interface per design
    - Implement `persistMatches(records)` function
    - Persist all matches (up to 50 per query fingerprint)
    - Include engine_versions snapshot per record
    - On failure → HALT downstream, mark batch as failed (critical for explainability)
    - Unique constraint on (fingerprint_id, match_fingerprint_id, batch_id)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_

  - [ ] 5.2 Wire Similarity Archiver into batch pipeline
    - Call within the similarity stage, BEFORE outcome stage begins
    - On archive write failure → halt downstream pipeline stages, mark batch failed
    - Modify batch-entry.ts similarity handler to call archiver after similarity engine
    - If zero matches → persist nothing, downstream proceeds with empty match set
    - _Requirements: 10.1, 10.6, 10.7_

  - [ ]* 5.3 Write unit tests for Similarity Archiver
    - Test successful persistence of up to 50 matches
    - Test failure halts downstream pipeline
    - Test zero matches produces no archive records
    - Test duplicate key rejection
    - _Requirements: 20.1_

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement Phase 5 — Platform Observability (Trace Wiring)
  - [ ] 7.1 Wire trace emitter into all batch stage handlers
    - Wrap each stage handler in `batch-entry.ts` with `traceEngineExecution`
    - Ensure trace persistence within 5 seconds of engine completion
    - Trace emission failure never interrupts pipeline (existing behaviour preserved)
    - No external monitoring platforms introduced
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [ ]* 7.2 Write property test for Trace Schema Completeness
    - **Property 12: Trace Schema Completeness**
    - Generate random engine executions (success and error)
    - Verify all fields present: batch_id, engine_name, engine_version, input_hash (64-char hex), output_hash (64-char hex), execution_time_ms (non-negative), status, timestamp_utc
    - When status is "error", verify error_detail is non-empty
    - **Validates: Requirements 12.1, 12.7, 1.7**

  - [ ]* 7.3 Write property test for Trace Failure Isolation
    - **Property 13: Trace Failure Isolation**
    - Generate executions with failing trace persistence
    - Verify engine return value unaffected by trace failures
    - **Validates: Requirements 12.3**

- [ ] 8. Implement Phase 4 — Confidence Calibration (Evidence-Based)
  - [ ] 8.1 Implement Confidence Engine v2 in `src/engines/confidence-engine-v2.ts`
    - Define `CalibrationParameters`, `ConfidenceV2Output` interfaces per design
    - Implement evidence-based confidence computation using evaluation dataset
    - Use calibration_adjusted_base, regime_accuracy_modifier, sample_density_modifier
    - Require min 30 evaluated forecasts per grouping; fallback to global if insufficient
    - Freeze calibration parameters per engine version (stored in engine_versions.config)
    - Output bounded [0.0, 1.0], 6 decimal places
    - No ML, no self-learning — deterministic
    - Both v1 and v2 loadable via VersionService
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9_

  - [ ]* 8.2 Write property test for Confidence Output Bounds
    - **Property 4: Confidence Output Bounds**
    - Generate random valid ConfidenceInput (all components in [0, 1], sample_size ≥ 1)
    - Verify every named component individually bounded to [0.0, 1.0] with ≤ 6 decimal places
    - Test both v1 and v2 engines
    - **Validates: Requirements 11.5, 11.7, 6.3**

  - [ ]* 8.3 Write unit tests for Confidence Engine v2
    - Test fallback to global when insufficient data
    - Test calibration parameter loading from engine_versions.config
    - Test determinism (same inputs = same outputs)
    - Test output component exposure (each factor individually available)
    - _Requirements: 20.1, 20.4_

- [ ] 9. Implement Phase 6 — Support & Resistance Topology Engine
  - [ ] 9.1 Implement Topology Engine in `src/engines/topology-engine.ts`
    - Define `TopologyLevel`, `TopologyOutput` interfaces per design
    - Use most recent 120 candles (480H) of price history
    - If < 30 candles → empty topology, insufficient_history = true
    - Produce up to 20 structural levels with type, strength, touch/rejection/breakout counts
    - Produce 40-dimensional normalised vector for similarity comparison
    - Normalise relative_importance to sum to 1.0
    - Deterministic: identical ordered price history → identical output
    - Store in fingerprint_topology table (FK to market_fingerprints)
    - Similarity Engine weight for topology layer = 0.0 initially (research-only)
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.7_

  - [ ] 9.2 Wire Topology Engine into batch pipeline
    - Execute after fingerprint stage, before similarity stage
    - Pipeline position: Fingerprint → Topology → Similarity
    - Persist to fingerprint_topology table
    - Existing pipeline stages unchanged
    - _Requirements: 13.4, 13.5_

  - [ ]* 9.3 Write property test for Topology Output Invariants
    - **Property 9: Topology Output Invariants**
    - Generate random price histories (30–120 candles)
    - Verify: at most 20 levels, each strength in [0, 1], sum of relative_importance = 1.0 (within 1e-6)
    - **Validates: Requirements 13.1**

  - [ ]* 9.4 Write unit tests for Topology Engine
    - Test with exactly 30 candles (minimum)
    - Test with < 30 candles (insufficient_history = true, empty levels)
    - Test with 120 candles (full window)
    - Test determinism
    - Test normalised vector is 40 dimensions, all values in [0, 1]
    - _Requirements: 20.1, 20.4_

- [ ] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Implement Phase 7 — Rich Market Context (Extended Fingerprint Features)
  - [ ] 11.1 Implement extended feature computation in `src/engines/fingerprint-engine.ts`
    - Add `ExtendedMarketFeatures` interface per design
    - Implement: rolling_trend (from 50 candles), atr_percentile, volatility_regime_score, session_statistics, correlated_markets, economic_calendar_summary, macro_state, sentiment_summary
    - Each feature independently enableable via engine_versions config
    - Missing data → substitute 0.5 (neutral default)
    - < 50 candles for rolling_trend → compute with available, record count
    - All values rounded to 6 decimal places
    - Increment fingerprint_schema_version when new features added
    - Deterministic output given identical inputs
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_

  - [ ]* 11.2 Write property test for Extended Feature Bounds and Defaults
    - **Property 16: Extended Feature Bounds and Defaults**
    - Generate random/missing inputs
    - Verify all feature values in [0.0, 1.0] rounded to 6 decimal places
    - Verify missing data → 0.5 default
    - **Validates: Requirements 14.1, 14.3**

  - [ ]* 11.3 Write property test for Feature Enablement via Config
    - **Property 17: Feature Enablement via Config**
    - Generate configs with random enabled/disabled features
    - Verify only enabled features appear in extended_state output
    - **Validates: Requirements 14.2**

  - [ ]* 11.4 Write unit tests for extended feature computation
    - Test each feature individually with known inputs
    - Test neutral defaults when data missing
    - Test rolling_trend with < 50 candles
    - Test feature enablement/disablement
    - _Requirements: 20.1, 20.4_

- [ ] 12. Implement Phase 8 — Regime Classification v2
  - [ ] 12.1 Implement Regime Engine v2 in `src/engines/regime-engine-v2.ts`
    - Define `RegimeV2Output` interface per design
    - 9 regime types: trend, ranging, expansion, contraction, macro_driven, breakout, reversal, accumulation, distribution
    - Deterministic rule-based classification (no ML, no black-box)
    - Exactly one primary_regime, up to 2 secondary_regimes with relevance_score [0, 1]
    - Structured explanation: rules_fired, features_evaluated, threshold_conditions, unavailable_features
    - Uses state_layers + extended_state features from Phase 7
    - Versioned as new Engine_Version, retain v1 for comparison
    - Both v1 and v2 persist concurrently until v1 deactivated
    - Handle neutral defaults gracefully (classify with available features, list excluded in explanation)
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7_

  - [ ] 12.2 Wire Regime Engine v2 into batch pipeline
    - Execute after fingerprint (and extended features), persist classification
    - Both v1 and v2 run concurrently, both results persisted
    - No changes to existing RegimeClassification fields (volatility_regime, trend_regime, session)
    - _Requirements: 15.3, 15.4_

  - [ ]* 12.3 Write property test for Regime v2 Output Structure
    - **Property 15: Regime v2 Output Structure**
    - Generate random fingerprints with state_layers and optional extended_state
    - Verify: exactly one primary_regime from valid set, at most 2 secondary_regimes, relevance_scores in [0, 1], non-empty explanation
    - **Validates: Requirements 15.1, 15.6**

  - [ ]* 12.4 Write unit tests for Regime Engine v2
    - Test each regime classification rule
    - Test with neutral default features
    - Test determinism
    - Test explanation completeness
    - _Requirements: 20.1, 20.4_

- [ ] 13. Implement Experimentation Engine (Phase 5)
  - [ ] 13.1 Implement Experiment Runner in `src/research/experimentation/experiment-runner.ts`
    - Support A/B engine testing: 2+ versions against same input
    - Write experiment outputs exclusively to research_experiments table
    - Never read by live Batch_Layer or Runtime_Layer (production isolation)
    - Support side-by-side comparison of outputs
    - Record failures with experiment_id, preserve partial results
    - Execute within 15-minute Cloud Run timeout
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 13.2 Write property test for Experiment Production Isolation
    - **Property 14: Experiment Production Isolation**
    - Generate experiment-tagged records
    - Verify live pipeline queries never read experiment records
    - **Validates: Requirements 5.2**

  - [ ]* 13.3 Write unit tests for Experiment Runner
    - Test A/B version execution
    - Test production isolation
    - Test failure recording
    - Test partial result preservation
    - _Requirements: 20.1_

- [ ] 14. Implement cross-cutting correctness properties and remaining tests
  - [ ]* 14.1 Write property test for Universal Engine Determinism
    - **Property 1: Universal Engine Determinism**
    - Generate random valid inputs for each engine (Evaluation, Confidence v2, Topology, Regime v2, extended Fingerprint)
    - Run twice, verify bit-identical outputs
    - **Validates: Requirements 2.1, 2.3, 2.5, 7.8, 11.2, 13.5, 14.6, 15.2, 15.5**

  - [ ]* 14.2 Write property test for Empirical Distribution Purity
    - **Property 2: Empirical Distribution Purity**
    - Generate random float arrays (forward returns)
    - Verify formula: up = count(r > 2)/N, down = count(r < -2)/N, flat = count(|r| ≤ 2)/N, sum = 1.0
    - **Validates: Requirements 1.1, 1.2, 1.5**

  - [ ]* 14.3 Write property test for OHLC Validation Invariant
    - **Property 8: OHLC Validation Invariant**
    - Generate random OHLC (valid + invalid)
    - Verify acceptance iff: high >= max(open, close), low <= min(open, close), high >= low, all positive
    - **Validates: Requirements 17.1, 17.6**

  - [ ]* 14.4 Write property test for Deterministic Tie-Breaking
    - **Property 10: Deterministic Tie-Breaking**
    - Generate candidate sets with duplicate scores
    - Verify ordering by fingerprint_id ascending lexicographic
    - **Validates: Requirements 2.4**

  - [ ]* 14.5 Write property test for Point-in-Time Correctness
    - **Property 18: Point-in-Time Correctness**
    - Generate timestamped data
    - Verify no data with timestamp > T contributes to fingerprint at time T
    - **Validates: Requirements 1.4**

  - [ ]* 14.6 Write property test for Gap Detection Completeness
    - **Property 19: Gap Detection Completeness**
    - Generate timestamp sequences with random gaps
    - Verify all missing 4H boundaries detected with zero false negatives
    - **Validates: Requirements 17.3**

- [ ] 15. Final integration, wiring, and documentation
  - [ ] 15.1 Implement integration between all phases and the batch orchestrator
    - Ensure full pipeline flow: Ingestion → Fingerprint → Extended Features → Topology → Similarity → Archive → Outcome → Forecast → Confidence → Cache Write → Research Persist → Evaluation
    - Wire VersionService to snapshot all new engine versions
    - Ensure batch_id linkage across all research records
    - Ensure all queries use deterministic ordering (fingerprint_id or timestamp)
    - _Requirements: 2.6, 3.3, 6.4, 16.3, 16.4_

  - [ ] 15.2 Update CURRENT-STATE.md with all new tables, engines, and capabilities
    - Add new tables to Database State section
    - Add new engines to File Structure section
    - Update "Known Limitations" section to reflect resolved items
    - Document Research namespace and new pipeline stages
    - _Requirements: 22.5_

  - [ ]* 15.3 Write integration tests for research archive lifecycle
    - Test end-to-end persist + query flow
    - Test matured forecast evaluation lifecycle
    - Test similarity archive write + failure halting
    - Test all stages emit traces
    - Test RLS policies reject UPDATE/DELETE on research tables
    - _Requirements: 20.1, 20.3_

- [ ] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (19 properties)
- Unit tests validate specific examples and edge cases
- The existing 7-stage pipeline remains completely unchanged — all additions are additive
- Phase dependency chain respected: 1 → 2, 1 → 3, 1 → 5, 1 → 7, 2 → 4, 3 → 6, 7 → 8
- All new tables use additive schema migrations (no modifications to existing tables)
- Budget constraint: ~61 MB/year new storage, well within 500 MB Supabase free tier

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"] },
    { "id": 1, "tasks": ["1.7", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5"] },
    { "id": 3, "tasks": ["4.1", "5.1", "7.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "5.2", "7.2", "7.3"] },
    { "id": 5, "tasks": ["4.4", "4.5", "4.6", "4.7", "5.3"] },
    { "id": 6, "tasks": ["8.1", "9.1"] },
    { "id": 7, "tasks": ["8.2", "8.3", "9.2", "9.3", "9.4"] },
    { "id": 8, "tasks": ["11.1"] },
    { "id": 9, "tasks": ["11.2", "11.3", "11.4"] },
    { "id": 10, "tasks": ["12.1"] },
    { "id": 11, "tasks": ["12.2", "12.3", "12.4"] },
    { "id": 12, "tasks": ["13.1"] },
    { "id": 13, "tasks": ["13.2", "13.3"] },
    { "id": 14, "tasks": ["14.1", "14.2", "14.3", "14.4", "14.5", "14.6"] },
    { "id": 15, "tasks": ["15.1", "15.2", "15.3"] }
  ]
}
```
