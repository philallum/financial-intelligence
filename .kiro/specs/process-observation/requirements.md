# Requirements Document

## Introduction

The Process Observation system captures per-batch diagnostics data from every stage of the pipeline and persists it to a single-row-per-asset table in Supabase. The system follows the fire-and-forget collector pattern (identical to trace-emitter.ts) so that diagnostics collection never interrupts or halts the batch pipeline. A Developer View tab in the existing dashboard queries Supabase REST directly to display the latest diagnostics for each asset.

## Glossary

- **Diagnostics_Collector**: The TypeScript module responsible for accumulating diagnostics observations during a batch cycle and persisting them to the batch_diagnostics table. Follows the fire-and-forget pattern.
- **Batch_Diagnostics_Table**: The Supabase Postgres table (`batch_diagnostics`) that stores one row per asset containing a JSONB diagnostics column, upserted each batch cycle.
- **Developer_View**: A tab in the existing dashboard (dashboard/index.html) that renders the latest diagnostics data for each processed asset.
- **Batch_Pipeline**: The 14-stage batch pipeline orchestrated by batch-entry.ts, triggered every 4 hours.
- **JSONB_Diagnostics**: The JSONB column within batch_diagnostics that contains structured diagnostics data from all observed pipeline stages.
- **Supabase_REST**: The auto-generated Supabase PostgREST endpoint used by the dashboard to query batch_diagnostics directly without a custom API endpoint.

## Requirements

### Requirement 1: Diagnostics Collection

**User Story:** As a developer, I want pipeline diagnostics collected automatically during each batch cycle, so that I can observe engine inputs, outputs, and behaviour without modifying pipeline logic.

#### Acceptance Criteria

1. WHEN a batch cycle executes for an asset, THE Diagnostics_Collector SHALL accumulate diagnostics observations from the Sentiment Engine, Macro Context Engine, ML Service, Market Context, Similarity, Outcome, Forecast, and Gemini stages.
2. THE Diagnostics_Collector SHALL capture the following Sentiment Engine diagnostics: article_count (integer), window_hours (number), 6-dimensional sentiment vector (array of 6 numbers), sentiment_score (number), and confidence_factor (number).
3. THE Diagnostics_Collector SHALL capture the following Macro Context Engine diagnostics: event_count (integer), 8-dimensional macro vector (array of 8 numbers), and macro_state (string).
4. THE Diagnostics_Collector SHALL capture the following ML Service diagnostics: called (boolean), response probabilities for up, down, and flat (numbers), and latency_ms (number).
5. THE Diagnostics_Collector SHALL capture the following Market Context diagnostics: available (boolean), and the fetched DXY, VIX, and SPX values (numbers or null).
6. THE Diagnostics_Collector SHALL capture the following Similarity diagnostics: match_count (integer), session_bonus_count (integer), and regime_bonus_count (integer).
7. THE Diagnostics_Collector SHALL capture the following Outcome diagnostics: dynamic_flat_threshold (number), and weighted_return_count (integer).
8. THE Diagnostics_Collector SHALL capture the following Forecast diagnostics: similarity-only forecast probabilities (up, down, flat as numbers), final ensemble forecast probabilities (up, down, flat as numbers), and alpha weight (number).
9. THE Diagnostics_Collector SHALL capture the following Gemini diagnostics: scored_article_count (integer representing articles with non-zero sentiment_hint).

### Requirement 2: Fire-and-Forget Persistence

**User Story:** As a developer, I want diagnostics persistence to never halt the batch pipeline, so that observability cannot degrade production reliability.

#### Acceptance Criteria

1. IF the Diagnostics_Collector encounters an error during persistence, THEN THE Diagnostics_Collector SHALL log the error to console.error and continue batch execution without throwing.
2. IF the Diagnostics_Collector encounters an error during data accumulation, THEN THE Diagnostics_Collector SHALL log the error to console.warn and continue batch execution without throwing.
3. THE Diagnostics_Collector SHALL persist diagnostics asynchronously at the end of a batch cycle without blocking the pipeline completion signal.

### Requirement 3: Latest-Only Storage Model

