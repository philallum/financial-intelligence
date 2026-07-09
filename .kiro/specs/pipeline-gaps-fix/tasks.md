# Implementation Plan

## Overview

Fix three pipeline gaps that render forecasts non-actionable: confidence always 0 (v1 engine), tradeability always NO_GO (hardcoded defaults + zero static score), and topology similarity weight = 0.0. Uses bug condition methodology: explore the bugs with failing tests, preserve existing behavior, then implement fixes and validate.

## Tasks

- [x] 1. Write bug condition exploration tests
  - **Property 1: Bug Condition** - Pipeline Produces Non-Actionable Outputs (Confidence=0, Tradeability=NO_GO, Topology Ignored)
  - **IMPORTANT**: Write these property-based tests BEFORE implementing any fixes
  - **CRITICAL**: These tests MUST FAIL on unfixed code — failure confirms the bugs exist
  - **DO NOT attempt to fix the tests or the code when they fail**
  - **NOTE**: These tests encode the expected behavior — they will validate the fixes when they pass after implementation
  - **GOAL**: Surface counterexamples that demonstrate all three pipeline gaps
  - **Scoped PBT Approach**:
    - **Confidence bug**: For any valid `ConfidenceInput` with `sample_size >= 1` and valid `CalibrationParameters` with non-zero `global_fallback`, assert `computeConfidenceV2FromInput(input, calibration).confidence_final > 0` — will fail because batch currently calls v1 (not v2), but confirms v2 itself works correctly. Additionally, write a test calling the current `confidence` stage handler in `batch-entry.ts` and assert the output `confidence_final > 0.1` — this will fail on unfixed code.
    - **Tradeability bug**: For any valid `Session` and asset hours, assert a `getSessionDefaults(session, assetHours)` function exists and returns `spreadPips > 0` and `liquidityProxy > 0` — will fail because function doesn't exist yet. Also test that `computeTradeabilityFromInput` with the hardcoded `spread_pips: 1.5` and `confidence_final = 0` produces `tradeability_score > 0` — will fail because `S_static = 0`.
    - **Topology bug**: For any two candidates with identical 5-layer scores but different topology similarity values, when `TOPOLOGY_SIMILARITY_WEIGHT > 0`, assert the blended scores differ — will fail because `TOPOLOGY_SIMILARITY_WEIGHT = 0.0` and `computeBlendedScore` doesn't exist yet.
  - Test file: `src/engines/__tests__/pipeline-gaps-exploration.property.test.ts`
  - Use `fast-check` for property generation
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct — proves the bugs exist)
  - Document counterexamples found:
    - `computeConfidenceFromInput` returns confidence_final ≈ 0 for realistic inputs (dampener too aggressive)
    - `computeTradeabilityFromInput` with confidence=0 always returns score=0 regardless of session
    - Identical similarity scores for candidates with different topology vectors (weight=0.0)
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. Write preservation property tests (BEFORE implementing fixes)
  - **Property 2: Preservation** - Existing Tradeability Formula, Graceful Degradation, 5-Layer Aggregation Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - **Observe** behavior on UNFIXED code for non-buggy inputs (cases where isBugCondition returns false):
    - Observe: `computeTradeabilityFromInput({ forecast: { confidence_final: 0.8 }, spread_pips: 1.2, session_state: LONDON, live_liquidity_proxy: 0.85, news_risk_flag: false })` returns `tradeability_score = clamp(0.8 × D_dynamic, 0, 1)` on unfixed code
    - Observe: `computeTradeabilityFromInput` with any null dynamic source returns `score = 0, label = NO_GO, unavailable_sources: [...]`
    - Observe: `computeAggregateScore(layerScores, weights)` returns same deterministic linear combination for identical inputs
    - Observe: `getRegimeWeights(regime)` returns frozen weight matrices identical to `REGIME_WEIGHT_MATRICES`
    - Observe: `computeConfidenceV2FromInput(input, calibration)` with `sample_size = 0` throws error
  - **Write property-based tests** capturing observed behavior (using `fast-check`):
    - **Tradeability formula preservation**: For all `forecast.confidence_final ∈ (0, 1]` with all non-null dynamic inputs, assert `score = clamp(S_static × D_dynamic, 0, 1)` with label bands GO > 0.75, CONDITIONAL ≥ 0.45, NO_GO < 0.45
    - **Graceful degradation preservation**: For all inputs with at least one null dynamic source, assert `score = 0, label = NO_GO, unavailable_sources` lists the null fields
    - **5-layer aggregate preservation**: For all valid layer scores in [0,1] and valid `RegimeWeightMatrix`, assert `computeAggregateScore` produces `sum(layer_i × weight_i)` clamped and rounded to 6dp
    - **Regime weight immutability**: For all valid `RegimeClassification`, assert `getRegimeWeights` returns values matching frozen `REGIME_WEIGHT_MATRICES`
    - **Confidence v2 zero-sample rejection**: Assert `computeConfidenceV2FromInput` throws for `sample_size = 0` regardless of calibration parameters
  - Test file: `src/engines/__tests__/pipeline-gaps-preservation.property.test.ts`
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.7_

