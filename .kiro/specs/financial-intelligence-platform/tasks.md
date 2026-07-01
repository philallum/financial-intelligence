# Implementation Plan: Financial Intelligence Platform

## Overview

This plan implements the Financial Intelligence Platform — a batch-driven, cost-efficient system for modelling 4H FX market behaviour. Implementation follows the dependency chain: infrastructure → database schema → core engines (in pipeline order) → API/product layer → observability → testing. All code is TypeScript on Node.js LTS, using Express, Supabase Postgres with pgvector, Google Cloud Run, Vitest + fast-check for testing.

## Tasks

- [x] 1. Project scaffolding and infrastructure setup
  - [x] 1.1 Initialise Node.js TypeScript project with build tooling
    - Create project root with `package.json` (exact dependency versions per 15.5.4)
    - Install dependencies: typescript, express, @supabase/supabase-js, @google/genai, vitest, fast-check, dotenv, tsx
    - Configure `tsconfig.json` with strict mode, ES2022 target, NodeNext module resolution
    - Create directory structure: `src/engines/`, `src/services/`, `src/api/`, `src/types/`, `src/utils/`, `src/config/`, `tests/`
    - Add npm scripts: `build`, `start`, `test`, `test:watch`, `lint`
    - _Requirements: 12.1, 15.5.4_

  - [x] 1.2 Define core TypeScript interfaces and shared types
    - Create `src/types/index.ts` with all component interfaces from design: `Fingerprint`, `SimilarityMatch`, `OutcomeDistribution`, `Forecast`, `ConfidenceOutput`, `TradeabilityInput`, `TradeabilityOutput`
    - Create `src/types/enums.ts` with regime types, session types, response modes, customer tiers
    - Create `src/types/config.ts` with engine version types and batch run types
    - _Requirements: 1.3, 2.3, 4.3, 5.1, 7.2, 10.1_

  - [x] 1.3 Configure Vitest and fast-check testing framework
    - Create `vitest.config.ts` with TypeScript support and path aliases
    - Create `tests/helpers/generators.ts` with shared fast-check arbitraries for OHLC, fingerprints, vectors, scores
    - Create `tests/helpers/fixtures.ts` with deterministic test fixtures
    - Verify test runner works with a simple smoke test
    - _Requirements: 13.1, 15.5.4_

  - [x] 1.4 Set up environment configuration and secrets management
    - Create `src/config/env.ts` for typed environment variable loading (provider API keys, Supabase URL/key, Cloud Run config)
    - Create `.env.example` with all required variables documented (no actual secrets)
    - Create `src/config/constants.ts` for FLAT_THRESHOLD (2 pips), UTC grid boundaries, batch timing
    - _Requirements: 12.1, 12.5_

- [x] 2. Database schema and migrations
  - [x] 2.1 Create Supabase migration for core data tables
    - Write SQL migration for `raw_candles` table with unique constraint and time-descending index
    - Write SQL migration for `market_fingerprints` table with LIST partition by asset, 5 pgvector columns (L1-L5), extended_state JSONB, and unique constraint
    - Create EUR/USD partition: `market_fingerprints_eurusd`
    - Write SQL migration for `market_outcomes` table with foreign key to fingerprints and composite indexes
    - _Requirements: 1.4, 1.6, 3.5, 12.3_

  - [x] 2.2 Create Supabase migration for similarity, forecast, and cache tables
    - Write SQL migration for `similarity_matches` table with unique constraint and batch/rank indexes
    - Write SQL migration for `forecasts` table with JSONB direction_probabilities, version columns, unique constraint
    - Write SQL migration for `cached_forecasts` table with asset primary key, TTL boundary, conditional index
    - _Requirements: 2.3, 4.4, 6.1, 6.6_

  - [x] 2.3 Create Supabase migration for observability and versioning tables
    - Write SQL migration for `execution_traces` table with batch/engine index
    - Write SQL migration for `batch_runs` table with status tracking and engine version snapshot
    - Write SQL migration for `engine_versions` table with unique constraint on engine_name + version
    - Write SQL migration for `api_keys` table with key_hash, tier, rate limit
    - _Requirements: 10.1, 16.1, 16.2, 11.7_

  - [x] 2.4 Create HNSW vector indexes for fingerprint similarity search
    - Create partial HNSW indexes with cosine ops for L1 (market_structure), L2 (volatility), L3 (liquidity) vectors
    - Create partial HNSW indexes with L2 ops for L4 (macro) and L5 (sentiment) vectors
    - Create filtering indexes for regime and session pre-similarity gate
    - All indexes scoped to `market_fingerprints_eurusd` partition with `WHERE timeframe = '4H'`
    - _Requirements: 2.1, 2.2, 12.3_

