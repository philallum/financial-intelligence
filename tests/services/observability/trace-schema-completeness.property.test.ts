/**
 * Property-Based Test: Trace Schema Completeness (Property 12)
 *
 * **Validates: Requirements 12.1, 12.7, 1.7**
 *
 * For any engine execution (success or error), the emitted trace SHALL contain:
 * - batch_id (UUID)
 * - engine_name (non-empty string)
 * - engine_version (semver string)
 * - input_hash (64-char hex SHA-256)
 * - output_hash (64-char hex SHA-256, or SHA-256 of empty string on error)
 * - execution_time_ms (non-negative integer)
 * - status ("success" or "error")
 * - timestamp_utc (valid ISO-8601)
 *
 * When status is "error", error_detail SHALL be a non-empty string.
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

/** SHA-256 of empty string — expected output_hash for error traces (Req 12.7) */
const SHA256_EMPTY_STRING = computeSha256(null);

function createMockSupabase(
  insertResult: { error: null | { message: string } } = { error: null },
) {
  const mockInsert = vi.fn().mockResolvedValue(insertResult);
  const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });
  return { from: mockFrom, _mockInsert: mockInsert };
}

// =============================================================================
// Property 12: Trace Schema Completeness
// =============================================================================

describe('Property 12: Trace Schema Completeness', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 12a: All required fields present in success traces via emitTrace
  // ---------------------------------------------------------------------------

  it('success traces via emitTrace contain all required schema fields with correct types', async () => {
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

          // batch_id: UUID string
          expect(record.batch_id).toBe(batchId);
          expect(typeof record.batch_id).toBe('string');

          // engine_name: non-empty string
          expect(typeof record.engine_name).toBe('string');
          expect(record.engine_name.length).toBeGreaterThan(0);

          // engine_version: semver string
          expect(record.engine_version).toMatch(/^\d+\.\d+\.\d+$/);

          // input_hash: 64-char hex
          expect(record.input_hash).toMatch(/^[a-f0-9]{64}$/);

          // output_hash: 64-char hex
          expect(record.output_hash).toMatch(/^[a-f0-9]{64}$/);

          // execution_time_ms: non-negative integer
          expect(typeof record.execution_time_ms).toBe('number');
          expect(record.execution_time_ms).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(record.execution_time_ms)).toBe(true);

          // status: "success" or "error"
          expect(record.status).toBe('success');

          // timestamp_utc: valid ISO-8601 string
          expect(typeof record.timestamp_utc).toBe('string');
          expect(new Date(record.timestamp_utc).toISOString()).toBe(record.timestamp_utc);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ---------------------------------------------------------------------------
  // 12b: Error traces contain all fields + error_detail is non-empty + output_hash
  //       is SHA-256 of empty string (Req 12.7)
  // ---------------------------------------------------------------------------

  it('error traces via emitTrace contain all required fields, non-empty error_detail, and output_hash matches SHA-256 of empty string', async () => {
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

          // All required fields present
          expect(record.batch_id).toBe(batchId);
          expect(typeof record.engine_name).toBe('string');
          expect(record.engine_name.length).toBeGreaterThan(0);
          expect(record.engine_version).toMatch(/^\d+\.\d+\.\d+$/);
          expect(record.input_hash).toMatch(/^[a-f0-9]{64}$/);
          expect(record.output_hash).toMatch(/^[a-f0-9]{64}$/);
          expect(typeof record.execution_time_ms).toBe('number');
          expect(record.execution_time_ms).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(record.execution_time_ms)).toBe(true);
          expect(record.status).toBe('error');
          expect(typeof record.timestamp_utc).toBe('string');
          expect(new Date(record.timestamp_utc).toISOString()).toBe(record.timestamp_utc);

          // Error-specific: error_detail is a non-empty string
          expect(typeof record.error_detail).toBe('string');
          expect(record.error_detail.length).toBeGreaterThan(0);

          // Req 12.7: output_hash is SHA-256 of empty string on error
          expect(record.output_hash).toBe(SHA256_EMPTY_STRING);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ---------------------------------------------------------------------------
  // 12c: traceEngineExecution success path emits complete schema
  // ---------------------------------------------------------------------------

  it('traceEngineExecution success path emits trace with complete schema', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbEngineName,
        arbEngineVersion,
        arbJsonObject,
        arbJsonObject,
        arbBatchId,
        arbSampleSize,
        async (engineName, engineVersion, input, output, batchId, sampleSize) => {
          const mockSupabase = createMockSupabase();
          const engineFn = vi.fn().mockResolvedValue(output);

          await traceEngineExecution(
            engineFn,
            input,
            {
              engine_name: engineName,
              engine_version: engineVersion,
              batch_id: batchId,
              sample_size: sampleSize,
            },
            mockSupabase as any,
          );

          expect(mockSupabase._mockInsert).toHaveBeenCalledTimes(1);
          const record = mockSupabase._mockInsert.mock.calls[0][0];

          // Full schema validation
          expect(record.batch_id).toBe(batchId);
          expect(typeof record.engine_name).toBe('string');
          expect(record.engine_name.length).toBeGreaterThan(0);
          expect(record.engine_version).toMatch(/^\d+\.\d+\.\d+$/);
          expect(record.input_hash).toMatch(/^[a-f0-9]{64}$/);
          expect(record.output_hash).toMatch(/^[a-f0-9]{64}$/);
          expect(typeof record.execution_time_ms).toBe('number');
          expect(record.execution_time_ms).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(record.execution_time_ms)).toBe(true);
          expect(record.status).toBe('success');
          expect(typeof record.timestamp_utc).toBe('string');
          expect(new Date(record.timestamp_utc).toISOString()).toBe(record.timestamp_utc);
        },
      ),
      { numRuns: 200 },
    );
  });

  // ---------------------------------------------------------------------------
  // 12d: traceEngineExecution error path emits complete schema with error_detail
  //       and output_hash is SHA-256 of empty string
  // ---------------------------------------------------------------------------

  it('traceEngineExecution error path emits trace with complete schema, non-empty error_detail, and correct output_hash', async () => {
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

          // traceEngineExecution re-throws, so we catch it
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

          expect(mockSupabase._mockInsert).toHaveBeenCalledTimes(1);
          const record = mockSupabase._mockInsert.mock.calls[0][0];

          // Full schema validation
          expect(record.batch_id).toBe(batchId);
          expect(typeof record.engine_name).toBe('string');
          expect(record.engine_name.length).toBeGreaterThan(0);
          expect(record.engine_version).toMatch(/^\d+\.\d+\.\d+$/);
          expect(record.input_hash).toMatch(/^[a-f0-9]{64}$/);
          expect(record.output_hash).toMatch(/^[a-f0-9]{64}$/);
          expect(typeof record.execution_time_ms).toBe('number');
          expect(record.execution_time_ms).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(record.execution_time_ms)).toBe(true);
          expect(record.status).toBe('error');
          expect(typeof record.timestamp_utc).toBe('string');
          expect(new Date(record.timestamp_utc).toISOString()).toBe(record.timestamp_utc);

          // Error-specific: error_detail is non-empty string
          expect(typeof record.error_detail).toBe('string');
          expect(record.error_detail.length).toBeGreaterThan(0);
          expect(record.error_detail).toBe(errorMessage);

          // Req 12.7: output_hash is SHA-256 of empty string on error
          expect(record.output_hash).toBe(SHA256_EMPTY_STRING);
        },
      ),
      { numRuns: 200 },
    );
  });
});
