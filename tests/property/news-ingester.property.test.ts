import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { detectAssetId, computeRelevanceScore } from '../../src/services/integrity/news-ingester.js';

// Feature: gbpusd-asset-onboarding, Property 4: Asset detection for dual-currency mentions
// Feature: gbpusd-asset-onboarding, Property 5: Direct pair reference relevance scoring

// ─── Generators ─────────────────────────────────────────────────────────────

/**
 * Generates a filler string that does NOT contain any currency codes (uppercase sequences
 * like EUR, JPY, AUD, NZD, CAD, CHF, GBP, USD).
 * Uses only lowercase letters and digits to avoid accidental currency code matches.
 */
const safeFillerArb = fc.string({ minLength: 0, maxLength: 50 }).map((s) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, ' '),
);

/**
 * Generates text that contains both "GBP" and "USD" but no other currency codes.
 * Injects GBP and USD at random positions within safe filler text.
 */
const textWithGbpAndUsdArb = fc.tuple(safeFillerArb, safeFillerArb, safeFillerArb).map(
  ([before, middle, after]) => `${before} GBP ${middle} USD ${after}`,
);

/**
 * Generates text that contains only "GBP" (no USD, no other currency codes).
 */
const textWithOnlyGbpArb = safeFillerArb.map((filler) => `${filler} GBP ${filler}`);

/**
 * Generates text that contains only "USD" (no GBP, no other currency codes).
 */
const textWithOnlyUsdArb = safeFillerArb.map((filler) => `${filler} USD ${filler}`);

/**
 * Generates text with "GBP/USD" injected at a random position.
 */
const textWithGbpSlashUsdArb = fc.tuple(safeFillerArb, safeFillerArb).map(
  ([before, after]) => `${before} GBP/USD ${after}`,
);

/**
 * Generates text with "GBPUSD" (concatenated) injected at a random position.
 */
const textWithGbpusdConcatArb = fc.tuple(safeFillerArb, safeFillerArb).map(
  ([before, after]) => `${before} GBPUSD ${after}`,
);

/**
 * Generates text with "EUR/USD" injected at a random position (regression test).
 */
const textWithEurSlashUsdArb = fc.tuple(safeFillerArb, safeFillerArb).map(
  ([before, after]) => `${before} EUR/USD ${after}`,
);

/**
 * Generates text with "EURUSD" (concatenated) injected at a random position (regression test).
 */
const textWithEurusdConcatArb = fc.tuple(safeFillerArb, safeFillerArb).map(
  ([before, after]) => `${before} EURUSD ${after}`,
);

// ─── Property 4: Asset detection for dual-currency mentions ─────────────────

describe('Property 4: Asset detection for dual-currency mentions', () => {
  /**
   * Validates: Requirements 5.1, 5.5
   * For any text containing both "GBP" and "USD" (without other currency codes
   * that could match earlier pairs), detectAssetId SHALL return "gbpusd".
   */
  it('returns "gbpusd" when text contains both GBP and USD', () => {
    fc.assert(
      fc.property(textWithGbpAndUsdArb, (text) => {
        const result = detectAssetId(text);
        expect(result).toBe('gbpusd');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.5
   * For any text containing only "GBP" (not "USD"), detectAssetId SHALL NOT return "gbpusd".
   */
  it('does NOT return "gbpusd" when text contains only GBP', () => {
    fc.assert(
      fc.property(textWithOnlyGbpArb, (text) => {
        const result = detectAssetId(text);
        expect(result).not.toBe('gbpusd');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.5
   * For any text containing only "USD" (not "GBP"), detectAssetId SHALL NOT return "gbpusd".
   */
  it('does NOT return "gbpusd" when text contains only USD', () => {
    fc.assert(
      fc.property(textWithOnlyUsdArb, (text) => {
        const result = detectAssetId(text);
        expect(result).not.toBe('gbpusd');
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 5: Direct pair reference relevance scoring ────────────────────

describe('Property 5: Direct pair reference relevance scoring', () => {
  /**
   * Validates: Requirements 5.2
   * For any text containing "GBP/USD", computeRelevanceScore SHALL return 0.9.
   */
  it('returns 0.9 when text contains "GBP/USD"', () => {
    fc.assert(
      fc.property(textWithGbpSlashUsdArb, (text) => {
        const result = computeRelevanceScore(text);
        expect(result).toBe(0.9);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.2
   * For any text containing "GBPUSD", computeRelevanceScore SHALL return 0.9.
   */
  it('returns 0.9 when text contains "GBPUSD"', () => {
    fc.assert(
      fc.property(textWithGbpusdConcatArb, (text) => {
        const result = computeRelevanceScore(text);
        expect(result).toBe(0.9);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.2
   * Regression: "EUR/USD" still returns 0.9 after generalisation.
   */
  it('returns 0.9 when text contains "EUR/USD" (regression)', () => {
    fc.assert(
      fc.property(textWithEurSlashUsdArb, (text) => {
        const result = computeRelevanceScore(text);
        expect(result).toBe(0.9);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 5.2
   * Regression: "EURUSD" still returns 0.9 after generalisation.
   */
  it('returns 0.9 when text contains "EURUSD" (regression)', () => {
    fc.assert(
      fc.property(textWithEurusdConcatArb, (text) => {
        const result = computeRelevanceScore(text);
        expect(result).toBe(0.9);
      }),
      { numRuns: 100 },
    );
  });
});