- [x] 3. Fix 1: Switch batch pipeline from Confidence Engine v1 to v2

  - [x] 3.1 Load `CalibrationParameters` from `engine_versions` table in `main()`
    - Query `engine_versions` table for `engine_name = 'confidence'` and `is_active = true`
    - Parse `config` column as `CalibrationParameters` type from `confidence-engine-v2.ts`
    - Load once before the asset processing loop, pass to stage handlers via closure
    - If config is missing or invalid, log error and `process.exit(1)` (pipeline cannot produce valid output without calibration)
    - _Bug_Condition: input.confidence_engine_version == "v1" AND input.match_corpus.effective_sample_size < 30_
    - _Expected_Behavior: Use v2 with CalibrationParameters to produce confidence_final > 0_
    - _Preservation: Pipeline stages prior to confidence remain unchanged (Req 3.5)_
    - _Requirements: 2.1_

  - [x] 3.2 Replace v1 import with v2 in `confidence` stage handler
    - Import `computeConfidenceV2FromInput` from `./engines/confidence-engine-v2.js`
    - Remove import of `computeConfidenceFromInput` from `./engines/confidence-engine.js`
    - Update the `confidence` handler to call `computeConfidenceV2FromInput(normalisedInput, calibrationParams)`
    - Map v2 output to existing `ConfidenceOutput` shape: `{ confidence_raw: v2Output.calibration_adjusted_base, sample_weight: v2Output.sample_density_modifier, regime_stability: v2Output.regime_accuracy_modifier, confidence_final: v2Output.confidence_final }`
    - _Bug_Condition: confidence handler calls v1 engine whose dampener caps confidence at ≈0_
    - _Expected_Behavior: confidence handler calls v2 engine producing evidence-based scores > 0_
    - _Preservation: Normalisation of variance (min(variance/50, 1)) remains the same_
    - _Requirements: 2.1, 2.2_

  - [x] 3.3 Verify bug condition exploration test (confidence portion) now passes
    - **Property 1: Expected Behavior** - Confidence V2 Produces Non-Zero Scores
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior for confidence
    - When this test passes, it confirms confidence v2 is correctly wired
    - **EXPECTED OUTCOME**: Confidence-related assertions PASS
    - _Requirements: 2.1, 2.2_

