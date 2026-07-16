/**
 * Property-Based Tests for Header and Title Reflecting Selected Asset
 *
 * Feature: dashboard-multi-asset
 * Property 9: Header and title reflect the selected asset
 *
 * **Validates: Requirements 2.2, 7.1, 7.2**
 *
 * "For any active asset selected in the dashboard, the page subtitle SHALL
 * contain the asset's display name (e.g., 'EUR/USD') and the document title
 * SHALL equal '{SYMBOL} — Financial Intelligence Platform'."
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  ACTIVE_ASSETS,
  computeSubtitle,
  computeDocumentTitle,
  type AssetConfig,
} from '../header-display.js';

// =============================================================================
// Generators
// =============================================================================

/** Generator for a random active asset from the ACTIVE_ASSETS list. */
const activeAssetArb: fc.Arbitrary<AssetConfig> = fc.constantFrom(...ACTIVE_ASSETS);

/** Generator for an arbitrary AssetConfig with random but valid strings. */
const arbitraryAssetArb: fc.Arbitrary<AssetConfig> = fc.record({
  symbol: fc.stringMatching(/^[A-Z]{3,10}$/),
  displayName: fc.stringMatching(/^[A-Z]{3}\/[A-Z]{3}$/),
  baseCurrency: fc.stringMatching(/^[A-Z]{3}$/),
  quoteCurrency: fc.stringMatching(/^[A-Z]{3}$/),
});

/** Combined generator that produces both known active assets and arbitrary ones. */
const anyAssetArb: fc.Arbitrary<AssetConfig> = fc.oneof(activeAssetArb, arbitraryAssetArb);

// =============================================================================
// Property 9: Header and title reflect the selected asset
// =============================================================================

describe('Property 9: Header and title reflect the selected asset', () => {
  /**
   * Validates: Requirements 7.1
   *
   * The subtitle SHALL contain the asset's displayName.
   */
  it('computeSubtitle always contains the asset displayName', () => {
    fc.assert(
      fc.property(anyAssetArb, (asset) => {
        const subtitle = computeSubtitle(asset);
        expect(subtitle).toContain(asset.displayName);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 7.1
   *
   * The subtitle SHALL contain "Deterministic Financial Research".
   */
  it('computeSubtitle always contains "Deterministic Financial Research"', () => {
    fc.assert(
      fc.property(anyAssetArb, (asset) => {
        const subtitle = computeSubtitle(asset);
        expect(subtitle).toContain('Deterministic Financial Research');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 2.2, 7.2
   *
   * The document title SHALL start with the asset's symbol.
   */
  it('computeDocumentTitle starts with the asset symbol', () => {
    fc.assert(
      fc.property(anyAssetArb, (asset) => {
        const title = computeDocumentTitle(asset);
        expect(title.startsWith(asset.symbol)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 7.2
   *
   * The document title SHALL contain "Financial Intelligence Platform".
   */
  it('computeDocumentTitle contains "Financial Intelligence Platform"', () => {
    fc.assert(
      fc.property(anyAssetArb, (asset) => {
        const title = computeDocumentTitle(asset);
        expect(title).toContain('Financial Intelligence Platform');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 2.2, 7.2
   *
   * The document title SHALL equal exactly `${asset.symbol} — Financial Intelligence Platform`.
   */
  it('computeDocumentTitle equals exactly "{symbol} — Financial Intelligence Platform"', () => {
    fc.assert(
      fc.property(anyAssetArb, (asset) => {
        const title = computeDocumentTitle(asset);
        expect(title).toBe(`${asset.symbol} — Financial Intelligence Platform`);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Validates: Requirements 7.1
   *
   * For the known ACTIVE_ASSETS specifically, verify both subtitle and title
   * match the expected format completely.
   */
  it('for known active assets, subtitle and title match expected format', () => {
    fc.assert(
      fc.property(activeAssetArb, (asset) => {
        const subtitle = computeSubtitle(asset);
        const title = computeDocumentTitle(asset);

        // Subtitle format: "{displayName} · Deterministic Financial Research · Next 4 Hours"
        expect(subtitle).toBe(
          `${asset.displayName} · Deterministic Financial Research · Next 4 Hours`,
        );

        // Title format: "{symbol} — Financial Intelligence Platform"
        expect(title).toBe(`${asset.symbol} — Financial Intelligence Platform`);
      }),
      { numRuns: 100 },
    );
  });
});
