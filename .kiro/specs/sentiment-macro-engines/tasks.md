# Implementation Plan: Sentiment & Macro Context Engines

## Overview

Implement three computational components — the Sentiment Engine, Macro Context Engine, and News Risk Evaluator — as pure TypeScript functions slotting into the existing 4H batch pipeline. The implementation proceeds from shared types and utilities, through isolated engine logic with property-based tests, to integration wiring with the batch orchestrator, fingerprint engine, and tradeability engine.

## Tasks

- [x] 1. Define shared types and utility functions
  - [x] 1.1 Create sentiment type definitions
    - Create `src/types/sentiment.ts` with `NewsArticle`, `SentimentEngineInput`, `SentimentVector`, and `SentimentEngineOutput` interfaces
    - All interfaces must use `readonly` fields as specified in design
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 1.2 Create macro context type definitions
    - Create `src/types/macro.ts` with `EconomicEvent`, `MacroContextEngineInput`, `MacroVector`, `MacroContextEngineOutput`, `NewsRiskEvaluatorInput`, and `NewsRiskEvaluatorOutput` interfaces
    - All interfaces must use `readonly` fields as specified in design
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 9.1_

  - [x] 1.3 Update types index and create shared math utilities
    - Update `src/types/index.ts` to re-export sentiment and macro types
    - Create utility functions `roundTo6(value: number): number` and `mapToUnitInterval(value: number): number` in the sentiment engine module (used by both engines)
    - _Requirements: 12.5, 12.6_

- [x] 2. Implement Sentiment Engine (pure computation)
  - [x] 2.1 Implement core sentiment computation
    - Create `src/engines/sentiment-engine.ts` with `computeSentiment`, `computeDecayWeight`, `mapToUnitInterval`, and `roundTo6` functions
    - Implement exponential decay with 8-hour half-life: `2^(-elapsed_hours / 8)`
    - Implement weighted mean aggregation of article scores (relevance × decay)
    - Map aggregate from [-1, 1] to [0, 1]
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 2.2 Implement sentiment vector construction
    - Implement all 6 dimensions: aggregate_sentiment, bullish_pressure, bearish_pressure, article_volume, sentiment_dispersion, momentum
    - Classify articles as positive (>0.2), negative (<-0.2), or neutral
    - Normalise article_volume by dividing count by 50, clamped [0, 1]
    - Compute momentum using previous_aggregate_sentiment (default 0.5 if null)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 2.3 Implement missing data handling and confidence blending
    - Return neutral vector (all 0.5) when zero articles available
    - Blend with neutral using confidence factor `min(count / 3, 1)` when fewer than 3 articles
    - Log warning when fewer than 3 articles are available
    - Round all output values to 6 decimal places
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 12.5_

  - [x] 2.4 Write property test: Sentiment output vector invariant (Property 1)
    - **Property 1: Sentiment output vector invariant**
    - Generate random arrays of NewsArticle (0–100 items), random window_end, random previous_aggregate
    - Assert vector has exactly 6 dimensions, all in [0, 1], rounded to 6 decimal places
    - Assert sentiment_score in [0, 1], rounded to 6 decimal places
    - Assert bullish_pressure + bearish_pressure <= 1.0
    - **Validates: Requirements 1.4, 1.5, 3.1, 3.2, 3.3, 3.4, 12.5**

  - [x] 2.5 Write property test: Exponential decay formula correctness (Property 2)
    - **Property 2: Exponential decay formula correctness**
    - Generate random non-negative floats for elapsed_hours
    - Assert result equals `2^(-elapsed_hours / 8)`
    - Assert monotonically decreasing (older articles get less weight)
    - Assert `computeDecayWeight(8, 8) === 0.5` exactly
    - **Validates: Requirements 2.4, 2.5**

  - [x] 2.6 Write property test: Sentiment order-independence (Property 3)
    - **Property 3: Sentiment order-independence**
    - Generate random article array, create shuffled permutation, compare outputs
    - Assert bit-identical output for both permutations (all vector dimensions and scalar score)
    - **Validates: Requirements 2.3, 2.6, 12.1**

  - [x] 2.7 Write property test: Sparse data confidence blending (Property 4)
    - **Property 4: Sparse data confidence blending**
    - Generate inputs with exactly 1 or 2 articles
    - Assert each dimension `d = computed_d * (count/3) + 0.5 * (1 - count/3)`
    - Assert no blending applied when count >= 3
    - **Validates: Requirements 4.3**

  - [x] 2.8 Write unit tests for Sentiment Engine
    - Test empty articles → neutral vector (Req 4.1, 4.2)
    - Test null sentiment_hint → treated as 0.0 (Req 2.2)
    - Test previous aggregate null → momentum uses 0.5 (Req 3.5)
    - Test single article with hint=1.0 → maximum bullish signal
    - Test all articles outside window → neutral
    - Test performance: 100 articles completes < 5s (Req 13.1)
    - _Requirements: 2.2, 3.5, 4.1, 4.2, 13.1_

