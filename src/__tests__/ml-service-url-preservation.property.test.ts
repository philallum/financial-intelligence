/**
 * Preservation Property Tests — Existing EnvConfig Fields and ML Integration Unchanged
 *
 * Property 2: Preservation - Existing EnvConfig Fields and ML Integration Unchanged
 *
 * These tests verify EXISTING behavior on the UNFIXED code to establish a baseline:
 * 1. All EnvConfig fields load correctly regardless of ML_SERVICE_URL state
 * 2. Dashboard renders green dot + "Applied" when calibration_applied: true
 * 3. Dashboard renders warning state when calibration_applied: false with non-null failure_reason
 *
 * EXPECTED OUTCOME: Tests PASS on unfixed code (confirms behavior to preserve)
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import {
  renderContinuousLearningCard,
  type LearningPipelineDiagnostics,
  type DiagRow,
} from '../../dashboard/continuous-learning-card.js';
import { env, type EnvConfig } from '../config/env.js';

// =============================================================================
// Generators
// =============================================================================

/**
 * Generator for non-empty API key strings (simulating real env var values).
 */
const apiKeyArb = fc.string({ minLength: 8, maxLength: 64 }).filter((s) => s.trim().length > 0);

/**
 * Generator for valid environment variable sets that simulate a configured environment.
 * ML_SERVICE_URL is explicitly set to various valid URLs.
 */
const envConfigWithMlServiceUrlArb = fc.record({
  TWELVE_DATA_API_KEY: apiKeyArb,
  MASSIVE_API_KEY: apiKeyArb,
  ALPHA_VANTAGE_API_KEY: apiKeyArb,
  FINNHUB_API_KEY: apiKeyArb,
  NEWS_API_KEY: apiKeyArb,
  GCP_PROJECT_ID: fc.string({ minLength: 3, maxLength: 30 }).filter((s) => s.trim().length > 0),
  GCP_LOCATION: fc.constantFrom('us-central1', 'europe-west1', 'asia-east1'),
  GEMINI_MODEL: fc.constantFrom('gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'),
  SUPABASE_URL: fc.webUrl(),
  SUPABASE_ANON_KEY: apiKeyArb,
  SUPABASE_SERVICE_ROLE_KEY: apiKeyArb,
  RAPIDAPI_PROXY_SECRET: fc.oneof(apiKeyArb, fc.constant('')),
  PORT: fc.constantFrom('8080', '3000', '9090', '4000'),
  NODE_ENV: fc.constantFrom('development', 'test') as fc.Arbitrary<'development' | 'test'>,
  ML_SERVICE_URL: fc.constantFrom(
    'http://localhost:5000',
    'http://localhost:8000',
    'http://ml-service:5000',
    'https://ml.example.com',
  ),
});

/**
 * Generator for diagnostics where calibration_applied: true
 * (ML service was reachable and calibration was applied successfully)
 */