- [x] 3. Checkpoint — Verify infrastructure
  - Ensure all migrations apply cleanly, test framework runs, and project builds without errors. Ask the user if questions arise.

- [x] 4. Data ingestion service with provider fallback
  - [x] 4.1 Implement data ingestion service with provider registry
    - Create `src/services/ingestion/ingestion-service.ts` implementing `IngestionInput → IngestionOutput` contract
    - Implement provider registry with Twelve Data (primary), Massive API (fallback), Yahoo Finance (emergency)
    - Implement fallback chain: attempt primary (10s timeout) → fallback on failure → emergency on second failure → skip cycle on all failures
    - Implement UTC 4H grid resampling and Sunday candle merging (Option A: merge into Monday open)
    - Store results to `raw_candles` table via Supabase client
    - _Requirements: 1.1, 1.5, 1.7, 14.1, 14.3_

  - [x] 4.2 Implement macro and sentiment data fetchers
    - Create `src/services/ingestion/macro-fetcher.ts` for DXY, VIX, SPX from Twelve Data and US10Y from Alpha Vantage
    - Create `src/services/ingestion/sentiment-fetcher.ts` for news from Finnhub + NewsAPI and economic calendar from Alpha Vantage
    - Implement rate limit tracking per provider per cycle
    - Return structured data matching L4 (macro_context) and L5 (sentiment_pressure) state layer inputs
    - _Requirements: 1.1, 1.5_

- [x] 5. Fingerprint engine
  - [x] 5.1 Implement fingerprint generation engine
    - Create `src/engines/fingerprint-engine.ts` implementing `FingerprintInput → Fingerprint` contract
    - Implement deterministic fingerprint_id generation: hash(asset + timestamp_utc)
    - Compute return_profile (net_return_pips, range_pips) from OHLC
    - Implement regime classification: volatility_regime (LOW/NORMAL/HIGH), trend_regime (BULLISH/BEARISH/RANGING), session mapping (ASIA/LONDON/NY based on UTC)
    - Compute 5 state layer vectors (L1-L5) independently with no cross-layer leakage
    - Bind normalisation metadata (quantile_table_version, scaling_method)
    - Store fingerprint as immutable record in `market_fingerprints`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6_

  - [x] 5.2 Implement fingerprint serialisation and parsing
    - Create `src/engines/fingerprint-serialiser.ts` with `serialise(fingerprint: Fingerprint): string` and `parse(json: string): Fingerprint`
    - Enforce canonical JSON: lexicographic key ordering, consistent number formatting
    - Implement strict parsing with validation of all required fields
    - Reject unrecognised fields (per Requirement 15.5)
    - Return parsing errors indicating which field is missing/invalid
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5_

  - [x] 5.3 Write property test for fingerprint serialisation round-trip
    - **Property 3: Fingerprint Serialization Round-Trip**
    - Generate random valid Fingerprint objects using fast-check arbitraries
    - Assert: serialise → parse → serialise produces byte-identical output to first serialisation
    - Minimum 100 iterations
    - **Validates: Requirements 15.1, 15.2, 15.3**

  - [x] 5.4 Write property test for engine determinism (fingerprint)
    - **Property 1: Engine Determinism (Fingerprint Engine)**
    - Generate random valid OHLC + market context inputs
    - Assert: executing fingerprint engine twice with identical inputs produces bit-identical output
    - Minimum 100 iterations
    - **Validates: Requirements 1.2, 13.1**