- [x] 3. Checkpoint - Verify Sentiment Engine
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement Macro Context Engine (pure computation)
  - [x] 4.1 Implement event proximity and surprise factor computation
    - Create `src/engines/macro-context-engine.ts` with `computeMacroContext`, `computeEventProximity`, and `computeSurpriseFactor` functions
    - Implement event proximity: `1 - (hours_to_event / 24)`, clamped [0, 1]
    - Implement surprise factor: `(actual - estimate) / |estimate|`, clamped [-1, 1], mapped to [0, 1]
    - Handle estimate = 0 case with absolute difference formula
    - _Requirements: 6.1, 6.2, 8.5_

  - [x] 4.2 Implement macro vector construction
    - Implement all 8 dimensions: event_proximity_pressure, aggregate_surprise_factor, rate_differential, high_impact_event_count, medium_impact_event_count, event_density, upcoming_event_intensity, composite_macro_state
    - Implement weighted surprise aggregation (high=3, medium=2, low=1)
    - Implement rate_differential from rate decision events
    - Implement composite_macro_state as weighted average with specified weights [0.25, 0.20, 0.15, 0.15, 0.05, 0.05, 0.15]
    - _Requirements: 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 4.3 Implement macro missing data handling
    - Return neutral vector (all 0.5) when zero events available
    - Exclude events with null actual or null estimate from surprise computation but include in counts
    - Handle estimate = 0 without dividing by zero
    - Round all output values to 6 decimal places
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 12.6_

  - [x] 4.4 Write property test: Macro output vector invariant (Property 5)
    - **Property 5: Macro output vector invariant**
    - Generate random arrays of EconomicEvent (0–50 items), random reference_time
    - Assert vector has exactly 8 dimensions, all in [0, 1], rounded to 6 decimal places
    - Assert macro_state in [0, 1], rounded to 6 decimal places
    - Assert composite_macro_state equals weighted average of first 7 dimensions
    - **Validates: Requirements 5.4, 5.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 12.6**

  - [x] 4.5 Write property test: Event proximity bounded and monotonic (Property 6)
    - **Property 6: Event proximity is bounded and monotonically decreasing**
    - Generate random non-negative floats for hours_to_event
    - Assert result in [0, 1]
    - Assert `computeEventProximity(h1) >= computeEventProximity(h2)` for h1 < h2
    - Assert events > 24 hours away return 0
    - **Validates: Requirements 6.1**

  - [x] 4.6 Write property test: Surprise factor bounded (Property 7)
    - **Property 7: Surprise factor is bounded**
    - Generate random actual/estimate pairs (including estimate = 0 cases)
    - Assert result always in [0, 1]
    - Verify formula correctness for estimate ≠ 0 and estimate = 0 branches
    - **Validates: Requirements 6.2, 8.5**

  - [x] 4.7 Write property test: Macro order-independence (Property 8)
    - **Property 8: Macro order-independence**
    - Generate random event array, create shuffled permutation, compare outputs
    - Assert bit-identical output for both permutations (all vector dimensions and scalar state)
    - **Validates: Requirements 6.3, 12.2**

  - [x] 4.8 Write unit tests for Macro Context Engine
    - Test empty events → neutral vector (Req 8.1, 8.2)
    - Test null actual → excluded from surprise (Req 8.3)
    - Test null estimate → excluded from surprise (Req 8.4)
    - Test estimate = 0 → absolute difference formula (Req 8.5)
    - Test no rate decisions → rate_differential = 0.5 (Req 6.5)
    - Test performance: 50 events completes < 2s (Req 13.2)
    - _Requirements: 6.5, 8.1, 8.2, 8.3, 8.4, 8.5, 13.2_

- [x] 5. Checkpoint - Verify Macro Context Engine
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement News Risk Evaluator
  - [x] 6.1 Implement news risk evaluation logic
    - Create `src/engines/news-risk-evaluator.ts` with `evaluateNewsRisk` function
    - Query `economic_events` table for high-impact events within 8-hour lookahead window
    - Filter by currency relevance to the asset
    - Return `{ news_risk_flag, triggering_events, hours_to_nearest }`
    - Handle database errors conservatively (return flag = true on failure)
    - _Requirements: 9.1, 9.2, 9.3, 9.6, 13.5_

  - [x] 6.2 Write property test: News risk flag correctness (Property 9)
    - **Property 9: News risk flag correctness**
    - Generate random event arrays with varying impact levels, currencies, and dates
    - Assert flag = true if and only if at least one high-impact event exists within window
    - Assert flag = false if and only if no high-impact events exist within window
    - Note: Test the pure logic portion by mocking the DB layer
    - **Validates: Requirements 9.2, 9.3**

  - [x] 6.3 Write unit tests for News Risk Evaluator
    - Test high-impact event in 4 hours → flag = true (Req 9.2)
    - Test no high-impact events → flag = false (Req 9.3)
    - Test medium-impact event in 4 hours → flag = false (only high triggers)
    - Test currency filtering: USD event not flagged for GBPJPY (Req 9.6)
    - Test database error → conservative flag = true
    - Test performance: < 1s (Req 13.5)
    - _Requirements: 9.2, 9.3, 9.6, 13.5_