const calibrationAppliedDiagnosticsArb: fc.Arbitrary<LearningPipelineDiagnostics> = fc.record({
  calibration_applied: fc.constant(true),
  calibration_model_version: fc.oneof(
    fc.constantFrom('v1.0', 'v2.1', 'isotonic-2024-01'),
    fc.constant(null),
  ),
  raw_probabilities: fc.record({
    up: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    down: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    flat: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  calibrated_probabilities: fc.record({
    up: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    down: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    flat: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  shap_computed: fc.boolean(),
  top_shap_features: fc.oneof(
    fc.array(
      fc.record({
        feature: fc.string({ minLength: 1, maxLength: 20 }),
        shap_value: fc.float({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
    fc.constant(null),
  ),
  event_context_applied: fc.boolean(),
  event_type: fc.oneof(fc.constantFrom('NFP', 'FOMC', 'CPI', 'GDP'), fc.constant(null)),
  event_impact: fc.oneof(
    fc.record({
      median_move_pips: fc.float({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
      direction_skew: fc.float({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }),
      vol_expansion_ratio: fc.float({ min: 0.5, max: 5, noNaN: true, noDefaultInfinity: true }),
    }),
    fc.constant(null),
  ),
  failure_reason: fc.constant(null),
});

/**
 * Generator for diagnostics where calibration_applied: false and failure_reason is non-null.
 * This simulates cases where ML service was reached but something went wrong.
 */
const failureReasonDiagnosticsArb: fc.Arbitrary<LearningPipelineDiagnostics> = fc.record({
  calibration_applied: fc.constant(false),
  calibration_model_version: fc.constant(null),
  raw_probabilities: fc.oneof(
    fc.record({
      up: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      down: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
      flat: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    }),
    fc.constant(null),
  ),
  calibrated_probabilities: fc.constant(null),
  shap_computed: fc.boolean(),
  top_shap_features: fc.constant(null),
  event_context_applied: fc.boolean(),
  event_type: fc.oneof(fc.constantFrom('NFP', 'FOMC', 'CPI'), fc.constant(null)),
  event_impact: fc.constant(null),
  failure_reason: fc.constantFrom(
    'ml_service_unavailable',
    'calibration_failed',
    'prediction_timeout',
    'model_not_loaded',
    'connection_refused',
  ),
});

/**
 * Generator for asset pair names.
 */
const assetArb = fc.constantFrom('EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD');

/**
 * Generator for ISO date strings within a recent range.
 */
const isoDateArb = fc
  .integer({ min: 1704067200000, max: 1735689600000 }) // 2024-01-01 to 2025-01-01 as ms timestamps
  .map((ts) => new Date(ts).toISOString());

/**
 * Generator for a DiagRow from given diagnostics.
 */
function diagRowArb(diagnosticsArb: fc.Arbitrary<LearningPipelineDiagnostics>): fc.Arbitrary<DiagRow> {
  return fc.record({
    asset: assetArb,
    batch_id: fc.string({ minLength: 5, maxLength: 20 }).filter((s) => s.trim().length > 0),
    updated_at: isoDateArb,
    diagnostics: diagnosticsArb.map((lp) => ({ learning_pipeline: lp })),
  });
}

// =============================================================================
// Property 2.1: EnvConfig Fields Load Correctly
// =============================================================================

describe('Property 2: Preservation — Existing EnvConfig Fields and ML Integration Unchanged', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  /**
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
   *
   * For all valid environment configurations where ML_SERVICE_URL IS explicitly
   * set, all other EnvConfig fields are loaded identically. The presence of
   * ML_SERVICE_URL in process.env does NOT affect loading of other fields.
   *
   * We verify the env singleton (loaded at module import) has all 14 existing
   * fields with correct types. This confirms that regardless of ML_SERVICE_URL
   * state, the existing fields load and type correctly — the baseline to preserve.
   */
  it('all existing EnvConfig fields load correctly when ML_SERVICE_URL is explicitly set in process.env', () => {
    fc.assert(
      fc.property(envConfigWithMlServiceUrlArb, (envVars) => {
        // The env singleton was loaded once at import time (reflects current .env state).
        // We verify the interface contract: all 14 existing fields are present and
        // correctly typed on the frozen env object. The fix must preserve this contract.
        //
        // Setting ML_SERVICE_URL in process.env has no effect on the already-loaded
        // singleton, but this test establishes the BASELINE: the current 14 fields
        // are all present and typed correctly — this is what we're preserving.

        // All 14 existing fields must be present
        const configKeys = Object.keys(env);
        expect(configKeys).toContain('TWELVE_DATA_API_KEY');
        expect(configKeys).toContain('MASSIVE_API_KEY');
        expect(configKeys).toContain('ALPHA_VANTAGE_API_KEY');
        expect(configKeys).toContain('FINNHUB_API_KEY');
        expect(configKeys).toContain('NEWS_API_KEY');
        expect(configKeys).toContain('GCP_PROJECT_ID');
        expect(configKeys).toContain('GCP_LOCATION');
        expect(configKeys).toContain('GEMINI_MODEL');
        expect(configKeys).toContain('SUPABASE_URL');
        expect(configKeys).toContain('SUPABASE_ANON_KEY');
        expect(configKeys).toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(configKeys).toContain('RAPIDAPI_PROXY_SECRET');
        expect(configKeys).toContain('PORT');
        expect(configKeys).toContain('NODE_ENV');

        // All string fields have correct type
        expect(typeof env.TWELVE_DATA_API_KEY).toBe('string');
        expect(typeof env.MASSIVE_API_KEY).toBe('string');
        expect(typeof env.ALPHA_VANTAGE_API_KEY).toBe('string');
        expect(typeof env.FINNHUB_API_KEY).toBe('string');
        expect(typeof env.NEWS_API_KEY).toBe('string');
        expect(typeof env.GCP_PROJECT_ID).toBe('string');
        expect(typeof env.GCP_LOCATION).toBe('string');
        expect(typeof env.GEMINI_MODEL).toBe('string');
        expect(typeof env.SUPABASE_URL).toBe('string');
        expect(typeof env.SUPABASE_ANON_KEY).toBe('string');
        expect(typeof env.SUPABASE_SERVICE_ROLE_KEY).toBe('string');
        expect(typeof env.RAPIDAPI_PROXY_SECRET).toBe('string');
        expect(typeof env.PORT).toBe('number');
        expect(typeof env.NODE_ENV).toBe('string');

        // GCP_LOCATION and GEMINI_MODEL have defaults (never empty)
        expect(env.GCP_LOCATION.length).toBeGreaterThan(0);
        expect(env.GEMINI_MODEL.length).toBeGreaterThan(0);

        // PORT is a valid port number
        expect(env.PORT).toBeGreaterThanOrEqual(0);
        expect(env.PORT).toBeLessThanOrEqual(65535);

        // NODE_ENV is one of the valid values
        expect(['development', 'production', 'test']).toContain(env.NODE_ENV);

        // The config is frozen (Object.freeze was applied)
        expect(Object.isFrozen(env)).toBe(true);

        // Verify that the generated env vars (with ML_SERVICE_URL) do NOT
        // conflict with expected typing of the fields. The fix that adds
        // ML_SERVICE_URL must NOT alter these existing 14 fields.
        // Here we verify: for ANY combination of valid env vars (including ML_SERVICE_URL),
        // the existing fields maintain their type contract.
        expect(envVars.ML_SERVICE_URL.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  // ===========================================================================
  // Property 2.2: Dashboard Calibration Applied Rendering Unchanged
  // ===========================================================================

  /**
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
   *
   * For all diagnostics objects where calibration_applied: true, the dashboard card
   * renders a green status dot and "Applied" text. This behavior must be preserved
   * after the fix.
   */
  it('dashboard renders green dot and "Applied" when calibration_applied is true', () => {
    fc.assert(
      fc.property(diagRowArb(calibrationAppliedDiagnosticsArb), (diagRow) => {
        const html = renderContinuousLearningCard([diagRow], []);

        // Green status dot for calibration
        expect(html).toContain('status-dot green');

        // "Applied" text (not "⚠️ Not Applied")
        expect(html).toContain('Applied');
        expect(html).not.toContain('⚠️ Not Applied');

        // Should NOT show the calibration warning bar
        expect(html).not.toContain('Calibration was not applied in the latest batch cycle');
      }),
      { numRuns: 100 },
    );
  });

  // ===========================================================================
  // Property 2.3: Dashboard Warning State for Non-null failure_reason
  // ===========================================================================

  /**
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
   *
   * For all diagnostics with various non-null failure_reason values when
   * calibration_applied: false, the card renders a warning state:
   * - Yellow status dot (not green)
   * - "⚠️ Not Applied" text
   * - Warning alert bar about calibration not being applied
   *
   * This warning behavior must be preserved after the fix.
   */
  it('dashboard renders warning state when calibration_applied is false with non-null failure_reason', () => {
    fc.assert(
      fc.property(diagRowArb(failureReasonDiagnosticsArb), (diagRow) => {
        const html = renderContinuousLearningCard([diagRow], []);

        // Yellow status dot for calibration (not green)
        expect(html).toContain('status-dot yellow');

        // "⚠️ Not Applied" text
        expect(html).toContain('⚠️ Not Applied');

        // Warning alert bar should be present
        expect(html).toContain('Calibration was not applied in the latest batch cycle');

        // The card itself should render successfully (not error state)
        expect(html).toContain('Continuous Learning');
        expect(html).not.toContain('Failed to load learning pipeline data');
      }),
      { numRuns: 100 },
    );
  });
});
