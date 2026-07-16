# Implementation Plan: GBPUSD Asset Onboarding

## Overview

Onboard GBPUSD as the second currency pair on the Financial Intelligence Platform. This is primarily configuration + data + minor news ingester fixes. The batch pipeline, macro engine, bootstrap pipeline, and database schema require no changes. Implementation uses TypeScript with Vitest and fast-check for testing.

## Tasks

- [x] 1. Add GBPUSD entry to the Asset Registry
  - [x] 1.1 Add GBPUSD entry to RESEARCH_ASSETS array in `src/config/research-assets.ts`
    - Append a new entry with id `gbpusd`, symbol `GBPUSD`, assetClass `FOREX`, status `BETA`, processingPriority `2`, pipSize `0.0001`, pricePrecision `5`, marketHours `24x5`, supportedTimeframes `['4H']`, providers `{ twelveData: 'GBP/USD' }`, and all engines set to `true`
    - Verify `assertNoDuplicates` passes at module load with both EURUSD and GBPUSD present
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 1.2 Write property tests for asset registry correctness (Properties 1, 2, 3)
    - **Property 1: Asset registry uniqueness invariant**
    - Generate random arrays of ResearchAsset entries with varying ids/symbols; verify `assertNoDuplicates` passes for unique sets and throws for duplicates
    - **Property 2: Processable assets ordering**
    - Generate random asset arrays with various priorities and statuses; verify `getProcessableAssets()` returns them sorted by processingPriority ascending
    - **Property 3: BETA exclusion from active queries**
    - Generate random status values; verify BETA assets appear in `getProcessableAssets()` but NOT in `getActiveSymbols()` or `getOpenApiAssetEnum()`
    - **Validates: Requirements 1.5, 1.6, 1.7, 4.1, 7.1**

  - [x] 1.3 Write unit tests for GBPUSD registry entry
    - Test that `getAssetById('gbpusd')` returns the correct entry
    - Test that `getAssetBySymbol('GBPUSD')` returns the correct entry
    - Test that `getProcessableAssets()` returns both EURUSD and GBPUSD in priority order
    - Test that `getActiveSymbols()` excludes GBPUSD while BETA
    - Test that `getOpenApiAssetEnum()` excludes GBPUSD while BETA
    - _Requirements: 1.5, 1.6, 1.7_

- [x] 2. Update News Ingester for multi-pair support
  - [x] 2.1 Generalise `computeRelevanceScore` in `src/services/integrity/news-ingester.ts`
    - Replace the hardcoded `EUR/USD` / `EURUSD` check with a loop over `CURRENCY_PAIRS` that builds slash-form and concatenated-form for each pair and checks for inclusion in the uppercased text
    - Any direct pair reference (e.g. "GBP/USD", "GBPUSD", "EUR/USD", "EURUSD") should return 0.9
    - _Requirements: 5.2_

  - [x] 2.2 Expand NewsAPI query to include GBP/USD terms
    - Update the search query string to include `(GBP+USD)`, `(BoE+rate)`, `GBPUSD`, and add `pound` and `sterling` to the forex keyword group
    - Final query: `(EUR+USD)+OR+(GBP+USD)+OR+(ECB+rate)+OR+(Fed+rate)+OR+(BoE+rate)+OR+(EURUSD)+OR+(GBPUSD)+OR+(forex+dollar+euro+pound+sterling)`
    - _Requirements: 5.1_

  - [x] 2.3 Fix `detectAssetId` single-currency fallback
    - Change the single-currency branch to always return `"forex"` instead of attempting to map a lone currency to a pair
    - When `mentioned.length === 1`, return `"forex"` regardless of which currency it is
    - _Requirements: 5.5_

  - [x] 2.4 Write property tests for news ingester changes (Properties 4, 5)
    - **Property 4: Asset detection for dual-currency mentions**
    - Generate arbitrary text with injected "GBP" and "USD" substrings; verify `detectAssetId` returns `"gbpusd"`
    - Generate text with only one of GBP/USD; verify result is NOT `"gbpusd"`
    - **Property 5: Direct pair reference relevance scoring**
    - Generate text with "GBP/USD" or "GBPUSD" injected at random positions; verify `computeRelevanceScore` returns 0.9
    - **Validates: Requirements 5.1, 5.2, 5.5**

  - [x] 2.5 Write unit tests for news ingester changes
    - Test `computeRelevanceScore` returns 0.9 for "GBP/USD" and "GBPUSD" in various sentence positions
    - Test `computeRelevanceScore` still returns 0.9 for "EUR/USD" and "EURUSD" (regression)
    - Test `detectAssetId` returns "gbpusd" when both GBP and USD mentioned
    - Test `detectAssetId` returns "forex" (not "gbpusd") when only "GBP" mentioned
    - Test `detectAssetId` returns "forex" when only "USD" mentioned
    - _Requirements: 5.1, 5.2, 5.5_

