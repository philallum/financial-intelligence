/**
 * Property-Based Test: Record Provenance Completeness
 *
 * Property 5: Record Provenance Completeness
 * - Generate random valid ResearchForecastRecords
 * - Verify batch_id (UUID), engine_versions (non-empty), created_at (ISO-8601) are non-null
 * - Verify fingerprint_id is non-null and non-empty
 *
 * **Validates: Requirements 3.3, 7.11, 9.1, 10.2**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import type { ResearchForecastRecord } from '../../../src/research/persistence/types.js';

// =============================================================================
// Constants
// =============================================================================

/** UUID v4 regex pattern. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ISO-8601 timestamp regex (accepts both Z and ±HH:MM offset). */
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// =============================================================================
// Arbitraries
// =============================================================================

/** Generates a valid UUID v4 string. */
const arbUuid: fc.Arbitrary<string> = fc.uuid();

/** Generates a valid ISO-8601 UTC timestamp from a Unix timestamp in milliseconds. */
const arbIso8601: fc.Arbitrary<string> = fc.integer({
  min: new Date('2020-01-01T00:00:00Z').getTime(),
  max: new Date('2030-12-31T23:59:59Z').getTime(),
}).map(ms => new Date(ms).toISOString());

/** Generates a non-empty engine_versions record. */
const arbEngineVersions: fc.Arbitrary<Record<string, string>> = fc.dictionary(
  fc.stringMatching(/^[a-z][a-z0-9_]{2,20}$/),
  fc.stringMatching(/^v\d+\.\d+\.\d+$/),
  { minKeys: 1, maxKeys: 5 },
);

/** Generates a valid ResearchForecastRecord with random data. */
const arbResearchForecastRecord: fc.Arbitrary<ResearchForecastRecord> = fc.record({
  fingerprint_id: arbUuid,
  batch_id: arbUuid,
  asset: fc.constantFrom('EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'NZDUSD', 'USDCAD'),
  timeframe: fc.constant('4H'),
  forecast_timestamp: arbIso8601,
  forecast_expiry: arbIso8601,
  direction_probabilities: fc.record({
    up: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    down: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    flat: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  }),
  expected_move_pips: fc.double({ min: -200, max: 200, noNaN: true, noDefaultInfinity: true }),
  confidence_raw: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  confidence_final: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  tradeability_placeholder: fc.constant(null),
  engine_versions: arbEngineVersions,
  quantile_table_version: fc.stringMatching(/^v\d+\.\d+$/),
  regime: fc.record({
    volatility_regime: fc.constantFrom('low', 'medium', 'high', 'extreme'),
    trend_regime: fc.constantFrom('trending', 'ranging', 'transitioning'),
    session: fc.constantFrom('london', 'new_york', 'asia', 'overlap'),
  }),
  sample_size: fc.integer({ min: 1, max: 500 }),
  created_at: arbIso8601,
});

// =============================================================================
// Property Tests
// =============================================================================

describe('Property 5: Record Provenance Completeness', () => {
  it('batch_id is always a valid UUID', () => {
    fc.assert(
      fc.property(arbResearchForecastRecord, (record) => {
        expect(record.batch_id).not.toBeNull();
        expect(record.batch_id).not.toBe('');
        expect(record.batch_id).toMatch(UUID_REGEX);
      }),
      { numRuns: 200 },
    );
  });

  it('engine_versions is always non-empty', () => {
    fc.assert(
      fc.property(arbResearchForecastRecord, (record) => {
        expect(record.engine_versions).not.toBeNull();
        expect(typeof record.engine_versions).toBe('object');
        expect(Object.keys(record.engine_versions).length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it('created_at is always a valid ISO-8601 timestamp', () => {
    fc.assert(
      fc.property(arbResearchForecastRecord, (record) => {
        expect(record.created_at).not.toBeNull();
        expect(record.created_at).not.toBe('');
        expect(record.created_at).toMatch(ISO_8601_REGEX);
        // Also verify it parses to a valid Date
        const parsed = new Date(record.created_at);
        expect(parsed.getTime()).not.toBeNaN();
      }),
      { numRuns: 200 },
    );
  });

  it('fingerprint_id is always non-null, non-empty, and a valid UUID', () => {
    fc.assert(
      fc.property(arbResearchForecastRecord, (record) => {
        expect(record.fingerprint_id).not.toBeNull();
        expect(record.fingerprint_id).not.toBe('');
        expect(record.fingerprint_id).toMatch(UUID_REGEX);
      }),
      { numRuns: 200 },
    );
  });
});
