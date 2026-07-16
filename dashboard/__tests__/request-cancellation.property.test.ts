/**
 * Property-Based Tests for Request Cancellation on Asset Switch
 *
 * Feature: dashboard-multi-asset
 * Property 4: Request cancellation on asset switch
 *
 * Validates: Requirements 2.5
 *
 * "For any pair of different active assets where the first asset's fetch is
 * still in-flight when the second asset is selected, the first fetch SHALL be
 * aborted (its response discarded) and only data for the second asset SHALL
 * be displayed."
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  ACTIVE_ASSETS,
  initiateAssetFetch,
  isAbortError,
  type AssetConfig,
  type FetcherState,
} from '../request-cancellation.js';

// =============================================================================
// Generators
// =============================================================================

/** Generator for a random active asset from the ACTIVE_ASSETS list. */
const activeAssetArb: fc.Arbitrary<AssetConfig> = fc.constantFrom(...ACTIVE_ASSETS);

/** Generator for a pair of DIFFERENT active assets. */
const differentAssetPairArb: fc.Arbitrary<[AssetConfig, AssetConfig]> = fc
  .tuple(activeAssetArb, activeAssetArb)
  .filter(([a, b]) => a.symbol !== b.symbol);

/** Generator for a sequence of asset switches (2–6 rapid switches). */
const assetSwitchSequenceArb: fc.Arbitrary<AssetConfig[]> = fc
  .array(activeAssetArb, { minLength: 2, maxLength: 6 })
  .filter((seq) => {
    // Ensure at least one consecutive pair differs
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].symbol !== seq[i - 1].symbol) return true;
    }
    return false;
  });

// =============================================================================
// Property 4: Request cancellation on asset switch
// =============================================================================

describe('Property 4: Request cancellation on asset switch', () => {
  /**
   * Validates: Requirements 2.5
   *
   * For any pair of different assets: when a second asset is selected while
   * a fetch is in-flight for the first, the first controller's signal becomes
   * aborted and the new controller's signal is NOT aborted.
   */
  it('switching to a different asset aborts the previous in-flight request', () => {
    fc.assert(
      fc.property(differentAssetPairArb, ([firstAsset, secondAsset]) => {
        // Start with the first asset fetch in-flight
        const initialState: FetcherState = {
          selectedAsset: firstAsset,
          currentAbortController: null,
        };

        // Initiate fetch for first asset (simulates first selection)
        const stateAfterFirst = initiateAssetFetch(initialState, firstAsset);
        const firstController = stateAfterFirst.currentAbortController!;

        // First controller should NOT be aborted yet (fetch is in-flight)
        expect(firstController.signal.aborted).toBe(false);

        // Now switch to second asset while first is still in-flight
        const stateAfterSecond = initiateAssetFetch(stateAfterFirst, secondAsset);
        const secondController = stateAfterSecond.currentAbortController!;

        // First controller's signal should now be aborted
        expect(firstController.signal.aborted).toBe(true);

        // Second controller's signal should NOT be aborted
        expect(secondController.signal.aborted).toBe(false);

        // The new state should reflect the second asset
        expect(stateAfterSecond.selectedAsset.symbol).toBe(secondAsset.symbol);
      }),
      { numRuns: 100 },
    );
  });

  it('rapid sequence of asset switches aborts all intermediate controllers', () => {
    fc.assert(
      fc.property(assetSwitchSequenceArb, (assetSequence) => {
        let state: FetcherState = {
          selectedAsset: assetSequence[0],
          currentAbortController: null,
        };

        const controllers: AbortController[] = [];

        // Simulate rapid asset switches
        for (const asset of assetSequence) {
          state = initiateAssetFetch(state, asset);
          controllers.push(state.currentAbortController!);
        }

        // All intermediate controllers should be aborted
        for (let i = 0; i < controllers.length - 1; i++) {
          expect(controllers[i].signal.aborted).toBe(true);
        }

        // Only the last controller should remain active
        const lastController = controllers[controllers.length - 1];
        expect(lastController.signal.aborted).toBe(false);

        // Final state should reflect the last asset in the sequence
        const lastAsset = assetSequence[assetSequence.length - 1];
        expect(state.selectedAsset.symbol).toBe(lastAsset.symbol);
      }),
      { numRuns: 100 },
    );
  });

  it('AbortError is correctly identified for suppression', () => {
    fc.assert(
      fc.property(differentAssetPairArb, ([firstAsset, secondAsset]) => {
        // Start fetch for first asset
        const initialState: FetcherState = {
          selectedAsset: firstAsset,
          currentAbortController: null,
        };
        const stateAfterFirst = initiateAssetFetch(initialState, firstAsset);
        const firstController = stateAfterFirst.currentAbortController!;

        // Switch to second asset, aborting the first
        initiateAssetFetch(stateAfterFirst, secondAsset);

        // Simulate the AbortError that would be thrown by fetch
        const abortError = new DOMException('The operation was aborted.', 'AbortError');

        // isAbortError should identify this as an abort error to suppress
        expect(isAbortError(abortError)).toBe(true);

        // Non-abort errors should NOT be suppressed
        const networkError = new Error('Network failure');
        expect(isAbortError(networkError)).toBe(false);

        // Null/undefined should NOT be identified as abort errors
        expect(isAbortError(null)).toBe(false);
        expect(isAbortError(undefined)).toBe(false);
        expect(isAbortError('some string')).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('initiating a fetch with no previous controller does not throw', () => {
    fc.assert(
      fc.property(activeAssetArb, (asset) => {
        const initialState: FetcherState = {
          selectedAsset: ACTIVE_ASSETS[0],
          currentAbortController: null,
        };

        // Should not throw when there is no previous controller to abort
        const newState = initiateAssetFetch(initialState, asset);

        expect(newState.currentAbortController).not.toBeNull();
        expect(newState.currentAbortController!.signal.aborted).toBe(false);
        expect(newState.selectedAsset.symbol).toBe(asset.symbol);
      }),
      { numRuns: 100 },
    );
  });
});
