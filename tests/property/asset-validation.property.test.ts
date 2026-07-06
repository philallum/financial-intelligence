import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import request from 'supertest';
import { createApp } from '../../src/api/server.js';

/**
 * Property 16: Unsupported Asset Error
 * Validates: Requirements 14.1
 *
 * For ANY random string that is NOT in the supported assets list (currently "EURUSD"),
 * the forecast endpoint should ALWAYS return HTTP 400 with error code "asset_not_supported"
 * and include the supported assets in the response message.
 */

// --- Mock Supabase client ---

function createMockSupabase() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: { message: 'not found' } }),
        }),
      }),
    }),
  } as any;
}

// --- Generators ---

/**
 * Generator for random asset strings that are NOT "EURUSD" (case-insensitive).
 * Produces alphanumeric strings that are valid URL path segments.
 */
const unsupportedAssetArb = fc.string({
  minLength: 1,
  maxLength: 20,
  unit: fc.constantFrom(
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  ),
}).filter((s) => s.toUpperCase() !== 'EURUSD');

// --- Tests ---

describe('Property 16: Unsupported Asset Error', () => {
  const app = createApp({ supabase: createMockSupabase() });

  /**
   * Validates: Requirements 14.1
   * For any string that is not "EURUSD" (case-insensitive), the forecast endpoint
   * returns HTTP 400 with error code "asset_not_supported" and lists supported assets.
   */
  it('returns 400 with asset_not_supported for any unsupported asset', async () => {
    await fc.assert(
      fc.asyncProperty(unsupportedAssetArb, async (asset) => {
        const res = await request(app).get(`/v1/forecast/${asset}`);

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('asset_not_supported');
        expect(res.body.asset).toBe(asset.toUpperCase());
        expect(res.body.message).toContain('EURUSD');
      }),
      { numRuns: 100 },
    );
  });
});
