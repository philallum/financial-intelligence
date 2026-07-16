/**
 * Query Parameterization Module — Testable pure functions for building
 * asset-scoped query URLs and parameters.
 *
 * Extracts the query-building logic from the dashboard so it can be
 * validated via property-based tests without requiring a DOM or network.
 */

// =============================================================================
// Types
// =============================================================================

export interface AssetConfig {
  symbol: string;
  displayName: string;
  baseCurrency: string;
  quoteCurrency: string;
}

// =============================================================================
// Constants
// =============================================================================

export const ACTIVE_ASSETS: AssetConfig[] = [
  { symbol: 'EURUSD', displayName: 'EUR/USD', baseCurrency: 'EUR', quoteCurrency: 'USD' },
  { symbol: 'GBPUSD', displayName: 'GBP/USD', baseCurrency: 'GBP', quoteCurrency: 'USD' },
];

// =============================================================================
// Query Builders
// =============================================================================

/**
 * Builds the Forecast API URL for a given asset.
 * Pattern: `${apiUrl}/v1/forecast/${asset.symbol}`
 */
export function buildForecastUrl(apiUrl: string, asset: AssetConfig): string {
  return `${apiUrl}/v1/forecast/${asset.symbol}`;
}

/**
 * Builds the query params for raw_candles filtered by asset symbol.
 * Pattern: `asset=eq.${asset.symbol}`
 */
export function buildCandleParams(asset: AssetConfig): string {
  return `asset=eq.${asset.symbol}`;
}

/**
 * Builds the query params for news_articles filtered by asset currencies.
 * Pattern: `or=(currency.eq.${base},currency.eq.${quote})`
 */
export function buildNewsParams(asset: AssetConfig): string {
  return `or=(currency.eq.${asset.baseCurrency},currency.eq.${asset.quoteCurrency})`;
}

/**
 * Builds the query params for economic_events filtered by asset currencies.
 * Pattern: `or=(currency.eq.${base},currency.eq.${quote})`
 */
export function buildEventsParams(asset: AssetConfig): string {
  return `or=(currency.eq.${asset.baseCurrency},currency.eq.${asset.quoteCurrency})`;
}

/**
 * Builds the query params for research_forecasts filtered by asset symbol.
 * Pattern: `asset=eq.${asset.symbol}`
 */
export function buildResearchForecastsParams(asset: AssetConfig): string {
  return `asset=eq.${asset.symbol}`;
}

/**
 * Builds the query params for batch_runs filtered by asset symbol.
 * Pattern: `asset=eq.${asset.symbol}`
 */
export function buildBatchRunsParams(asset: AssetConfig): string {
  return `asset=eq.${asset.symbol}`;
}

/**
 * Builds the query params for execution_traces filtered by asset symbol.
 * Pattern: `asset=eq.${asset.symbol}`
 */
export function buildExecutionTracesParams(asset: AssetConfig): string {
  return `asset=eq.${asset.symbol}`;
}

/**
 * Builds the query params for batch_diagnostics filtered by asset symbol.
 * Pattern: `asset=eq.${asset.symbol}`
 */
export function buildBatchDiagnosticsParams(asset: AssetConfig): string {
  return `asset=eq.${asset.symbol}`;
}

/**
 * Builds the query params for drift_alerts filtered by asset symbol.
 * Pattern: `asset=eq.${asset.symbol}`
 */
export function buildDriftAlertsParams(asset: AssetConfig): string {
  return `asset=eq.${asset.symbol}`;
}

/**
 * Builds the query params for research_similarity_archive filtered by asset symbol.
 * Pattern: `asset=eq.${asset.symbol}`
 */
export function buildSimilarityArchiveParams(asset: AssetConfig): string {
  return `asset=eq.${asset.symbol}`;
}
