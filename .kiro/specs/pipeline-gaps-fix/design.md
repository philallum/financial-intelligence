# Pipeline Gaps Fix — Bugfix Design

## Overview

The batch pipeline produces three incorrect outputs that render forecasts non-actionable: confidence is always 0 (v1 engine), tradeability is always NO_GO (zero static score + no session defaults), and similarity ignores topology (weight = 0.0). This design formalizes the three bug conditions, specifies the minimal changes to resolve each, and defines correctness properties for property-based testing validation.

**Fix Strategy:**
1. Switch the batch pipeline's confidence stage from v1 to v2 (already implemented)
2. Add session-based heuristic defaults for tradeability dynamic inputs when no live feed is connected
3. Introduce a configurable topology weight into the similarity engine's aggregation

All three fixes are additive — they wire existing engines or extend existing computation with no structural changes to the pipeline stages, response envelopes, or database schema.

## Glossary

- **Bug_Condition (C)**: The set of inputs/states that trigger incorrect output (confidence = 0, tradeability = NO_GO, topology contribution = 0)
- **Property (P)**: The desired correct behavior when the bug condition holds (non-zero scores, topology influence on similarity)
- **Preservation**: Existing behaviors that must remain unchanged — label thresholds, existing 5-layer weights, graceful degradation, response structure
- **`computeConfidenceFromInput`**: Confidence Engine v1 in `src/engines/confidence-engine.ts` — uses sample-size dampener S(N) = min(1.0, N/30) capped at 0.5
- **`computeConfidenceV2FromInput`**: Confidence Engine v2 in `src/engines/confidence-engine-v2.ts` — uses empirical calibration curves, regime accuracy, sample density
- **`CalibrationParameters`**: Frozen config loaded from `engine_versions.config` column for confidence v2
- **`computeTradeabilityFromInput`**: Pure tradeability computation in `src/engines/tradeability-engine.ts`
- **`getSessionDefaults`**: New function providing session-aware spread/liquidity heuristics for EUR/USD
- **`TOPOLOGY_SIMILARITY_WEIGHT`**: Configurable weight for topology layer contribution to similarity scoring
- **`RegimeWeightMatrix`**: Type defining per-layer weights used by the similarity engine (currently 5 layers)

## Bug Details

### Bug Condition

The bugs manifest across three independent conditions that combine to produce non-actionable API responses:

**Condition 1 — Confidence Always Zero:**
The batch pipeline calls `computeConfidenceFromInput` (v1) whose sample-size dampener caps confidence at ≈0 given the current match corpus characteristics (N < 30 effective matches per regime grouping).

**Condition 2 — Tradeability Always NO_GO:**
With `confidence_final = 0` from v1, `S_static = 0`, making `tradeability_score = 0 × D_dynamic = 0` regardless of favorable conditions. Additionally, the forecast route passes hardcoded spread/liquidity values rather than session-aware defaults.

**Condition 3 — Topology Weight Zero:**
`TOPOLOGY_SIMILARITY_WEIGHT = 0.0` in `topology-engine.ts`, meaning the computed topology vectors have no influence on similarity match quality.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type PipelineState
  OUTPUT: boolean
  
  condition1 := input.confidence_engine_version == "v1"
                AND input.match_corpus.effective_sample_size < 30
  
  condition2 := input.forecast.confidence_final == 0
                OR (input.live_feed_connected == false
                    AND input.session_defaults_available == false)
  
  condition3 := input.topology_similarity_weight == 0.0
                AND input.topology_vector_exists == true
  
  RETURN condition1 OR condition2 OR condition3
