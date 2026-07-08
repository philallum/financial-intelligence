# Implementation Plan: Research Asset Registry

## Overview

Implement a centralised TypeScript configuration registry (`src/config/research-assets.ts`) that serves as the single source of truth for all tradeable research assets. Refactor the batch pipeline, API routes, and OpenAPI generator to derive their asset configuration from this registry instead of hardcoded arrays.

## Tasks

- [ ] 1. Create registry module with types, validation, and seed entry
  - [ ] 1.1 Create `src/config/research-assets.ts` with types and enums
    - Define `AssetClass` enum (FOREX, INDICES, CRYPTO, COMMODITIES, BONDS)
    - Define `AssetStatus` enum (ACTIVE, BETA, DISABLED, DEPRECATED)
    - Define `ProviderMap` interface (required `twelveData`, optional `massive`, `yahoo`)
    - Define `EngineParticipationMap` interface (6 boolean flags: fingerprint, similarity, confidence, tradeability, sentiment, macro)
    - Define `ResearchAsset` interface with all required readonly properties
    - Export all types and enums
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 4.1, 4.5_

  - [ ] 1.2 Add the RESEARCH_ASSETS array with EURUSD seed entry and validation
    - Add `RESEARCH_ASSETS` as a `readonly ResearchAsset[]` array
    - Include the EURUSD seed entry with exact values from the design (id: "eurusd", symbol: "EURUSD", assetClass: FOREX, status: ACTIVE, processingPriority: 1, pipSize: 0.0001, pricePrecision: 5, marketHours: "24x5", supportedTimeframes: ["4H"], providers: { twelveData: "EUR/USD" }, engines: { fingerprint: true, similarity: true, confidence: true, tradeability: true, sentiment: false, macro: true })
    - Implement `assertNoDuplicates()` function that checks for duplicate ids, duplicate symbols, and empty supportedTimeframes — throws descriptive errors
    - Call `assertNoDuplicates(RESEARCH_ASSETS)` at module initialization
    - _Requirements: 1.3, 1.8, 1.9, 1.10, 3.4_

- [ ] 2. Implement query utilities
  - [ ] 2.1 Implement `getProcessableAssets()` and `getActiveSymbols()`
    - `getProcessableAssets()` filters ACTIVE + BETA, sorts by processingPriority ascending
    - `getActiveSymbols()` filters ACTIVE only, sorts by processingPriority ascending, returns symbol strings
    - Export both functions
    - _Requirements: 5.1, 5.2, 6.1_

  - [ ] 2.2 Implement `getAssetById()` and `getAssetBySymbol()`
    - `getAssetById(id)` performs case-insensitive lookup across all statuses, returns `ResearchAsset | undefined`
    - `getAssetBySymbol(symbol)` performs case-insensitive lookup across all statuses, returns `ResearchAsset | undefined`
    - Export both functions
    - _Requirements: 5.3, 7.1_

  - [ ] 2.3 Implement `getOpenApiAssetEnum()` and `getAssetsByClass()`
    - `getOpenApiAssetEnum()` returns ACTIVE symbols in alphabetical order
    - `getAssetsByClass(assetClass)` returns processable assets of a given class sorted by priority
    - Export both functions
    - _Requirements: 5.4, 5.5, 8.1_

- [ ] 3. Property-based tests for registry module
  - [ ]* 3.1 Write property test for Registry Schema Invariant
    - **Property 1: Registry Schema Invariant**
    - Create `src/config/__tests__/research-assets.property.test.ts`
    - Build `arbResearchAsset()` generator producing valid ResearchAsset objects with randomised schema-conforming fields
    - Assert all field constraints hold for any generated asset (id format, symbol format, pipSize range, pricePrecision range, processingPriority ≥ 1, non-empty supportedTimeframes, twelveData 3–15 chars, all 6 engine flags are boolean)
    - Use `{ numRuns: 100 }` configuration
    - **Validates: Requirements 1.2, 2.1, 3.1, 4.1, 4.5, 11.3, 12.1**

  - [ ]* 3.2 Write property test for Registry Uniqueness Invariant
    - **Property 2: Registry Uniqueness Invariant**
    - Build `arbRegistry()` generator that produces arrays of unique ResearchAsset objects
    - Assert `assertNoDuplicates()` succeeds for any valid registry (no duplicate ids or symbols)
    - Assert `assertNoDuplicates()` throws for any registry with injected duplicate id or symbol
    - Use `{ numRuns: 100 }` configuration
    - **Validates: Requirements 1.8, 1.9**

  - [ ]* 3.3 Write property test for Processable Assets Filter and Sort
    - **Property 3: Processable Assets Filter and Sort**
    - For any generated registry, `getProcessableAssets()` returns only ACTIVE/BETA assets, never DISABLED/DEPRECATED
    - Assert result is sorted by processingPriority ascending
    - Use `{ numRuns: 100 }` configuration
    - **Validates: Requirements 5.1, 6.4, 10.1, 10.4, 11.1**

  - [ ]* 3.4 Write property test for Active Symbols Filter
    - **Property 4: Active Symbols Filter**
    - For any generated registry, `getActiveSymbols()` returns only ACTIVE symbols (excluding BETA)
    - Assert result is sorted by processingPriority ascending and is a subset of all registry symbols
    - Use `{ numRuns: 100 }` configuration
    - **Validates: Requirements 5.2, 10.5**

  - [ ]* 3.5 Write property test for Case-Insensitive Lookup
    - **Property 5: Case-Insensitive Lookup**
    - For any asset in a generated registry and any case variation of its id/symbol, the lookup functions return that asset
    - Use `{ numRuns: 100 }` configuration
    - **Validates: Requirements 5.3, 7.1**

  - [ ]* 3.6 Write property test for OpenAPI Enum Generation
    - **Property 6: OpenAPI Enum Generation**
    - For any registry with at least one ACTIVE asset, `getOpenApiAssetEnum()` returns only ACTIVE symbols in strict alphabetical order
    - Assert BETA/DISABLED/DEPRECATED symbols are excluded
    - Use `{ numRuns: 100 }` configuration
    - **Validates: Requirements 5.4, 8.2, 8.3, 10.3**

  - [ ]* 3.7 Write property test for Class-Based Filtering
    - **Property 7: Class-Based Filtering**
    - For any AssetClass value, `getAssetsByClass(cls)` returns only processable assets matching that class, sorted by priority
    - Use `{ numRuns: 100 }` configuration
    - **Validates: Requirements 5.5**

  - [ ]* 3.8 Write property test for Price Precision Formatting
    - **Property 8: Price Precision Formatting**
    - For any ResearchAsset and any numeric price, `price.toFixed(asset.pricePrecision)` produces a string with exactly `pricePrecision` decimal places
    - Use `{ numRuns: 100 }` configuration
    - **Validates: Requirements 7.4**

