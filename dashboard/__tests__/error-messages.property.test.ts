/**
 * Property-Based Tests for Dashboard Error Messages
 *
 * Feature: dashboard-multi-asset
 * Property 3: Error messages identify the asset
 *
 * Validates: Requirements 1.6, 2.4, 3.4
 *
 * For any active asset and any data-fetching failure (HTTP error, timeout,
 * network error), the displayed error message SHALL contain the selected
 * asset's symbol so the operator can identify which asset's data failed to load.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { generateErrorHtml, ACTIVE_ASSETS } from '../error-display.js';

// =============================================================================
// Generators
// =============================================================================

/** Generator for active asset symbols. */
const activeAssetSymbolArb = fc.constantFrom(...ACTIVE_ASSETS.map(a => a.symbol));

/** Generator for component names (non-empty strings). */
const componentNameArb = fc.string({ minLength: 1, maxLength: 50 });

/** Generator for HTTP error messages. */
const httpErrorArb = fc.integer({ min: 400, max: 599 }).map(code => `HTTP ${code}`);

/** Generator for timeout error messages. */
const timeoutErrorArb = fc.integer({ min: 1, max: 120 }).map(secs => `Request timeout after ${secs}s`);

/** Generator for network error messages. */
const networkErrorArb = fc.constantFrom(
  'Network error',
  'CORS blocked',
  'DNS resolution failed',
  'Connection refused',
  'Socket hang up',
);

/** Generator for any error type. */
const anyErrorArb = fc.oneof(httpErrorArb, timeoutErrorArb, networkErrorArb);

// =============================================================================
// Property 3: Error messages identify the asset
// =============================================================================

describe('Property 3: Error messages identify the asset', () => {
  /**
   * Validates: Requirements 1.6, 2.4, 3.4
   *
   * For ANY active asset symbol and ANY error message string, the generated
   * error HTML ALWAYS contains the asset symbol so the operator can identify
   * which asset's data failed to load.
   */
  it('error HTML always contains the asset symbol', () => {
    fc.assert(
      fc.property(activeAssetSymbolArb, componentNameArb, anyErrorArb, (asset, component, error) => {
        const html = generateErrorHtml(asset, component, error);
        expect(html).toContain(asset);
      }),
      { numRuns: 100 },
    );
  });

  it('error HTML always contains the component name', () => {
    fc.assert(
      fc.property(activeAssetSymbolArb, componentNameArb, anyErrorArb, (asset, component, error) => {
        const html = generateErrorHtml(asset, component, error);
        expect(html).toContain(component);
      }),
      { numRuns: 100 },
    );
  });

  it('error HTML always contains the error description', () => {
    fc.assert(
      fc.property(activeAssetSymbolArb, componentNameArb, anyErrorArb, (asset, component, error) => {
        const html = generateErrorHtml(asset, component, error);
        expect(html).toContain(error);
      }),
      { numRuns: 100 },
    );
  });

  it('error HTML is never empty', () => {
    fc.assert(
      fc.property(activeAssetSymbolArb, componentNameArb, anyErrorArb, (asset, component, error) => {
        const html = generateErrorHtml(asset, component, error);
        expect(html.trim().length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('error HTML contains error color styling (#ff1744) for visibility', () => {
    fc.assert(
      fc.property(activeAssetSymbolArb, componentNameArb, anyErrorArb, (asset, component, error) => {
        const html = generateErrorHtml(asset, component, error);
        expect(html).toContain('#ff1744');
      }),
      { numRuns: 100 },
    );
  });

  it('error HTML contains the card class for consistent layout', () => {
    fc.assert(
      fc.property(activeAssetSymbolArb, componentNameArb, anyErrorArb, (asset, component, error) => {
        const html = generateErrorHtml(asset, component, error);
        expect(html).toContain('class="card grid-full"');
      }),
      { numRuns: 100 },
    );
  });
});
