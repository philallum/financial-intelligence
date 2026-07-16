/**
 * Property-Based Tests for Currency Derivation from Forex Symbol
 *
 * Feature: dashboard-multi-asset
 * Property 5: Currency derivation from forex symbol
 *
 * Validates: Requirements 4.1, 4.2
 *
 * For any 6-character forex symbol, the base currency SHALL equal the first 3
 * characters and the quote currency SHALL equal the last 3 characters of the
 * symbol, and both derived currencies SHALL be used as filter parameters in
 * news article and economic event queries.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  deriveCurrencies,
  buildCurrencyFilter,
  ACTIVE_ASSETS,
} from '../currency-derivation.js';

// =============================================================================
// Generators
// =============================================================================

/** Generator for a single uppercase letter A-Z. */
const upperCharArb = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));

/** Generator for a single 3-character uppercase currency code. */
const currencyCodeArb = fc
  .tuple(upperCharArb, upperCharArb, upperCharArb)
  .map(([a, b, c]) => a + b + c);

/** Generator for a 6-character uppercase forex symbol (base + quote). */
const forexSymbolArb = fc
  .tuple(currencyCodeArb, currencyCodeArb)
  .map(([base, quote]) => base + quote);

// =============================================================================
// Property 5: Currency derivation from forex symbol
// =============================================================================

describe('Property 5: Currency derivation from forex symbol', () => {
  /**
   * Validates: Requirements 4.1, 4.2
   *
   * For any 6-character uppercase forex symbol, deriveCurrencies always returns
   * base === symbol.slice(0,3) and quote === symbol.slice(3,6).
   */
  it('deriveCurrencies returns first 3 chars as base and last 3 chars as quote', () => {
    fc.assert(
      fc.property(forexSymbolArb, (symbol) => {
        const { base, quote } = deriveCurrencies(symbol);
        expect(base).toBe(symbol.slice(0, 3));
        expect(quote).toBe(symbol.slice(3, 6));
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 4.1, 4.2
   *
   * For any 6-character forex symbol, buildCurrencyFilter output always
   * contains both the base and quote currencies derived from the symbol.
   */
  it('buildCurrencyFilter contains both derived currencies', () => {
    fc.assert(
      fc.property(forexSymbolArb, (symbol) => {
        const { base, quote } = deriveCurrencies(symbol);
        const filter = buildCurrencyFilter(base, quote);
        expect(filter).toContain(base);
        expect(filter).toContain(quote);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 4.1, 4.2
   *
   * The ACTIVE_ASSETS array has consistent baseCurrency/quoteCurrency — they
   * match what deriveCurrencies would produce from the symbol.
   */
  it('ACTIVE_ASSETS have consistent baseCurrency and quoteCurrency with deriveCurrencies', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ACTIVE_ASSETS), (asset) => {
        const { base, quote } = deriveCurrencies(asset.symbol);
        expect(asset.baseCurrency).toBe(base);
        expect(asset.quoteCurrency).toBe(quote);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 4.1, 4.2
   *
   * For any base and quote currency, buildCurrencyFilter output is a valid
   * Supabase PostgREST filter format: or=(currency.eq.{base},currency.eq.{quote})
   */
  it('buildCurrencyFilter output matches valid Supabase PostgREST filter format', () => {
    fc.assert(
      fc.property(currencyCodeArb, currencyCodeArb, (base, quote) => {
        const filter = buildCurrencyFilter(base, quote);
        // Must match the exact PostgREST OR filter pattern
        const expectedPattern = /^or=\(currency\.eq\.[A-Z]{3},currency\.eq\.[A-Z]{3}\)$/;
        expect(filter).toMatch(expectedPattern);
        // Verify the exact format
        expect(filter).toBe(`or=(currency.eq.${base},currency.eq.${quote})`);
      }),
      { numRuns: 100 },
    );
  });
});
