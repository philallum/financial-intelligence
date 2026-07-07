import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import { createForecastRouter } from '../../src/api/routes/forecast.js';

/**
 * Property 16: Unsupported Asset Error
 * Validates: Requirements 14.1
 *
 * For ANY random string that is NOT in the supported assets list (currently "EURUSD"),
 * the forecast endpoint should ALWAYS return HTTP 400 with error code "asset_not_supported"
 * and include the supported assets in the response message.
 *
 * Tests the route handler directly (bypassing auth) to isolate the asset validation logic.
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

/**
 * Creates a minimal app that tests the forecast route directly,
 * simulating an authenticated request (bypassing the full middleware chain).
 */
function createTestApp() {
  const app = express();
  // Simulate request-id middleware
  app.use((req, _res, next) => {
    req.requestId = 'test-request-id';
    req.anonymous = false;
    req.tier = 'RETAIL' as any;
    next();
  });
  app.use('/v1/forecast', createForecastRouter({ supabase: createMockSupabase() }));
  return app;
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
  const app = createTestApp();

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
        expect(res.body.message).toContain('EURUSD');
        expect(res.body.message).toContain(asset.toUpperCase());
      }),
      { numRuns: 100 },
    );
  });
});