- [x] 3. Checkpoint - Verify registry and news ingester changes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Write property tests for sentiment and macro engines
  - [x] 4.1 Write property test for confidence blending (Property 6)
    - **Property 6: Confidence blending for sparse sentiment data**
    - Generate random article counts (0, 1, 2) and computed sentiment values (0.0–1.0); verify blending formula `(computed × confidence_factor) + (0.5 × (1 − confidence_factor))` where `confidence_factor = article_count / 3`
    - Verify blended values are strictly between the computed value and 0.5
    - **Validates: Requirements 5.4**

  - [x] 4.2 Write property test for macro engine currency derivation (Property 7)
    - **Property 7: Macro engine currency derivation**
    - Generate random 6-character uppercase strings; verify `deriveCurrencies` splits into `[str.slice(0,3), str.slice(3,6)]`
    - Specifically verify "GBPUSD" → `["GBP", "USD"]` and "EURUSD" → `["EUR", "USD"]`
    - **Validates: Requirements 6.1**

  - [x] 4.3 Write property test for bootstrap idempotency (Property 8)
    - **Property 8: Bootstrap idempotency**
    - Generate random candle record sets; verify that double-insert via mock upsert layer produces 0 new inserts on second pass
    - Verify all upsert operations resolve as duplicate-ignore on re-run
    - **Validates: Requirements 8.1, 8.4**

- [x] 5. Write unit tests for API behaviour and batch pipeline integration
  - [x] 5.1 Write unit tests for API BETA/ACTIVE behaviour
    - Test `GET /v1/forecast/GBPUSD` returns HTTP 400 with error code `asset_not_supported` while BETA
    - Test `GET /v1/forecast/GBPUSD` returns HTTP 200 with forecast data when ACTIVE and forecast exists
    - Test `GET /v1/forecast/GBPUSD` returns HTTP 404 with error code `forecast_unavailable` when ACTIVE but no cached forecast
    - _Requirements: 7.1, 7.4, 7.5_

  - [x] 5.2 Write unit tests for batch pipeline multi-asset processing
    - Test that batch pipeline processes both EURUSD and GBPUSD in priority order
    - Test that failure on GBPUSD does not prevent other assets from processing
    - Test that GBPUSD uses its own pipSize (0.0001) for calculations
    - _Requirements: 4.1, 4.3, 4.4_

- [~] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Export historical data and run bootstrap pipeline
  - [x] 7.1 Export GBPUSD 4H historical data from Dukascopy
    - Export ~5 years (2020-01 to 2025-01) of GBPUSD 4H candles from Dukascopy Historical Data
    - Save as CSV to `./data/gbpusd-4h.csv` in format `DD.MM.YYYY HH:MM:SS.000,open,high,low,close,volume`
    - Verify file contains at least 5000 valid candle records
    - **Note: This is a manual operator task requiring browser access to Dukascopy**
    - _Requirements: 2.1, 2.2_

  - [x] 7.2 Run bootstrap pipeline for GBPUSD
    - Execute: `npx tsx scripts/bootstrap-asset.ts --asset GBPUSD --csv ./data/gbpusd-4h.csv`
    - Verify pipeline summary shows expected counts: ~6,500 candles, matching fingerprints, n-1 outcomes, n-30 topology vectors
    - Verify first 30 candles report topology skip (insufficient history)
    - **Note: This is an operator task requiring valid `.env` with Supabase credentials**
    - _Requirements: 2.5, 3.1, 3.2, 3.3, 3.4, 3.6_

  - [x] 7.3 Validate batch pipeline processes GBPUSD
    - Wait for next 4H batch cycle or trigger manually
    - Verify `cached_forecasts` table contains a GBPUSD entry after batch execution
    - Verify batch_runs table shows successful processing of both EURUSD and GBPUSD
    - _Requirements: 4.1, 4.2_

- [x] 8. Promote GBPUSD from BETA to ACTIVE
  - [x] 8.1 Change GBPUSD status to ACTIVE in `src/config/research-assets.ts`
    - Update `status: AssetStatus.BETA` to `status: AssetStatus.ACTIVE` in the GBPUSD entry
    - Verify `getActiveSymbols()` now includes GBPUSD
    - Verify `getOpenApiAssetEnum()` now includes GBPUSD
    - Verify `GET /v1/forecast/GBPUSD` returns 200 with forecast data
    - _Requirements: 7.3, 7.4_

- [~] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The batch pipeline, macro engine, bootstrap pipeline, and database schema require NO code changes — only the asset registry entry and news ingester are modified
- Tasks 7.1 and 7.2 are operator tasks requiring manual Dukascopy export and valid Supabase credentials
- fast-check (v4.8.0) is already in devDependencies — no additional dependency installation needed
- Property tests should be placed in `tests/property/` following existing project conventions

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "2.2", "2.3"] },
    { "id": 2, "tasks": ["2.4", "2.5"] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.3", "5.1", "5.2"] },
    { "id": 4, "tasks": ["7.1"] },
    { "id": 5, "tasks": ["7.2"] },
    { "id": 6, "tasks": ["7.3"] },
    { "id": 7, "tasks": ["8.1"] }
  ]
}
```
