# Implementation Plan

## Overview

Fix the Developer tab panels showing "No data" empty states by removing invalid `asset` column filters from query builders targeting tables that lack an `asset` column (`batch_runs`, `execution_traces`, `research_similarity_archive`, `drift_alerts`), removing the overly restrictive `sentiment_hint=neq.0` filter from the sentiment query, and broadening the anonymous access check in `auth.ts` to cover all active assets.

## Tasks

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Invalid Asset Column Filter on Tables Without Asset Column
  - **IMPORTANT**: Write this property-based test BEFORE implementing the fix
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists in query builder functions and auth middleware
  - **Scoped PBT Approach**: Scope the property to the concrete failing cases:
    - `buildBatchRunsParams(asset)` produces `asset=eq.{symbol}` for tables without an `asset` column
    - `buildExecutionTracesParams(asset)` produces `asset=eq.{symbol}` for tables without an `asset` column
    - `buildSimilarityArchiveParams(asset)` produces `asset=eq.{symbol}` for tables without an `asset` column
    - `buildDriftAlertsParams(asset)` produces `asset=eq.{symbol}` for tables without an `asset` column
    - `isAnonymousEligible` returns false for `/v1/forecast/gbpusd` (non-EURUSD assets)
  - Write property-based test in `dashboard/__tests__/developer-tab-panels-bugcondition.property.test.ts` using fast-check
  - Use `assetConfigArb` generator (arbitrary `{ symbol, displayName, baseCurrency, quoteCurrency }`)
  - Assert: for any asset, `buildBatchRunsParams(asset)` does NOT contain `asset=eq.` (from Bug Condition in design: `isBugCondition` CONDITION_1)
  - Assert: for any asset, `buildExecutionTracesParams(asset)` does NOT contain `asset=eq.` (from Bug Condition in design: `isBugCondition` CONDITION_1)
  - Assert: for any asset, `buildSimilarityArchiveParams(asset)` does NOT contain `asset=eq.` (from Bug Condition in design: `isBugCondition` CONDITION_1)
  - Assert: for any asset, `buildDriftAlertsParams(asset)` does NOT contain `asset=eq.` (from Bug Condition in design: `isBugCondition` CONDITION_1)
  - Assert: for any active asset symbol, `isAnonymousEligible(mockReq('GET', `/v1/forecast/${symbol.toLowerCase()}`))` returns true (from Bug Condition in design: `isBugCondition` CONDITION_3)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found (e.g., `buildBatchRunsParams({symbol:'GBPUSD',...})` returns `asset=eq.GBPUSD` instead of empty string; `isAnonymousEligible` returns false for `/v1/forecast/gbpusd`)
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Valid Asset Column Queries and Currency Filtering Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe behavior on UNFIXED code for non-buggy inputs (tables WITH `asset` column and currency-based filters):
  - Observe: `buildBatchDiagnosticsParams(EURUSD)` returns `asset=eq.EURUSD` on unfixed code
  - Observe: `buildBatchDiagnosticsParams(GBPUSD)` returns `asset=eq.GBPUSD` on unfixed code
  - Observe: `buildCandleParams(EURUSD)` returns `asset=eq.EURUSD` on unfixed code
  - Observe: `buildResearchForecastsParams(EURUSD)` returns `asset=eq.EURUSD` on unfixed code
  - Observe: `buildNewsParams(EURUSD)` returns `or=(currency.eq.EUR,currency.eq.USD)` on unfixed code
  - Observe: `buildEventsParams(EURUSD)` returns `or=(currency.eq.EUR,currency.eq.USD)` on unfixed code
  - Observe: `isAnonymousEligible(mockReq('GET', '/v1/forecast/eurusd'))` returns true on unfixed code
  - Observe: `isAnonymousEligible(mockReq('POST', '/v1/forecast/eurusd'))` returns false on unfixed code
  - Write property-based test in `dashboard/__tests__/developer-tab-panels-preservation.property.test.ts` using fast-check
  - Property: for any arbitrary `AssetConfig`, `buildBatchDiagnosticsParams(asset)` equals `asset=eq.${asset.symbol}` (Preservation Requirement 3.1)
  - Property: for any arbitrary `AssetConfig`, `buildCandleParams(asset)` equals `asset=eq.${asset.symbol}` (Preservation Requirement 3.4)
  - Property: for any arbitrary `AssetConfig`, `buildResearchForecastsParams(asset)` equals `asset=eq.${asset.symbol}` (Preservation Requirement 3.4)
  - Property: for any arbitrary `AssetConfig`, `buildNewsParams(asset)` equals `or=(currency.eq.${asset.baseCurrency},currency.eq.${asset.quoteCurrency})` (Preservation Requirement 3.3)
  - Property: for any arbitrary `AssetConfig`, `buildEventsParams(asset)` equals `or=(currency.eq.${asset.baseCurrency},currency.eq.${asset.quoteCurrency})` (Preservation Requirement 3.2)
  - Property: for any non-GET request method, `isAnonymousEligible` returns false (Preservation Requirement 3.7)
  - Property: for any request with a valid API key, auth behavior is unchanged (Preservation Requirement 3.7)
  - Verify tests PASS on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.7_