- [x] 4. Fix 2: Add session-based tradeability defaults

  - [x] 4.1 Implement `getSessionDefaults(session, assetMarketHours)` in tradeability engine
    - Add to `src/engines/tradeability-engine.ts`
    - Export `SessionDefaults` interface: `{ spreadPips: number; liquidityProxy: number }`
    - Implement lookup logic:
      - London/NY overlap (session = LONDON or NY, hours in overlap range): `{ spreadPips: 1.0, liquidityProxy: 0.85 }`
      - London-only or NY-only: `{ spreadPips: 1.2, liquidityProxy: 0.85 }`
      - Asia: `{ spreadPips: 1.5, liquidityProxy: 0.70 }`
    - Pure function, deterministic, no side effects
    - _Bug_Condition: input.live_feed_connected == false AND input.session_defaults_available == false_
    - _Expected_Behavior: getSessionDefaults returns spreadPips > 0 and liquidityProxy > 0 for all sessions_
    - _Preservation: Existing computeTradeabilityFromInput signature and formula unchanged (Req 3.2)_
    - _Requirements: 2.3_

  - [x] 4.2 Update forecast route to use session-aware defaults
    - In `src/api/routes/forecast.ts`, import `getSessionDefaults` from tradeability engine
    - Replace hardcoded `spread_pips: 1.5, live_liquidity_proxy: 0.75` with:
      ```typescript
      const defaults = getSessionDefaults(session, 'EURUSD');
      const tradeabilityResult = computeTradeabilityFromInput({
        forecast,
        spread_pips: defaults.spreadPips,
        session_state: session,
        live_liquidity_proxy: defaults.liquidityProxy,
        news_risk_flag: false,
      });
      ```
    - Keep `news_risk_flag: false` as default (no live news feed)
    - _Bug_Condition: Forecast route uses hardcoded spread/liquidity values unrelated to session_
    - _Expected_Behavior: Forecast route uses session-aware defaults producing realistic D_dynamic_
    - _Preservation: Response envelope structure, field names, HTTP status codes unchanged (Req 3.6)_
    - _Requirements: 2.2, 2.3_

  - [x] 4.3 Verify bug condition exploration test (tradeability portion) now passes
    - **Property 1: Expected Behavior** - Session Defaults Produce Non-Zero Dynamic Score
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 checks that `getSessionDefaults` exists and returns non-zero values
    - When this test passes, it confirms session-aware defaults are correctly implemented
    - **EXPECTED OUTCOME**: Tradeability-related assertions PASS
    - _Requirements: 2.2, 2.3_

- [x] 5. Fix 3: Integrate topology weight into similarity scoring

  - [x] 5.1 Add `TOPOLOGY_SIMILARITY_WEIGHT` to constants and remove from topology engine
    - Add `export const TOPOLOGY_SIMILARITY_WEIGHT = 0.10 as const;` to `src/config/constants.ts`
    - Remove (or deprecate with comment) `export const TOPOLOGY_SIMILARITY_WEIGHT = 0.0;` from `src/engines/topology-engine.ts`
    - Update any imports that reference `TOPOLOGY_SIMILARITY_WEIGHT` from topology engine to point to constants
    - _Bug_Condition: TOPOLOGY_SIMILARITY_WEIGHT = 0.0 hardcoded in topology-engine.ts_
    - _Expected_Behavior: TOPOLOGY_SIMILARITY_WEIGHT = 0.10 configurable in constants_
    - _Preservation: Existing topology engine computation (computeTopology) unchanged_
    - _Requirements: 2.4, 2.5_

  - [x] 5.2 Create `computeBlendedScore()` in similarity engine
    - Add to `src/engines/similarity-engine.ts`:
      ```typescript
      export function computeBlendedScore(
        existingAggregateScore: number,
        topologySimilarity: number | undefined,
        topologyWeight: number,
      ): number {
        if (topologySimilarity === undefined || topologyWeight === 0) {
          return existingAggregateScore;
        }
        const blended = (1 - topologyWeight) * existingAggregateScore + topologyWeight * topologySimilarity;
        return roundTo6Decimals(clamp(blended, 0, 1));
      }
      ```
    - Export `clamp` and `roundTo6Decimals` helpers (or keep internal with `computeBlendedScore` using them)
    - Import `TOPOLOGY_SIMILARITY_WEIGHT` from `../config/constants.js`
    - _Bug_Condition: No blending function exists; topology vectors computed but discarded_
    - _Expected_Behavior: computeBlendedScore produces (1-w)*existing + w*topology, bounded [0,1]_
    - _Preservation: computeAggregateScore remains unchanged — blending is applied externally (Req 3.1, 3.7)_
    - _Requirements: 2.4, 2.5_

  - [x] 5.3 Integrate topology vectors into batch pipeline similarity stage
    - In the `similarity` handler in `src/batch-entry.ts`:
      1. After scoring candidates, fetch topology vectors from `fingerprint_topology` table for the query fingerprint and all candidate fingerprint_ids
      2. Compute cosine similarity between query topology vector and each candidate's topology vector
      3. Apply blending: `computeBlendedScore(existingScore, topologySimilarity, TOPOLOGY_SIMILARITY_WEIGHT)` for each candidate before sorting
      4. Handle missing topology: if either query or candidate lacks a topology vector, pass `undefined` (opt-out path returns existing score unchanged)
    - Import `computeBlendedScore` from `./engines/similarity-engine.js`
    - Import `TOPOLOGY_SIMILARITY_WEIGHT` from `./config/constants.js`
    - _Bug_Condition: Similarity stage only uses 5-layer scores; topology vectors are computed but never consumed_
    - _Expected_Behavior: Topology vectors influence final similarity ranking via blended score_
    - _Preservation: Candidates without topology vectors get unchanged scores; existing 5-layer computation untouched_
    - _Requirements: 2.4, 2.5, 3.1, 3.7_

  - [x] 5.4 Verify bug condition exploration test (topology portion) now passes
    - **Property 1: Expected Behavior** - Topology Weight Influences Similarity Score
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 checks that different topology similarities produce different blended scores
    - When this test passes, it confirms topology integration is working
    - **EXPECTED OUTCOME**: Topology-related assertions PASS
    - _Requirements: 2.4, 2.5_

