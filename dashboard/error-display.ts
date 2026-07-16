/**
 * Error Display Module — Testable pure functions for error rendering.
 *
 * Extracts the error display logic from the dashboard so it can be
 * validated via property-based tests without requiring a DOM.
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
// Error HTML Generation
// =============================================================================

/**
 * Generates error message HTML for display in the dashboard.
 * The error message MUST contain the asset symbol so the operator
 * can identify which asset's data failed to load.
 */
export function generateErrorHtml(asset: string, component: string, error: string): string {
  return `<div class="card grid-full">
    <p style="color:#ff1744">Failed to load ${component} for ${asset}: ${error}</p>
  </div>`;
}
