/**
 * Unit tests for the Similarity Archiver.
 *
 * Validates:
 * - Successful persistence of up to 50 matches
 * - Failure halts downstream pipeline (throws on non-duplicate errors)
 * - Zero matches produces no archive records (no DB call)
 * - Duplicate key rejection (log warning, no error thrown)
 *
 * Requirements: 20.1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSimilarityArchiver } from '../../../src/research/archival/similarity-archiver.js';
import type { SimilarityArchiveRecord } from '../../../src/research/archival/types.js';

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

function createValidRecord(overrides: Partial<SimilarityArchiveRecord> = {}): SimilarityArchiveRecord {
  return {
    fingerprint_id: '550e8400-e29b-41d4-a716-446655440000',
    match_fingerprint_id: '660e8400-e29b-41d4-a716-446655440001',
    similarity_score: 0.872345,
    layer_breakdown: {
      market_structure: 0.91,
      volatility: 0.85,
      liquidity: 0.78,
      macro: 0.92,
      sentiment: 0.88,
    },
    match_explanation: {
      matched_layers: ['market_structure', 'macro', 'sentiment'],
      mismatched_layers: ['liquidity'],
      primary_match_reason: 'Strong structural alignment across macro and sentiment layers',
    },
    rank: 1,
    batch_id: '770e8400-e29b-41d4-a716-446655440002',
    engine_versions: { fingerprint: '1.0.0', similarity: '1.0.0' },
    created_at: '2024-06-15T12:01:30.000Z',
    ...overrides,
  };
}

function createRecordBatch(count: number): SimilarityArchiveRecord[] {
  return Array.from({ length: count }, (_, i) =>
    createValidRecord({
      match_fingerprint_id: `660e8400-e29b-41d4-a716-44665544${String(i).padStart(4, '0')}`,
      rank: i + 1,
      similarity_score: Number((0.99 - i * 0.01).toFixed(6)),
    })
  );
}

// =============================================================================
// Tests
// =============================================================================

describe('SimilarityArchiver - persistMatches', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Successful persistence
  // ---------------------------------------------------------------------------

  it('inserts records into research_similarity_archive table on success', async () => {
    const supabase = createMockSupabase({ data: null, error: null });
    const archiver = createSimilarityArchiver(supabase as never);
    const records = [createValidRecord()];

    await archiver.persistMatches(records);

    expect(supabase.from).toHaveBeenCalledWith('research_similarity_archive');
    expect(supabase._chain.insert).toHaveBeenCalledTimes(1);
    expect(supabase._chain.insert).toHaveBeenCalledWith([
      {
        fingerprint_id: records[0].fingerprint_id,
        match_fingerprint_id: records[0].match_fingerprint_id,
        similarity_score: records[0].similarity_score,
        layer_breakdown: records[0].layer_breakdown,
        match_explanation: records[0].match_explanation,
        rank: records[0].rank,
        batch_id: records[0].batch_id,
        engine_versions: records[0].engine_versions,
        created_at: records[0].created_at,
      },
    ]);
  });

  it('persists up to 50 matches in a single batch insert', async () => {
    const supabase = createMockSupabase({ data: null, error: null });
    const archiver = createSimilarityArchiver(supabase as never);
    const records = createRecordBatch(50);

    await archiver.persistMatches(records);

    expect(supabase.from).toHaveBeenCalledWith('research_similarity_archive');
    expect(supabase._chain.insert).toHaveBeenCalledTimes(1);

    const insertedData = supabase._chain.insert.mock.calls[0][0];
    expect(insertedData).toHaveLength(50);
    expect(insertedData[0].rank).toBe(1);
    expect(insertedData[49].rank).toBe(50);
  });

  // ---------------------------------------------------------------------------
  // Zero matches — no archive records
  // ---------------------------------------------------------------------------

  it('does not call supabase.from() when records array is empty', async () => {
    const supabase = createMockSupabase({ data: null, error: null });
    const archiver = createSimilarityArchiver(supabase as never);

    await archiver.persistMatches([]);

    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase._chain.insert).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Duplicate key rejection — warn, do NOT throw
  // ---------------------------------------------------------------------------

  it('does not throw on duplicate key conflict (code 23505) and logs warning', async () => {
    const supabase = createMockSupabase({
      data: null,
      error: { message: 'duplicate key value violates unique constraint', code: '23505' },
    });
    const archiver = createSimilarityArchiver(supabase as never);
    const records = [createValidRecord()];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Must not throw
    await expect(archiver.persistMatches(records)).resolves.toBeUndefined();

    // Should log a warning with batch context
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[SimilarityArchiver]')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(records[0].batch_id)
    );
  });

  // ---------------------------------------------------------------------------
  // Failure halts downstream pipeline — THROWS on non-duplicate DB errors
  // ---------------------------------------------------------------------------

  it('throws on non-duplicate DB error to halt downstream pipeline', async () => {
    const supabase = createMockSupabase({
      data: null,
      error: { message: 'connection timeout', code: '08006' },
    });
    const archiver = createSimilarityArchiver(supabase as never);
    const records = [createValidRecord()];

    await expect(archiver.persistMatches(records)).rejects.toThrow(
      '[SimilarityArchiver] Failed to persist similarity matches'
    );
  });

  it('throws on unexpected errors (network failures) to halt downstream pipeline', async () => {
    const chain = {
      insert: vi.fn().mockRejectedValue(new Error('Network failure')),
    };
    const supabase = {
      from: vi.fn(() => chain),
      _chain: chain,
    };
    const archiver = createSimilarityArchiver(supabase as never);
    const records = [createValidRecord()];

    await expect(archiver.persistMatches(records)).rejects.toThrow(
      '[SimilarityArchiver] Unexpected error persisting similarity matches'
    );
  });

  it('includes batch_id and error message in thrown error', async () => {
    const supabase = createMockSupabase({
      data: null,
      error: { message: 'disk full', code: '53100' },
    });
    const archiver = createSimilarityArchiver(supabase as never);
    const records = [createValidRecord()];

    let thrownError: Error | undefined;
    try {
      await archiver.persistMatches(records);
    } catch (err) {
      thrownError = err as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).toContain(records[0].batch_id);
    expect(thrownError!.message).toContain('disk full');
  });

  // ---------------------------------------------------------------------------
  // JSONB fields are passed correctly
  // ---------------------------------------------------------------------------

  it('passes JSONB fields as objects, not stringified', async () => {
    const supabase = createMockSupabase({ data: null, error: null });
    const archiver = createSimilarityArchiver(supabase as never);
    const records = [createValidRecord()];

    await archiver.persistMatches(records);

    const insertedData = supabase._chain.insert.mock.calls[0][0];
    expect(insertedData[0].layer_breakdown).toEqual({
      market_structure: 0.91,
      volatility: 0.85,
      liquidity: 0.78,
      macro: 0.92,
      sentiment: 0.88,
    });
    expect(insertedData[0].match_explanation).toEqual({
      matched_layers: ['market_structure', 'macro', 'sentiment'],
      mismatched_layers: ['liquidity'],
      primary_match_reason: 'Strong structural alignment across macro and sentiment layers',
    });
    expect(insertedData[0].engine_versions).toEqual({ fingerprint: '1.0.0', similarity: '1.0.0' });
  });
});
