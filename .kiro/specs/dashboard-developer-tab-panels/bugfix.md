# Bugfix Requirements Document

## Introduction

After the multi-asset feature was added to the dashboard (adding GBP/USD alongside EUR/USD), most panels in the Developer tab stopped displaying data, and the Trader view's "Current Prediction" panel fails for GBP/USD. There are two root causes:

1. **Developer tab query failures:** The `loadDeveloperView` function queries Supabase tables (`batch_runs`, `execution_traces`, `research_similarity_archive`, `drift_alerts`) with an `asset=eq.{symbol}` filter, but these tables do not have an `asset` column in their database schema. Supabase returns errors for queries filtering on non-existent columns, which are caught by `.catch(() => [])`, resulting in empty arrays and "No data" empty-state messages on most developer panels.

2. **Forecast API anonymous access restriction:** The API auth middleware (`auth.ts`) hardcodes anonymous access to only `/v1/forecast/eurusd`. When the dashboard requests `/v1/forecast/GBPUSD` without an API key, it is rejected, causing "Could not load forecast for GBPUSD" on the Trader view and "API is not responding" on the Developer tab's System Health panel.

Additionally, the Sentiment Engine Output panel returns no data because the query filters `sentiment_hint=neq.0` but most articles have a sentiment_hint of exactly 0.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the developer tab loads and queries the `batch_runs` table with `asset=eq.{symbol}` THEN the system returns an empty result because the `batch_runs` table has no `asset` column, and the "Latest Batch Run" panel displays "No batch runs available"

1.2 WHEN the developer tab loads and queries the `execution_traces` table with `asset=eq.{symbol}` THEN the system returns an empty result because the `execution_traces` table has no `asset` column, and the "Execution Traces" panel displays "No execution traces available"

1.3 WHEN the developer tab loads and queries the `research_similarity_archive` table with `asset=eq.{symbol}` THEN the system returns an empty result because the `research_similarity_archive` table has no `asset` column, and the "Similarity Matches" panel displays "No matches"

1.4 WHEN the developer tab loads and queries the `drift_alerts` table with `asset=eq.{symbol}` THEN the system returns an empty result because the `drift_alerts` table has no `asset` column, and the "Continuous Learning Pipeline" panel shows incomplete data

1.5 WHEN the developer tab loads and queries `news_articles` with `sentiment_hint=neq.0` THEN the system returns no results because most articles have a sentiment_hint value of exactly 0, and the "Sentiment Engine Output" panel displays "No data"

1.6 WHEN the dashboard fetches the forecast for GBPUSD via `GET /v1/forecast/GBPUSD` without an API key THEN the system rejects the request because the `isAnonymousEligible` function in `auth.ts` only permits the exact path `/v1/forecast/eurusd`, causing "Could not load forecast for GBPUSD" on the Trader tab and "API is not responding" on the Developer tab's System Health panel

### Expected Behavior (Correct)

2.1 WHEN the developer tab loads and queries the `batch_runs` table THEN the system SHALL query without the non-existent `asset` column filter (or use a valid join through `batch_id` to correlate with asset-specific data) so that batch run records are returned and displayed in the "Latest Batch Run" panel

2.2 WHEN the developer tab loads and queries the `execution_traces` table THEN the system SHALL query without the non-existent `asset` column filter (or use a valid join through `batch_id` to correlate with asset-specific data) so that execution trace records are returned and displayed in the "Execution Traces" panel

2.3 WHEN the developer tab loads and queries the `research_similarity_archive` table THEN the system SHALL query without the non-existent `asset` column filter (or use a valid join through `batch_id` or `fingerprint_id` to correlate with asset-specific data) so that similarity match records are returned and displayed in the "Similarity Matches" panel

2.4 WHEN the developer tab loads and queries the `drift_alerts` table THEN the system SHALL query without the non-existent `asset` column filter so that drift alert records are returned and displayed in the "Continuous Learning Pipeline" panel

2.5 WHEN the developer tab loads and queries `news_articles` for the Sentiment Engine Output panel THEN the system SHALL include articles regardless of their sentiment_hint value (removing the `sentiment_hint=neq.0` filter or using a more inclusive filter) so that available articles are displayed

2.6 WHEN the dashboard fetches the forecast for any active asset (including GBPUSD) via `GET /v1/forecast/{asset}` without an API key THEN the system SHALL allow anonymous access for all assets in the Research Asset Registry, so that the Trader tab's "Current Prediction" panel and Developer tab's "System Health" panel display correctly for all assets

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the developer tab loads and queries `batch_diagnostics` THEN the system SHALL CONTINUE TO filter by `asset=eq.{symbol}` since this table has a valid `asset` column

3.2 WHEN the developer tab loads and queries `economic_events` THEN the system SHALL CONTINUE TO filter by currency using the `or=(currency.eq.{base},currency.eq.{quote})` pattern

3.3 WHEN the developer tab loads and queries `news_articles` for currency filtering THEN the system SHALL CONTINUE TO filter by currency using the `or=(currency.eq.{base},currency.eq.{quote})` pattern

3.4 WHEN the Trader tab loads data for EURUSD THEN the system SHALL CONTINUE TO display all trader view panels correctly with their existing query patterns

3.5 WHEN no data exists for a valid query THEN the system SHALL CONTINUE TO display appropriate empty-state messages with the selected asset symbol

3.6 WHEN the user switches between EURUSD and GBPUSD THEN the system SHALL CONTINUE TO update the header, title, and asset selector correctly

3.7 WHEN the forecast API is accessed with a valid API key THEN the system SHALL CONTINUE TO enforce tier-based access controls as before
