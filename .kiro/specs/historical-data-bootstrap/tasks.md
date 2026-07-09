# Implementation Plan: Historical Data Bootstrap

## Overview

Implement the CLI-driven historical data bootstrap pipeline for onboarding new currency pairs. The implementation follows the module layout defined in the design: shared types first, then pure logic modules (csv-parser, data-validator, outcome-computer) in parallel, followed by I/O modules (candle-importer, fingerprint-generator, topology-backfiller), and finally the CLI entrypoint that orchestrates the full pipeline.

## Tasks

- [x] 1. Set up project structure and shared types
  - [x] 1.1 Create `src/bootstrap/types.ts` with all shared interfaces
    - Define `CandleRecord`, `ValidationResult`, `OHLCViolation`, `GapInfo`, `ImportResult`, `ImportOptions`, `FingerprintResult`, `OutcomeResult`, `OutcomeRecord`, `TopologyResult`, and `PipelineSummary` interfaces
    - Define pipeline constants: `BATCH_SIZE_CANDLES` (500), `BATCH_SIZE_FINGERPRINTS` (200), `BATCH_SIZE_OUTCOMES` (200), `BATCH_SIZE_TOPOLOGY` (100), `MIN_TOPOLOGY_CANDLES` (30), `MAX_TOPOLOGY_CANDLES` (120), `BOOTSTRAP_BATCH_ID`, `TIMEFRAME` ("4H")
    - _Requirements: 3.1, 5.1, 6.2, 6.3, 11.2_

- [x] 2. Implement pure logic modules
  - [x] 2.1 Implement `src/bootstrap/csv-parser.ts`
    - Implement `parseDukascopyTimestamp(raw: string): string` to convert "DD.MM.YYYY HH:MM:SS.000" to ISO 8601
    - Implement `isHeaderRow(fields: string[]): boolean` to detect header rows by checking non-numeric OHLC columns
    - Implement `formatCandleToCSV(record: CandleRecord): string` for round-trip testing
    - Implement `parseDukascopyCSV(filePath: string): CandleRecord[]` main parser function
    - Handle both Dukascopy and ISO 8601 timestamp formats
    - Throw descriptive errors for missing files, empty files, and non-numeric values (identifying row number and column)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [x] 2.2 Write property tests for csv-parser (Properties 1–4)
    - Create `src/bootstrap/__tests__/csv-parser.property.test.ts`
    - **Property 1: CSV Round-Trip** — For any valid CandleRecord, formatCandleToCSV then re-parsing produces equivalent record
    - **Validates: Requirements 1.1, 1.8**
    - **Property 2: Timestamp Parsing Correctness** — Dukascopy timestamp → ISO 8601 represents same instant; ISO 8601 input is idempotent
    - **Validates: Requirements 1.2, 1.3**
    - **Property 3: Non-Numeric Value Rejection** — Any row with non-numeric OHLCV column is rejected with correct row/column identification
    - **Validates: Requirements 1.5**
    - **Property 4: Header Row Detection** — Rows with non-numeric OHLC columns detected as headers; rows with numeric OHLC are not
    - **Validates: Requirements 1.7**

  - [x] 2.3 Implement `src/bootstrap/data-validator.ts`
    - Implement `checkOHLCInvariant(candle: CandleRecord): boolean` verifying high >= max(open,close) and low <= min(open,close)
    - Implement `computeExpectedTimestamps(start: Date, end: Date): string[]` for forex 4H schedule (Mon 00:00–Fri 20:00 UTC)
    - Implement `validateCandles(records: CandleRecord[], asset: string): ValidationResult` orchestrating OHLC checks, gap detection, and expected count comparison
    - Abort on OHLC violations (set valid=false); warn on gaps (set valid=true with gap info)
    - Report first 10 gap timestamps for operator visibility
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 2.4 Write property tests for data-validator (Properties 5–7)
    - Create `src/bootstrap/__tests__/data-validator.property.test.ts`
    - **Property 5: OHLC Invariant Validation** — Valid candles pass; violating candles fail with correct constraint identification
    - **Validates: Requirements 2.1, 2.2**
    - **Property 6: Gap Detection Completeness** — Removed timestamps from a sequence are exactly the detected gaps (no false positives/negatives)
    - **Validates: Requirements 2.3**
    - **Property 7: Expected Candle Count Formula** — Complete forex weeks produce weeks × 30 expected candles
    - **Validates: Requirements 2.5**

  - [x] 2.5 Implement `src/bootstrap/outcome-computer.ts`
    - Implement `computeOutcomes(candles, fingerprintIds, asset, pipSize): OutcomeRecord[]` computing forward 4H outcomes for consecutive candle pairs
    - Calculate `net_return_pips = (next_close - current_close) / pipSize`
    - Calculate `max_favourable_excursion = (next_high - current_close) / pipSize`
    - Calculate `max_adverse_excursion = (current_close - next_low) / pipSize`
    - Calculate `realised_volatility = ((next_high - next_low) / pipSize) / 10000`
    - Implement `storeOutcomes(supabase, outcomes, batchSize): Promise<OutcomeResult>` with batched upsert and deduplication on (fingerprint_id, horizon)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x] 2.6 Write property tests for outcome-computer (Properties 8–9)
    - Create `src/bootstrap/__tests__/outcome-computer.property.test.ts`
    - **Property 8: Outcome Count Invariant** — For N candles (N ≥ 2), computeOutcomes produces exactly N-1 records
    - **Validates: Requirements 5.1**
    - **Property 9: Outcome Formula Correctness** — Computed metrics match expected formulas within ±0.01 tolerance
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5**

