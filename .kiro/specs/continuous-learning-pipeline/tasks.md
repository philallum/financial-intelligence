# Implementation Plan: Continuous Learning Pipeline

## Overview

Implement the Pipeline Computation Calibration Framework as a new `src/calibration/` namespace. The system comprises 7 database tables, shared TypeScript interfaces/types, 6 pure-function analysis engines, 1 orchestrator, a scheduling mechanism, and a query interface. Property-based tests validate the 24 correctness properties using fast-check.

## Tasks

- [x] 1. Set up calibration namespace and shared types
  - [x] 1.1 Create directory structure and core interfaces
    - Create `src/calibration/` directory with `types.ts`, `constants.ts`, and `index.ts`
    - Define all TypeScript interfaces: `CalibrationRunConfig`, `CalibrationRunResult`, `StageContribution`, `RegimeAccuracyResult`, `CounterfactualRequest`, `CounterfactualResult`, `LayerSignalResult`, `BucketCalibration`, `CalibrationDriftResult`, `ParameterRecommendation`, `ValidationResult`
    - Define `PARAMETER_BOUNDS` constant, regime types enum, asset types, layer names
    - Export all types from the barrel `index.ts`
    - _Requirements: 3.2, 3.5, 6.6_

  - [x] 1.2 Create database migration for all 7 calibration tables
    - Create SQL migration file with all table definitions: `calibration_runs`, `calibration_stage_contributions`, `calibration_regime_accuracy`, `calibration_counterfactuals`, `calibration_layer_signals`, `calibration_confidence_drift`, `calibration_recommendations`
    - Include all indexes as specified in the design
    - Include all CHECK constraints and foreign key relationships
    - _Requirements: 1.4, 2.4, 3.6, 4.5, 5.6, 6.7, 7.3_

  - [x] 1.3 Create shared test utilities and custom fast-check arbitraries
    - Create `tests/calibration/helpers/arbitraries.ts` with all custom arbitraries: `arbLayerBreakdown`, `arbRegime`, `arbAsset`, `arbDirection`, `arbEvaluationRecord`, `arbRegimeWeightVector`
    - Create `tests/calibration/helpers/factories.ts` with test data factory functions
    - _Requirements: all (test infrastructure)_

- [x] 2. Implement Stage Contribution Tracker
  - [x] 2.1 Implement computeContributions pure function
    - Create `src/calibration/stage-contribution-tracker.ts`
    - Implement per-stage contribution score computation correlating stage output with forecast accuracy
    - Implement layer-dominant identification (maximum breakdown value, lowest index on tie)
    - Implement marginal accuracy delta for macro/sentiment stages
    - Implement low-confidence marking when (asset, regime) pair count < 10
    - Ensure contribution scores are clamped to [-1, 1]
    - _Requirements: 1.1, 1.2, 1.3, 1.5_

  - [x] 2.2 Write property tests for Stage Contribution Tracker
    - **Property 1: Contribution scores are bounded and complete**
    - **Property 2: Layer dominant identification correctness**
    - **Property 3: Marginal accuracy delta correctness**
    - **Property 4: Low-confidence marking threshold**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.5**
    - Create `tests/calibration/stage-contribution.property.test.ts`

  - [x] 2.3 Write unit tests for Stage Contribution Tracker edge cases
    - Test empty evaluation set returns empty results
    - Test single evaluation produces one contribution per stage
    - Test missing batch_diagnostics FK skips evaluation with warning
    - Test exactly 10 evaluations for (asset, regime) → not low-confidence
    - Test layer_breakdown ties (e.g. L1=L3=max) picks lowest index
    - _Requirements: 1.1, 1.2, 1.3, 1.5_

