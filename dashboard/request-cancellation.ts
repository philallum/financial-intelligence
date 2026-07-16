/**
 * Request Cancellation Module
 *
 * Encapsulates the AbortController-based request cancellation pattern
 * used in the dashboard when the operator switches assets mid-fetch.
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

export interface FetcherState {
  selectedAsset: AssetConfig;
  currentAbortController: AbortController | null;
}

/**
 * Creates a new fetcher state, aborting any in-flight request.
 * Returns the new state with a fresh AbortController.
 */
export function initiateAssetFetch(state: FetcherState, newAsset: AssetConfig): FetcherState {
  // Abort previous controller
  if (state.currentAbortController) {
    state.currentAbortController.abort();
  }
  const newController = new AbortController();
  return {
    selectedAsset: newAsset,
    currentAbortController: newController,
  };
}

/**
 * Checks if an error is an AbortError that should be suppressed.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
