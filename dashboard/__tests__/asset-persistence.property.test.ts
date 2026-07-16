/**
 * Property-Based Tests for Asset Selection Persistence Across Tab Switches
 *
 * Feature: dashboard-multi-asset
 * Property 2: Asset selection persists across tab switches
 *
 * **Validates: Requirements 1.4**
 *
 * "For any active asset and any sequence of tab switches between Trader View
 * and Developer View, the selected asset SHALL remain unchanged after each
 * switch — the asset state is never reset by a tab change."
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  ACTIVE_ASSETS,
  switchTab,
  selectAsset,
  type AssetConfig,
  type TabId,
  type DashboardState,
} from '../asset-persistence.js';

// =============================================================================
// Generators
// =============================================================================

/** Generator for a random active asset from the ACTIVE_ASSETS list. */
const activeAssetArb: fc.Arbitrary<AssetConfig> = fc.constantFrom(...ACTIVE_ASSETS);

/** Generator for a random tab id. */
const tabArb: fc.Arbitrary<TabId> = fc.constantFrom('trader', 'developer');

/** Generator for a sequence of tab switches (1–20 switches). */
const tabSwitchSequenceArb: fc.Arbitrary<TabId[]> = fc.array(
  fc.constantFrom('trader', 'developer'),
  { minLength: 1, maxLength: 20 },
);

// =============================================================================
// Property 2: Asset selection persists across tab switches
// =============================================================================

describe('Property 2: Asset selection persists across tab switches', () => {
  /**
   * Validates: Requirements 1.4
   *
   * For any active asset and any sequence of tab switches, the selectedAsset
   * remains unchanged after each switch.
   */
  it('selected asset remains unchanged after any sequence of tab switches', () => {
    fc.assert(
      fc.property(activeAssetArb, tabArb, tabSwitchSequenceArb, (asset, initialTab, tabSwitches) => {
        // Start with a known asset and tab
        let state: DashboardState = {
          selectedAsset: asset,
          activeTab: initialTab,
        };

        // Apply every tab switch in the sequence
        for (const newTab of tabSwitches) {
          state = switchTab(state, newTab);
          // After each switch, the selected asset must remain the same
          expect(state.selectedAsset).toStrictEqual(asset);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('a single tab switch never resets the selected asset', () => {
    fc.assert(
      fc.property(activeAssetArb, tabArb, tabArb, (asset, initialTab, newTab) => {
        const state: DashboardState = {
          selectedAsset: asset,
          activeTab: initialTab,
        };

        const newState = switchTab(state, newTab);

        // The asset must be identical before and after the tab switch
        expect(newState.selectedAsset.symbol).toBe(asset.symbol);
        expect(newState.selectedAsset.displayName).toBe(asset.displayName);
        expect(newState.selectedAsset.baseCurrency).toBe(asset.baseCurrency);
        expect(newState.selectedAsset.quoteCurrency).toBe(asset.quoteCurrency);
      }),
      { numRuns: 100 },
    );
  });

  it('switching tabs updates the active tab without affecting asset selection', () => {
    fc.assert(
      fc.property(activeAssetArb, tabArb, tabArb, (asset, initialTab, newTab) => {
        const state: DashboardState = {
          selectedAsset: asset,
          activeTab: initialTab,
        };

        const newState = switchTab(state, newTab);

        // Tab should be updated
        expect(newState.activeTab).toBe(newTab);
        // Asset should be preserved
        expect(newState.selectedAsset).toStrictEqual(asset);
      }),
      { numRuns: 100 },
    );
  });

  it('asset selection followed by tab switches preserves the most recently selected asset', () => {
    fc.assert(
      fc.property(activeAssetArb, activeAssetArb, tabArb, tabSwitchSequenceArb, (firstAsset, secondAsset, initialTab, tabSwitches) => {
        // Start with firstAsset
        let state: DashboardState = {
          selectedAsset: firstAsset,
          activeTab: initialTab,
        };

        // Select a different asset
        state = selectAsset(state, secondAsset);
        expect(state.selectedAsset).toStrictEqual(secondAsset);

        // Apply tab switches — asset must remain the second one
        for (const newTab of tabSwitches) {
          state = switchTab(state, newTab);
          expect(state.selectedAsset).toStrictEqual(secondAsset);
        }
      }),
      { numRuns: 100 },
    );
  });
});
