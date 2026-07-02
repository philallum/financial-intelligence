/**
 * Property-Based Tests for Trace Failure Isolation.
 *
 * **Validates: Requirements 12.3**
 *
 * Property 13: Trace Failure Isolation
 * For any engine execution, if trace emission or persistence fails, the engine's
 * return value SHALL be unaffected — the calling code SHALL receive the same output
 * (or same error) regardless of whether the trace was successfully persisted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { traceEngineExecution } from '../../../src/services/observability/trace-emitter.js';

// =============================================================================
// Generators
// =============================================================================

const arbEngineName = fc.constantFrom(
  'fingerprint',
  'similarity',
  'outcome',
  'forecast',
  'confidence',
);

const arbEngineVersion = fc
  .tuple(
    fc.integer({ min: 0, max: 9 }),
    fc.integer({ min: 0, max: 9 }),
    fc.integer({ min: 0, max: 9 }),
  )
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

const arbJsonObject = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 10 }),
  fc.oneof(
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.string({ maxLength: 20 }),
    fc.boolean(),
    fc.constant(null),
  ),
  { minKeys: 0, maxKeys: 5 },
);

const arbBatchId = fc.uuid();

const arbSampleSize = fc.oneof(
  fc.integer({ min: 1, max: 1000 }),
  fc.constant(null),
);

const arbErrorMessage = fc.string({ minLength: 1, maxLength: 100 });

// =============================================================================
// Mock Supabase Clients — Various Failure Modes
// =============================================================================

/**
 * Creates a mock Supabase client where `.from()` throws synchronously.
 * Simulates a total client failure (e.g., invalid configuration, network crash).
 */
function createFromThrowsSupabase(errorMessage: string) {
  return {
    from: vi.fn().mockImplementation(() => {
      throw new Error(errorMessage);
    }),
  };
}

/**
 * Creates a mock Supabase client where `.insert()` rejects with an error.
 * Simulates an async persistence failure (e.g., timeout, connection dropped).
 */
function createInsertRejectsSupabase(errorMessage: string) {
  const mockInsert = vi.fn().mockRejectedValue(new Error(errorMessage));
  const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });
  return { from: mockFrom };
}

/**
 * Creates a mock Supabase client where `.insert()` returns `{ error: { message } }`.
 * Simulates a Supabase API error response (e.g., constraint violation, rate limit).
 */
function createInsertReturnsErrorSupabase(errorMessage: string) {
  const mockInsert = vi.fn().mockResolvedValue({ error: { message: errorMessage } });
  const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });
  return { from: mockFrom };
}

/** Generator for different trace failure modes. */
const arbFailingSupabase = fc.constantFrom(
  'from_throws' as const,
  'insert_rejects' as const,
  'insert_returns_error' as const,
);

function createFailingSupabase(mode: 'from_throws' | 'insert_rejects' | 'insert_returns_error', errorMessage: string) {
  switch (mode) {
    case 'from_throws':
      return createFromThrowsSupabase(errorMessage);
    case 'insert_rejects':
      return createInsertRejectsSupabase(errorMessage);
    case 'insert_returns_error':
      return createInsertReturnsErrorSupabase(errorMessage);
  }
}

// =============================================================================
// Property 13: Trace Failure Isolation
// =============================================================================

describe('Property 13: Trace Failure Isolation', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  // ===========================================================================
  // Scenario 1: Success path + trace failure
  // Engine returns a value, trace persistence fails — return value is identical.
  // ===========================================================================

  it('engine success output is returned unchanged when trace persistence fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEngineName,
        arbEngineVersion,
        arbJsonObject,
        arbJsonObject,
        arbBatchId,
        arbSampleSize,
        arbFailingSupabase,
        arbErrorMessage,
        async (engineName, engineVersion, input, expectedOutput, batchId, sampleSize, failureMode, traceErrorMsg) => {
          const failingSupabase = createFailingSupabase(failureMode, traceErrorMsg);

          // Engine function that succeeds and returns a known output
          const engineFn = vi.fn().mockResolvedValue(expectedOutput);

          const result = await traceEngineExecution(
            engineFn,
            input,
            {
              engine_name: engineName,
              engine_version: engineVersion,
              batch_id: batchId,
              sample_size: sampleSize,
            },
            failingSupabase as any,
          );

          // The return value MUST be identical to what the engine produced
          expect(result).toEqual(expectedOutput);

          // Engine function was called exactly once with the correct input
          expect(engineFn).toHaveBeenCalledTimes(1);
          expect(engineFn).toHaveBeenCalledWith(input);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ===========================================================================
  // Scenario 2: Error path + trace failure
  // Engine throws, trace persistence also fails — original error propagates.
  // ===========================================================================

  it('engine error is re-thrown unchanged when trace persistence also fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEngineName,
        arbEngineVersion,
        arbJsonObject,
        arbBatchId,
        arbSampleSize,
        arbFailingSupabase,
        arbErrorMessage,
        arbErrorMessage,
        async (engineName, engineVersion, input, batchId, sampleSize, failureMode, engineErrorMsg, traceErrorMsg) => {
          const failingSupabase = createFailingSupabase(failureMode, traceErrorMsg);

          // Engine function that throws an error
          const originalError = new Error(engineErrorMsg);
          const engineFn = vi.fn().mockRejectedValue(originalError);

          // The original engine error MUST propagate unchanged
          await expect(
            traceEngineExecution(
              engineFn,
              input,
              {
                engine_name: engineName,
                engine_version: engineVersion,
                batch_id: batchId,
                sample_size: sampleSize,
              },
              failingSupabase as any,
            ),
          ).rejects.toThrow(engineErrorMsg);

          // Engine function was called exactly once
          expect(engineFn).toHaveBeenCalledTimes(1);
          expect(engineFn).toHaveBeenCalledWith(input);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ===========================================================================
  // Scenario 3: Various failure modes — all preserve engine output
  // Different types of trace failures (from() throws, insert() rejects,
  // insert() returns error) must all leave the engine result unaffected.
  // ===========================================================================

  it('all trace failure modes preserve engine return value identity', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEngineName,
        arbEngineVersion,
        arbJsonObject,
        arbJsonObject,
        arbBatchId,
        arbSampleSize,
        arbErrorMessage,
        async (engineName, engineVersion, input, expectedOutput, batchId, sampleSize, traceErrorMsg) => {
          const engineFn = vi.fn().mockResolvedValue(expectedOutput);

          // Test all three failure modes produce identical engine output
          const results = await Promise.all(
            (['from_throws', 'insert_rejects', 'insert_returns_error'] as const).map(
              async (mode) => {
                const failingSupabase = createFailingSupabase(mode, traceErrorMsg);
                return traceEngineExecution(
                  engineFn,
                  input,
                  {
                    engine_name: engineName,
                    engine_version: engineVersion,
                    batch_id: batchId,
                    sample_size: sampleSize,
                  },
                  failingSupabase as any,
                );
              },
            ),
          );

          // All results MUST be identical to the expected output
          for (const result of results) {
            expect(result).toEqual(expectedOutput);
          }

          // All results MUST be identical to each other (isolation is consistent)
          expect(results[0]).toEqual(results[1]);
          expect(results[1]).toEqual(results[2]);
        },
      ),
      { numRuns: 200 },
    );
  });
});
