# Requirements Document

## Introduction

The Historical Data Bootstrap feature enables operators to onboard new currency pairs (e.g., GBPUSD) to the Financial Intelligence Platform. Adding a new asset requires loading approximately 5 years of historical 4H candle data and running the full derivation chain (fingerprints, outcomes, topology) so the similarity engine can produce meaningful forecasts. This feature provides a CLI script that accepts a Dukascopy-exported CSV file, validates and imports the data into Supabase, runs the bootstrap pipeline, and registers the asset in the research asset registry.

## Glossary

- **Bootstrap_CLI**: The command-line script (`scripts/bootstrap-asset.ts`) that orchestrates the full historical data import and derivation pipeline for a new asset.
- **Dukascopy_CSV**: A comma-separated values file exported from the Dukascopy FX data provider containing historical OHLC candle data with columns: timestamp, open, high, low, close, volume.
- **CSV_Parser**: The module responsible for reading and parsing Dukascopy CSV files into structured candle records.
- **Data_Validator**: The module responsible for checking OHLC invariants, gap detection, and expected candle counts before database insertion.
- **Candle_Importer**: The module responsible for bulk-inserting validated candle records into the `raw_candles` table with deduplication.
- **Fingerprint_Generator**: The module responsible for generating market fingerprints for all imported historical candles using the existing `generateFingerprint` engine.
- **Outcome_Computer**: The module responsible for computing forward 4H outcomes (net return, MFE, MAE, realised volatility) for each fingerprint.
- **Topology_Backfiller**: The module responsible for computing topology vectors for historical fingerprints using the existing `computeTopology` engine.
- **Asset_Registrar**: The module responsible for validating that the target asset exists in the research asset registry or reporting that it must be added.
- **OHLC_Invariant**: The constraint that for any candle: high >= max(open, close) and low <= min(open, close).
- **Candle_Gap**: A missing 4H candle within expected trading hours (24x5 for forex, excluding weekends).
- **Batch_Insert**: An insert operation that processes records in configurable-size chunks to avoid memory exhaustion and database timeouts.
- **Deduplication**: The process of skipping candle records where a row already exists for the same asset, timeframe, and timestamp.

## Requirements

### Requirement 1: CSV Parsing

**User Story:** As a platform operator, I want to parse Dukascopy CSV files containing historical OHLC data, so that I can load candle data for new currency pairs.

#### Acceptance Criteria

1. WHEN a file path is provided, THE CSV_Parser SHALL read the file and parse each row into a structured candle record containing timestamp, open, high, low, close, and volume fields.
2. WHEN the CSV contains timestamps in "DD.MM.YYYY HH:MM:SS.000" format, THE CSV_Parser SHALL parse them into ISO 8601 UTC timestamps.
3. WHEN the CSV contains timestamps in ISO 8601 format, THE CSV_Parser SHALL accept them without transformation.
4. IF the CSV file does not exist at the provided path, THEN THE CSV_Parser SHALL exit with a descriptive error message and non-zero exit code.
5. IF a row contains non-numeric values in the open, high, low, close, or volume columns, THEN THE CSV_Parser SHALL reject the file with an error identifying the row number and column.
6. IF the CSV file contains zero data rows, THEN THE CSV_Parser SHALL exit with an error indicating the file is empty.
7. WHEN the CSV contains a header row, THE CSV_Parser SHALL detect and skip it automatically.
8. FOR ALL valid Dukascopy CSV files, parsing then formatting back to CSV then re-parsing SHALL produce equivalent candle records (round-trip property).

### Requirement 2: Data Validation

**User Story:** As a platform operator, I want the bootstrap tool to validate imported data before insertion, so that I can ensure data quality and catch issues early.

#### Acceptance Criteria

1. WHEN a candle record is validated, THE Data_Validator SHALL verify the OHLC_Invariant holds: high >= max(open, close) and low <= min(open, close).
2. IF any candle violates the OHLC_Invariant, THEN THE Data_Validator SHALL report the failing row number, timestamp, and which constraint was violated.
3. WHEN all candles are parsed, THE Data_Validator SHALL detect gaps by identifying missing 4H candles within expected forex trading hours (Monday 00:00 UTC through Friday 20:00 UTC).
4. WHEN gaps are detected, THE Data_Validator SHALL report the number of missing candles and the timestamps of the first 10 gaps.
5. WHEN all candles are parsed, THE Data_Validator SHALL report the total candle count and compare it to the expected count for the date range (approximately 6 candles per day, 5 days per week).
6. IF any candle fails the OHLC_Invariant, THEN THE Data_Validator SHALL abort the import before any database writes occur.
7. WHEN gaps are detected, THE Data_Validator SHALL proceed with a warning rather than aborting, since minor gaps in historical FX data are common.