- [x] 6. Verify preservation tests still pass after all fixes
  - **Property 2: Preservation** - Tradeability Formula, Graceful Degradation, 5-Layer Aggregation
  - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
  - Run preservation property tests from step 2
  - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions introduced by fixes)
  - Confirm:
    - Tradeability formula `S_static × D_dynamic` with label bands unchanged
    - Graceful degradation (null sources → NO_GO, score 0) unchanged
    - `computeAggregateScore` produces identical results for identical 5-layer inputs
    - `getRegimeWeights` returns same frozen matrices
    - Confidence v2 still rejects `sample_size = 0`

- [x] 7. Checkpoint - Ensure all tests pass
  - Run full test suite: `npx vitest --run`
  - Ensure all property-based tests (exploration + preservation) pass
  - Ensure existing unit tests in `src/config/__tests__/research-assets.property.test.ts` still pass
  - Ensure TypeScript compilation succeeds: `npx tsc --noEmit`
  - Ensure no lint errors
  - Ask the user if questions arise

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "description": "Write exploration and preservation tests before any fixes",
      "tasks": ["1", "2"]
    },
    {
      "wave": 2,
      "description": "Independent entry points for all three fixes (parallel)",
      "tasks": ["3.1", "4.1", "5.1"],
      "dependsOn": ["1", "2"]
    },
    {
      "wave": 3,
      "description": "Implementation steps with intra-fix dependencies (parallel)",
      "tasks": ["3.2", "4.2", "5.2"],
      "dependsOn": ["3.1", "4.1", "5.1"]
    },
    {
      "wave": 4,
      "description": "Verification of exploration tests + final topology integration (parallel)",
      "tasks": ["3.3", "4.3", "5.3"],
      "dependsOn": ["3.2", "4.2", "5.2"]
    },
    {
      "wave": 5,
      "description": "Verify topology exploration test passes",
      "tasks": ["5.4"],
      "dependsOn": ["5.3"]
    },
    {
      "wave": 6,
      "description": "Re-run preservation tests to confirm no regressions",
      "tasks": ["6"],
      "dependsOn": ["3.3", "4.3", "5.4"]
    },
    {
      "wave": 7,
      "description": "Final checkpoint — full test suite and compilation",
      "tasks": ["7"],
      "dependsOn": ["6"]
    }
  ]
}
```

## Notes

- All three fixes are additive and independent of each other — they can be implemented in parallel after exploration/preservation tests are written
- The `computeBlendedScore` function gracefully handles the opt-out case (`topologyWeight = 0` or `topologySimilarity = undefined`) returning the existing score unchanged
- Confidence v2 engine is already fully implemented and tested in `src/engines/confidence-engine-v2.ts` — this fix only wires it into the batch pipeline
- The existing `computeAggregateScore` function in `similarity-engine.ts` is NOT modified — topology blending happens externally after the 5-layer aggregate is computed
- Session defaults use heuristic values for EUR/USD; future iteration could load from config or engine_versions table
