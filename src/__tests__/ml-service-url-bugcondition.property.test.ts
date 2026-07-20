/**
 * Bug Condition Exploration Test — ML Service URL Undefined Skips Calibration
 *
 * Property 1: Bug Condition - ML Service URL Undefined Skips Calibration
 *
 * This test encodes the EXPECTED (correct) behavior:
 * - loadEnvConfig() SHALL return a non-empty ML_SERVICE_URL string defaulting to
 *   'http://localhost:5000' when process.env['ML_SERVICE_URL'] is undefined
 * - Dashboard SHALL show actionable guidance (not generic messages) when
 *   calibration_applied: false and failure_reason: null
 *
 * EXPECTED TO FAIL on unfixed code — failure confirms the bug exists.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 2.1
 */

import { describe, it, expect } from 'vitest';
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
 * Generator for random environment states where ML_SERVICE_URL is specifically
 * undefined. Other env vars may be set/unset randomly to simulate various
 * deployment configurations.
 */
const envStateWithoutMlServiceUrlArb = fc.record({
  TWELVE_DATA_API_KEY: fc.oneof(fc.string({ minLength: 1, maxLength: 40 }), fc.constant(undefined)),
  SUPABASE_URL: fc.oneof(fc.string({ minLength: 1, maxLength: 60 }), fc.constant(undefined)),
  GCP_PROJECT_ID: fc.oneof(fc.string({ minLength: 1, maxLength: 40 }), fc.constant(undefined)),
  GCP_LOCATION: fc.oneof(fc.constantFrom('us-central1', 'europe-west1'), fc.constant(undefined)),
  NODE_ENV: fc.constantFrom('development', 'test'),
  PORT: fc.oneof(fc.constantFrom('8080', '3000', '9090'), fc.constant(undefined)),
});

/**
 * Generator for diagnostics representing the bug condition:
 * calibration_applied: false and failure_reason: null
 * (the state produced when ML_SERVICE_URL is undefined and pipeline skips ML)
 */
const bugConditionDiagnosticsArb: fc.Arbitrary<LearningPipelineDiagnostics> = fc.record({
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
  event_type: fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), fc.constant(null)),
  event_impact: fc.constant(null),
  failure_reason: fc.constant(null), // null = pipeline skipped ML entirely (bug condition)
});

// =============================================================================
// Property 1: Bug Condition — EnvConfig ML_SERVICE_URL Default
// =============================================================================

describe('Property 1: Bug Condition — ML Service URL Undefined Skips Calibration', () => {
  /**
   * Validates: Requirements 1.1, 1.2, 1.3, 2.1
   *
   * For any environment state where process.env['ML_SERVICE_URL'] is undefined,
   * loadEnvConfig() SHALL return a config object with a non-empty ML_SERVICE_URL
   * string defaulting to 'http://localhost:5000'.
   *
   * We test this by verifying the loaded `env` singleton (which reflects the
   * current state of the config module) has the ML_SERVICE_URL field.
   * Since ML_SERVICE_URL is NOT in process.env (not in .env.example, not set
   * anywhere), this tests the exact bug condition.
   */
  it('env config contains ML_SERVICE_URL with default value when env var is unset', () => {
    fc.assert(
      fc.property(envStateWithoutMlServiceUrlArb, (_envState) => {
        // The bug condition: process.env['ML_SERVICE_URL'] is undefined
        // (which is the current state - it's not in .env.example or .env)
        // Regardless of what other env vars look like, the config MUST provide ML_SERVICE_URL

        // Assert: env config object MUST have ML_SERVICE_URL property
        const configKeys = Object.keys(env);
        expect(configKeys).toContain('ML_SERVICE_URL');

        // Assert: ML_SERVICE_URL must be a non-empty string
        const mlUrl = (env as Record<string, unknown>)['ML_SERVICE_URL'];
        expect(typeof mlUrl).toBe('string');
        expect((mlUrl as string).length).toBeGreaterThan(0);

        // Assert: default value should be http://localhost:5000
        expect(mlUrl).toBe('http://localhost:5000');
      }),
      { numRuns: 50 },
    );
  });

  /**
   * Validates: Requirements 2.1
   *
   * For diagnostics with calibration_applied: false and failure_reason: null
   * (the state produced by the bug condition), the dashboard card SHALL show
   * actionable guidance — NOT generic "Calibration was not applied" or
   * "Calibration skipped" messages.
   *
   * Actionable guidance should mention ML_SERVICE_URL or specific configuration steps.
   */
  it('dashboard shows actionable guidance when failure_reason is null and calibration not applied', () => {
    fc.assert(
      fc.property(bugConditionDiagnosticsArb, (diagnostics) => {
        const diagRow: DiagRow = {
          asset: 'EURUSD',
          batch_id: 'test-batch-001',
          updated_at: new Date().toISOString(),
          diagnostics: { learning_pipeline: diagnostics },
        };

        const html = renderContinuousLearningCard([diagRow], []);

        // The card should contain actionable guidance about ML_SERVICE_URL
        // when calibration is not applied and failure_reason is null.
        // Actionable means: mentions ML_SERVICE_URL, .env, or specific fix steps
        const hasActionableGuidance =
          html.includes('ML_SERVICE_URL') ||
          html.includes('ml_service_url') ||
          html.includes('.env') ||
          html.includes('docker run') ||
          html.includes('not configured') ||
          html.includes('not running');

        // It should NOT just show generic non-actionable messages
        const hasOnlyGenericMessage =
          !hasActionableGuidance &&
          (html.includes('Calibration was not applied') ||
            html.includes('Calibration skipped') ||
            html.includes('Raw probabilities'));

        expect(hasOnlyGenericMessage).toBe(false);
        expect(hasActionableGuidance).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