- [x] 3. Implement Regime Accuracy Breakdown
  - [x] 3.1 Implement computeRegimeAccuracy pure function
    - Create `src/calibration/regime-accuracy-analyser.ts`
    - Implement direction accuracy as (correct_count / total_count) × 100, rounded to 2 decimal places
    - Implement statistical significance classification (sample_count >= 30)
    - Implement underperforming classification (accuracy_pct < 40)
    - Implement accuracy delta computation versus previous run results
    - Produce results for all 9 regime types × 2 assets × 3 directions
    - _Requirements: 2.1, 2.2, 2.3, 2.5_

  - [x] 3.2 Write property tests for Regime Accuracy Breakdown
    - **Property 5: Direction accuracy computation**
    - **Property 6: Statistical significance classification**
    - **Property 7: Underperforming classification**
    - **Property 8: Accuracy delta computation**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.5**
    - Create `tests/calibration/regime-accuracy.property.test.ts`

  - [x] 3.3 Write unit tests for Regime Accuracy Breakdown
    - Test no evaluations returns empty results
    - Test exactly 30 samples → is_significant = true
    - Test exactly 29 samples → is_significant = false
    - Test 40.00% accuracy → not underperforming, 39.99% → underperforming
    - Test accuracy_delta is null when no previous run exists
    - _Requirements: 2.1, 2.2, 2.3, 2.5_

- [ ] 4. Implement Threshold Analyser
  - [~] 4.1 Implement counterfactual analysis pure functions
    - Create `src/calibration/threshold-analyser.ts`
    - Implement `runCounterfactual` for FLAT_THRESHOLD (re-classify direction with alternative threshold)
    - Implement `runCounterfactual` for TOPOLOGY_SIMILARITY_WEIGHT (recompute composite scores, re-rank)
    - Implement `runCounterfactual` for regime weight matrix values (recompute weighted layer similarities)
    - Compute direction accuracy, Brier score, and ECE for both baseline and alternative
    - Implement `validateRegimeWeights` (sum to 1.0 within 0.001 tolerance)
    - Implement `generateAlternatives` to produce candidate values within bounds
    - Filter out records without complete layer_breakdown (all 5 layers required)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [~] 4.2 Write property tests for Threshold Analyser
    - **Property 9: Counterfactual parameter isolation**
    - **Property 10: Parameter validation bounds**
    - **Property 11: Counterfactual completeness filter**
    - **Validates: Requirements 3.1, 3.2, 3.4, 3.5**
    - Create `tests/calibration/threshold-analyser.property.test.ts`

  - [~] 4.3 Write unit tests for Threshold Analyser
    - Test regime weight sum = 1.001 is rejected
    - Test regime weight sum = 0.999 is accepted (within tolerance)
    - Test FLAT_THRESHOLD = 0 rejected, = 6 rejected, = 1 accepted, = 5 accepted
    - Test TOPOLOGY_SIMILARITY_WEIGHT = -0.01 rejected, = 0.31 rejected, = 0.0 accepted, = 0.30 accepted
    - Test records with missing L3 layer excluded from computation
    - Test generateAlternatives returns values within parameter bounds
    - _Requirements: 3.1, 3.2, 3.4, 3.5_