### Requirement 3: Candle Import with Deduplication

**User Story:** As a platform operator, I want candles inserted into the database with deduplication, so that I can safely re-run the import without creating duplicate records.

#### Acceptance Criteria

1. WHEN validated candles are ready for import, THE Candle_Importer SHALL insert records into the `raw_candles` table using batched operations with a configurable batch size (default: 500 records per batch).
2. THE Candle_Importer SHALL perform Deduplication by skipping rows where a record already exists for the same asset, timeframe, and timestamp_utc combination.
3. WHEN inserting a batch, THE Candle_Importer SHALL use an upsert operation with `ignoreDuplicates: true` on the (asset, timeframe, timestamp_utc) unique constraint.
4. IF a batch insert fails, THEN THE Candle_Importer SHALL log the error and continue with the remaining batches rather than aborting the entire import.
5. WHEN all batches have been processed, THE Candle_Importer SHALL report the total number of rows inserted and the number of duplicates skipped.
6. THE Candle_Importer SHALL set the asset field using the uppercase asset symbol provided via the `--asset` CLI argument.
7. THE Candle_Importer SHALL set the timeframe field to "4H" for all imported candles.

### Requirement 4: Fingerprint Generation

**User Story:** As a platform operator, I want fingerprints generated for all imported historical candles, so that the similarity engine has a complete corpus for matching.

#### Acceptance Criteria

1. WHEN candle import completes successfully, THE Fingerprint_Generator SHALL generate a market fingerprint for each imported candle using the existing `generateFingerprint` function.
2. THE Fingerprint_Generator SHALL process candles in chronological order (ascending timestamp_utc).
3. THE Fingerprint_Generator SHALL insert fingerprints into the `market_fingerprints` table using batched upsert operations with deduplication on (asset, timeframe, timestamp_utc).
4. WHEN processing candles, THE Fingerprint_Generator SHALL log progress every 1000 fingerprints generated.
5. IF a fingerprint batch insert fails, THEN THE Fingerprint_Generator SHALL log the error and continue with remaining batches.
6. WHEN fingerprint generation completes, THE Fingerprint_Generator SHALL report the total number of fingerprints generated and stored.

### Requirement 5: Forward Outcome Computation

**User Story:** As a platform operator, I want forward outcomes computed for each historical fingerprint, so that the similarity engine can project probable returns for new matches.

#### Acceptance Criteria

1. WHEN fingerprint generation completes, THE Outcome_Computer SHALL compute the forward 4H outcome for each fingerprint where a subsequent candle exists.
2. THE Outcome_Computer SHALL compute net_return_pips as (next_close - current_close) / pip_size for the asset.
3. THE Outcome_Computer SHALL compute max_favourable_excursion as (next_high - current_close) / pip_size.
4. THE Outcome_Computer SHALL compute max_adverse_excursion as (current_close - next_low) / pip_size.
5. THE Outcome_Computer SHALL compute realised_volatility as (next_high - next_low) / pip_size, normalised by dividing by 10000.
6. THE Outcome_Computer SHALL insert outcomes into the `market_outcomes` table using batched upsert operations with deduplication on (fingerprint_id, horizon).
7. WHEN outcome computation completes, THE Outcome_Computer SHALL report the total number of outcomes computed and stored.

### Requirement 6: Topology Vector Backfill

**User Story:** As a platform operator, I want topology vectors computed for all historical fingerprints, so that the topology-weighted similarity engine can function for the new asset.

#### Acceptance Criteria

1. WHEN outcome computation completes, THE Topology_Backfiller SHALL compute a topology vector for each fingerprint using the existing `computeTopology` function.
2. THE Topology_Backfiller SHALL provide the preceding candle history (up to 120 candles) as context for each topology computation.
3. THE Topology_Backfiller SHALL skip fingerprints where fewer than 30 preceding candles are available (minimum required by the topology engine).
4. THE Topology_Backfiller SHALL insert topology vectors into the `fingerprint_topology` table using batched upsert operations.
5. WHEN topology backfill completes, THE Topology_Backfiller SHALL report the total number of topology vectors computed, stored, and skipped.

