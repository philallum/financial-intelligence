# Implementation Plan

## Overview

Fix the `ML_SERVICE_URL` configuration bug that causes the batch pipeline to skip ML prediction and calibration entirely when the environment variable is undefined. This implementation follows the bug condition methodology: explore the bug with property-based tests, preserve existing behavior, implement the fix, and validate.

## Task Dependency Graph

```json
{
  "waves": [
    ["1"],
    ["2"],
    ["3.1", "3.3"],
    ["3.2"],
    ["3.4", "3.5"],
    ["3.6", "3.7"],
    ["4"]
  ]
}
```

## Tasks

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - ML Service URL Undefined Skips Calibration
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to the concrete failing case: when `ML_SERVICE_URL` is not set in process.env, the env config should still provide a default URL value
  - Test file: `src/__tests__/ml-service-url-bugcondition.property.test.ts`
  - Property: For any environment state where `process.env['ML_SERVICE_URL']` is undefined, `loadEnvConfig()` SHALL return a non-empty `ML_SERVICE_URL` string defaulting to `http://localhost:5000`
  - Bug Condition from design: `isBugCondition(input) = input.processEnv['ML_SERVICE_URL'] === undefined AND input.mlServiceRunningLocally === true AND input.pipelineStage === 'forecast'`
  - Expected Behavior: `loadEnvConfig()` returns `ML_SERVICE_URL: 'http://localhost:5000'` when env var is unset
  - Generate random environment states (with various other env vars set/unset) where ML_SERVICE_URL is specifically undefined
  - Assert that the loaded config always contains a non-empty ML_SERVICE_URL string
  - Also test dashboard rendering: for diagnostics with `calibration_applied: false` and `failure_reason: null`, assert card shows actionable guidance (not "Calibration skipped")
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists: env config has no ML_SERVICE_URL field, dashboard shows non-actionable message)
  - Document counterexamples found to understand root cause
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 2.1_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Existing EnvConfig Fields and ML Integration Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Test file: `src/__tests__/ml-service-url-preservation.property.test.ts`
  - Observe on UNFIXED code: when `ML_SERVICE_URL` IS explicitly set in process.env, `loadEnvConfig()` returns all other fields identically
  - Observe on UNFIXED code: when `calibration_applied: true` in diagnostics, dashboard card renders green status dot and "Applied" text
  - Observe on UNFIXED code: all existing EnvConfig fields (TWELVE_DATA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GCP_PROJECT_ID, GCP_LOCATION, etc.) load correctly regardless of ML_SERVICE_URL state
  - Write property-based test: for all valid environment configurations where ML_SERVICE_URL IS explicitly set, all other EnvConfig fields are loaded identically to the unfixed code
  - Write property-based test: for all diagnostics objects where `calibration_applied: true`, the dashboard card rendering (green dot, "Applied" status) is unchanged
  - Write property-based test: for all diagnostics with various non-null `failure_reason` values when `calibration_applied: false`, the card still renders a warning state (preservation of warning behavior)
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix for ML_SERVICE_URL undefined causing calibration errors

  - [x] 3.1 Add ML_SERVICE_URL to EnvConfig interface with default value
    - In `src/config/env.ts`, add `readonly ML_SERVICE_URL: string` to the `EnvConfig` interface
    - In `loadEnvConfig()`, add `ML_SERVICE_URL: process.env['ML_SERVICE_URL'] ?? 'http://localhost:5000'`
    - Default matches Dockerfile.ml EXPOSE 5000 and CMD default port
    - _Bug_Condition: isBugCondition(input) where input.processEnv['ML_SERVICE_URL'] === undefined_
    - _Expected_Behavior: loadEnvConfig() returns ML_SERVICE_URL: 'http://localhost:5000' when env var is unset_
    - _Preservation: All existing EnvConfig fields unchanged, ML integration behavior identical when URL is explicitly set_
    - _Requirements: 2.1_

  - [x] 3.2 Update batch-entry.ts to use typed env config
    - Replace `const mlServiceUrl = process.env['ML_SERVICE_URL']` with `const mlServiceUrl = env.ML_SERVICE_URL`
    - Import `env` is already present at line 22 of batch-entry.ts
    - Keep the `if (mlServiceUrl)` guard for safety (empty string edge case)
    - When `mlServiceUrl` is falsy (empty string), set `failure_reason: 'ml_service_url_not_configured'` instead of `null`
    - _Bug_Condition: batch-entry.ts reads undefined process.env['ML_SERVICE_URL'] and skips ML stage_
    - _Expected_Behavior: batch-entry.ts uses env.ML_SERVICE_URL which always has a default value_
    - _Preservation: When URL is defined and ML service is reachable, ensemble blending and calibration logic produces identical results_
    - _Requirements: 2.1, 2.2_

  - [x] 3.3 Document ML_SERVICE_URL in .env.example
    - Add a `# --- ML Service ---` section to `.env.example`
    - Include comment explaining default value and purpose
    - Include comment showing how to run locally: `docker build -f Dockerfile.ml -t fip-ml . && docker run -p 5000:5000 fip-ml`
    - Add `ML_SERVICE_URL=http://localhost:5000`
    - _Bug_Condition: .env.example omits ML_SERVICE_URL, leaving developers without guidance_
    - _Expected_Behavior: .env.example documents ML_SERVICE_URL with default and usage instructions_
    - _Requirements: 2.2_

  - [x] 3.4 Improve dashboard error messaging in index.html
    - In `dashboard/index.html` `renderContinuousLearningCard` function, differentiate failure reasons:
    - When `failure_reason === null` or `'ml_service_url_not_configured'` → show "ML service URL not configured — set ML_SERVICE_URL in .env"
    - When `failure_reason === 'ml_service_unavailable'` → show "ML service not running — start with: docker run -p 5000:5000 fip-ml"
    - When `failure_reason` contains `'calibration_failed'` → show "Calibration model not yet trained"
    - When ML was called but `calibrated: false` → show "Calibration pending — model not yet trained (informational)"
    - _Bug_Condition: dashboard shows non-actionable "Calibration skipped" or raw failure_reason strings_
    - _Expected_Behavior: dashboard shows differentiated, actionable messages based on failure_reason_
    - _Requirements: 2.3, 2.4_

  - [x] 3.5 Improve dashboard error messaging in continuous-learning-card.ts
    - Mirror the same differentiated error messaging logic from 3.4 in `dashboard/continuous-learning-card.ts`
    - Ensure the exported `renderContinuousLearningCard` function uses the same actionable messages
    - Keep both implementations consistent for testability
    - _Bug_Condition: continuous-learning-card.ts shows non-actionable error messages_
    - _Expected_Behavior: continuous-learning-card.ts shows differentiated, actionable messages matching index.html_
    - _Requirements: 2.3, 2.4_

  - [x] 3.6 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - ML Service URL Undefined Skips Calibration
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed: env config now provides default ML_SERVICE_URL, dashboard now shows actionable messages)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.7 Verify preservation tests still pass
    - **Property 2: Preservation** - Existing EnvConfig Fields and ML Integration Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions: all existing EnvConfig fields unchanged, dashboard rendering for calibration_applied: true unchanged)
    - Confirm all tests still pass after fix (no regressions)

- [ ] 4. Checkpoint - Ensure all tests pass
  - Run full test suite to verify no regressions across the codebase
  - Verify exploration test (Property 1) passes after fix
  - Verify preservation tests (Property 2) pass after fix
  - Verify existing dashboard tests still pass
  - Ensure all tests pass, ask the user if questions arise

## Notes

- The exploration test (Property 1) is expected to FAIL on unfixed code - this confirms the bug exists
- The preservation test (Property 2) is expected to PASS on unfixed code - this confirms baseline behavior
- After the fix, both Property 1 and Property 2 should PASS
- The default URL `http://localhost:5000` matches the ML service Dockerfile.ml EXPOSE and CMD settings
- Dashboard error messaging improvements affect both `dashboard/index.html` (inline) and `dashboard/continuous-learning-card.ts` (module)
