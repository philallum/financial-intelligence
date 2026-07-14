# Implementation Plan: Process Observation

## Overview

Add a lightweight diagnostics collection layer to the batch pipeline. A `DiagnosticsCollector` class accumulates per-stage observations during each batch cycle, persists them to a `batch_diagnostics` table via Supabase upsert, and a new Batch Diagnostics card in the Developer View displays the results. The implementation uses TypeScript with the existing Vitest + fast-check testing stack.

## Tasks

- [x] 1. Create the database table and RLS policies
  - [x] 1.1 Create SQL migration for `batch_diagnostics` table
    - Create a migration file at `supabase/migrations/` (or inline SQL script) defining the `batch_diagnostics` table with columns: `asset` (text, PK), `batch_id` (text, NOT NULL), `updated_at` (timestamptz, NOT NULL, DEFAULT now()), `diagnostics` (jsonb, NOT NULL)
    - Enable Row Level Security on the table
    - Create policy "Allow read for all roles" (SELECT, USING true)
    - Create policy "Allow write for service role" (ALL, USING auth.role() = 'service_role', WITH CHECK auth.role() = 'service_role')
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 2. Implement the DiagnosticsCollector module
  - [x] 2.1 Create TypeScript interfaces for diagnostics payload
    - Create `src/services/observability/diagnostics-types.ts`
    - Define interfaces: `SentimentDiagnostics`, `MacroContextDiagnostics`, `MLServiceDiagnostics`, `MarketContextDiagnostics`, `SimilarityDiagnostics`, `OutcomeDiagnostics`, `ForecastDiagnostics`, `GeminiDiagnostics`, `BatchDiagnosticsPayload`, `BatchDiagnosticsRow`
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [x] 2.2 Implement the DiagnosticsCollector class
    - Create `src/services/observability/diagnostics-collector.ts`
    - Implement constructor accepting `asset`, `batchId`, and `supabase` client
    - Implement `record*()` methods for each stage (recordSentiment, recordMacroContext, recordMLService, recordMarketContext, recordSimilarity, recordOutcome, recordForecast, recordGemini)
    - Each `record*()` method wrapped in try/catch, logs to console.warn on error, never throws
    - Implement private `buildPayload()` method assembling all recorded fields
    - Implement `persist()` method performing Supabase upsert on `batch_diagnostics` with `onConflict: 'asset'`
    - `persist()` wrapped in try/catch, logs to console.error on error, never throws
    - _Requirements: 1.1, 2.1, 2.2, 2.3, 3.1, 3.2, 6.3, 6.4, 6.5_

  - [x] 2.3 Write property test: fire-and-forget guarantee (Property 2)
    - **Property 2: Fire-and-forget guarantee**
    - **Validates: Requirements 2.1, 2.2**
    - Create `tests/services/observability/diagnostics-collector.property.test.ts`
    - Use fast-check to generate arbitrary inputs (including invalid types, nulls, and error-throwing mocks)
    - Verify that no `record*()` call ever throws regardless of input
    - Verify that `persist()` never throws even when Supabase client rejects or throws

  - [x] 2.4 Write property test: diagnostics shape completeness (Property 1)
    - **Property 1: Diagnostics shape completeness**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9**
    - In the same test file, add property tests using fast-check arbitraries for each stage interface
    - Verify that after recording all stages, `buildPayload()` (tested via persist spy) produces a payload containing all 8 keys with correctly-typed values matching their respective interfaces

  - [x] 2.5 Write unit tests for DiagnosticsCollector
    - Create `tests/services/observability/diagnostics-collector.test.ts`
    - Test default state (ml_service.called=false, market_context.available=false, nulls for optional stages)
    - Test that recording a single stage only populates that field
    - Test persist calls supabase.from('batch_diagnostics').upsert() with correct shape
    - Test persist logs error on Supabase failure but does not throw
    - _Requirements: 2.1, 2.2, 6.4, 6.5_

- [x] 3. Checkpoint - Ensure collector tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Integrate DiagnosticsCollector into batch-entry.ts
  - [x] 4.1 Wire DiagnosticsCollector into the batch pipeline
    - Import `DiagnosticsCollector` in `src/batch-entry.ts`
    - Instantiate a new `DiagnosticsCollector(asset.symbol, batchId, supabase)` at the start of each asset's processing loop
    - Add `diagnostics.recordMarketContext(...)` after market context fetch
    - Add `diagnostics.recordSentiment(...)` after sentiment engine output
    - Add `diagnostics.recordMacroContext(...)` after macro context engine output
    - Add `diagnostics.recordSimilarity(...)` after similarity stage
    - Add `diagnostics.recordOutcome(...)` after outcome stage
    - Add `diagnostics.recordForecast(...)` after forecast stage
    - Add `diagnostics.recordMLService(...)` after ML service call (or with defaults if skipped)
    - Add `diagnostics.recordGemini(...)` after Gemini scoring
    - Call `diagnostics.persist().catch(() => {})` after all stages complete (fire-and-forget)
    - _Requirements: 1.1, 2.3, 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 5. Add Batch Diagnostics card to the Developer View
  - [x] 5.1 Implement the Batch Diagnostics dashboard card
    - Modify `dashboard/index.html` to add a "Batch Diagnostics" card in the Developer View tab
    - Implement `renderBatchDiagnosticsCard()` function that queries `batch_diagnostics` via Supabase REST (select=*&order=updated_at.desc)
    - Render per-asset cards showing: batch_id, updated_at timestamp, and all 8 diagnostic sections (sentiment, macro_context, ml_service, market_context, similarity, outcome, forecast, gemini)
    - Display "No diagnostics data available" when the query returns empty or fails
    - Call `renderBatchDiagnosticsCard()` when the Developer tab is selected
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12_

- [x] 6. Final checkpoint - Ensure all tests pass and pipeline runs end-to-end
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties (fire-and-forget, shape completeness)
- Unit tests validate specific examples and edge cases
- The implementation follows the same pattern as the existing `trace-emitter.ts` module
- TypeScript is the implementation language (matching the existing codebase)
- Testing uses Vitest + fast-check (already configured in package.json)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["2.2"] },
    { "id": 2, "tasks": ["2.3", "2.4", "2.5"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["5.1"] }
  ]
}
```