END FUNCTION
```

### Examples

- **Confidence = 0**: Batch runs, v1 computes `S(N=50) = min(1.0, 50/30) = 1.0` but raw C_raw ≈ 0.01 due to dampener → `confidence_final ≈ 0.005` → effectively zero after rounding
- **Tradeability NO_GO**: API serves forecast with `confidence_final = 0`, London session with spread 1.2 pips → `S_static = 0`, `D_dynamic = 0.8` → `score = 0` → NO_GO
- **Topology ignored**: Two fingerprints with identical 5-layer scores but vastly different S/R structures get identical similarity scores (topology_weight = 0.0)
- **Edge case**: v2 with `sample_size = 0` → should still throw error (Req 3.4 preserved)

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Existing 5-layer similarity weight matrices (regime-frozen) continue to use the same values and distance metrics (cosine for L1-L3, L2 for L4-L5)
- Tradeability formula `S_static × D_dynamic` with label bands GO > 0.75, CONDITIONAL ≥ 0.45, NO_GO < 0.45 remains unchanged
- When all dynamic sources are explicitly null/undefined, graceful degradation (NO_GO, score 0, list unavailable sources) remains
- Confidence v2 rejects `sample_size = 0` with an error
- Pipeline stages prior to confidence (ingestion → fingerprint → topology → regime_v2 → similarity → outcome → forecast) remain unchanged
- API response envelope structure, field names, HTTP status codes remain unchanged
- Existing similarity weights for 5 layers continue to sum correctly within the original matrix (topology is blended externally)

**Scope:**
All inputs that do NOT involve the three bug conditions should be completely unaffected by these fixes. This includes:
- Pipeline execution with a hypothetical live feed providing explicit spread/liquidity values
- Similarity scoring when `TOPOLOGY_SIMILARITY_WEIGHT` is set to 0.0 (opt-out)
- Confidence computation when using v1 explicitly (version service routing)

## Hypothesized Root Cause

Based on the bug description and code analysis, the root causes are:

1. **Confidence v1 Dampener Too Aggressive**: The `confidence` stage handler in `batch-entry.ts` (line ~165) calls `computeConfidenceFromInput` from `confidence-engine.ts`. The v1 formula uses `S(N) = min(1.0, N/30)` which caps at 0.5 for N < 30, and the raw C_raw itself is low due to theoretical (non-empirical) weighting. The v2 engine uses actual calibration data and produces meaningful scores > 0.

2. **Hardcoded Tradeability Defaults**: The forecast route (`src/api/routes/forecast.ts`, line ~128) passes `spread_pips: 1.5`, `live_liquidity_proxy: 0.75` — static values unrelated to the actual trading session. When confidence_final = 0, it doesn't matter what dynamic values are used. Once confidence is non-zero (Fix 1), these defaults need to be session-aware to produce realistic D_dynamic values.

3. **Topology Weight Declared But Unused**: `TOPOLOGY_SIMILARITY_WEIGHT = 0.0` is exported from `topology-engine.ts` but never consumed by `similarity-engine.ts`. The similarity engine's `computeAggregateScore` only operates on the 5-layer `RegimeWeightMatrix`. There is no code path to incorporate topology vectors.

## Correctness Properties

Property 1: Bug Condition - Confidence V2 Produces Non-Zero Scores

_For any_ valid `ConfidenceInput` where `sample_size >= 1` and valid `CalibrationParameters` with non-zero `global_fallback` values, the function `computeConfidenceV2FromInput` SHALL return `confidence_final > 0`.

**Validates: Requirements 2.1, 2.2**

Property 2: Preservation - Confidence V2 Rejects Zero Sample Size

_For any_ `ConfidenceInput` where `sample_size === 0`, the function `computeConfidenceV2FromInput` SHALL throw an error regardless of calibration parameters, preserving the zero-data rejection invariant.

**Validates: Requirements 3.4**

Property 3: Bug Condition - Session Defaults Produce Non-Zero Dynamic Score

_For any_ valid `Session` value and asset market hours string, the function `getSessionDefaults` SHALL return `spreadPips > 0` and `liquidityProxy > 0`, such that when combined with `newsRiskFlag = false`, the resulting `D_dynamic > 0`.

**Validates: Requirements 2.3**

Property 4: Preservation - Tradeability Formula Unchanged

_For any_ `TradeabilityInputNullable` where all dynamic sources are non-null, the tradeability computation SHALL produce `tradeability_score = clamp(S_static × D_dynamic, 0, 1)` with the same label banding thresholds (GO > 0.75, CONDITIONAL ≥ 0.45, NO_GO < 0.45) as before the fix.

**Validates: Requirements 3.2**

Property 5: Preservation - Graceful Degradation Unchanged

_For any_ `TradeabilityInputNullable` where at least one dynamic source is null/undefined, the tradeability computation SHALL produce `tradeability_score = 0`, `tradeability_label = "NO_GO"`, and list the unavailable sources.

**Validates: Requirements 3.3**

Property 6: Bug Condition - Topology Weight Influences Similarity Score

_For any_ two candidates with identical 5-layer scores but different topology similarity values, when `TOPOLOGY_SIMILARITY_WEIGHT > 0`, the function computing the final blended score SHALL produce different scores for the two candidates.

**Validates: Requirements 2.4, 2.5**

Property 7: Preservation - Existing 5-Layer Weights Unchanged

_For any_ valid `RegimeClassification`, the function `getRegimeWeights` SHALL return the same frozen weight matrix values as before the fix, and the 5-layer `computeAggregateScore` SHALL produce identical results for identical layer scores and weights.

**Validates: Requirements 3.1, 3.7**

Property 8: Bug Condition - Topology Blending Bounded

_For any_ topology similarity value in [0, 1] and any existing 5-layer aggregate in [0, 1], the blended final score `(1 - TOPOLOGY_SIMILARITY_WEIGHT) * existing + TOPOLOGY_SIMILARITY_WEIGHT * topology` SHALL be bounded to [0, 1].

**Validates: Requirements 2.4, 3.7**

## Fix Implementation

### Changes Required

#### Fix 1: Switch Confidence Engine v1 → v2

**File**: `src/batch-entry.ts`

**Function**: `createStageHandlers` → `confidence` handler

**Specific Changes**:
1. **Load calibration parameters at pipeline start**: Query `engine_versions` table for the active confidence engine (engine_name = 'confidence', is_active = true), parse `config` column as `CalibrationParameters`
2. **Replace v1 import with v2**: Import `computeConfidenceV2FromInput` from `./engines/confidence-engine-v2.js` instead of `computeConfidenceFromInput` from `./engines/confidence-engine.js`
3. **Update confidence handler signature**: The handler receives `input: ConfidenceInput` and `fingerprintId: string`. Call `computeConfidenceV2FromInput(normalisedInput, calibrationParams)` and map the v2 output to the existing `ConfidenceOutput` shape:
   ```typescript
   return {
     confidence_raw: v2Output.calibration_adjusted_base,
     sample_weight: v2Output.sample_density_modifier,
     regime_stability: v2Output.regime_accuracy_modifier,
     confidence_final: v2Output.confidence_final,
   };
   ```
4. **Calibration loading**: Load once in `main()` before the asset loop, pass to handler via closure. Error handling: if config is missing or invalid, log error and exit with code 1 (pipeline cannot produce valid output without calibration).

---

#### Fix 2: Session-Based Tradeability Defaults

**File**: `src/engines/tradeability-engine.ts` (new export)

**Function**: `getSessionDefaults(session: Session, assetMarketHours: string)`

**Specific Changes**:
1. **Add `getSessionDefaults` function**: Returns `{ spreadPips: number; liquidityProxy: number }` based on session and asset market hours:
   - London/NY overlap (session = LONDON or NY, hours in overlap range): `{ spreadPips: 1.0, liquidityProxy: 0.85 }`
   - London-only or NY-only: `{ spreadPips: 1.2, liquidityProxy: 0.85 }`
   - Asia: `{ spreadPips: 1.5, liquidityProxy: 0.70 }`
2. **Export the `SessionDefaults` interface**: `{ spreadPips: number; liquidityProxy: number }`

**File**: `src/api/routes/forecast.ts`

**Specific Changes**:
1. **Import `getSessionDefaults`** from the tradeability engine
2. **Replace hardcoded values**: Instead of `spread_pips: 1.5, live_liquidity_proxy: 0.75`, call `getSessionDefaults(session, 'EUR/USD')` and use the returned values
3. **Keep `news_risk_flag: false`** as default (no live news feed)
4. **The tradeability input becomes**:
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

---

#### Fix 3: Configurable Topology Weight in Similarity

**File**: `src/config/constants.ts`

**Specific Changes**:
1. **Add constant**: `export const TOPOLOGY_SIMILARITY_WEIGHT = 0.10 as const;`
2. **Remove** the `TOPOLOGY_SIMILARITY_WEIGHT = 0.0` export from `src/engines/topology-engine.ts` (move to constants)

**File**: `src/types/index.ts`

**Specific Changes**:
1. **Extend `RegimeWeightMatrix`**: Add optional `topology?: number` field (backward-compatible)

**File**: `src/engines/similarity-engine.ts`

**Specific Changes**:
1. **Import** `TOPOLOGY_SIMILARITY_WEIGHT` from `../config/constants.js`
2. **Add `computeBlendedScore` function**:
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
3. **Topology similarity computation**: In the batch pipeline's similarity handler (or in a utility function), compute cosine similarity between query and candidate topology vectors when both are available
4. **Integration point**: The `computeWeightedScores` function (or its caller) applies blending after computing the 5-layer aggregate. The existing `computeAggregateScore` remains unchanged.

**File**: `src/batch-entry.ts` — `similarity` stage handler

**Specific Changes**:
1. **Fetch topology vectors** for the query fingerprint and candidates from `fingerprint_topology` table
2. **Compute topology cosine similarity** between query topology vector and each candidate's topology vector
3. **Apply blending**: Call `computeBlendedScore(existingScore, topologySimilarity, TOPOLOGY_SIMILARITY_WEIGHT)` for each candidate before sorting

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bugs on unfixed code, then verify the fixes work correctly and preserve existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the three bugs BEFORE implementing fixes. Confirm or refute the root cause analysis.

**Test Plan**: Write tests that exercise the current code paths and assert they produce non-zero outputs. These will fail on unfixed code, confirming the bugs.

**Test Cases**:
1. **Confidence V1 Output Test**: Call `computeConfidenceFromInput` with typical pipeline inputs (N=50, variance=0.3, mean_similarity=0.7) — assert `confidence_final > 0.1` (will fail on unfixed code due to dampener)
2. **Tradeability With Zero Confidence**: Construct a forecast with `confidence_final = 0`, call `computeTradeabilityFromInput` — assert `tradeability_score > 0` (will fail because S_static = 0)
3. **Topology Contribution Test**: Compute similarity aggregate for two candidates with different topology vectors — assert scores differ (will fail because topology weight = 0.0)
4. **Session Defaults Availability**: Attempt to call a `getSessionDefaults` function — assert it exists and returns non-zero values (will fail because function doesn't exist yet)

**Expected Counterexamples**:
- V1 confidence output ≈ 0 for realistic inputs (dampener too aggressive)
- Tradeability score = 0 regardless of session conditions when confidence = 0
- Identical similarity scores for candidates with different topology structures

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed functions produce the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  -- Fix 1: Confidence v2 produces meaningful scores
  IF input.confidence_engine_version == "v2" THEN
    result := computeConfidenceV2FromInput(input.confidenceInput, input.calibration)
    ASSERT result.confidence_final > 0
    ASSERT result.confidence_final <= 1.0
  END IF
  
  -- Fix 2: Session defaults produce non-zero dynamic scores
  IF input.live_feed_connected == false THEN
    defaults := getSessionDefaults(input.session, input.asset)
    ASSERT defaults.spreadPips > 0
    ASSERT defaults.liquidityProxy > 0
    D_dynamic := computeDynamicScore(defaults)
    ASSERT D_dynamic > 0
  END IF
  
  -- Fix 3: Topology weight produces differentiated scores
  IF input.topology_similarity_weight > 0 THEN
    blended := computeBlendedScore(input.existingScore, input.topologySimilarity, input.weight)
    ASSERT blended != input.existingScore (when topologySimilarity != existingScore)
    ASSERT 0 <= blended <= 1
  END IF
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed functions produce the same result as the original functions.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  -- Tradeability: explicit non-null inputs → same formula
  IF allDynamicSourcesAvailable(input) THEN
    ASSERT computeTradeabilityFromInput_fixed(input) = computeTradeabilityFromInput_original(input)
  END IF
  
  -- Tradeability: null sources → same degradation
  IF anyDynamicSourceNull(input) THEN
    ASSERT computeTradeabilityFromInput_fixed(input).tradeability_score == 0
    ASSERT computeTradeabilityFromInput_fixed(input).tradeability_label == "NO_GO"
  END IF
  
  -- Similarity: 5-layer aggregation unchanged
  ASSERT computeAggregateScore_fixed(layerScores, weights) == computeAggregateScore_original(layerScores, weights)
  
  -- Similarity: topology weight = 0 → no change
  ASSERT computeBlendedScore(existing, topology, 0.0) == existing
END FOR
```

