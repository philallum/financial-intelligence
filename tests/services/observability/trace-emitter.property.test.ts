/**
 * Property-Based Tests for Execution Trace Emitter.
 *
 * **Validates: Requirements 16.1, 16.3**
 *
 * Properties verified:
 * 1. Trace completeness on success — all required fields present and well-formed
 * 2. Trace completeness on failure — error traces include error_detail, output_hash is hash of null
 * 3. Hash determinism — computeSha256 is pure/referentially transparent
 * 4. Non-crashing guarantee (Req 16.3) — trace emission failure never throws
 * 5. traceEngineExecution re-throws on failure — original error propagates
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import {
  computeSha256,
  emitTrace,
  traceEngineExecution,
} from '../../../src/services/observability/trace-emitter.js';

// =============================================================================
// Generators
// =============================================================================

const arbEngineName = fc.constantFrom('fingerprint', 'similarity', 'outcome', 'forecast', 'confidence');

const arbEngineVersion = fc.tuple(
  fc.integer({ min: 0, max: 9 }),
  fc.integer({ min: 0, max: 9 }),
  fc.integer({ min: 0, max: 9 }),
).map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

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

const arbExecutionTimeMs = fc.integer({ min: 0, max: 60_000 });

const arbSampleSize = fc.oneof(
  fc.integer({ min: 1, max: 1000 }),
  fc.constant(null),
);

const arbBatchId = fc.uuid();

const arbErrorDetail = fc.string({ minLength: 1, maxLength: 100 });

// =============================================================================
// Helpers
// =============================================================================

function createMockSupabase(insertResult: { error: null | { message: string } } = { error: null }) {
  const mockInsert = vi.fn().mockResolvedValue(insertResult);
  const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });
  return { from: mockFrom, _mockInsert: mockInsert };
}

// =============================================================================
// Property 1: Trace completeness on success
// =============================================================================

describe('Property 15: Execution Trace Emission', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('trace completeness on success: emitted trace always contains input_hash, output_hash, execution_time_ms, engine_version, sample_size', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEngineName,
        arbEngineVersion,
        arbJsonObject,
        arbJsonObject,
        arbExecutionTimeMs,
        arbSampleSize,
        arbBatchId,
        async (engineName, engineVersion, input, output, execTime, sampleSize, batchId) => {
          const mockSupabase = createMockSupabase();

          await emitTrace(
            {
              batch_id: batchId,
              engine_name: engineName,
              engine_version: engineVersion,
              input,
              output,
              execution_time_ms: execTime,
              sample_size: sampleSize,
              status: 'success',
            },
            mockSupabase as any,
          );

          expect(mockSupabase._mockInsert).toHaveBeenCalledTimes(1);
          const record = mockSupabase._mockInsert.mock.calls[0][0];

          // input_hash: 64-char hex
          expect(record.input_hash).toMatch(/^[a-f0-9]{64}$/);
          // output_hash: 64-char hex
          expect(record.output_hash).toMatch(/^[a-f0-9]{64}$/);
          // execution_time_ms: non-negative number
          expect(record.execution_time_ms).toBeGreaterThanOrEqual(0);
          expect(typeof record.execution_time_ms).toBe('number');
          // engine_version: non-empty string
          expect(typeof record.engine_version).toBe('string');
          expect(record.engine_version.length).toBeGreaterThan(0);
          // sample_size: number or null
          expect(
            record.sample_size === null || typeof record.sample_size === 'number',
          ).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ===========================================================================
  // Property 2: Trace completeness on failure
  // ===========================================================================

  it('trace completeness on failure: error traces include error_detail and output_hash is hash of null', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEngineName,
        arbEngineVersion,
        arbJsonObject,
        arbExecutionTimeMs,
        arbSampleSize,
        arbBatchId,
        arbErrorDetail,
        async (engineName, engineVersion, input, execTime, sampleSize, batchId, errorDetail) => {
          const mockSupabase = createMockSupabase();

          await emitTrace(
            {
              batch_id: batchId,
              engine_name: engineName,
              engine_version: engineVersion,
              input,
              output: null,
              execution_time_ms: execTime,
              sample_size: sampleSize,
              status: 'error',
              error_detail: errorDetail,
            },
            mockSupabase as any,
          );

          expect(mockSupabase._mockInsert).toHaveBeenCalledTimes(1);
          const record = mockSupabase._mockInsert.mock.calls[0][0];

          // Same base fields
          expect(record.input_hash).toMatch(/^[a-f0-9]{64}$/);
          expect(record.output_hash).toMatch(/^[a-f0-9]{64}$/);
          expect(record.execution_time_ms).toBeGreaterThanOrEqual(0);
          expect(record.engine_version.length).toBeGreaterThan(0);
          expect(
            record.sample_size === null || typeof record.sample_size === 'number',
          ).toBe(true);

          // Error-specific: error_detail is a non-empty string
          expect(typeof record.error_detail).toBe('string');
          expect(record.error_detail.length).toBeGreaterThan(0);

          // output_hash is the hash of null
          expect(record.output_hash).toBe(computeSha256(null));
        },
      ),
      { numRuns: 100 },
    );
  });

  // ===========================================================================
  // Property 3: Hash determinism
  // ===========================================================================

  it('hash determinism: computeSha256 called twice on same input produces identical results', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          arbJsonObject,
          fc.constant(null),
          fc.string({ maxLength: 50 }),
          fc.integer(),
          fc.array(fc.integer(), { maxLength: 10 }),
        ),
        async (input) => {
          const hash1 = computeSha256(input);
          const hash2 = computeSha256(input);

          expect(hash1).toBe(hash2);
          expect(hash1).toMatch(/^[a-f0-9]{64}$/);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ===========================================================================
  // Property 4: Non-crashing guarantee (Req 16.3)
  // ===========================================================================

  it('non-crashing guarantee: trace emission failure never throws (Req 16.3)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEngineName,
        arbEngineVersion,
        arbJsonObject,
        arbJsonObject,
        arbExecutionTimeMs,
        arbSampleSize,
        arbBatchId,
        fc.constantFrom('success' as const, 'error' as const),
        async (engineName, engineVersion, input, output, execTime, sampleSize, batchId, status) => {
          // Supabase throws on .from() — simulates total failure
          const crashingSupabase = {
            from: vi.fn().mockImplementation(() => {
              throw new Error('Simulated Supabase crash');
            }),
          };

          // emitTrace must NEVER throw — it should resolve successfully
          await expect(
            emitTrace(
              {
                batch_id: batchId,
                engine_name: engineName,
                engine_version: engineVersion,
                input,
                output: status === 'error' ? null : output,
                execution_time_ms: execTime,
                sample_size: sampleSize,
                status,
                error_detail: status === 'error' ? 'some error' : undefined,
              },
              crashingSupabase as any,
            ),
          ).resolves.toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  // ===========================================================================
  // Property 5: traceEngineExecution re-throws on failure
  // ===========================================================================

  it('traceEngineExecution re-throws on failure: if engine throws, same error propagates', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEngineName,
        arbEngineVersion,
        arbJsonObject,
        arbBatchId,
        arbSampleSize,
        arbErrorDetail,
        async (engineName, engineVersion, input, batchId, sampleSize, errorMessage) => {
          const mockSupabase = createMockSupabase();
          const originalError = new Error(errorMessage);
          const engineFn = vi.fn().mockRejectedValue(originalError);

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
              mockSupabase as any,
            ),
          ).rejects.toThrow(errorMessage);

          // Verify trace was still emitted
          expect(mockSupabase._mockInsert).toHaveBeenCalledTimes(1);
          const record = mockSupabase._mockInsert.mock.calls[0][0];
          expect(record.status).toBe('error');
          expect(record.error_detail).toBe(errorMessage);
        },
      ),
      { numRuns: 100 },
    );
  });
});
