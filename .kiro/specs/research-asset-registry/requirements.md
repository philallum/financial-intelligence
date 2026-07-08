# Requirements Document

## Introduction

The Research Asset Registry introduces a centralised, typed configuration registry that defines each tradeable research asset with rich metadata. It replaces the current pattern of hardcoding asset symbols across multiple files (batch-entry.ts, forecast route, OpenAPI spec) with a single source of truth that acts as the control plane for the entire research platform. Adding a new market (e.g., GBPUSD, XAUUSD, BTCUSD) becomes a configuration change rather than a code change. Each asset declares its provider mappings, supported timeframes, market hours, and engine participation — enabling the batch pipeline to execute the correct engines per asset without conditional logic for different asset classes.

## Glossary

- **Registry**: A TypeScript module exporting a typed array of Research_Asset objects, serving as the single source of truth for all tradeable assets in the platform
- **Research_Asset**: A single record in the Registry containing all metadata for one tradeable asset, including its stable identifier, symbol, provider mappings, engine participation, and processing configuration
- **Asset_Id**: A stable, lowercase slug identifier for an asset (e.g., "eurusd", "btcusd") that never changes, used as the canonical key across the platform
- **Symbol**: The display/trading identifier for an asset (e.g., "EURUSD", "GBPUSD") — uppercase, no separators
- **Provider_Map**: An object mapping data provider names to their respective symbol formats for a given asset (e.g., `{ twelveData: "EUR/USD", massive: "EURUSD", yahoo: "EURUSD=X" }`)
- **Pip_Size**: The minimum price increment for a given asset, used by engines for pip-based calculations (e.g., 0.0001 for major FX pairs, 0.01 for JPY pairs)
- **Price_Precision**: The number of decimal places used for formatting price values in API responses (e.g., 5 for EURUSD, 3 for USDJPY)
- **Asset_Class**: A classification enum indicating the market type — one of FOREX, INDICES, CRYPTO, COMMODITIES, or BONDS
- **Asset_Status**: An enum indicating the lifecycle state of an asset — one of ACTIVE, BETA, DISABLED, or DEPRECATED
- **Processing_Priority**: A positive integer (1–N) on a Research_Asset that determines batch processing order, where lower values are processed first
- **Supported_Timeframes**: An array of timeframe strings (e.g., ["4H"], ["1H", "4H", "1D"]) defining which candle intervals an asset supports for research processing
- **Market_Hours**: A string indicating the trading schedule for an asset (e.g., "24x5" for Forex, "24x7" for Crypto)
- **Engine_Participation_Map**: An object declaring which research engines a given asset participates in, with boolean flags for each engine type
- **Batch_Pipeline**: The scheduled process that fetches OHLC data and runs it through analysis engines for each processable asset based on status and engine participation
- **OpenAPI_Generator**: The build-time script (`scripts/generate-openapi.ts`) that produces the OpenAPI JSON specification from the YAML source

## Requirements

### Requirement 1: Registry Module Definition

**User Story:** As a platform developer, I want a single TypeScript module defining all research assets with typed metadata, so that asset configuration is centralised and type-safe.

#### Acceptance Criteria