- [~] 5. Checkpoint - Core analysis engines
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement Signal-Noise Evaluator
  - [~] 6.1 Implement computeLayerSignals pure function
    - Create `src/calibration/signal-noise-evaluator.ts`
    - Implement Pearson product-moment correlation coefficient calculation
    - Implement signal classification: low-signal (r < 0.05, n >= 50), high-signal (r > 0.20, n >= 50), neutral otherwise
    - Group computations by (regime, asset, layer) triple
    - Handle edge case: fewer than 2 distinct values → correlation = 0, classification = 'neutral'
    - Clamp correlation to [-1, 1]
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [~] 6.2 Write property tests for Signal-Noise Evaluator
    - **Property 12: Pearson correlation correctness**
    - **Property 13: Signal classification thresholds**
    - **Property 14: Per-regime-asset grouping completeness**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
    - Create `tests/calibration/signal-noise.property.test.ts`

  - [~] 6.3 Write unit tests for Signal-Noise Evaluator
    - Test perfectly correlated data returns r ≈ 1.0
    - Test perfectly anti-correlated data returns r ≈ -1.0
    - Test uncorrelated data returns r ≈ 0
    - Test sample_size < 50 always classifies as 'neutral'
    - Test exactly 50 samples applies classification thresholds
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] 7. Implement Calibration Monitor
  - [~] 7.1 Implement computeCalibrationDrift pure function
    - Create `src/calibration/calibration-monitor.ts`
    - Implement bucket assignment for confidence values into 10 buckets (0.0-0.1 through 0.9-1.0)
    - Implement observed accuracy as mean of direction_accuracy per bucket
    - Implement miscalibration detection: |nominal_midpoint - observed_accuracy| > 0.15
    - Implement ECE: weighted average of per-bucket calibration gaps
    - Implement alert severity: 'high' if miscalibrated_count >= 3 OR ece > 0.10; 'low' if 1-2 miscalibrated AND ece <= 0.10; 'none' otherwise
    - Handle empty window: ECE = 0, miscalibrated_count = 0, alert_severity = 'none'
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [~] 7.2 Write property tests for Calibration Monitor
    - **Property 15: Bucket accuracy computation**
    - **Property 16: Miscalibration detection**
    - **Property 17: Expected Calibration Error (ECE) computation**
    - **Property 18: Alert severity determination**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
    - Create `tests/calibration/calibration-monitor.property.test.ts`

  - [~] 7.3 Write unit tests for Calibration Monitor
    - Test no evaluations in window returns all-zero results
    - Test perfectly calibrated data (observed = midpoint) gives ECE = 0
    - Test exactly 3 miscalibrated buckets triggers 'high' severity
    - Test ECE = 0.101 triggers 'high' even with 0 miscalibrated buckets
    - Test single bucket with large gap: miscalibrated_count = 1, severity = 'low'
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 8. Implement Recommendation Engine
  - [~] 8.1 Implement synthesiseRecommendations pure function
    - Create `src/calibration/recommendation-engine.ts`
    - Implement synthesis logic combining contributions, regime accuracy, counterfactuals, layer signals, and calibration drift
    - Implement confidence level assignment: low (< 30), medium (30-99), high (>= 100)
    - Implement bounds enforcement for all recommended values (PARAMETER_BOUNDS)
    - Implement human-readable explanation string generation
    - Implement `validateRecommendation` function
    - Ensure all output fields are non-null and explanation is non-empty
    - Rank recommendations by projected accuracy improvement
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8_

  - [~] 8.2 Write property tests for Recommendation Engine
    - **Property 19: Confidence level assignment**
    - **Property 20: Recommendation output completeness**
    - **Property 21: Recommendation bounds enforcement**
    - **Validates: Requirements 6.3, 6.4, 6.5, 6.2, 6.6, 6.8**
    - Create `tests/calibration/recommendation-engine.property.test.ts`

  - [~] 8.3 Write unit tests for Recommendation Engine
    - Test sample_size = 29 → confidence 'low', = 30 → 'medium', = 100 → 'high'
    - Test recommended FLAT_THRESHOLD outside [1, 5] is clamped
    - Test recommended TOPOLOGY_SIMILARITY_WEIGHT outside [0.0, 0.30] is clamped
    - Test empty analysis inputs produces empty recommendations array
    - Test explanation string is always non-empty
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8_

- [~] 9. Checkpoint - All analysis engines complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Implement Scheduling and Trigger Logic
  - [~] 10.1 Implement shouldTrigger function and threshold check
    - Create `src/calibration/scheduler.ts`
    - Implement `shouldTrigger(newEvalCount, lastRunAt)`: returns true if newEvalCount >= 50 OR elapsed time > 7 days OR lastRunAt is null
    - Implement `checkCalibrationThreshold` that queries `calibration_runs` and `research_evaluations` to determine if threshold is met
    - _Requirements: 7.1, 7.2_

  - [~] 10.2 Write property tests for scheduler trigger logic
    - **Property 22: Trigger condition correctness**
    - **Validates: Requirements 7.1, 7.2**
    - Create `tests/calibration/scheduler-trigger.property.test.ts`

  - [~] 10.3 Write unit tests for scheduler edge cases
    - Test newEvalCount = 49, lastRunAt = 6 days ago → false
    - Test newEvalCount = 50, lastRunAt = 1 day ago → true (threshold)
    - Test newEvalCount = 0, lastRunAt = 8 days ago → true (schedule)
    - Test lastRunAt = null → true (first run)
    - _Requirements: 7.1, 7.2_

