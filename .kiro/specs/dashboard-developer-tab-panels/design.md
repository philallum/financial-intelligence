# Dashboard Developer Tab Panels Bugfix Design

## Overview

After adding multi-asset support (GBP/USD alongside EUR/USD), several Developer tab panels display empty "No data" states because queries filter on a non-existent `asset` column in tables that lack one (`batch_runs`, `execution_traces`, `research_similarity_archive`, `drift_alerts`). Supabase returns errors for these invalid filters, which are silently caught and treated as empty results. Additionally, the Sentiment Engine Output panel filters out articles with `sentiment_hint=0`, excluding most data. Finally, the Forecast API auth middleware only permits anonymous access to `/v1/forecast/eurusd`, blocking GBP/USD forecasts from the dashboard.

The fix removes the invalid `asset` column filter from queries against tables that don't have that column, removes the overly restrictive `sentiment_hint=neq.0` filter, and broadens the anonymous access check in `auth.ts` to cover all active assets.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — Developer tab queries include `asset=eq.{symbol}` on tables without an `asset` column, or the sentiment query excludes zero-sentiment articles, or the auth middleware rejects non-EURUSD anonymous forecast requests
- **Property (P)**: The desired behavior — panels display actual data from Supabase (or proper empty states only when data genuinely doesn't exist), and the Forecast API serves all active assets anonymously
- **Preservation**: Existing query behavior on tables that DO have an `asset` column (`batch_diagnostics`, `raw_candles`, `research_forecasts`) must remain unchanged; currency-based filtering for `news_articles` and `economic_events` must remain unchanged; API key-based tier enforcement must remain unchanged
- **loadDeveloperView**: The function in `dashboard/index.html` that fetches and renders all Developer tab panels
- **supabaseQuery**: Helper function that constructs Supabase REST API queries with PostgREST filter syntax
- **isAnonymousEligible**: Function in `src/api/middleware/auth.ts` that determines which requests can proceed without an API key
- **buildBatchRunsParams / buildExecutionTracesParams / buildSimilarityArchiveParams / buildDriftAlertsParams**: Query builder functions in `dashboard/query-parameterization.ts` that produce the filter strings

## Bug Details

### Bug Condition

The bug manifests when the Developer tab loads and the `loadDeveloperView` function queries Supabase tables that do not have an `asset` column using an `asset=eq.{symbol}` filter. Supabase's PostgREST layer returns an error (column not found), which the `.catch(() => [])` handler converts to an empty array, causing "No data" empty states across multiple panels. A secondary bug occurs when the sentiment query uses `sentiment_hint=neq.0` and excludes most articles. A third bug occurs when the Forecast API rejects anonymous requests for any asset other than EURUSD.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { table: string, filterParams: string, asset: AssetConfig }
  OUTPUT: boolean

  // Bug condition 1: Invalid asset column filter on tables without that column
  CONDITION_1 := input.table IN ['batch_runs', 'execution_traces', 'research_similarity_archive', 'drift_alerts']
                 AND input.filterParams CONTAINS 'asset=eq.'

  // Bug condition 2: Sentiment filter excludes zero-sentiment articles
  CONDITION_2 := input.table == 'news_articles'
                 AND input.filterParams CONTAINS 'sentiment_hint=neq.0'

  // Bug condition 3: Anonymous access rejected for non-EURUSD assets
  CONDITION_3 := input.table == 'forecast_api'
                 AND input.asset.symbol != 'EURUSD'
                 AND requestHasNoApiKey()

  RETURN CONDITION_1 OR CONDITION_2 OR CONDITION_3
END FUNCTION
```

### Examples

- **batch_runs with EURUSD**: Query `batch_runs?select=*&asset=eq.EURUSD` → Supabase error (no `asset` column) → caught as `[]` → panel shows "No batch runs available for EURUSD" even though batch_runs records exist
- **execution_traces with GBPUSD**: Query `execution_traces?select=...&asset=eq.GBPUSD` → Supabase error → caught as `[]` → panel shows "No execution traces available for GBPUSD"
- **research_similarity_archive**: Query with `asset=eq.EURUSD` → error → empty → "No matches"
- **news_articles sentiment**: Query with `sentiment_hint=neq.0` → returns 0 articles (most have sentiment_hint=0) → "No data" in Sentiment Engine Output
- **Forecast API for GBPUSD**: `GET /v1/forecast/GBPUSD` without API key → `isAnonymousEligible` returns false → 401 response → "Could not load forecast for GBPUSD"
- **Edge case - batch_diagnostics (NOT buggy)**: Query `batch_diagnostics?asset=eq.EURUSD` → works correctly because this table HAS an `asset` column

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Queries to `batch_diagnostics` MUST continue to filter by `asset=eq.{symbol}` (this table has a valid `asset` column)
- Queries to `raw_candles` and `research_forecasts` MUST continue to filter by `asset=eq.{symbol}` (these tables have valid `asset` columns)
- Queries to `economic_events` MUST continue to use `or=(currency.eq.{base},currency.eq.{quote})` filtering
- Queries to `news_articles` MUST continue to use `or=(currency.eq.{base},currency.eq.{quote})` for currency filtering
- The Trader tab MUST continue to display all panels correctly for EURUSD
- Asset switching MUST continue to update header, title, and selector
- API key-based authentication and tier enforcement MUST remain unchanged
- Empty-state messages MUST still display when data genuinely doesn't exist (but with correct asset context)

**Scope:**
All queries and behaviors NOT involving the four affected tables' asset filter, the sentiment exclusion filter, or anonymous API access routing should be completely unaffected by this fix. This includes:
- All Trader tab queries and rendering
- Currency-based filtering (news_articles, economic_events)
- Asset-scoped queries on tables that have `asset` columns (batch_diagnostics, raw_candles, research_forecasts)
- Authenticated API key access to the Forecast API

## Hypothesized Root Cause

Based on the bug description and code analysis, the root causes are:

1. **Invalid column assumption in query-parameterization.ts**: The `buildBatchRunsParams`, `buildExecutionTracesParams`, `buildSimilarityArchiveParams`, and `buildDriftAlertsParams` functions all produce `asset=eq.{symbol}` filters. However, the Supabase tables `batch_runs`, `execution_traces`, `research_similarity_archive`, and `drift_alerts` do not have an `asset` column in their schema. These functions were likely written assuming all tables would follow the same pattern as `batch_diagnostics`.

2. **Overly restrictive sentiment filter**: In `loadDeveloperView` (and `loadTraderView`), the `news_articles` query includes `sentiment_hint=neq.0`. Since most articles have `sentiment_hint` exactly equal to 0, this filter excludes nearly all data, leaving the Sentiment Engine Output panel empty.

3. **Hardcoded anonymous path in auth middleware**: The `isAnonymousEligible` function in `src/api/middleware/auth.ts` checks `path === '/v1/forecast/eurusd'` (exact string match, lowercased). When the dashboard requests `/v1/forecast/GBPUSD`, the lowercased path `/v1/forecast/gbpusd` doesn't match, so the request is rejected with 401.

4. **Silent error swallowing**: The `.catch(() => [])` pattern in `loadDeveloperView` converts genuine query errors (column not found) into empty arrays, making the bug appear as "no data" rather than surfacing the underlying error.

## Correctness Properties

Property 1: Bug Condition - Developer Tab Queries Return Data

_For any_ query against a table that does NOT have an `asset` column (`batch_runs`, `execution_traces`, `research_similarity_archive`, `drift_alerts`), the fixed query builder functions SHALL produce filter parameters that do not include `asset=eq.{symbol}`, allowing Supabase to return actual records when they exist, and the corresponding Developer tab panels SHALL display the returned data.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Bug Condition - Sentiment Articles Not Excluded

_For any_ query to `news_articles` for the Developer tab's Sentiment Engine Output panel, the fixed query SHALL NOT include the `sentiment_hint=neq.0` filter, allowing articles with zero sentiment values to be returned and displayed.

**Validates: Requirements 2.5**

Property 3: Bug Condition - Anonymous Forecast Access for All Assets

_For any_ GET request to `/v1/forecast/{asset}` where `{asset}` is a registered active asset symbol (EURUSD or GBPUSD), the fixed `isAnonymousEligible` function SHALL return true when the request has no API key, allowing the dashboard to load forecast data for all supported assets.

**Validates: Requirements 2.6**

Property 4: Preservation - Valid Asset Column Queries Unchanged

_For any_ query against a table that DOES have an `asset` column (`batch_diagnostics`, `raw_candles`, `research_forecasts`), the fixed code SHALL produce the same `asset=eq.{symbol}` filter parameters as the original code, preserving asset-scoped data isolation.

**Validates: Requirements 3.1, 3.4**

Property 5: Preservation - Currency Filtering Unchanged

_For any_ query against `economic_events` or `news_articles` that uses currency-based filtering, the fixed code SHALL produce the same `or=(currency.eq.{base},currency.eq.{quote})` filter parameters as the original code, preserving currency-scoped filtering.

**Validates: Requirements 3.2, 3.3**

Property 6: Preservation - API Key Authentication Unchanged

_For any_ request that includes a valid API key, the fixed auth middleware SHALL continue to enforce tier-based access controls identically to the original code, and SHALL NOT modify behavior for authenticated requests.

**Validates: Requirements 3.7**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `dashboard/query-parameterization.ts`

**Functions**: `buildBatchRunsParams`, `buildExecutionTracesParams`, `buildSimilarityArchiveParams`, `buildDriftAlertsParams`

**Specific Changes**:
1. **Remove `asset` filter from batch_runs**: Change `buildBatchRunsParams` to return an empty string (no asset filter) since the `batch_runs` table doesn't have an `asset` column. The table likely uses `batch_id` which can be correlated to an asset through other means, or the data is not asset-specific.

2. **Remove `asset` filter from execution_traces**: Change `buildExecutionTracesParams` to return an empty string since `execution_traces` doesn't have an `asset` column. Traces are linked via `batch_id`.

3. **Remove `asset` filter from research_similarity_archive**: Change `buildSimilarityArchiveParams` to return an empty string since this table doesn't have an `asset` column.

4. **Remove `asset` filter from drift_alerts**: Change `buildDriftAlertsParams` to return an empty string since this table doesn't have an `asset` column.

**File**: `dashboard/index.html`

**Function**: `loadDeveloperView`

**Specific Changes**:
5. **Update Supabase queries for affected tables**: Remove the `asset=eq.${selectedAsset.symbol}` filter from queries to `batch_runs`, `execution_traces`, `research_similarity_archive`, and `drift_alerts` (or adjust the query builder usage).

6. **Remove sentiment exclusion filter**: In both `loadDeveloperView` and `loadTraderView`, remove `sentiment_hint=neq.0` from the `news_articles` query for the developer sentiment panel. (The Trader view may also benefit but is a separate consideration per requirements.)

**File**: `src/api/middleware/auth.ts`

**Function**: `isAnonymousEligible`

**Specific Changes**:
7. **Broaden anonymous access path check**: Change the path comparison from exact match `path === '/v1/forecast/eurusd'` to a pattern match that accepts any active asset. For example: `path.match(/^\/v1\/forecast\/[a-z]{6}$/)` or check against a list of registered asset symbols.

**File**: `dashboard/index.html` (Continuous Learning Card)

**Specific Changes**:
8. **Update drift_alerts query in renderContinuousLearningCard**: The internal `drift_alerts` query also uses `asset=eq.${selectedAsset.symbol}` and needs the same fix.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that call the query builder functions and verify the filter strings they produce. Run these tests on the UNFIXED code to observe that they produce `asset=eq.{symbol}` filters for tables that don't support it. For the auth middleware, write tests that send GET requests to `/v1/forecast/gbpusd` without API keys and observe 401 rejections.

**Test Cases**:
1. **batch_runs query test**: Call `buildBatchRunsParams(GBPUSD)` and verify it produces `asset=eq.GBPUSD` (will fail on fixed code because fixed code shouldn't include asset filter)
2. **execution_traces query test**: Call `buildExecutionTracesParams(EURUSD)` and verify it incorrectly includes `asset=eq.EURUSD` (will fail on fixed code)
3. **similarity_archive query test**: Call `buildSimilarityArchiveParams(GBPUSD)` and verify it includes the invalid filter (will fail on fixed code)
4. **drift_alerts query test**: Call `buildDriftAlertsParams(EURUSD)` and verify it includes the invalid filter (will fail on fixed code)
5. **Auth anonymous test**: Call `isAnonymousEligible` with path `/v1/forecast/gbpusd` and verify it returns false (will fail on fixed code)

**Expected Counterexamples**:
- All four query builders produce `asset=eq.{symbol}` which is invalid for these tables
- `isAnonymousEligible` returns false for any path other than `/v1/forecast/eurusd`
- The `sentiment_hint=neq.0` filter in the HTML excludes articles, producing empty panels

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL asset IN ACTIVE_ASSETS DO
  // Tables without asset column should not produce asset filter
  ASSERT buildBatchRunsParams_fixed(asset) DOES NOT CONTAIN 'asset=eq.'
  ASSERT buildExecutionTracesParams_fixed(asset) DOES NOT CONTAIN 'asset=eq.'
  ASSERT buildSimilarityArchiveParams_fixed(asset) DOES NOT CONTAIN 'asset=eq.'
  ASSERT buildDriftAlertsParams_fixed(asset) DOES NOT CONTAIN 'asset=eq.'

  // Sentiment query should not exclude zero-sentiment articles
  ASSERT developerSentimentQuery_fixed(asset) DOES NOT CONTAIN 'sentiment_hint=neq.0'

  // Anonymous access should work for all active assets
  ASSERT isAnonymousEligible_fixed(GET, `/v1/forecast/${asset.symbol}`) == true
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL asset IN ACTIVE_ASSETS DO
  // Tables WITH asset column must still filter correctly
  ASSERT buildBatchDiagnosticsParams_fixed(asset) == buildBatchDiagnosticsParams_original(asset)
  ASSERT buildCandleParams_fixed(asset) == buildCandleParams_original(asset)
  ASSERT buildResearchForecastsParams_fixed(asset) == buildResearchForecastsParams_original(asset)

  // Currency-based filters must remain unchanged
  ASSERT buildNewsParams_fixed(asset) == buildNewsParams_original(asset)
  ASSERT buildEventsParams_fixed(asset) == buildEventsParams_original(asset)

  // Authenticated requests must still work the same
  FOR ALL authenticatedRequest DO
    ASSERT authMiddleware_fixed(authenticatedRequest) == authMiddleware_original(authenticatedRequest)
  END FOR
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (various asset configurations)
- It catches edge cases that manual unit tests might miss (unusual symbol formats, boundary conditions)
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for valid asset-column queries and currency filtering, then write property-based tests capturing that behavior.

**Test Cases**:
1. **batch_diagnostics Preservation**: Verify `buildBatchDiagnosticsParams` still returns `asset=eq.{symbol}` for any valid asset
2. **Currency Filter Preservation**: Verify `buildNewsParams` and `buildEventsParams` still return `or=(currency.eq.{base},currency.eq.{quote})` for any valid asset
3. **Forecast URL Preservation**: Verify `buildForecastUrl` still produces the correct URL pattern for any asset
4. **API Key Auth Preservation**: Verify that requests with valid API keys bypass the anonymous check entirely

### Unit Tests

- Test each query builder function returns the expected filter string (or empty string for tables without `asset` column)
- Test `isAnonymousEligible` returns true for all active asset paths and false for non-forecast paths
- Test that the `loadDeveloperView` query strings no longer contain invalid filters
- Test edge cases: unknown asset symbols, empty asset symbol, malformed paths

### Property-Based Tests

- Generate random `AssetConfig` objects and verify that query builders for tables without `asset` columns never produce `asset=eq.` filters
- Generate random `AssetConfig` objects and verify that query builders for tables WITH `asset` columns always produce the correct `asset=eq.{symbol}` filter
- Generate random valid asset symbols and verify `isAnonymousEligible` accepts `/v1/forecast/{symbol}` patterns
- Generate random non-forecast paths and verify `isAnonymousEligible` rejects them (preservation of security)

### Integration Tests

- Test full Developer tab load with mocked Supabase responses confirming all panels render data
- Test asset switching between EURUSD and GBPUSD and verify Developer tab re-queries correctly
- Test that the Forecast API returns data for both EURUSD and GBPUSD without authentication from the dashboard