- [ ] 6. Similarity engine
  - [~] 6.1 Implement similarity retrieval engine
    - Create `src/engines/similarity-engine.ts` implementing `SimilarityInput → SimilarityOutput` contract
    - Implement Step 1: Pre-filter candidates by asset, timeframe, regime metadata via SQL
    - Implement Step 2: pgvector HNSW search across 5 layers (cosine for L1-L3, L2 distance for L4-L5)
    - Implement Step 3: Regime-based linear weight aggregation with frozen weight matrices
    - Return top 50 matches with similarity_score (6 decimal places), rank, layer_breakdown, and match_explanation
    - Exclude query fingerprint from results
    - Store results in `similarity_matches` table
    - Handle fewer than 50 matches gracefully (return all available, record count)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ] 6.2 Write property test for similarity pre-filter correctness
    - **Property 4: Similarity Pre-Filter Correctness**
    - Generate random query fingerprints and candidate sets with varied asset/timeframe/regime combinations
    - Assert: all fingerprints passing pre-filter match query's asset and timeframe and satisfy regime filter constraints
    - Minimum 100 iterations
    - **Validates: Requirements 2.2**

  - [ ] 6.3 Write property test for engine determinism (similarity)
    - **Property 1: Engine Determinism (Similarity Engine)**
    - Generate random valid fingerprints with consistent historical dataset
    - Assert: querying same fingerprint against same dataset produces identical ranked results
    - Minimum 100 iterations
    - **Validates: Requirements 2.6, 13.1**

- [ ] 7. Outcome distribution engine
  - [~] 7.1 Implement outcome distribution computation engine
    - Create `src/engines/outcome-engine.ts` implementing `OutcomeInput → OutcomeDistribution` contract
    - Accept array of matched fingerprint_ids only (no similarity scores consumed)
    - Query `market_outcomes` table for forward 4H returns of each matched ID
    - Compute: mean_return, median_return, direction_probability (UP/DOWN/FLAT), volatility_profile, risk_range (p10/p50/p90)
    - Apply FLAT classification: |R| ≤ 2 pips = FLAT, R > +2 = UP, R < -2 = DOWN
    - Equal weight all matches — no similarity-score weighting
    - Compute confidence_inputs (regime_consistency, distribution_sharpness)
    - Store results with fingerprint_id, batch_id, engine_version
    - Return error if matched fingerprint count is zero
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ] 7.2 Write property test for FLAT threshold classification
    - **Property 6: FLAT Threshold Classification**
    - Generate random continuous return values R (floats around ±2 pip boundary)
    - Assert: UP when R > +2 pips, DOWN when R < -2 pips, FLAT when |R| ≤ 2 pips
    - Assert: UP_count + DOWN_count + FLAT_count = total sample size
    - Minimum 100 iterations
    - **Validates: Requirements 3.3**

  - [ ] 7.3 Write property test for outcome distribution equal weighting
    - **Property 5: Outcome Distribution Equal Weighting**
    - Generate random sets of forward returns paired with random similarity scores
    - Assert: reordering matches or changing similarity scores does NOT alter distribution output
    - Minimum 100 iterations
    - **Validates: Requirements 3.1, 3.4**

- [ ] 8. Forecast engine
  - [~] 8.1 Implement probabilistic forecast generation engine
    - Create `src/engines/forecast-engine.ts` implementing `ForecastInput → Forecast` contract
    - Convert OutcomeDistribution into directional probabilities (up, down, flat) rounded to 2 decimal places
    - Ensure probabilities sum to exactly 1.00
    - Compute expected_move_pips from distribution
    - Reference FLAT classification from Outcome Engine verbatim — no redefinition
    - Store forecast with fingerprint_id, direction_probabilities, expected_move, batch_id, engine_version
    - Reject input if sample_size < 1 or distribution empty
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ] 8.2 Write property test for forecast probability normalisation
    - **Property 7: Forecast Probability Normalisation**
    - Generate random valid outcome distributions
    - Assert: output up + down + flat = 1.00 exactly, each in [0.00, 1.00]
    - Minimum 100 iterations
    - **Validates: Requirements 4.3**

- [ ] 9. Confidence engine
  - [~] 9.1 Implement statistically bounded confidence scoring engine
    - Create `src/engines/confidence-engine.ts` implementing `ConfidenceInput → ConfidenceOutput` contract
    - Implement C_final = C_raw × S(N) × R formula
    - Implement Sample_Size_Dampener: S(N) = min(1.0, N / 30), capped at 0.5 when N < 30
    - Compute Regime_Consistency from fingerprint regime metadata alignment (not from outcome data)
    - Bound C_final to [0.0, 1.0]
    - Output both confidence_raw and confidence_final
    - Reject if N = 0 or any input outside [0, 1] range
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ] 9.2 Write property test for confidence formula correctness
    - **Property 8: Confidence Formula Correctness**
    - Generate random C_raw ∈ [0,1], N ∈ [1,200], R ∈ [0,1]
    - Assert: C_final = C_raw × S(N) × R and C_final ∈ [0.0, 1.0]
    - Minimum 100 iterations
    - **Validates: Requirements 5.1**

  - [ ] 9.3 Write property test for sample size dampener cap
    - **Property 9: Sample Size Dampener Cap**
    - Generate random N in [1, 29]
    - Assert: S(N) ≤ 0.5, resulting in C_final ≤ 0.5 × C_raw × R
    - Minimum 100 iterations
    - **Validates: Requirements 5.3**