### Requirement 7: Asset Registry Validation

**User Story:** As a platform operator, I want the bootstrap tool to validate that the target asset is registered, so that I am alerted if configuration is missing before running the pipeline.

#### Acceptance Criteria

1. WHEN the CLI is invoked, THE Asset_Registrar SHALL check whether the provided asset symbol exists in the RESEARCH_ASSETS registry.
2. IF the asset symbol is not found in the registry, THEN THE Asset_Registrar SHALL exit with an error message instructing the operator to add the asset to `src/config/research-assets.ts` before running the bootstrap.
3. IF the asset is found but has status DISABLED or DEPRECATED, THEN THE Asset_Registrar SHALL exit with a warning indicating the asset is not in an active state.
4. WHEN the asset is found with status ACTIVE or BETA, THE Asset_Registrar SHALL proceed with the bootstrap pipeline.

### Requirement 8: CLI Interface

**User Story:** As a platform operator, I want a single CLI command to run the full bootstrap pipeline, so that I can onboard new assets with minimal manual steps.

#### Acceptance Criteria

1. THE Bootstrap_CLI SHALL accept a required `--asset` argument specifying the uppercase asset symbol (e.g., GBPUSD).
2. THE Bootstrap_CLI SHALL accept a required `--csv` argument specifying the file path to the Dukascopy CSV file.
3. IF the `--asset` or `--csv` argument is missing, THEN THE Bootstrap_CLI SHALL exit with a usage message showing the expected syntax.
4. THE Bootstrap_CLI SHALL be executable via `npx tsx scripts/bootstrap-asset.ts --asset GBPUSD --csv path/to/file.csv`.
5. WHEN the pipeline completes successfully, THE Bootstrap_CLI SHALL exit with code 0.
6. IF any critical step fails (validation errors, missing asset registration), THEN THE Bootstrap_CLI SHALL exit with code 1.
7. THE Bootstrap_CLI SHALL load environment variables from `.env` using dotenv for Supabase credentials.

### Requirement 9: Summary Report

**User Story:** As a platform operator, I want a comprehensive summary after the bootstrap completes, so that I can verify the import was successful and identify any issues.

#### Acceptance Criteria

1. WHEN the bootstrap pipeline completes, THE Bootstrap_CLI SHALL print a summary report to stdout.
2. THE summary report SHALL include: total candles parsed from CSV, candles imported (new), candles skipped (duplicates), fingerprints generated, outcomes computed, topology vectors created, and gaps detected.
3. WHEN gaps were detected during validation, THE summary report SHALL include the count of missing candles and the date range of the imported data.
4. THE summary report SHALL include the total elapsed time for the bootstrap operation.

### Requirement 10: Idempotent Execution

**User Story:** As a platform operator, I want the bootstrap to be safely re-runnable, so that I can retry after failures without corrupting data.

#### Acceptance Criteria

1. THE Bootstrap_CLI SHALL produce identical database state whether run once or multiple times with the same input CSV and asset.
2. THE Candle_Importer SHALL use upsert with ignore-duplicates semantics so re-importing the same candles has no effect.
3. THE Fingerprint_Generator SHALL use upsert with ignore-duplicates semantics so re-generating fingerprints for existing candles has no effect.
4. THE Outcome_Computer SHALL use upsert with ignore-duplicates semantics so re-computing outcomes for existing fingerprints has no effect.
5. THE Topology_Backfiller SHALL use upsert with ignore-duplicates semantics so re-computing topology vectors for existing fingerprints has no effect.

### Requirement 11: Performance and Batching

**User Story:** As a platform operator, I want the bootstrap to handle large datasets efficiently, so that importing 5 years of 4H data completes in a reasonable time.

#### Acceptance Criteria

1. THE Bootstrap_CLI SHALL process datasets of 10,000 or more candles without exceeding Node.js default memory limits.
2. THE Candle_Importer SHALL use batched inserts with a configurable batch size to avoid database timeouts.
3. THE Fingerprint_Generator SHALL process fingerprints in batches to avoid accumulating all results in memory simultaneously.
4. THE Bootstrap_CLI SHALL log progress indicators during long-running operations so the operator can monitor execution.
