/**
 * Property-Based Test: Experiment Production Isolation
 *
 * Property 14: Experiment Production Isolation
 * - Generate experiment-tagged records
 * - Verify live pipeline queries never read experiment records
 *
 * **Validates: Requirements 5.2**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { createExperimentRunner } from '../../../src/research/experimentation/experiment-runner.js';
import type { ExperimentConfig } from '../../../src/research/experimentation/types.js';

// =============================================================================
// Constants
// =============================================================================

/** The ONLY table the experiment runner should interact with. */
const ALLOWED_TABLE = 'research_experiments';

/** Production tables that MUST NEVER be accessed by the experiment runner. */
const PRODUCTION_TABLES = [
  'cached_forecasts',
  'market_fingerprints',
  'batch_runs',
  'raw_candles',
  'market_outcomes',
  'similarity_matches',
  'execution_traces',
  'engine_versions',
  'research_forecasts',
  'research_evaluations',
  'research_similarity_archive',
  'fingerprint_topology',
];

// =============================================================================
// Arbitraries
// =============================================================================

/** Generates a valid experiment_id string. */
const arbExperimentId: fc.Arbitrary<string> = fc
  .tuple(fc.stringMatching(/^[a-z]{3,8}$/), fc.integer({ min: 1, max: 9999 }))
  .map(([prefix, num]) => `exp-${prefix}-${num}`);

/** Generates a non-empty engine_versions record with at least 2 entries. */
const arbEngineVersions: fc.Arbitrary<Record<string, string>> = fc
  .tuple(
    fc.array(
      fc.tuple(
        fc.constantFrom(
          'confidence', 'fingerprint', 'similarity', 'outcome',
          'forecast', 'regime', 'topology', 'tradeability'
        ),
        fc.stringMatching(/^\d+\.\d+\.\d+$/)
      ),
      { minLength: 2, maxLength: 5 }
    )
  )
  .map(([entries]) => {
    const record: Record<string, string> = {};
    // Ensure unique keys by appending suffix
    entries.forEach(([key, version], idx) => {
      record[`${key}_v${idx + 1}`] = version;
    });
    return record;
  })
  .filter((r) => Object.keys(r).length >= 2);

/** Generates an array of fingerprint IDs (1–5 items). */
const arbFingerprintIds: fc.Arbitrary<string[]> = fc.array(fc.uuid(), {
  minLength: 1,
  maxLength: 5,
});

/** Generates a valid ExperimentConfig with at least 2 engine versions. */
const arbExperimentConfig: fc.Arbitrary<ExperimentConfig> = fc
  .tuple(arbExperimentId, arbEngineVersions, arbFingerprintIds, fc.option(fc.uuid()))
  .map(([experiment_id, engine_versions, input_fingerprint_ids, original_batch_id]) => ({
    experiment_id,
    engine_versions,
    input_fingerprint_ids,
    original_batch_id: original_batch_id ?? undefined,
    description: `Property test experiment ${experiment_id}`,
  }));

// =============================================================================
// Mock Factory
// =============================================================================

/**
 * Creates a mock Supabase client that tracks all table accesses.
 * Returns successful responses for all operations.
 */
function createIsolationTrackingSupabase() {
  const tableAccesses: string[] = [];

  const chain = {
    insert: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    })),
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        })),
      })),
    })),
  };

  const supabase = {
    from: vi.fn((tableName: string) => {
      tableAccesses.push(tableName);
      return chain;
    }),
  };

  return { supabase, tableAccesses };
}

/**
 * Creates a mock engine execution handler that returns valid output.
 */
function createMockEngine() {
  return vi.fn().mockResolvedValue({
    direction_probabilities: { up: 0.45, down: 0.35, flat: 0.20 },
    expected_move_pips: 12.5,
    confidence_final: 0.72,
    sample_size: 47,
  });
}

// =============================================================================
// Property Tests
// =============================================================================

describe('Property 14: Experiment Production Isolation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('all supabase.from() calls during runExperiment target ONLY research_experiments', async () => {
    await fc.assert(
      fc.asyncProperty(arbExperimentConfig, async (config) => {
        const { supabase, tableAccesses } = createIsolationTrackingSupabase();
        const engine = createMockEngine();
        const runner = createExperimentRunner(supabase as never, engine);

        await runner.runExperiment(config);

        // Every table access must be to research_experiments
        expect(tableAccesses.length).toBeGreaterThan(0);
        for (const table of tableAccesses) {
          expect(table).toBe(ALLOWED_TABLE);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('no production tables are ever accessed by the experiment runner', async () => {
    await fc.assert(
      fc.asyncProperty(arbExperimentConfig, async (config) => {
        const { supabase, tableAccesses } = createIsolationTrackingSupabase();
        const engine = createMockEngine();
        const runner = createExperimentRunner(supabase as never, engine);

        await runner.runExperiment(config);

        // None of the production tables should appear in the access log
        for (const table of tableAccesses) {
          expect(PRODUCTION_TABLES).not.toContain(table);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('all returned ExperimentRecords have the correct experiment_id tag', async () => {
    await fc.assert(
      fc.asyncProperty(arbExperimentConfig, async (config) => {
        const { supabase } = createIsolationTrackingSupabase();
        const engine = createMockEngine();
        const runner = createExperimentRunner(supabase as never, engine);

        const results = await runner.runExperiment(config);

        // Every record must carry the same experiment_id from the config
        expect(results.length).toBeGreaterThan(0);
        for (const record of results) {
          expect(record.experiment_id).toBe(config.experiment_id);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('all returned ExperimentRecords include engine_versions identifying the version used', async () => {
    await fc.assert(
      fc.asyncProperty(arbExperimentConfig, async (config) => {
        const { supabase } = createIsolationTrackingSupabase();
        const engine = createMockEngine();
        const runner = createExperimentRunner(supabase as never, engine);

        const results = await runner.runExperiment(config);

        // Every record must have a non-empty engine_versions object
        // Each record's engine_versions key should be one of the keys from config.engine_versions
        const configVersionKeys = Object.keys(config.engine_versions);

        for (const record of results) {
          expect(record.engine_versions).toBeDefined();
          expect(Object.keys(record.engine_versions).length).toBeGreaterThan(0);

          // Each record's engine_version key(s) must be a subset of the config's engine_versions
          for (const key of Object.keys(record.engine_versions)) {
            expect(configVersionKeys).toContain(key);
          }

          // The version value in the record must match the config
          for (const [key, version] of Object.entries(record.engine_versions)) {
            expect(version).toBe(config.engine_versions[key]);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('batch-entry.ts does not reference research_experiments table', async () => {
    // Static analysis: read the batch-entry source and verify it never queries research_experiments.
    // This is a deterministic check but included as a property-style assertion for completeness.
    const fs = await import('fs');
    const path = await import('path');
    const batchEntryPath = path.resolve(
      import.meta.dirname ?? __dirname,
      '../../../src/batch-entry.ts'
    );
    const batchEntrySource = fs.readFileSync(batchEntryPath, 'utf-8');

    // The batch pipeline must never read from or write to research_experiments
    expect(batchEntrySource).not.toContain("'research_experiments'");
    expect(batchEntrySource).not.toContain('"research_experiments"');
    expect(batchEntrySource).not.toContain('`research_experiments`');
  });
});