**Testing Approach**: Property-based testing (fast-check) is recommended for preservation checking because:
- It generates many random input combinations across the full domain
- It catches edge cases in floating-point arithmetic and boundary conditions
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs
- The similarity weight matrices are purely numerical — ideal for PBT

**Test Plan**: Observe behavior on UNFIXED code first for the tradeability formula and similarity aggregation, then write property-based tests capturing that behavior, and verify it holds after the fix.

**Test Cases**:
1. **Tradeability Formula Preservation**: Generate random forecasts with `confidence_final > 0` and random valid dynamic inputs → verify `score = S_static × D_dynamic` with same label bands
2. **Graceful Degradation Preservation**: Generate random inputs with at least one null dynamic source → verify NO_GO output
3. **5-Layer Aggregate Preservation**: Generate random layer scores and valid regime weights → verify `computeAggregateScore` output is unchanged
4. **Topology Opt-Out Preservation**: Call `computeBlendedScore` with `topologyWeight = 0` → verify output equals input existing score exactly

### Unit Tests

- Test `computeConfidenceV2FromInput` produces `confidence_final > 0` for valid inputs with realistic calibration
- Test `computeConfidenceV2FromInput` throws for `sample_size = 0`
- Test `getSessionDefaults` returns correct spread/liquidity for each session (LONDON, NY, ASIA)
- Test `getSessionDefaults` returns correct overlap values during London/NY overlap hours
- Test `computeBlendedScore` with topology = undefined returns existing score
- Test `computeBlendedScore` with topology weight = 0.0 returns existing score
- Test `computeBlendedScore` with topology weight = 0.10 produces correct linear blend
- Test `computeBlendedScore` output is always in [0, 1]
- Test `computeAggregateScore` remains unchanged (no topology in its signature)

