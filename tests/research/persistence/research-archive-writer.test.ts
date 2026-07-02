/**
 * Unit tests for the Research Archive Writer.
 *
 * Validates:
 * - Successful persistence of forecast records
 * - Duplicate key rejection (log warning, no error thrown)
 * - Write failure handling (log error, no throw, batch continues)
 * - Record shape matches expected schema
 *
 * Requirements: 4.1, 9.1, 9.3, 9.4, 3.1, 3.7, 20.1, 20.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchArchiveWriter } from '../../../src/research/persistence/research-archive-writer.js';
import type { ResearchForecastRecord } from '../../../src/research/persistence/types.js';

// =============================================================================
// Mock Supabase Client
// =============================================================================

function createMockSupabase(response: { data: unknown; error: { message: string; code: string } | null }) {
  const chain = {
    insert: vi.fn().mockResolvedValue(response),
  };

  return {
    from: vi.fn(() => chain),
    _chain: chain,
  };
}

// =============================================================================
// Test Fixtures
// =============================================================================

function createValidRecord(): ResearchForecastRecord {
  return {
    fingerprint_id: '550e8400-e29b-41d4-a716-446655440000',
    batch_id: '660e8400-e29b-41d4-a716-446655440001',
    asset: 'EURUSD',
    timeframe: '4H',
    forecast_timestamp: '2024-06-15T12:00:00.000Z',
    forecast_expiry: '2024-06-15T16:00:00.000Z',
    direction_probabilities: { up: 0.45, down: 0.35, flat: 0.20 },
    expected_move_pips: 12.5,
    confidence_raw: 0.72,
    confidence_final: 0.68,
    tradeability_placeholder: null,
    engine_versions: { fingerprint: '1.0.0', similarity: '1.0.0', outcome: '1.0.0' },
    quantile_table_version: '2024-Q2',
    regime: { volatility_regime: 'normal', trend_regime: 'ranging', session: 'london' },
    sample_size: 47,
    created_at: '2024-06-15T12:01:30.000Z',
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('ResearchArchiveWriter - persistForecast', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts record into research_forecasts table on success', async () => {
    const supabase = createMockSupabase({ data: null, error: null });
    const writer = createResearchArchiveWriter(supabase as never);
    const record = createValidRecord();

    await writer.persistForecast(record);

    expect(supabase.from).toHaveBeenCalledWith('research_forecasts');
    expect(supabase._chain.insert).toHaveBeenCalledTimes(1);
    expect(supabase._chain.insert).toHaveBeenCalledWith({
      fingerprint_id: record.fingerprint_id,
      batch_id: record.batch_id,
      asset: record.asset,
      timeframe: record.timeframe,
      forecast_timestamp: record.forecast_timestamp,
      forecast_expiry: record.forecast_expiry,
      direction_probabilities: record.direction_probabilities,
      expected_move_pips: record.expected_move_pips,
      confidence_raw: record.confidence_raw,
      confidence_final: record.confidence_final,
      tradeability_placeholder: record.tradeability_placeholder,
      engine_versions: record.engine_versions,
      quantile_table_version: record.quantile_table_version,
      regime: record.regime,
      sample_size: record.sample_size,
      created_at: record.created_at,
    });
  });

  it('does not throw on duplicate key conflict (code 23505)', async () => {
    const supabase = createMockSupabase({
      data: null,
      error: { message: 'duplicate key value violates unique constraint', code: '23505' },
    });
    const writer = createResearchArchiveWriter(supabase as never);
    const record = createValidRecord();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Must not throw
    await expect(writer.persistForecast(record)).resolves.toBeUndefined();

    // Should log a warning with context
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ResearchArchiveWriter] Duplicate forecast rejected')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(record.fingerprint_id)
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(record.batch_id)
    );
  });

  it('does not throw on non-duplicate write failure and logs error', async () => {
    const supabase = createMockSupabase({
      data: null,
      error: { message: 'connection timeout', code: '08006' },
    });
    const writer = createResearchArchiveWriter(supabase as never);
    const record = createValidRecord();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Must not throw
    await expect(writer.persistForecast(record)).resolves.toBeUndefined();

    // Should log an error with context
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ResearchArchiveWriter] Failed to persist forecast')
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(record.batch_id)
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(record.fingerprint_id)
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('connection timeout')
    );
  });

  it('does not throw on unexpected errors (network, serialisation)', async () => {
    const chain = {
      insert: vi.fn().mockRejectedValue(new Error('Network failure')),
    };
    const supabase = {
      from: vi.fn(() => chain),
      _chain: chain,
    };
    const writer = createResearchArchiveWriter(supabase as never);
    const record = createValidRecord();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Must not throw
    await expect(writer.persistForecast(record)).resolves.toBeUndefined();

    // Should log the unexpected error
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ResearchArchiveWriter] Unexpected error persisting forecast'),
      expect.stringContaining('Network failure')
    );
  });

  it('never halts the batch pipeline regardless of failure mode', async () => {
    const scenarios = [
      // Duplicate key
      { data: null, error: { message: 'unique violation', code: '23505' } },
      // Connection error
      { data: null, error: { message: 'connection refused', code: '08001' } },
      // Permission error
      { data: null, error: { message: 'permission denied', code: '42501' } },
    ];

    for (const scenario of scenarios) {
      const supabase = createMockSupabase(scenario);
      const writer = createResearchArchiveWriter(supabase as never);
      const record = createValidRecord();

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // None of these should throw
      await expect(writer.persistForecast(record)).resolves.toBeUndefined();
    }
  });

  it('passes all record fields including JSONB fields correctly', async () => {
    const supabase = createMockSupabase({ data: null, error: null });
    const writer = createResearchArchiveWriter(supabase as never);
    const record = createValidRecord();

    await writer.persistForecast(record);

    const insertedData = supabase._chain.insert.mock.calls[0][0];

    // Verify JSONB fields are passed as objects (not stringified)
    expect(insertedData.direction_probabilities).toEqual({ up: 0.45, down: 0.35, flat: 0.20 });
    expect(insertedData.engine_versions).toEqual({ fingerprint: '1.0.0', similarity: '1.0.0', outcome: '1.0.0' });
    expect(insertedData.regime).toEqual({ volatility_regime: 'normal', trend_regime: 'ranging', session: 'london' });

    // Verify null fields are passed as null
    expect(insertedData.tradeability_placeholder).toBeNull();
  });
});
