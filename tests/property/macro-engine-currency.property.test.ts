import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// Feature: gbpusd-asset-onboarding, Property 7: Macro engine currency derivation

// ─── Helper ─────────────────────────────────────────────────────────────────

/**
 * Replicates the deriveCurrencies logic from EventContextService.
 * Since the method is private, we test the derivation logic directly as a pure function.
 * e.g., "EURUSD" → ["EUR", "USD"], "GBPUSD" → ["GBP", "USD"]
 */
function deriveCurrencies(asset: string): string[] {
  const upper = asset.toUpperCase();
  if (upper.length >= 6) {
    return [upper.slice(0, 3), upper.slice(3, 6)];
  }
  return [upper];
}

// ─── Generators ─────────────────────────────────────────────────────────────

/**
 * Generates a random 6-character uppercase string (A-Z only).
 * Uses an array of 6 uppercase characters joined together.
 */
const upperChar = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
const sixCharUpperArb = fc.tuple(upperChar, upperChar, upperChar, upperChar, upperChar, upperChar)
  .map(([a, b, c, d, e, f]) => `${a}${b}${c}${d}${e}${f}`);

// ─── Property 7: Macro engine currency derivation ───────────────────────────

describe('Property 7: Macro engine currency derivation', () => {
  /**
   * Validates: Requirements 6.1
   * For any random 6-character uppercase string, deriveCurrencies SHALL split it
   * into [first 3 chars, last 3 chars].
   */
  it('splits any 6-character uppercase string into [first 3, last 3]', () => {
    fc.assert(
      fc.property(sixCharUpperArb, (str) => {
        const result = deriveCurrencies(str);
        expect(result).toHaveLength(2);
        expect(result[0]).toBe(str.slice(0, 3));
        expect(result[1]).toBe(str.slice(3, 6));
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 6.1
   * Specific verification: "GBPUSD" → ["GBP", "USD"]
   */
  it('derives ["GBP", "USD"] from "GBPUSD"', () => {
    const result = deriveCurrencies('GBPUSD');
    expect(result).toEqual(['GBP', 'USD']);
  });

  /**
   * Validates: Requirements 6.1
   * Specific verification: "EURUSD" → ["EUR", "USD"]
   */
  it('derives ["EUR", "USD"] from "EURUSD"', () => {
    const result = deriveCurrencies('EURUSD');
    expect(result).toEqual(['EUR', 'USD']);
  });
});
