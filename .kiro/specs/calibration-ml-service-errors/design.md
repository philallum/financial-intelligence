# Calibration ML Service Errors Bugfix Design

## Overview

The batch pipeline (`src/batch-entry.ts`) reads `ML_SERVICE_URL` directly from `process.env` with no fallback default. When the variable is undefined — which is the default state because it is absent from both `.env.example` and the typed `EnvConfig` in `src/config/env.ts` — the pipeline skips the ML prediction and calibration stages entirely. This produces `calibration_applied: false` and `failure_reason: null` in diagnostics, which the dashboard's Continuous Learning Pipeline card renders as "⚠️ Calibration not applied — predictions are using raw uncalibrated probabilities" with a red status dot. Additionally, when the ML service is reachable but throws a network error mid-request, the `failure_reason` is recorded as `'ml_service_unavailable'`, surfacing a second unhelpful error on the dashboard.

The fix introduces a default `ML_SERVICE_URL` of `http://localhost:5000` (matching the ML service's Dockerfile `EXPOSE 5000` and `CMD` default port), documents it in `.env.example`, adds it to the typed `EnvConfig` interface, and improves dashboard error messaging to differentiate between "ML service not running" and "calibration model not yet trained."

## Glossary

- **Bug_Condition (C)**: The condition where `ML_SERVICE_URL` is undefined in the runtime environment, causing the batch pipeline to skip ML prediction and calibration entirely
- **Property (P)**: When `ML_SERVICE_URL` is configured (explicitly or via default), the pipeline SHALL attempt to connect to the ML service for prediction and calibration
- **Preservation**: Existing graceful degradation behavior when the ML service is reachable but returns errors, and all non-ML-service pipeline stages, must remain unchanged
- **`batch-entry.ts`**: The Cloud Run entry point (`src/batch-entry.ts`) that orchestrates the batch intelligence pipeline every 4 hours
- **`env.ts`**: The typed environment configuration module (`src/config/env.ts`) that loads and validates environment variables
- **`continuous-learning-card`**: The dashboard component (both `dashboard/continuous-learning-card.ts` and the inline `renderContinuousLearningCard` in `dashboard/index.html`) that displays calibration and ML pipeline status
- **`DiagnosticsAccumulator`**: The mutable object in `batch-entry.ts` that collects per-stage diagnostics during pipeline execution

## Bug Details

### Bug Condition

The bug manifests when the batch pipeline runs without `ML_SERVICE_URL` set in the environment. The variable is not in `EnvConfig`, not in `.env.example`, and `batch-entry.ts` reads it directly via `process.env['ML_SERVICE_URL']` with no fallback. When undefined, the entire `if (mlServiceUrl) { ... }` block (lines 563–722) is skipped, leading to `calibration_applied: false` being recorded in diagnostics. The dashboard then shows a permanent calibration warning.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type BatchPipelineEnvironment
  OUTPUT: boolean
  
  RETURN input.processEnv['ML_SERVICE_URL'] === undefined
         AND input.mlServiceRunningLocally === true
         AND input.pipelineStage === 'forecast'
END FUNCTION
```

### Examples

- Developer starts the ML service via `docker run -p 5000:5000 fip-ml`, runs the batch pipeline locally → pipeline skips ML prediction because `ML_SERVICE_URL` is not set → dashboard shows "Calibration not applied" error
- Developer clones repo, copies `.env.example` to `.env` → no `ML_SERVICE_URL` entry exists → batch pipeline never attempts ML connection
- ML service is running on `http://localhost:5000` and healthy → batch pipeline records `ml_service.called: false` in diagnostics → dashboard shows red calibration dot
- Pipeline runs in production with `ML_SERVICE_URL` properly set via Cloud Run env vars → bug does NOT manifest (no bug condition)

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- When ML service is reachable and returns valid predictions from `/predict`, the 50/50 ensemble blending logic must produce identical results
- When ML service is reachable and `/calibrate` returns `calibrated: true`, isotonic regression calibration must still be applied identically
- When ML service `/predict` returns a non-OK HTTP status, the pipeline must still fall back to similarity-only forecast without crashing
- When ML service `/calibrate` returns `calibrated: false` (no model loaded), the pipeline must still use raw ensemble probabilities
- All non-ML pipeline stages (ingestion, regime, fingerprint, similarity, sentiment, macro, confidence, tradeability, outcome) must be completely unaffected
- Diagnostics recording must remain non-blocking (wrapped in try/catch)
- The 3-second AbortSignal timeout on ML service calls must remain unchanged
- SHAP computation fire-and-forget behavior must remain unchanged

**Scope:**
All inputs where `ML_SERVICE_URL` IS defined and the ML service IS reachable should produce behavior identical to the current implementation. The fix only affects the code path where `ML_SERVICE_URL` would previously have been `undefined`.

## Hypothesized Root Cause

Based on the bug description and code analysis, the root causes are:

1. **Missing Default Value**: `batch-entry.ts` line 552 reads `process.env['ML_SERVICE_URL']` with no fallback. Unlike other optional env vars in `env.ts` (e.g., `GCP_LOCATION` defaults to `'us-central1'`), `ML_SERVICE_URL` has no default value anywhere in the codebase.

2. **Not in EnvConfig Interface**: The `EnvConfig` interface in `src/config/env.ts` does not include `ML_SERVICE_URL`, so it bypasses the typed configuration system entirely. The batch entry reads it directly from `process.env` rather than through the validated `env` object.

3. **Not Documented in `.env.example`**: The `.env.example` file lists every other environment variable but omits `ML_SERVICE_URL`. Developers have no guidance that this variable exists or what value it should have.

4. **Dashboard Error Messaging**: The `renderContinuousLearningCard` function in `dashboard/index.html` shows `latest.failure_reason || 'Calibration skipped'` as the detail text. When `failure_reason` is `null` (the "URL not configured" path), it shows "Calibration skipped" which is non-actionable. When `failure_reason` is `'ml_service_unavailable'` (the network error path), it shows that raw string without guidance.

## Correctness Properties

Property 1: Bug Condition - ML Service Connection Attempted With Default URL

_For any_ batch pipeline execution where `ML_SERVICE_URL` is not explicitly set in the environment, the fixed code SHALL use the default value `http://localhost:5000` and attempt to connect to the ML service for prediction and calibration, rather than skipping the ML stage entirely.

**Validates: Requirements 2.1, 2.2**

Property 2: Preservation - ML Service Reachable Behavior Unchanged

_For any_ batch pipeline execution where `ML_SERVICE_URL` is defined (explicitly or via default) and the ML service is reachable, the fixed code SHALL produce exactly the same ensemble blending, calibration application, SHAP computation, and diagnostics recording as the original code, preserving all existing ML integration behavior.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/config/env.ts`

**Changes**:
1. **Add `ML_SERVICE_URL` to `EnvConfig` interface**: Add a `readonly ML_SERVICE_URL: string` field to the typed config interface
2. **Add default value in `loadEnvConfig()`**: Set `ML_SERVICE_URL: process.env['ML_SERVICE_URL'] ?? 'http://localhost:5000'` — matching the Dockerfile.ml default port

**File**: `src/batch-entry.ts`

**Changes**:
3. **Use typed env config instead of raw process.env**: Replace `const mlServiceUrl = process.env['ML_SERVICE_URL']` with `const mlServiceUrl = env.ML_SERVICE_URL` (import `env` is already present at line 22). Since the default is always defined, the `if (mlServiceUrl)` check will always be truthy — but keep it for safety in case someone explicitly sets it to empty string.
4. **Improve the else-branch failure_reason**: When `mlServiceUrl` is falsy (empty string edge case), set `failure_reason: 'ml_service_url_not_configured'` instead of `null` for better diagnostics.

**File**: `.env.example`

**Changes**:
5. **Document ML_SERVICE_URL**: Add a section documenting `ML_SERVICE_URL` with its default value and purpose:
   ```
   # --- ML Service ---
   # URL for the XGBoost ML prediction service (default: http://localhost:5000)
   # Run locally: docker build -f Dockerfile.ml -t fip-ml . && docker run -p 5000:5000 fip-ml
   ML_SERVICE_URL=http://localhost:5000
   ```

**File**: `dashboard/index.html` (inline `renderContinuousLearningCard`)

**Changes**:
6. **Improve calibration error messaging**: When `calibration_applied` is false, differentiate between:
   - `failure_reason === null` or `failure_reason === 'ml_service_url_not_configured'` → show "ML service URL not configured — set ML_SERVICE_URL in .env"
   - `failure_reason === 'ml_service_unavailable'` → show "ML service not running — start with: docker run -p 5000:5000 fip-ml"
   - `failure_reason` contains `'calibration_failed'` → show "Calibration model not yet trained"
   - No `failure_reason` and ML was called but `calibrated: false` → show "Calibration pending — model not yet trained (informational)"

**File**: `dashboard/continuous-learning-card.ts`

**Changes**:
7. **Mirror improved messaging in the testable module**: Apply the same differentiated error messaging logic to the exported `renderContinuousLearningCard` function for consistency and testability.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that exercise the batch pipeline's ML service integration with `ML_SERVICE_URL` unset and verify that the pipeline skips ML prediction entirely. Run these on the UNFIXED code to observe the bug in action.

**Test Cases**:
1. **Env Var Missing Test**: Delete `ML_SERVICE_URL` from process.env, verify `process.env['ML_SERVICE_URL']` is `undefined` and the pipeline records `ml_service.called: false` (will demonstrate bug on unfixed code)
2. **EnvConfig Omission Test**: Import `env` from `src/config/env.ts`, verify it does NOT have an `ML_SERVICE_URL` property (will demonstrate bug on unfixed code)
3. **Dashboard Warning Rendered Test**: Provide diagnostics with `calibration_applied: false` and `failure_reason: null`, verify the card shows the non-actionable "Calibration skipped" text (will demonstrate bug on unfixed code)
4. **`.env.example` Missing Entry Test**: Read `.env.example`, verify `ML_SERVICE_URL` is NOT present (will demonstrate bug on unfixed code)

**Expected Counterexamples**:
- `env` object does not contain `ML_SERVICE_URL` property
- `process.env['ML_SERVICE_URL']` returns `undefined` with default `.env.example` config
- Dashboard shows unhelpful "Calibration skipped" instead of actionable guidance

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := loadEnvConfig_fixed()
  ASSERT result.ML_SERVICE_URL === 'http://localhost:5000'
  ASSERT typeof result.ML_SERVICE_URL === 'string'
  ASSERT result.ML_SERVICE_URL.length > 0
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT loadEnvConfig_original(input) = loadEnvConfig_fixed(input)
  // Specifically: all other EnvConfig fields are identical
  // ML service integration logic is identical when URL is provided
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many combinations of environment variable states to verify no regressions
- It catches edge cases in URL formatting and empty-string handling
- It provides strong guarantees that the dashboard rendering logic is unchanged for non-bug-condition inputs

**Test Plan**: Observe behavior on UNFIXED code first for cases where `ML_SERVICE_URL` IS explicitly set, then write property-based tests capturing that behavior remains identical after the fix.

**Test Cases**:
1. **EnvConfig Preservation**: Verify all existing `EnvConfig` fields (TWELVE_DATA_API_KEY, SUPABASE_URL, etc.) are unchanged when `ML_SERVICE_URL` is added
2. **ML Integration Path Preservation**: Verify that when `ML_SERVICE_URL` is explicitly set to a value, the ensemble blending and calibration logic produces identical results
3. **Dashboard Rendering Preservation**: Verify that when `calibration_applied: true`, the dashboard card renders identically (green dot, "Applied" status)
4. **Diagnostics Recording Preservation**: Verify that when ML service IS called and succeeds, the diagnostics payload structure is unchanged

### Unit Tests

- Test `loadEnvConfig()` returns `ML_SERVICE_URL` with default `http://localhost:5000` when env var is unset
- Test `loadEnvConfig()` returns explicit value when `ML_SERVICE_URL` is set in environment
- Test `loadEnvConfig()` returns default when `ML_SERVICE_URL` is set to empty string
- Test that `batch-entry.ts` uses `env.ML_SERVICE_URL` instead of raw `process.env`
- Test dashboard card renders actionable message for `failure_reason: 'ml_service_unavailable'`
- Test dashboard card renders informational message when calibration is pending (no model trained)

### Property-Based Tests

- Generate random `EnvConfig` states with and without `ML_SERVICE_URL` set, verify the fixed `loadEnvConfig()` always returns a non-empty string for `ML_SERVICE_URL`
- Generate random `LearningPipelineDiagnostics` objects with various `failure_reason` values, verify the dashboard card always renders an actionable message (never raw error codes)
- Generate random diagnostics with `calibration_applied: true`, verify the card rendering is unchanged from the original implementation

### Integration Tests

- End-to-end test: start ML service on localhost:5000, run batch pipeline with default env, verify `calibration_applied` is recorded correctly based on ML service state
- End-to-end test: stop ML service, run batch pipeline, verify graceful degradation with actionable error message in diagnostics
- End-to-end test: verify `.env.example` contains `ML_SERVICE_URL` and value matches Dockerfile.ml port