- [ ] 11. Implement Calibration Orchestrator
  - [~] 11.1 Implement runCalibration orchestrator function
    - Create `src/calibration/orchestrator.ts`
    - Implement advisory lock acquisition via `pg_advisory_xact_lock`
    - Implement data collection: query unprocessed evaluations since last run
    - Implement parallel execution of: Stage Contribution Tracker, Regime Accuracy Breakdown, Signal-Noise Evaluator, Calibration Monitor
    - Implement sequential execution of Threshold Analyser (depends on contribution data)
    - Implement Recommendation Engine synthesis after all analyses complete
    - Implement partial failure handling: catch per-stage errors, persist completed results, record failed_stage and error_detail
    - Implement run metadata persistence to `calibration_runs`
    - Wire all analysis engine outputs to their respective database tables
    - _Requirements: 7.3, 7.4, 7.5_

  - [~] 11.2 Write unit tests for orchestrator
    - Test successful full run records status 'completed'
    - Test single stage failure records status 'partial' with failed_stage
    - Test advisory lock unavailable returns immediately
    - Test parallel analysis stages all receive the same evaluation data
    - Test Recommendation Engine receives outputs from all sub-analyses
    - _Requirements: 7.3, 7.4, 7.5_

- [ ] 12. Implement Trend Tracking and Query Interface
  - [~] 12.1 Implement trend computation and post-application tracking
    - Create `src/calibration/trend-tracker.ts`
    - Implement platform-level accuracy trend: current run vs mean of up to 5 previous runs
    - Implement per-stage improvement score comparing contribution correlation before/after parameter changes
    - Implement post-application accuracy delta: mean accuracy 30 days after minus mean accuracy 30 days before applied_at
    - _Requirements: 8.2, 8.3, 8.4_

  - [~] 12.2 Implement read-only query interface
    - Create `src/calibration/query-interface.ts`
    - Implement filtering by asset, regime, date range, and analysis run identifier
    - Expose functions for querying all calibration tables
    - Ensure historical results are never deleted (append-only by design)
    - _Requirements: 8.1, 8.5_

  - [~] 12.3 Write property tests for trend tracking
    - **Property 23: Accuracy trend computation**
    - **Property 24: Post-application accuracy delta**
    - **Validates: Requirements 8.2, 8.4**
    - Create `tests/calibration/trend-tracking.property.test.ts`

  - [~] 12.4 Write unit tests for query interface and trend tracking
    - Test trend with fewer than 2 runs returns null
    - Test trend with exactly 5 previous runs averages all 5
    - Test post-application delta with no post-period evaluations returns null
    - Test query filters correctly by asset, regime, date range
    - _Requirements: 8.1, 8.2, 8.4, 8.5_

- [ ] 13. Wire batch pipeline integration and Cloud Scheduler hook
  - [~] 13.1 Add post-evaluation threshold check to batch pipeline
    - Modify the batch pipeline's post-evaluation phase to call `checkCalibrationThreshold`
    - When threshold met, invoke `runCalibration` with trigger_reason 'threshold'
    - Ensure the threshold check is lightweight and non-blocking to batch completion
    - _Requirements: 7.1_

  - [~] 13.2 Create Cloud Scheduler endpoint for weekly trigger
    - Create HTTP endpoint or Cloud Run job entry point for scheduled calibration
    - Implement the 7-day guard check (skip if last run < 7 days ago)
    - Configure trigger_reason as 'schedule'
    - _Requirements: 7.2_

- [~] 14. Final checkpoint - Full integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties (24 properties across 8 test files)
- Unit tests validate specific examples and edge cases
- All analysis engines are pure functions — database I/O is confined to the orchestrator layer
- Tests use 100 minimum iterations per property (matching project convention)
- Test files go in `tests/calibration/` directory matching the existing project structure

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "3.1", "6.1", "7.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2", "3.3", "4.1", "6.2", "6.3", "7.2", "7.3"] },
    { "id": 3, "tasks": ["4.2", "4.3", "8.1", "10.1"] },
    { "id": 4, "tasks": ["8.2", "8.3", "10.2", "10.3"] },
    { "id": 5, "tasks": ["11.1", "12.1", "12.2"] },
    { "id": 6, "tasks": ["11.2", "12.3", "12.4"] },
    { "id": 7, "tasks": ["13.1", "13.2"] }
  ]
}
```