- [x] 3. Checkpoint - Verify pure logic modules
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement I/O modules
  - [x] 4.1 Implement `src/bootstrap/candle-importer.ts`
    - Implement `importCandles(supabase, records, asset, options?): Promise<ImportResult>`
    - Use batched upsert with configurable batch size (default 500)
    - Use `onConflict: 'asset,timeframe,timestamp_utc'` with `ignoreDuplicates: true` for deduplication
    - Set timeframe to "4H" and asset to uppercase symbol for all rows
    - Log errors per batch and continue (fail-forward); track inserted/skipped/error counts
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 10.2, 11.2_

  - [x] 4.2 Implement `src/bootstrap/fingerprint-generator.ts`
    - Implement `generateAndStoreFingerprints(supabase, candles, asset, batchSize?): Promise<FingerprintResult>`
    - Process candles in chronological order (ascending timestamp_utc)
    - Use existing `generateFingerprint()` from `src/engines/fingerprint-engine.ts`
    - Batch-upsert into `market_fingerprints` with deduplication on (asset, timeframe, timestamp_utc)
    - Log progress every 1000 fingerprints generated
    - Continue on batch errors; track generated/stored/error counts
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 10.3, 11.3_

  - [x] 4.3 Implement `src/bootstrap/topology-backfiller.ts`
    - Implement `backfillTopology(supabase, candles, fingerprintIds, asset, batchSize?): Promise<TopologyResult>`
    - Use existing `computeTopology()` from `src/engines/topology-engine.ts`
    - Skip fingerprints with fewer than 30 preceding candles
    - Provide up to 120 preceding candles as context for each computation
    - Batch-upsert into `fingerprint_topology` with deduplication on (fingerprint_id)
    - Track computed/stored/skipped/error counts
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 10.5_

  - [x] 4.4 Write property test for topology-backfiller (Property 10)
    - Create `src/bootstrap/__tests__/topology-backfiller.property.test.ts`
    - **Property 10: Topology Window and Skip Logic** — Index < 30 is skipped; index >= 30 provides min(index, 120) preceding candles
    - **Validates: Requirements 6.2, 6.3**

- [x] 5. Checkpoint - Verify I/O modules
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement CLI entrypoint and integration
  - [x] 6.1 Implement `scripts/bootstrap-asset.ts` CLI entrypoint
    - Implement `parseArgs(argv: string[]): CliArgs` for `--asset` and `--csv` arguments
    - Load environment variables from `.env` using `dotenv/config`
    - Validate asset exists in RESEARCH_ASSETS registry (exit with error if missing, disabled, or deprecated)
    - Orchestrate pipeline stages in sequence: parse CSV → validate → import candles → generate fingerprints → compute outcomes → backfill topology
    - Implement `printSummary(summary: PipelineSummary): void` to output final report
    - Track elapsed time and aggregate stats from each stage
    - Exit with code 0 on success, code 1 on fatal errors
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 9.1, 9.2, 9.3, 9.4, 10.1, 11.1, 11.4_

  - [x] 6.2 Write unit tests for CLI argument parsing and asset validation
    - Create `src/bootstrap/__tests__/bootstrap-cli.test.ts`
    - Test missing `--asset` argument exits with usage message
    - Test missing `--csv` argument exits with usage message
    - Test unknown asset symbol exits with registration error
    - Test disabled/deprecated asset exits with warning
    - Test valid asset proceeds without error
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3_

- [x] 7. Final checkpoint - Run full test suite
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1–10)
- Unit tests validate specific examples and edge cases
- All modules reuse existing engine functions (`generateFingerprint`, `computeTopology`) and follow patterns from `scripts/seed-historical-data.ts`
- The project uses `vitest` + `fast-check` for testing (both already in devDependencies)
- TypeScript is the implementation language (consistent with the full codebase)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.3", "2.5"] },
    { "id": 2, "tasks": ["2.2", "2.4", "2.6"] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.3"] },
    { "id": 4, "tasks": ["4.4"] },
    { "id": 5, "tasks": ["6.1"] },
    { "id": 6, "tasks": ["6.2"] }
  ]
}
```