- [x] 7. Integrate engines with batch orchestrator and fingerprint engine
  - [x] 7.1 Wire Sentiment Engine into batch pipeline
    - Extend `StageHandlers` interface with `sentiment` handler
    - Add orchestrator logic to fetch articles from `news_articles` table (SQL query per design)
    - Invoke `computeSentiment` when `Engine_Participation_Map.sentiment = true` for asset
    - Pass resulting `SentimentVector` as input to fingerprint generation (L5 layer)
    - _Requirements: 10.1, 10.3, 13.3_

  - [x] 7.2 Wire Macro Context Engine into batch pipeline
    - Extend `StageHandlers` interface with `macro_context` handler
    - Add orchestrator logic to fetch events from `economic_events` table (SQL query per design)
    - Invoke `computeMacroContext` when `Engine_Participation_Map.macro = true` for asset
    - Pass resulting `MacroVector` as input to fingerprint generation (L4 layer)
    - _Requirements: 10.2, 10.4, 13.4_

  - [x] 7.3 Enable parallel execution of both engines
    - Execute sentiment and macro engines in parallel using `Promise.all` (no data dependency)
    - Ensure both complete before passing results to fingerprint engine
    - Preserve existing behaviour when `Engine_Participation_Map` has engines disabled (Req 10.5)
    - _Requirements: 10.5, 13.6_

  - [x] 7.4 Extend FingerprintInput and update fingerprint engine
    - Add `sentiment_vector?: SentimentVector` and `macro_vector?: MacroVector` to `FingerprintInput`
    - Update fingerprint engine to use `SentimentVector` for L5 layer when provided
    - Update fingerprint engine to use `MacroVector` for L4 layer when provided
    - Fall back to existing MacroContext-based computation when vectors not provided
    - _Requirements: 10.3, 10.4, 10.5_

- [x] 8. Integrate News Risk Evaluator with tradeability engine
  - [x] 8.1 Wire news risk flag into tradeability computation
    - Call `evaluateNewsRisk` from tradeability engine at request time
    - Apply `news_factor = 0.0` when `news_risk_flag = true` (produces NO_GO label)
    - Apply `news_factor = 1.0` when `news_risk_flag = false` (score unaffected)
    - _Requirements: 9.4, 9.5_

  - [x] 8.2 Update similarity engine to consume real sentiment data
    - Ensure similarity engine uses `SentimentVector` from L5 layer for cosine distance when sentiment weight > 0
    - Verify existing frozen weight matrices remain unmodified
    - Neutral placeholder vectors naturally produce moderate distance (no special handling needed)
    - _Requirements: 11.1, 11.2, 11.3_

- [x] 9. Checkpoint - Verify full integration
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Final integration tests
  - [x] 10.1 Write integration tests for pipeline wiring
    - Test orchestrator invokes sentiment engine when `engines.sentiment = true` (Req 10.1)
    - Test orchestrator invokes macro engine when `engines.macro = true` (Req 10.2)
    - Test both engines execute in parallel (Req 13.6)
    - Test fingerprint L4 populated from MacroVector (Req 10.4)
    - Test fingerprint L5 populated from SentimentVector (Req 10.3)
    - Test tradeability engine applies news_factor = 0 when flag is true (Req 9.4)
    - Test similarity engine uses real sentiment vector for cosine distance (Req 11.1)
    - _Requirements: 9.4, 10.1, 10.2, 10.3, 10.4, 11.1, 13.6_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation after each engine implementation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The Sentiment Engine and Macro Context Engine are pure functions (no I/O) — all data fetching is done by the orchestrator
- The News Risk Evaluator is the only component with I/O (database query)
- Both engines run in parallel (Stage 1.5a and 1.5b) before fingerprint generation (Stage 2)
- The News Risk Evaluator runs at API request time, not during batch processing

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3"] },
    { "id": 2, "tasks": ["2.1", "4.1", "6.1"] },
    { "id": 3, "tasks": ["2.2", "4.2", "6.2", "6.3"] },
    { "id": 4, "tasks": ["2.3", "4.3"] },
    { "id": 5, "tasks": ["2.4", "2.5", "2.6", "2.7", "2.8", "4.4", "4.5", "4.6", "4.7", "4.8"] },
    { "id": 6, "tasks": ["7.1", "7.2", "8.1"] },
    { "id": 7, "tasks": ["7.3", "7.4", "8.2"] },
    { "id": 8, "tasks": ["10.1"] }
  ]
}
```
