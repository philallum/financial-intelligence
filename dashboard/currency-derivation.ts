/**
 * Currency Derivation Module — Testable pure functions for forex currency logic.
 *
 * Extracts the currency derivation and query filter logic from the dashboard
 * so it can be validated via property-based tests without requiring a DOM.
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
// Currency Derivation
// =============================================================================

/**
 * Derives base and quote currencies from a 6-character forex symbol.
 * Base = first 3 chars, Quote = last 3 chars.
 */
export function deriveCurrencies(symbol: string): { base: string; quote: string } {
  return {
    base: symbol.slice(0, 3),
    quote: symbol.slice(3, 6),
  };
}

/**
 * Builds the Supabase query filter for currency-based queries (news, events).
 * Uses the derived currencies to create an OR filter.
 */
export function buildCurrencyFilter(base: string, quote: string): string {
  return `or=(currency.eq.${base},currency.eq.${quote})`;
}