- [x] 3. Fix for Developer Tab Panels Empty State Bug

  - [x] 3.1 Remove invalid `asset` filter from query builders for tables without `asset` column
    - In `dashboard/query-parameterization.ts`, modify `buildBatchRunsParams` to return empty string `''` instead of `asset=eq.${asset.symbol}`
    - In `dashboard/query-parameterization.ts`, modify `buildExecutionTracesParams` to return empty string `''` instead of `asset=eq.${asset.symbol}`
    - In `dashboard/query-parameterization.ts`, modify `buildSimilarityArchiveParams` to return empty string `''` instead of `asset=eq.${asset.symbol}`
    - In `dashboard/query-parameterization.ts`, modify `buildDriftAlertsParams` to return empty string `''` instead of `asset=eq.${asset.symbol}`
    - _Bug_Condition: isBugCondition(input) where input.table IN ['batch_runs', 'execution_traces', 'research_similarity_archive', 'drift_alerts'] AND input.filterParams CONTAINS 'asset=eq.'_
    - _Expected_Behavior: Fixed query builders return empty string (no asset filter) for tables without asset column_
    - _Preservation: buildBatchDiagnosticsParams, buildCandleParams, buildResearchForecastsParams must continue to return asset=eq.{symbol}_
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.2 Remove `sentiment_hint=neq.0` filter from developer sentiment query
    - In `dashboard/index.html`, locate the `loadDeveloperView` function's news_articles query for Sentiment Engine Output
    - Remove `sentiment_hint=neq.0` from the query parameters so that articles with zero sentiment values are included
    - _Bug_Condition: isBugCondition(input) where input.table == 'news_articles' AND input.filterParams CONTAINS 'sentiment_hint=neq.0'_
    - _Expected_Behavior: Sentiment query returns all articles regardless of sentiment_hint value_
    - _Preservation: Currency-based filtering (or=(currency.eq.{base},currency.eq.{quote})) on news_articles must remain unchanged_
    - _Requirements: 2.5_

  - [x] 3.3 Broaden anonymous access in auth middleware to all active assets
    - In `src/api/middleware/auth.ts`, modify `isAnonymousEligible` function
    - Change from exact match `path === '/v1/forecast/eurusd'` to pattern match that accepts any active asset path (e.g., `path.match(/^\/v1\/forecast\/[a-z]{6}$/)` or check against ACTIVE_ASSETS registry)
    - _Bug_Condition: isBugCondition(input) where input.table == 'forecast_api' AND input.asset.symbol != 'EURUSD' AND requestHasNoApiKey()_
    - _Expected_Behavior: isAnonymousEligible returns true for GET /v1/forecast/{any_active_asset}_
    - _Preservation: Non-GET requests must still be rejected; API key-based auth must remain unchanged_
    - _Requirements: 2.6_

  - [x] 3.4 Update dashboard queries to use fixed query builders
    - In `dashboard/index.html`, update `loadDeveloperView` to handle empty filter strings from the fixed query builders (avoid appending `&` with empty params)
    - In `dashboard/index.html`, update `renderContinuousLearningCard` drift_alerts query to use the fixed `buildDriftAlertsParams`
    - Ensure Supabase queries for batch_runs, execution_traces, research_similarity_archive, and drift_alerts no longer include invalid `asset=eq.` filters
    - _Bug_Condition: Dashboard queries append asset filter from query builders to Supabase URLs_
    - _Expected_Behavior: Queries to tables without asset column omit the filter; Supabase returns actual data_
    - _Preservation: Queries to tables WITH asset column (batch_diagnostics, raw_candles, research_forecasts) must still include the filter_
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.5 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Invalid Asset Column Filter Removed
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior (query builders return empty string for tables without asset column, isAnonymousEligible returns true for all active assets)
    - Run bug condition exploration test from step 1: `npx vitest --run dashboard/__tests__/developer-tab-panels-bugcondition.property.test.ts`
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

  - [x] 3.6 Verify preservation tests still pass
    - **Property 2: Preservation** - Valid Asset Column Queries and Currency Filtering Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2: `npx vitest --run dashboard/__tests__/developer-tab-panels-preservation.property.test.ts`
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all preservation properties still hold after fix (batch_diagnostics, raw_candles, research_forecasts, news currency filter, events currency filter, auth key enforcement)

- [x] 4. Checkpoint - Ensure all tests pass
  - Run full test suite: `npx vitest --run`
  - Ensure all existing tests pass (including `developer-view.test.ts` - NOTE: this test file asserts the OLD buggy behavior and will need updating to match the fix)
  - Update `dashboard/__tests__/developer-view.test.ts` to expect the fixed behavior (empty strings for tables without asset column) instead of `asset=eq.{symbol}`
  - Ensure all property-based tests pass
  - Ensure no regressions in other dashboard tests (query-parameterization, continuous-learning-card, etc.)
  - Ask the user if questions arise


## Task Dependency Graph

```json
{
  "waves": [
    ["1", "2"],
    ["3.1", "3.2", "3.3", "3.4"],
    ["3.5", "3.6"],
    ["4"]
  ]
}
```

## Notes

- Tasks 1 and 2 are independent and can be executed in parallel (both run BEFORE the fix)
- Task 3 (implementation) depends on understanding gained from tasks 1 and 2
- The existing `developer-view.test.ts` asserts the OLD buggy behavior (`asset=eq.{symbol}` for all tables) and must be updated in the checkpoint phase
- The existing `query-parameterization.property.test.ts` also asserts buggy behavior for the affected builders and will need updating
- Property-based tests use `fast-check` library (already a project dependency)
- Test runner is `vitest` (run with `npx vitest --run` for single execution)