- [~] 10. Checkpoint — Verify core engines
  - Ensure all engine implementations compile, unit tests pass, and property tests pass. Ask the user if questions arise.

- [ ] 11. Tradeability engine (runtime)
  - [~] 11.1 Implement tradeability evaluation engine
    - Create `src/engines/tradeability-engine.ts` implementing `TradeabilityInput → TradeabilityOutput` contract
    - Compute tradeability_score = S_static × D_dynamic, bounded [0.00, 1.00]
    - Implement label banding: score > 0.75 → "GO", [0.45, 0.75] → "CONDITIONAL", < 0.45 → "NO_GO"
    - Compute execution_metrics: spread_penalty, session_alignment, news_buffer_status
    - DO NOT modify forecast probabilities or confidence scores
    - Implement graceful degradation: if any dynamic source unavailable → NO_GO, score = 0, indicate missing source
    - Store threshold config in versioned configuration artifact tied to engine_version
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ] 11.2 Write property test for tradeability score formula
    - **Property 11: Tradeability Score Formula**
    - Generate random valid static inputs (confidence, stability) and dynamic inputs (spread, session, liquidity, news)
    - Assert: score = S_static × D_dynamic and score ∈ [0.00, 1.00]
    - Minimum 100 iterations
    - **Validates: Requirements 7.1**

  - [ ] 11.3 Write property test for tradeability label banding
    - **Property 12: Tradeability Label Banding**
    - Generate random scores in [0, 1]
    - Assert: "GO" when > 0.75, "CONDITIONAL" when in [0.45, 0.75], "NO_GO" when < 0.45
    - Assert: exactly one label assigned per evaluation
    - Minimum 100 iterations
    - **Validates: Requirements 7.2**

  - [ ] 11.4 Write property test for tradeability graceful degradation
    - **Property 13: Tradeability Graceful Degradation**
    - Generate random inputs with one or more dynamic sources set to unavailable/null
    - Assert: label = "NO_GO", score = 0, unavailable source indicated in response
    - Minimum 100 iterations
    - **Validates: Requirements 7.5**

- [ ] 12. Batch pipeline orchestrator
  - [~] 12.1 Implement batch pipeline orchestration service
    - Create `src/services/pipeline/batch-orchestrator.ts`
    - Implement 7-stage sequential pipeline: ingestion → fingerprint → similarity → outcome → forecast → confidence → cache write
    - Each stage starts only after predecessor succeeds
    - On any stage failure: halt downstream, discard partial output, record failure in `batch_runs`
    - Implement global 15-minute timeout — terminate Cloud Run instance on exceed
    - Implement overlap detection: queue new cycle if previous still running (database lock on batch_runs.status)
    - Generate batch_id, snapshot active engine versions at batch start, store in `batch_runs.engine_versions`
    - Mark batch as completed only when all 7 stages succeed
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 10.6_

  - [~] 12.2 Implement cache writing service with TTL calculation
    - Create `src/services/cache/cache-writer.ts`
    - Compute TTL = remaining time in current 4H window
    - If remaining time < 60 seconds, set TTL to 0 and skip caching
    - Write to `cached_forecasts` table: overwrite existing entry for asset
    - Ensure cached entry only becomes visible after batch completion confirmed
    - Key by asset — one active cached forecast per asset
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [ ] 12.3 Write property test for cache TTL calculation
    - **Property 10: Cache TTL Calculation**
    - Generate random timestamps within 4H windows
    - Assert: TTL = window_end - current_time for normal cases
    - Assert: TTL = 0 when remaining < 60 seconds
    - Minimum 100 iterations
    - **Validates: Requirements 6.1, 6.2**

