# Implementation Plan: Dashboard Multi-Asset Support

## Overview

Update the local operational dashboard (`dashboard/index.html`) to support multi-asset reporting. The implementation adds an asset selector control, introduces global asset state with persistence across tab switches, parameterizes all Supabase queries and Forecast API calls with the selected asset symbol, adds loading/error states per component, and implements request cancellation via AbortController when the operator switches assets mid-fetch.

This is a frontend-only change. The existing vanilla HTML/JS architecture is preserved — no framework introduction.

## Tasks

- [x] 1. Add asset configuration and global state management
  - [x] 1.1 Define the ACTIVE_ASSETS array and global asset state in the dashboard script
    - Add `AssetConfig` objects for EURUSD and GBPUSD with symbol, displayName, baseCurrency, quoteCurrency
    - Add `selectedAsset` variable defaulting to EURUSD (first entry)
    - Add `currentAbortController` variable initialized to null
    - Add `selectAsset(symbol)` function that updates state, calls `updateHeader()`, and calls `refreshAll()`
    - _Requirements: 1.1, 1.3, 1.4_

  - [x] 1.2 Implement the Asset Selector UI control in the config bar
    - Add a styled `<select>` element (or toggle buttons) to the `.config` bar listing all active assets
    - Wire the `onchange` event to call `selectAsset(symbol)`
    - Ensure the selector visually indicates the currently selected asset at all times
    - Style consistently with existing dark theme (background: #1a1f25, border: #2f3336, color: #e7e9ea)
    - _Requirements: 1.1, 1.7_

  - [x] 1.3 Implement header and title updater function
    - Create `updateHeader()` function that sets `.subtitle` text to `${selectedAsset.displayName} · Deterministic Financial Research · Next 4 Hours`
    - Set `document.title` to `${selectedAsset.symbol} — Financial Intelligence Platform`
    - Call `updateHeader()` on initial page load and on each asset selection
    - _Requirements: 7.1, 7.2, 7.3_

- [x] 2. Implement request cancellation and loading/error states
  - [x] 2.1 Implement AbortController-based request cancellation in refreshAll
    - Modify `refreshAll()` to abort any in-flight requests via `currentAbortController.abort()` before creating a new AbortController
    - Pass the `signal` from the new AbortController to all fetch calls in the active view loader
    - Suppress `AbortError` exceptions (do not show error UI for cancelled requests)
    - _Requirements: 2.5_

  - [x] 2.2 Add loading indicator and error display functions
    - Implement `showLoading(containerId)` that replaces container content with a styled "Loading..." message
    - Implement `showError(containerId, asset, component, error)` that shows error message identifying the asset and failed component
    - Call `showLoading` at the start of each view load, clearing any previously displayed stale content
    - _Requirements: 1.5, 1.6, 2.3, 2.4, 3.4_

  - [x] 2.3 Write property test for request cancellation on asset switch
    - **Property 4: Request cancellation on asset switch**
    - **Validates: Requirements 2.5**

  - [x] 2.4 Write property test for error messages identifying the asset
    - **Property 3: Error messages identify the asset**
    - **Validates: Requirements 1.6, 2.4, 3.4**

- [x] 3. Parameterize Trader View data fetching with selected asset
  - [x] 3.1 Update fetchForecast to use the selected asset symbol and accept AbortSignal
    - Change URL from hardcoded `/v1/forecast/EURUSD` to `/v1/forecast/${selectedAsset.symbol}`
    - Add `signal` parameter to the fetch options
    - Add 10-second timeout via `setTimeout` + abort on the signal
    - Include asset symbol in error messages
    - _Requirements: 2.1, 2.2, 2.4_

  - [x] 3.2 Update supabaseQuery to accept AbortSignal and add asset-scoped candle query
    - Add optional `signal` parameter to `supabaseQuery(table, params, signal)`
    - Update the candle query to include `asset=eq.${selectedAsset.symbol}`
    - _Requirements: 3.1, 3.2_

  - [x] 3.3 Parameterize news and events queries with derived currencies
    - Derive baseCurrency (first 3 chars) and quoteCurrency (last 3 chars) from `selectedAsset`
    - Update news query to filter by `or=(currency.eq.${base},currency.eq.${quote})`
    - Update events query to filter by `or=(currency.eq.${base},currency.eq.${quote})`
    - _Requirements: 4.1, 4.2_

  - [x] 3.4 Parameterize research_forecasts query with selected asset
    - Add `asset=eq.${selectedAsset.symbol}` filter to the research_forecasts Supabase query
    - _Requirements: 5.1_

  - [x] 3.5 Update loadTraderView to use AbortSignal and handle per-component errors
    - Pass the AbortController signal to all fetch calls within `loadTraderView`
    - Wrap individual component renders in try/catch to isolate failures
    - Show asset-specific error messages when individual components fail
    - Show empty-state messages for sparkline (< 2 candles), news (no articles), and prediction history (no forecasts)
    - _Requirements: 1.5, 1.6, 3.3, 4.4, 5.3_

  - [x] 3.6 Write property test for query parameterization with selected asset
    - **Property 1: Query parameterization with selected asset**
    - **Validates: Requirements 1.2, 2.1, 3.1, 5.1, 6.1, 6.2, 6.3, 6.4**

  - [x] 3.7 Write property test for currency derivation from forex symbol
    - **Property 5: Currency derivation from forex symbol**
    - **Validates: Requirements 4.1, 4.2**

- [~] 4. Checkpoint - Ensure trader view works for both assets
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Parameterize Developer View data fetching with selected asset
  - [x] 5.1 Update Developer View queries to filter by selected asset
    - Add `asset=eq.${selectedAsset.symbol}` to batch_runs query (limit 10)
    - Add `asset=eq.${selectedAsset.symbol}` to execution_traces query (limit 10)
    - Add `asset=eq.${selectedAsset.symbol}` to batch_diagnostics query
    - Add `asset=eq.${selectedAsset.symbol}` to drift_alerts query
    - Add `asset=eq.${selectedAsset.symbol}` to research_similarity_archive query
    - Pass AbortSignal to all queries
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 5.2 Update loadDeveloperView to handle per-component errors and empty states
    - Wrap individual component renders in try/catch
    - Show empty-state messages when no batch runs, traces, or diagnostics data exists for the asset
    - Show asset-specific error messages on failures
    - _Requirements: 6.5_

  - [x] 5.3 Write unit tests for Developer View asset-scoped queries
    - Test that batch_runs, execution_traces, batch_diagnostics, drift_alerts, and similarity_archive queries include the asset filter
    - Test empty-state messages appear when no data is returned
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 6. Wire tab switching to preserve asset state
  - [x] 6.1 Update switchTab to preserve selectedAsset and pass signal
    - Ensure `switchTab()` does not reset `selectedAsset` when toggling between Trader/Developer views
    - Ensure the Asset Selector UI reflects the current selection after tab switch
    - Call `refreshAll()` which uses the existing `selectedAsset` state
    - _Requirements: 1.4_

  - [x] 6.2 Write property test for asset selection persistence across tab switches
    - **Property 2: Asset selection persists across tab switches**
    - **Validates: Requirements 1.4**

- [x] 7. Implement computed metrics (sentiment, direction accuracy, sparkline ordering)
  - [x] 7.1 Update sentiment aggregation to compute arithmetic mean of non-zero values
    - Ensure `renderSentimentCard` computes aggregate sentiment as arithmetic mean of all non-zero `sentiment_hint` values
    - Display 0 if no non-zero values exist
    - This logic already exists but verify it operates only on the asset-filtered articles
    - _Requirements: 4.3_

  - [x] 7.2 Update direction accuracy computation to use asset-scoped forecasts
    - Ensure `renderHistoryCard` computes accuracy using only the selected asset's forecasts and candle data
    - Display evaluated forecast count alongside accuracy percentage
    - _Requirements: 5.2, 5.4_

  - [x] 7.3 Write property test for sentiment aggregation (arithmetic mean of non-zero values)
    - **Property 6: Sentiment aggregation is arithmetic mean of non-zero values**
    - **Validates: Requirements 4.3**

  - [x] 7.4 Write property test for sparkline chronological ordering
    - **Property 7: Sparkline renders candles in chronological order**
    - **Validates: Requirements 3.2**

  - [x] 7.5 Write property test for direction accuracy computation
    - **Property 8: Direction accuracy computation**
    - **Validates: Requirements 5.2**

  - [x] 7.6 Write property test for header and title reflecting selected asset
    - **Property 9: Header and title reflect the selected asset**
    - **Validates: Requirements 2.2, 7.1, 7.2**

- [x] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using fast-check (already a devDependency)
- Unit tests validate specific examples and edge cases
- The dashboard is a vanilla HTML/JS single-page app — no framework is introduced
- All Supabase tables already have an `asset` column; no backend changes needed
- The project uses Vitest as test framework and fast-check 4.8.0 for property-based testing

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "2.2"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3", "3.4", "6.1"] },
    { "id": 3, "tasks": ["3.5", "5.1"] },
    { "id": 4, "tasks": ["2.3", "2.4", "3.6", "3.7", "5.2", "7.1", "7.2"] },
    { "id": 5, "tasks": ["5.3", "6.2", "7.3", "7.4", "7.5", "7.6"] }
  ]
}
```