### Property-Based Tests

- Generate random `ConfidenceInput` (sample_size ≥ 1, all values in [0,1]) with random valid `CalibrationParameters` → assert `confidence_final ∈ (0, 1]`
- Generate random `Session` values → assert `getSessionDefaults` returns `spreadPips ∈ [1.0, 1.5]` and `liquidityProxy ∈ [0.70, 0.85]`
- Generate random 5-layer scores and random topology similarity → assert `computeBlendedScore` output ∈ [0, 1]
- Generate random existing aggregate and topology similarity, weight = 0.10 → assert `blended = 0.9 * existing + 0.1 * topology` (within floating point tolerance)
- Generate random `TradeabilityInputNullable` with all fields non-null → assert score = `clamp(forecast.confidence_final × D_dynamic, 0, 1)` (preservation)
- Generate random `TradeabilityInputNullable` with at least one null field → assert score = 0, label = NO_GO (preservation)

### Integration Tests

- Full batch pipeline run with v2 confidence → assert `cached_forecasts.confidence_final > 0`
- API forecast endpoint returns non-zero `tradeability_score` when `confidence_final > 0` and session is LONDON
- Similarity stage with topology vectors produces different scores for candidates with different topology structures
- End-to-end: batch produces forecast → API serves it → tradeability is CONDITIONAL or GO during London session