- [ ] 13. Execution trace and observability
  - [~] 13.1 Implement execution trace emitter
    - Create `src/services/observability/trace-emitter.ts`
    - Emit structured trace after every engine execution (success or failure)
    - Compute input_hash (SHA-256 of serialised input) and output_hash (SHA-256 of serialised output)
    - Record execution_time_ms (wall-clock), engine_version, sample_size (where applicable)
    - Store in `execution_traces` table with batch_id, engine_name, timestamp_utc
    - Handle trace emission failure: record missing trace event without crashing pipeline
    - _Requirements: 16.1, 16.2, 16.3_

  - [ ] 13.2 Write property test for execution trace emission
    - **Property 15: Execution Trace Emission**
    - Generate random engine execution results (success and failure cases)
    - Assert: trace is emitted containing input_hash, output_hash, execution_time_ms, engine_version, and sample_size
    - Minimum 100 iterations
    - **Validates: Requirements 16.1, 16.3**

- [~] 14. Checkpoint — Verify pipeline and observability
  - Ensure batch orchestrator runs end-to-end with test data, traces are emitted correctly, and cache TTL logic works. Ask the user if questions arise.

- [ ] 15. API gateway and product layer
  - [~] 15.1 Implement Express API gateway with endpoint routing
    - Create `src/api/server.ts` with Express app setup, versioned routes under `/v1/`
    - Create `src/api/routes/forecast.ts` for `GET /v1/forecast/:asset`
    - Create `src/api/routes/similarity.ts` for `GET /v1/similarity/:asset`
    - Create `src/api/routes/state.ts` for `GET /v1/state/:asset`
    - Implement request flow: fetch cached forecast → inject runtime conditions → execute tradeability engine → return response
    - Return error if no cached forecast exists or asset not supported
    - Target <300ms response time on cached path
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [~] 15.2 Implement authentication and tier resolution middleware
    - Create `src/api/middleware/auth.ts` for API key authentication
    - Validate API key hash against `api_keys` table
    - Resolve caller tier (retail, developer, research, integrator, internal)
    - Enforce rate limits per tier (retail: 30/min, developer: 100/min, research: 50/min)
    - Return 401 on invalid/expired key, reject requests exceeding tier permissions
    - _Requirements: 11.5, 11.6, 11.7_

  - [~] 15.3 Implement response mode filtering and tier-based field stripping
    - Create `src/api/middleware/response-filter.ts` implementing `ResponseModeRouter` interface
    - Support 5 response modes: forecast, trade, explain, raw, research
    - Default to "forecast" mode when parameter absent (per Req 11.12)
    - Apply MODE_ACCESS matrix: retail gets forecast/trade only, developer+ gets explain/raw, research+ gets research
    - Reject request if tier does not authorise requested mode (return error per Req 11.9)
    - Strip fields: retail MUST NOT receive raw vectors or similarity matrices
    - _Requirements: 11.1, 11.2, 11.3, 11.8, 11.9, 11.10, 11.12_

  - [ ] 15.4 Write property test for tier-based response filtering
    - **Property 14: Tier-Based Response Filtering**
    - Generate random full forecast responses and random customer tiers
    - Assert: filtered response contains only fields authorised for that tier
    - Assert: retail never receives raw vectors or similarity matrices
    - Assert: developer receives probability vectors and similarity scores
    - Assert: research receives full historical distributions
    - Minimum 100 iterations
    - **Validates: Requirements 11.1, 11.2, 11.3**

- [ ] 16. Edge caching layer
  - [~] 16.1 Implement edge caching with dynamic TTL
    - Create `src/api/middleware/edge-cache.ts`
    - Implement cache key formula: `{asset}:{timeframe}:{timestamp_bucket}`
    - Compute dynamic TTL: remaining time in current 4H candle block
    - If valid edge cache entry exists, return immediately without hitting DB or compute
    - Invalidate on TTL expiry (aligned to next candle boundary)
    - MVP implementation: in-memory cache on Cloud Run instance (upgradeable to Cloudflare Workers KV)
    - _Requirements: 6.3, 12.4_

