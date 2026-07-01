/**
 * Tests for Execution Trace Emitter.
 *
 * Covers:
 * - SHA-256 hash computation correctness (deterministic)
 * - Successful trace emission stores correct record
 * - Failed engine execution emits error trace and re-throws
 * - Trace emission failure does NOT crash the caller
 * - Sample size is included when provided, null when not
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeSha256,
  emitTrace,
  traceEngineExecution,
} from '../../../src/services/observability/trace-emitter.js';

// =============================================================================
// Helpers
// =============================================================================

function createMockSupabase(insertResult: { error: null | { message: string } } = { error: null }) {
  const mockInsert = vi.fn().mockResolvedValue(insertResult);
  const mockFrom = vi.fn().mockReturnValue({ insert: mockInsert });
  return { from: mockFrom, _mockInsert: mockInsert };
}

// =============================================================================
// computeSha256 Tests
// =============================================================================

describe('computeSha256', () => {
  it('produces a deterministic 64-char hex string', () => {
    const input = { asset: 'EURUSD', value: 42 };
    const hash1 = computeSha256(input);
    const hash2 = computeSha256(input);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('matches the expected SHA-256 of JSON-serialised input', () => {
    const input = { hello: 'world' };
    const expected = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');

    expect(computeSha256(input)).toBe(expected);
  });

  it('returns the hash of empty string for null input', () => {
    const expected = createHash('sha256').update('').digest('hex');
    expect(computeSha256(null)).toBe(expected);
  });

  it('returns the hash of empty string for undefined input', () => {
    const expected = createHash('sha256').update('').digest('hex');
    expect(computeSha256(undefined)).toBe(expected);
  });

  it('produces different hashes for different inputs', () => {
    const hash1 = computeSha256({ a: 1 });
    const hash2 = computeSha256({ a: 2 });

    expect(hash1).not.toBe(hash2);
  });

  it('handles array inputs correctly', () => {
    const input = [1, 2, 3];
    const expected = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');

    expect(computeSha256(input)).toBe(expected);
  });

  it('handles string inputs correctly', () => {
    const input = 'test-string';
    const expected = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');

    expect(computeSha256(input)).toBe(expected);
  });
});

// =============================================================================
// emitTrace Tests
// =============================================================================

describe('emitTrace', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('stores a correct trace record on success', async () => {
    const mockSupabase = createMockSupabase();
    const input = { asset: 'EURUSD' };
    const output = { forecast: 0.65 };

    await emitTrace(
      {
        batch_id: 'batch-001',
        engine_name: 'forecast',
        engine_version: '1.0.0',
        input,
        output,
        execution_time_ms: 150,
        sample_size: 30,
        status: 'success',
      },
      mockSupabase as any,
    );

    expect(mockSupabase.from).toHaveBeenCalledWith('execution_traces');
    expect(mockSupabase._mockInsert).toHaveBeenCalledTimes(1);

    const insertedRecord = mockSupabase._mockInsert.mock.calls[0][0];
    expect(insertedRecord.batch_id).toBe('batch-001');
    expect(insertedRecord.engine_name).toBe('forecast');
    expect(insertedRecord.engine_version).toBe('1.0.0');
    expect(insertedRecord.input_hash).toBe(computeSha256(input));
    expect(insertedRecord.output_hash).toBe(computeSha256(output));
    expect(insertedRecord.execution_time_ms).toBe(150);
    expect(insertedRecord.sample_size).toBe(30);
    expect(insertedRecord.status).toBe('success');
    expect(insertedRecord.error_detail).toBeNull();
    expect(insertedRecord.timestamp_utc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes sample_size as null when not provided', async () => {
    const mockSupabase = createMockSupabase();

    await emitTrace(
      {
        batch_id: 'batch-002',
        engine_name: 'similarity',
        engine_version: '2.0.0',
        input: {},
        output: {},
        execution_time_ms: 50,
        status: 'success',
      },
      mockSupabase as any,
    );

    const insertedRecord = mockSupabase._mockInsert.mock.calls[0][0];
    expect(insertedRecord.sample_size).toBeNull();
  });

  it('includes sample_size when explicitly provided', async () => {
    const mockSupabase = createMockSupabase();

    await emitTrace(
      {
        batch_id: 'batch-003',
        engine_name: 'outcome',
        engine_version: '1.2.0',
        input: { ids: ['a', 'b'] },
        output: { distribution: [] },
        execution_time_ms: 200,
        sample_size: 50,
        status: 'success',
      },
      mockSupabase as any,
    );

    const insertedRecord = mockSupabase._mockInsert.mock.calls[0][0];
    expect(insertedRecord.sample_size).toBe(50);
  });

  it('does NOT throw when Supabase insert fails (logs error instead)', async () => {
    const mockSupabase = createMockSupabase({ error: { message: 'Connection refused' } });

    // Should not throw
    await expect(
      emitTrace(
        {
          batch_id: 'batch-004',
          engine_name: 'fingerprint',
          engine_version: '1.0.0',
          input: {},
          output: {},
          execution_time_ms: 100,
          status: 'success',
        },
        mockSupabase as any,
      ),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[TraceEmitter] Failed to store execution trace'),
      'Connection refused',
    );
  });

  it('does NOT throw when an unexpected error occurs', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => {
        throw new Error('Unexpected crash');
      }),
    };

    await expect(
      emitTrace(
        {
          batch_id: 'batch-005',
          engine_name: 'confidence',
          engine_version: '1.0.0',
          input: {},
          output: {},
          execution_time_ms: 10,
          status: 'success',
        },
        mockSupabase as any,
      ),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[TraceEmitter] Unexpected error'),
      'Unexpected crash',
    );
  });

  it('stores error_detail when status is error', async () => {
    const mockSupabase = createMockSupabase();

    await emitTrace(
      {
        batch_id: 'batch-006',
        engine_name: 'forecast',
        engine_version: '1.0.0',
        input: { test: true },
        output: null,
        execution_time_ms: 75,
        status: 'error',
        error_detail: 'Division by zero',
      },
      mockSupabase as any,
    );

    const insertedRecord = mockSupabase._mockInsert.mock.calls[0][0];
    expect(insertedRecord.status).toBe('error');
    expect(insertedRecord.error_detail).toBe('Division by zero');
    expect(insertedRecord.output_hash).toBe(computeSha256(null));
  });
});

// =============================================================================
// traceEngineExecution Tests
// =============================================================================

describe('traceEngineExecution', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('returns engine output on success and emits a success trace', async () => {
    const mockSupabase = createMockSupabase();
    const engineFn = vi.fn().mockResolvedValue({ result: 42 });

    const result = await traceEngineExecution(
      engineFn,
      { query: 'test' },
      {
        engine_name: 'similarity',
        engine_version: '2.0.0',
        batch_id: 'batch-100',
        sample_size: 25,
      },
      mockSupabase as any,
    );

    expect(result).toEqual({ result: 42 });
    expect(engineFn).toHaveBeenCalledWith({ query: 'test' });

    const insertedRecord = mockSupabase._mockInsert.mock.calls[0][0];
    expect(insertedRecord.engine_name).toBe('similarity');
    expect(insertedRecord.status).toBe('success');
    expect(insertedRecord.sample_size).toBe(25);
    expect(insertedRecord.execution_time_ms).toBeGreaterThanOrEqual(0);
    expect(insertedRecord.error_detail).toBeNull();
  });

  it('re-throws engine error and emits an error trace', async () => {
    const mockSupabase = createMockSupabase();
    const engineError = new Error('Engine computation failed');
    const engineFn = vi.fn().mockRejectedValue(engineError);

    await expect(
      traceEngineExecution(
        engineFn,
        { input: 'data' },
        {
          engine_name: 'outcome',
          engine_version: '1.1.0',
          batch_id: 'batch-200',
        },
        mockSupabase as any,
      ),
    ).rejects.toThrow('Engine computation failed');

    const insertedRecord = mockSupabase._mockInsert.mock.calls[0][0];
    expect(insertedRecord.engine_name).toBe('outcome');
    expect(insertedRecord.status).toBe('error');
    expect(insertedRecord.error_detail).toBe('Engine computation failed');
    expect(insertedRecord.output_hash).toBe(computeSha256(null));
  });

  it('records execution_time_ms (wall-clock) for successful execution', async () => {
    const mockSupabase = createMockSupabase();
    const engineFn = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('done'), 50)),
    );

    await traceEngineExecution(
      engineFn,
      {},
      {
        engine_name: 'fingerprint',
        engine_version: '1.0.0',
        batch_id: 'batch-300',
      },
      mockSupabase as any,
    );

    const insertedRecord = mockSupabase._mockInsert.mock.calls[0][0];
    // Should record at least ~50ms (allow some tolerance)
    expect(insertedRecord.execution_time_ms).toBeGreaterThanOrEqual(40);
  });

  it('sets sample_size to null when not provided in options', async () => {
    const mockSupabase = createMockSupabase();
    const engineFn = vi.fn().mockResolvedValue({ output: true });

    await traceEngineExecution(
      engineFn,
      {},
      {
        engine_name: 'confidence',
        engine_version: '1.0.0',
        batch_id: 'batch-400',
      },
      mockSupabase as any,
    );

    const insertedRecord = mockSupabase._mockInsert.mock.calls[0][0];
    expect(insertedRecord.sample_size).toBeNull();
  });

  it('does not crash when trace emission fails after successful engine run', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockRejectedValue(new Error('DB down')),
      }),
    };
    const engineFn = vi.fn().mockResolvedValue({ value: 'ok' });

    // Should still return the engine result without throwing
    const result = await traceEngineExecution(
      engineFn,
      { x: 1 },
      {
        engine_name: 'forecast',
        engine_version: '1.0.0',
        batch_id: 'batch-500',
      },
      mockSupabase as any,
    );

    expect(result).toEqual({ value: 'ok' });
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('does not crash when trace emission fails after engine error (still re-throws original)', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        insert: vi.fn().mockRejectedValue(new Error('DB down')),
      }),
    };
    const engineError = new Error('Engine broke');
    const engineFn = vi.fn().mockRejectedValue(engineError);

    await expect(
      traceEngineExecution(
        engineFn,
        {},
        {
          engine_name: 'similarity',
          engine_version: '1.0.0',
          batch_id: 'batch-600',
        },
        mockSupabase as any,
      ),
    ).rejects.toThrow('Engine broke');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