1. THE Registry SHALL export a readonly typed array of Research_Asset objects from a single TypeScript file located in the `src/config/` directory
2. THE Registry SHALL define each Research_Asset with the following required properties: id (string, lowercase alphanumeric slug, unique across all entries), symbol (string, 3–10 uppercase alphanumeric characters, unique across all entries), assetClass (Asset_Class enum), status (Asset_Status enum), processingPriority (positive integer, 1 or greater), pipSize (number, between 0.000001 and 1), pricePrecision (positive integer between 0 and 10), marketHours (string), supportedTimeframes (non-empty string array), providers (Provider_Map with required twelveData field and optional massive and yahoo fields), and engines (Engine_Participation_Map with boolean flags for fingerprint, similarity, confidence, tradeability, sentiment, and macro)
3. THE Registry SHALL include "eurusd" as the initial seed entry with id "eurusd", symbol "EURUSD", assetClass FOREX, status ACTIVE, processingPriority 1, pipSize 0.0001, pricePrecision 5, marketHours "24x5", supportedTimeframes ["4H"], providers { twelveData: "EUR/USD" }, and engines { fingerprint: true, similarity: true, confidence: true, tradeability: true, sentiment: false, macro: true }
4. THE Registry SHALL enforce compile-time type checking on all Research_Asset properties via TypeScript interfaces or types such that assigning an incorrect type to any property produces a compilation error
5. THE Registry SHALL export the Research_Asset type, Asset_Class enum, Asset_Status enum, Provider_Map type, and Engine_Participation_Map type for use by consuming modules
6. THE Registry SHALL define the Asset_Class enum with the following members: FOREX, INDICES, CRYPTO, COMMODITIES, BONDS
7. THE Registry SHALL define the Asset_Status enum with the following members: ACTIVE, BETA, DISABLED, DEPRECATED
8. IF two Research_Asset objects share the same id value, THEN THE Registry SHALL fail TypeScript compilation or produce a runtime initialization error indicating the duplicate identifier
9. IF two Research_Asset objects share the same symbol value, THEN THE Registry SHALL fail TypeScript compilation or produce a runtime initialization error indicating the duplicate symbol
10. THE Registry SHALL impose no artificial upper limit on the number of Research_Asset entries

### Requirement 2: Multi-Provider Metadata

**User Story:** As a platform developer, I want each asset to declare its symbol format per data provider, so that the platform can call different providers without symbol translation logic elsewhere.

#### Acceptance Criteria

1. THE Registry SHALL define Provider_Map as an object with a required twelveData property (string, 3–15 characters) and optional massive property (string) and optional yahoo property (string)
2. WHEN the Batch_Pipeline fetches data for an asset, THE Batch_Pipeline SHALL use the corresponding provider key from the asset's Provider_Map for the active data source
3. IF a provider key is not defined for a given asset, THEN THE Batch_Pipeline SHALL skip that provider for the asset without error
4. THE Registry SHALL allow different symbol formats per provider for the same asset (e.g., twelveData: "EUR/USD", massive: "EURUSD", yahoo: "EURUSD=X")

### Requirement 3: Supported Timeframes

**User Story:** As a platform developer, I want each asset to declare its supported timeframes, so that different assets can run on different candle intervals without code changes.

#### Acceptance Criteria

1. THE Registry SHALL define supportedTimeframes as a non-empty array of timeframe strings on each Research_Asset
2. WHEN the Batch_Pipeline processes an asset, THE Batch_Pipeline SHALL execute the pipeline for each timeframe in the asset's supportedTimeframes array
3. THE Registry SHALL allow different assets to declare different timeframe sets (e.g., one asset with ["4H"] and another with ["1H", "4H", "1D"])
4. IF a Research_Asset has an empty supportedTimeframes array, THEN THE Registry SHALL produce a compile-time or runtime validation error

### Requirement 4: Engine Participation

**User Story:** As a platform developer, I want each asset to declare which research engines it participates in, so that the batch pipeline executes only the relevant engines per asset without conditional logic based on asset class.

#### Acceptance Criteria

1. THE Registry SHALL define Engine_Participation_Map as an object with boolean properties for each engine: fingerprint, similarity, confidence, tradeability, sentiment, and macro
2. WHEN the Batch_Pipeline processes an asset, THE Batch_Pipeline SHALL execute only the engines where the corresponding Engine_Participation_Map flag is true for that asset
3. WHEN the Batch_Pipeline processes an asset, THE Batch_Pipeline SHALL skip engines where the corresponding Engine_Participation_Map flag is false for that asset without logging an error
4. THE Batch_Pipeline SHALL contain no conditional logic based on Asset_Class for engine selection; all engine routing SHALL be derived exclusively from the Engine_Participation_Map
5. THE Registry SHALL require all six engine flags to be explicitly set (no implicit defaults) for each Research_Asset, enforced at compile time

### Requirement 5: Registry Query Utilities

**User Story:** As a platform developer, I want utility functions to query the registry by common access patterns, so that consuming code is concise and consistent.