- [ ] 4. Checkpoint - Ensure registry module and property tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Batch pipeline integration
  - [ ] 5.1 Refactor `src/batch-entry.ts` to use registry
    - Remove the hardcoded `BATCH_ASSETS` array
    - Import `getProcessableAssets` from `./config/research-assets.js`
    - Replace `BATCH_ASSETS` loop with `getProcessableAssets()` result
    - Iterate over each asset's `supportedTimeframes` array
    - Pass `asset.providers.twelveData` as the provider symbol to the orchestrator
    - Pass `asset.engines` (EngineParticipationMap) to the orchestrator execute call
    - Handle zero processable assets: log warning, exit code 0
    - Handle individual asset failures: log, continue, exit code 1 at end
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.1, 11.1, 11.4_

  - [ ] 5.2 Update `BatchOrchestrator` to accept and use `engineParticipation`
    - Extend the orchestrator execute input type to include `providerSymbol` and `engineParticipation` (EngineParticipationMap)
    - Add conditional engine execution based on `engineParticipation` flags
    - Implement engine dependency chain short-circuiting: if `similarity` is false, skip `outcome`, `forecast`, `confidence`, `tradeability`
    - Ensure no conditional logic based on AssetClass — only engine map drives routing
    - _Requirements: 4.2, 4.3, 4.4, 2.2_

  - [ ]* 5.3 Write unit tests for batch pipeline registry integration
    - Test that `getProcessableAssets()` is called and results drive the loop
    - Test engine participation skipping behaviour
    - Test zero-asset graceful exit
    - Test failure-continuation behaviour
    - _Requirements: 6.1, 6.6, 6.7, 4.2, 4.3_

- [ ] 6. API route integration
  - [ ] 6.1 Refactor `src/api/routes/forecast.ts` to use registry
    - Remove the hardcoded `SUPPORTED_ASSETS` array
    - Import `getActiveSymbols` and `getAssetBySymbol` from `../../config/research-assets.js`
    - Replace `SUPPORTED_ASSETS.includes()` check with `getActiveSymbols().includes()`
    - Use `getAssetBySymbol(upperAsset)!.pricePrecision` for price formatting in responses
    - Include list of active symbols in error response for unsupported assets
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 9.2, 10.2, 10.5_

  - [ ] 6.2 Refactor `src/api/routes/similarity.ts` to use registry
    - Remove any hardcoded asset validation
    - Import `getActiveSymbols` from registry
    - Validate asset parameter against active symbols from registry
    - Return HTTP 400 with `asset_not_supported` and active symbol list for invalid assets
    - _Requirements: 7.1, 7.2, 7.3, 9.4_

  - [ ] 6.3 Refactor `src/api/routes/state.ts` to use registry
    - Remove any hardcoded asset validation
    - Import `getActiveSymbols` from registry
    - Validate asset parameter against active symbols from registry
    - Return HTTP 400 with `asset_not_supported` and active symbol list for invalid assets
    - _Requirements: 7.1, 7.2, 7.3, 9.4_

  - [ ]* 6.4 Write unit tests for API route registry integration
    - Test that non-ACTIVE symbols return HTTP 400 with correct error format
    - Test that BETA symbols are excluded from API validation
    - Test case-insensitive asset matching
    - Test pricePrecision is applied to price formatting
    - _Requirements: 7.1, 7.2, 7.4, 10.5_

- [ ] 7. OpenAPI generator refactor
  - [ ] 7.1 Refactor `scripts/generate-openapi.ts` to use registry
    - Import `getOpenApiAssetEnum` from `../src/config/research-assets.js`
    - After loading YAML, inject dynamic enum from `getOpenApiAssetEnum()` into `components.parameters.Asset.schema.enum`
    - Update asset parameter description to list currently ACTIVE symbols
    - Exit with code 1 and error message if zero ACTIVE assets exist
    - Write the modified spec to JSON output
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.3, 10.3_

  - [ ]* 7.2 Write unit test for OpenAPI generator registry integration
    - Test that generated spec contains dynamic enum from registry
    - Test that DISABLED/BETA/DEPRECATED assets are excluded from enum
    - Test that zero ACTIVE assets causes exit code 1
    - _Requirements: 8.2, 8.3, 8.5_

- [ ] 8. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 8 correctness properties defined in the design document
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout — all implementations use TypeScript
- The project uses Vitest + fast-check for testing

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "2.2", "2.3"] },
    { "id": 3, "tasks": ["3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8"] },
    { "id": 4, "tasks": ["5.1", "5.2", "6.1", "6.2", "6.3", "7.1"] },
    { "id": 5, "tasks": ["5.3", "6.4", "7.2"] }
  ]
}
```