- [ ] 17. Engine versioning and schema completeness
  - [~] 17.1 Implement engine version management service
    - Create `src/services/versioning/version-service.ts`
    - Load active engine versions at batch start from `engine_versions` table
    - Ensure consistent version snapshot used throughout entire batch (no mid-batch changes)
    - Propagate version identifiers to every engine output record
    - Implement version increment logic for engine_version, quantile_table_version, fingerprint_schema_version
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [ ] 17.2 Write property test for engine output schema completeness
    - **Property 2: Engine Output Schema Completeness**
    - Generate random valid inputs for each engine
    - Assert: every successful output contains engine_version, quantile_table_version (where applicable), fingerprint_schema_version (where applicable), and all schema-required fields
    - Minimum 100 iterations
    - **Validates: Requirements 1.3, 2.3, 3.5, 4.4, 5.5, 10.1, 16.1**

- [~] 18. Checkpoint — Verify API and product layer
  - Ensure all API endpoints respond correctly, authentication works, tier filtering is enforced, and caching prevents redundant DB hits. Ask the user if questions arise.

- [ ] 19. Cloud Run deployment configuration
  - [~] 19.1 Create Cloud Run service definitions and Dockerfiles
    - Create `Dockerfile` for batch pipeline service (Node.js LTS base)
    - Create `Dockerfile` for API service (Node.js LTS base, Express)
    - Create `cloudbuild.yaml` or deployment scripts for both services
    - Configure Cloud Run: max 1 instance for batch, max 2 for API, concurrency limits
    - Configure Cloud Scheduler: 6 cron jobs at 00:02, 04:02, 08:02, 12:02, 16:02, 20:02 UTC
    - Set environment variables for API keys, Supabase connection, engine config
    - _Requirements: 12.1, 12.2, 12.6, 12.7, 12.8_

- [ ] 20. Integration tests
  - [ ] 20.1 Write integration tests for end-to-end batch pipeline
    - Test full pipeline execution with seeded database (ingestion → fingerprint → similarity → outcome → forecast → confidence → cache)
    - Verify batch_runs status transitions and engine version snapshot
    - Verify execution traces emitted for each stage
    - Verify cached_forecasts written only after full batch completion
    - Test pipeline failure and halt behaviour (stage failure → downstream halted)
    - _Requirements: 14.1, 14.2, 14.5, 16.2_

  - [ ] 20.2 Write integration tests for API endpoint contracts
    - Test GET /v1/forecast/{asset} returns correct response schema
    - Test response mode parameter filtering (forecast, trade, explain, raw, research)
    - Test authentication and tier enforcement (401 on invalid key, tier rejection)
    - Test error responses: forecast unavailable, asset not supported, rate limit exceeded
    - Test cached path response time < 300ms
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 11.6, 11.9_

  - [ ] 20.3 Write integration tests for batch-runtime boundary enforcement
    - Verify batch layer does NOT access live market data
    - Verify runtime layer does NOT compute historical statistics
    - Verify fingerprint is sole originating input to batch pipeline
    - Verify each engine receives only its predecessor's output
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [~] 21. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, property-based tests validate all 15 correctness properties, integration tests confirm end-to-end flow, and the system builds for deployment. Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP delivery
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- Property tests validate universal correctness properties from the design document (15 properties total)
- Unit tests validate specific examples and edge cases
- All dependencies must use exact pinned versions (no ^ or ~ ranges) per Requirement 15.5.4
- TypeScript strict mode is mandatory throughout
- All engines are pure functions where possible — deterministic given identical inputs
- The batch pipeline is strictly sequential; no parallel engine execution within a single batch
- Cloud Run ephemeral compute ensures no long-running processes or state leakage between cycles

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1", "2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4"] },
    { "id": 4, "tasks": ["4.1", "4.2", "5.1"] },
    { "id": 5, "tasks": ["5.2", "5.4", "6.1"] },
    { "id": 6, "tasks": ["5.3", "6.2", "6.3", "7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "8.1"] },
    { "id": 8, "tasks": ["8.2", "9.1"] },
    { "id": 9, "tasks": ["9.2", "9.3", "11.1"] },
    { "id": 10, "tasks": ["11.2", "11.3", "11.4", "13.1"] },
    { "id": 11, "tasks": ["12.1", "12.2", "13.2"] },
    { "id": 12, "tasks": ["12.3", "15.1", "17.1"] },
    { "id": 13, "tasks": ["15.2", "15.3", "16.1", "17.2"] },
    { "id": 14, "tasks": ["15.4", "19.1"] },
    { "id": 15, "tasks": ["20.1", "20.2", "20.3"] }
  ]
}
```