#### Acceptance Criteria

1. THE Registry SHALL export a function that returns all Research_Asset objects with status ACTIVE or BETA, sorted by processingPriority in ascending order, returning an empty array when no processable assets exist
2. THE Registry SHALL export a function that returns all ACTIVE asset symbols as a string array sorted by processingPriority in ascending order
3. WHEN an id or symbol is provided to a lookup function, THE Registry SHALL perform a case-insensitive comparison against all Research_Asset objects (regardless of status) and return the matching Research_Asset or undefined if no match exists
4. THE Registry SHALL export a function that returns all ACTIVE asset symbols as a string array suitable for use as OpenAPI enum values in the asset path parameter schema
5. THE Registry SHALL export a function that accepts an Asset_Class value and returns all processable (ACTIVE or BETA) Research_Asset objects of that class sorted by processingPriority

### Requirement 6: Batch Pipeline Integration

**User Story:** As a platform developer, I want the batch pipeline to derive its asset list and engine configuration from the registry, so that adding new assets does not require editing batch-entry.ts.

#### Acceptance Criteria

1. WHEN the Batch_Pipeline starts execution, THE Batch_Pipeline SHALL retrieve the list of processable assets (status ACTIVE or BETA) from the Registry sorted by processingPriority in ascending order (processingPriority 1 processed first)
2. THE Batch_Pipeline SHALL process each processable asset sequentially in ascending processingPriority order, completing all pipeline stages for one asset before beginning the next
3. WHEN the Batch_Pipeline processes an asset, THE Batch_Pipeline SHALL iterate over each timeframe in the asset's supportedTimeframes and execute the engines indicated by the asset's Engine_Participation_Map
4. IF an asset has status DISABLED or DEPRECATED, THEN THE Batch_Pipeline SHALL exclude that asset from processing without logging an error
5. THE Batch_Pipeline SHALL use the provider key from the asset's Provider_Map corresponding to the active data source when making data provider API calls
6. IF the Registry returns zero processable assets, THEN THE Batch_Pipeline SHALL log a warning and exit with code 0 without executing any pipeline stages
7. IF processing fails for an individual asset, THEN THE Batch_Pipeline SHALL log the failure, continue processing the remaining assets in processingPriority order, and exit with a non-zero exit code after all assets have been attempted

### Requirement 7: API Route Integration

**User Story:** As a platform developer, I want API routes to derive their supported asset list from the registry, so that new assets are automatically available via the API without editing route files.

#### Acceptance Criteria

1. WHEN an API request includes an asset path parameter, THE API_Route SHALL validate the asset (case-insensitive) against symbols with status ACTIVE in the Registry
2. IF a request specifies a symbol that is not ACTIVE in the Registry, THEN THE API_Route SHALL return HTTP 400 with error code "asset_not_supported" and include the list of currently ACTIVE asset symbols in the error response
3. THE API_Route SHALL contain no hardcoded asset arrays; all supported-asset lookups SHALL resolve exclusively from the Registry at runtime, such that adding an ACTIVE asset to the Registry makes it available on the next deployment without code changes
4. WHEN serving price data in API responses, THE API_Route SHALL format price values using the pricePrecision property from the asset's Research_Asset definition

### Requirement 8: OpenAPI Specification Integration

**User Story:** As a platform developer, I want the OpenAPI specification to derive its asset enum dynamically from the registry, so that the API documentation is always in sync with available assets.

#### Acceptance Criteria

1. WHEN the OpenAPI_Generator script executes, THE OpenAPI_Generator SHALL read the list of ACTIVE asset symbols from the Registry
2. THE OpenAPI_Generator SHALL write the ACTIVE asset symbols as the enum values for the asset path parameter in the generated OpenAPI specification output file, preserving alphabetical order
3. WHEN an asset has status DISABLED, DEPRECATED, or BETA, THE OpenAPI_Generator SHALL exclude that asset symbol from the generated enum the next time the script is executed
4. THE OpenAPI_Generator SHALL set the asset parameter description to list the currently ACTIVE asset symbols so that consumers can identify valid values without inspecting the enum
5. IF the Registry contains zero ACTIVE assets, THEN THE OpenAPI_Generator SHALL terminate with a non-zero exit code and an error message indicating that at least one asset must be ACTIVE

