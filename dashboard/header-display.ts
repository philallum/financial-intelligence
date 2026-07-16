/**
 * Header Display Module
 *
 * Encapsulates the pure logic for computing the page subtitle and document title
 * based on the currently selected asset. This extracts the core computation from
 * the dashboard's `updateHeader()` function for testability without DOM dependency.
 *
 * This module extracts the core logic from dashboard/index.html for testability.
 */

export interface AssetConfig {
  symbol: string;
  displayName: string;
  baseCurrency: string;
  quoteCurrency: string;
}

export const ACTIVE_ASSETS: AssetConfig[] = [
  { symbol: 'EURUSD', displayName: 'EUR/USD', baseCurrency: 'EUR', quoteCurrency: 'USD' },
  { symbol: 'GBPUSD', displayName: 'GBP/USD', baseCurrency: 'GBP', quoteCurrency: 'USD' },
];

/**
 * Computes the subtitle text for the given asset.
 */
export function computeSubtitle(asset: AssetConfig): string {
  return `${asset.displayName} · Deterministic Financial Research · Next 4 Hours`;
}

/**
 * Computes the document title for the given asset.
 */
export function computeDocumentTitle(asset: AssetConfig): string {
  return `${asset.symbol} — Financial Intelligence Platform`;
}
