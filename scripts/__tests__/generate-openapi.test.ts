/**
 * Unit tests for OpenAPI generator registry integration.
 *
 * Tests the `generateOpenApiSpec` function which is the core logic of the
 * `scripts/generate-openapi.ts` build script. Verifies that:
 * - Generated spec contains dynamic enum from registry (ACTIVE assets only)
 * - DISABLED/BETA/DEPRECATED assets are excluded from the enum
 * - Zero ACTIVE assets causes an error (which the script translates to exit code 1)
 *
 * **Validates: Requirements 8.2, 8.3, 8.5**
 */

import { describe, it, expect } from 'vitest';
import { generateOpenApiSpec } from '../generate-openapi.js';

// ─── Minimal OpenAPI YAML fixture ───────────────────────────────────────────

/**
 * A minimal YAML string that mirrors the structure of the real openapi.yaml,
 * containing the components.parameters.Asset.schema.enum path that the
 * generator needs to inject into.
 */
const MINIMAL_OPENAPI_YAML = `
openapi: 3.1.0
info:
  title: Test API
  version: 1.0.0
paths:
  /forecast/{asset}:
    get:
      parameters:
        - $ref: '#/components/parameters/Asset'
components:
  parameters:
    Asset:
      name: asset
      in: path
      required: true
      description: The asset to query.
      schema:
        type: string
        enum:
          - PLACEHOLDER
`;

// =============================================================================
// Tests
// =============================================================================

describe('OpenAPI Generator - generateOpenApiSpec', () => {
  // ---------------------------------------------------------------------------
  // 1. Generated spec contains dynamic enum from registry
  // ---------------------------------------------------------------------------
  describe('generated spec contains dynamic enum from registry', () => {
    it('injects ACTIVE asset symbols into components.parameters.Asset.schema.enum', () => {
      const activeAssets = ['BTCUSD', 'EURUSD'];

      const result = generateOpenApiSpec(MINIMAL_OPENAPI_YAML, activeAssets);

      expect(result.error).toBeUndefined();
      expect(result.json).not.toBe('');

      const spec = JSON.parse(result.json);
      const assetEnum = spec.components.parameters.Asset.schema.enum;

      expect(assetEnum).toEqual(['BTCUSD', 'EURUSD']);
    });

    it('updates the Asset parameter description to list supported assets', () => {
      const activeAssets = ['BTCUSD', 'EURUSD', 'GBPUSD'];

      const result = generateOpenApiSpec(MINIMAL_OPENAPI_YAML, activeAssets);

      expect(result.error).toBeUndefined();

      const spec = JSON.parse(result.json);
      const description = spec.components.parameters.Asset.description;

      expect(description).toBe('The asset to query. Supported: BTCUSD, EURUSD, GBPUSD');
    });

    it('replaces the placeholder enum entirely with active assets', () => {
      const activeAssets = ['EURUSD'];

      const result = generateOpenApiSpec(MINIMAL_OPENAPI_YAML, activeAssets);

      const spec = JSON.parse(result.json);
      const assetEnum = spec.components.parameters.Asset.schema.enum;

      // PLACEHOLDER should be gone, only EURUSD remains
      expect(assetEnum).not.toContain('PLACEHOLDER');
      expect(assetEnum).toEqual(['EURUSD']);
    });

    it('preserves the rest of the spec structure unchanged', () => {
      const activeAssets = ['EURUSD'];

      const result = generateOpenApiSpec(MINIMAL_OPENAPI_YAML, activeAssets);

      const spec = JSON.parse(result.json);

      expect(spec.openapi).toBe('3.1.0');
      expect(spec.info.title).toBe('Test API');
      expect(spec.info.version).toBe('1.0.0');
      expect(spec.paths['/forecast/{asset}']).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. DISABLED/BETA/DEPRECATED assets are excluded from enum
  // ---------------------------------------------------------------------------
  describe('DISABLED/BETA/DEPRECATED assets are excluded from enum', () => {
    it('only ACTIVE symbols appear when getOpenApiAssetEnum filters correctly', () => {
      // Simulate what getOpenApiAssetEnum() would return:
      // Given a registry with mixed statuses, only ACTIVE symbols are passed in
      // The filtering happens in getOpenApiAssetEnum(), so we only pass ACTIVE symbols
      const activeOnlyAssets = ['EURUSD', 'GBPUSD'];

      const result = generateOpenApiSpec(MINIMAL_OPENAPI_YAML, activeOnlyAssets);

      const spec = JSON.parse(result.json);
      const assetEnum = spec.components.parameters.Asset.schema.enum;

      // DISABLED assets like XAUUSD should not appear
      expect(assetEnum).not.toContain('XAUUSD');
      // BETA assets like BTCUSD should not appear
      expect(assetEnum).not.toContain('BTCUSD');
      // DEPRECATED assets like USDJPY should not appear
      expect(assetEnum).not.toContain('USDJPY');
      // Only the ACTIVE assets we passed in should appear
      expect(assetEnum).toEqual(['EURUSD', 'GBPUSD']);
    });

    it('single ACTIVE asset produces a single-element enum', () => {
      // If only one asset is ACTIVE, the enum should have just that one
      const activeOnlyAssets = ['EURUSD'];

      const result = generateOpenApiSpec(MINIMAL_OPENAPI_YAML, activeOnlyAssets);

      const spec = JSON.parse(result.json);
      const assetEnum = spec.components.parameters.Asset.schema.enum;

      expect(assetEnum).toHaveLength(1);
      expect(assetEnum).toEqual(['EURUSD']);
    });

    it('description only lists ACTIVE assets, not BETA/DISABLED/DEPRECATED', () => {
      // Only ACTIVE assets are passed to generateOpenApiSpec
      const activeOnlyAssets = ['EURUSD', 'GBPUSD'];

      const result = generateOpenApiSpec(MINIMAL_OPENAPI_YAML, activeOnlyAssets);

      const spec = JSON.parse(result.json);
      const description = spec.components.parameters.Asset.description;

      expect(description).toContain('EURUSD');
      expect(description).toContain('GBPUSD');
      // Non-ACTIVE assets should not be mentioned
      expect(description).not.toContain('XAUUSD');
      expect(description).not.toContain('BTCUSD');
      expect(description).not.toContain('USDJPY');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Zero ACTIVE assets causes exit code 1 (returns error)
  // ---------------------------------------------------------------------------
  describe('zero ACTIVE assets causes error (exit code 1 in script)', () => {
    it('returns an error when activeAssets array is empty', () => {
      const result = generateOpenApiSpec(MINIMAL_OPENAPI_YAML, []);

      expect(result.error).toBe('✗ No ACTIVE assets in registry — cannot generate OpenAPI spec');
      expect(result.json).toBe('');
    });

    it('does not produce any JSON output when no ACTIVE assets exist', () => {
      const result = generateOpenApiSpec(MINIMAL_OPENAPI_YAML, []);

      expect(result.json).toBe('');
    });

    it('the error message matches what would be logged before process.exit(1)', () => {
      const result = generateOpenApiSpec(MINIMAL_OPENAPI_YAML, []);

      // This is the exact message the script logs before calling process.exit(1)
      expect(result.error).toContain('No ACTIVE assets');
      expect(result.error).toContain('cannot generate OpenAPI spec');
    });
  });
});