**User Story:** As a developer, I want only the latest diagnostics per asset stored, so that storage remains bounded and the dashboard always shows current state.

#### Acceptance Criteria

1. WHEN the Diagnostics_Collector persists diagnostics for an asset, THE Batch_Diagnostics_Table SHALL contain exactly one row per asset after the upsert operation.
2. WHEN a new batch cycle completes for an asset, THE Diagnostics_Collector SHALL overwrite the existing diagnostics row for that asset using an upsert operation keyed on the asset column.
3. THE Batch_Diagnostics_Table SHALL store the diagnostics payload in a single JSONB column named `diagnostics`.
4. THE Batch_Diagnostics_Table SHALL include the following columns: asset (text, primary key), batch_id (text), updated_at (timestamptz), and diagnostics (jsonb).

### Requirement 4: Database Schema

**User Story:** As a developer, I want a well-defined table schema, so that the diagnostics data is queryable and the dashboard can rely on a stable contract.

#### Acceptance Criteria

1. THE Batch_Diagnostics_Table SHALL use `asset` as the primary key to enforce the one-row-per-asset invariant.
2. THE Batch_Diagnostics_Table SHALL store `batch_id` as a text column identifying which batch cycle produced the diagnostics.
3. THE Batch_Diagnostics_Table SHALL store `updated_at` as a timestamptz column set to the current UTC time on each upsert.
4. THE Batch_Diagnostics_Table SHALL allow the Supabase service role and the anon role to read rows via the PostgREST API.
5. THE Batch_Diagnostics_Table SHALL allow only the Supabase service role to insert and update rows.

### Requirement 5: Developer View Dashboard

**User Story:** As a developer, I want to view the latest batch diagnostics in the existing dashboard, so that I can quickly inspect pipeline behaviour without querying the database manually.

#### Acceptance Criteria

1. THE Developer_View SHALL appear as a new tab labelled "Developer" in the existing dashboard tab bar.
2. WHEN the Developer tab is selected, THE Developer_View SHALL query the Batch_Diagnostics_Table via Supabase_REST and display the latest diagnostics for each asset.
3. THE Developer_View SHALL display Sentiment Engine diagnostics including article_count, window_hours, sentiment_score, confidence_factor, and the 6-dimensional vector.
4. THE Developer_View SHALL display Macro Context Engine diagnostics including event_count, macro_state, and the 8-dimensional vector.
5. THE Developer_View SHALL display ML Service diagnostics including called status, response probabilities, and latency_ms.
6. THE Developer_View SHALL display Market Context diagnostics including availability status and DXY, VIX, SPX values.
7. THE Developer_View SHALL display Similarity diagnostics including match_count, session_bonus_count, and regime_bonus_count.
8. THE Developer_View SHALL display Outcome diagnostics including dynamic_flat_threshold and weighted_return_count.
9. THE Developer_View SHALL display Forecast diagnostics including similarity-only probabilities, ensemble probabilities, and alpha weight.
10. THE Developer_View SHALL display Gemini diagnostics including scored_article_count.
11. WHEN diagnostics data is unavailable or the query fails, THE Developer_View SHALL display a message indicating no diagnostics data is available.
12. THE Developer_View SHALL display the batch_id and updated_at timestamp to indicate data freshness.

### Requirement 6: Integration with Batch Pipeline

**User Story:** As a developer, I want the diagnostics collector integrated into the existing batch-entry.ts flow, so that observations are captured without restructuring the pipeline.

#### Acceptance Criteria

1. THE Diagnostics_Collector SHALL be instantiated within batch-entry.ts and passed through the pipeline stages to accumulate observations.
2. WHEN the batch pipeline completes all stages for an asset, THE Diagnostics_Collector SHALL persist the accumulated diagnostics to the Batch_Diagnostics_Table.
3. THE Diagnostics_Collector SHALL record the batch_id and asset for each diagnostics payload.
4. IF the ML Service is not called during a batch cycle, THEN THE Diagnostics_Collector SHALL record ml_service.called as false with null response and null latency_ms.
5. IF Market Context data fetch fails, THEN THE Diagnostics_Collector SHALL record market_context.available as false with null values for DXY, VIX, and SPX.