### Requirement 9: Single Source of Truth Guarantee

**User Story:** As a platform developer, I want adding a new asset to require only a Registry file edit, so that the operational cost of onboarding new markets is minimal.

#### Acceptance Criteria

1. WHEN a new Research_Asset is added to the Registry with status ACTIVE, THE Batch_Pipeline SHALL include that asset in the next execution without any other code changes
2. WHEN a new Research_Asset is added to the Registry with status ACTIVE, THE API_Route SHALL accept requests for that asset after redeployment without any other code changes
3. WHEN a new Research_Asset is added to the Registry with status ACTIVE, THE OpenAPI_Generator SHALL include that asset in the specification on the next build without any other code changes
4. THE Registry SHALL be the sole location where asset definitions are maintained — no other module in the platform SHALL contain hardcoded asset symbol arrays or engine participation logic

### Requirement 10: Asset Lifecycle Status

**User Story:** As a platform operator, I want to control asset lifecycle through a status enum, so that I can manage assets through stages from beta testing to deprecation without removing their configuration.

#### Acceptance Criteria

1. WHEN a Research_Asset has status DISABLED or DEPRECATED, THE Batch_Pipeline SHALL exclude that asset from processing on the next scheduled execution
2. WHEN a Research_Asset has status DISABLED or DEPRECATED, THE API_Route SHALL reject requests for that asset with HTTP 400, error code "asset_not_supported", a message indicating the asset is currently unavailable, and a list of currently ACTIVE asset symbols
3. WHEN a Research_Asset has status DISABLED or DEPRECATED, THE OpenAPI_Generator SHALL exclude that asset from the generated enum on the next build
4. WHEN a Research_Asset has status BETA, THE Batch_Pipeline SHALL include that asset in processing alongside ACTIVE assets in processingPriority order
5. WHEN a Research_Asset has status BETA, THE API_Route SHALL exclude that asset from public API responses (treated as not available to external consumers)
6. WHEN a Research_Asset transitions from DISABLED to ACTIVE, THE Batch_Pipeline SHALL include that asset in the next scheduled batch execution, and THE API_Route SHALL accept requests for that asset after redeployment
7. WHEN a Research_Asset has status DISABLED or DEPRECATED, THE Platform SHALL retain all previously processed data for that asset in the database, making no deletions or modifications to existing records

### Requirement 11: Priority-Based Processing Order

**User Story:** As a platform developer, I want assets processed in processingPriority order, so that the most important assets complete first within the batch window.

#### Acceptance Criteria

1. THE Batch_Pipeline SHALL process processable assets (ACTIVE and BETA) sequentially in ascending processingPriority order, where processingPriority 1 is processed first and higher numeric values are processed later
2. WHEN two assets have equal processingPriority values, THE Batch_Pipeline SHALL process them in an undefined relative order with no guaranteed sequence between them
3. THE Registry SHALL enforce at compile time that processingPriority values are positive integers (1 or greater), rejecting zero, negative values, and non-integer values via the Research_Asset type definition
4. IF an asset fails during processing, THEN THE Batch_Pipeline SHALL log the failure and continue processing the remaining assets in processingPriority order without halting the batch

### Requirement 12: Market Hours Declaration

**User Story:** As a platform developer, I want each asset to declare its market hours, so that the platform can use this metadata for future scheduling decisions and operational checks.

#### Acceptance Criteria

1. THE Registry SHALL define marketHours as a required string property on each Research_Asset
2. THE Registry SHALL use "24x5" for assets trading 24 hours on weekdays (Forex), "24x7" for assets trading continuously (Crypto), and descriptive strings for other schedules
3. THE Registry SHALL export the marketHours property for each asset so that consuming modules can access it for scheduling logic
4. WHEN a consuming module queries an asset's marketHours, THE Registry SHALL return the declared value without modification
