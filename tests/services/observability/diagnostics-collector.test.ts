/**
 * Unit tests for DiagnosticsCollector.
 *
 * Covers:
 * - Default state (ml_service.called=false, market_context.available=false, nulls for optional stages)
 * - Recording a single stage only populates that field
 * - persist() calls supabase.from('batch_diagnostics').upsert() with correct shape
 * - persist() logs error on Supabase failure but does not throw
 * - persist() does not throw when from() throws an exception
 *
 * Requirements: 2.1, 2.2, 6.4, 6.5
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiagnosticsCollector } from '../../../src/services/observability/diagnostics-collector.js';
import type { SentimentDiagnostics } from '../../../src/services/observability/diagnostics-types.js';

// =============================================================================
// Helpers
// =============================================================================

function createMockSupabase(upsertResult: { error: null | { message: string } } = { error: null }) {
  const mockUpsert = vi.fn().mockResolvedValue(upsertResult);
  const mockFrom = vi.fn().mockReturnValue({ upsert: mockUpsert });
  return { from: mockFrom, _mockUpsert: mockUpsert };
}

// =============================================================================
// Default State Tests
// =============================================================================

describe('DiagnosticsCollector - default state', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('persists ml_service.called=false and market_context.available=false with nulls for optional stages', async () => {
    const mockSupabase = createMockSupabase();
    const collector = new DiagnosticsCollector('EURUSD', 'batch-001', mockSupabase as any);

    await collector.persist();

    expect(mockSupabase._mockUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = mockSupabase._mockUpsert.mock.calls[0][0];

    // Required fields with defaults
    expect(upsertArg.diagnostics.ml_service).toEqual({
      called: false,
      response: null,
      latency_ms: null,
    });
    expect(upsertArg.diagnostics.market_context).toEqual({
      available: false,
      dxy: null,
      vix: null,
      spx: null,
    });

    // Optional stages should all be null
    expect(upsertArg.diagnostics.sentiment).toBeNull();
    expect(upsertArg.diagnostics.macro_context).toBeNull();
    expect(upsertArg.diagnostics.similarity).toBeNull();
    expect(upsertArg.diagnostics.outcome).toBeNull();
    expect(upsertArg.diagnostics.forecast).toBeNull();
    expect(upsertArg.diagnostics.gemini).toBeNull();
  });
});

// =============================================================================
// Single Stage Recording Tests
// =============================================================================

describe('DiagnosticsCollector - single stage recording', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('recording only sentiment populates sentiment and leaves other optional stages null', async () => {
    const mockSupabase = createMockSupabase();
    const collector = new DiagnosticsCollector('GBPUSD', 'batch-002', mockSupabase as any);

    const sentimentData: SentimentDiagnostics = {
      article_count: 5,
      window_hours: 24,
      sentiment_vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
      sentiment_score: 0.75,
      confidence_factor: 0.9,
    };

    collector.recordSentiment(sentimentData);
    await collector.persist();

    const upsertArg = mockSupabase._mockUpsert.mock.calls[0][0];

    // Sentiment should be populated
    expect(upsertArg.diagnostics.sentiment).toEqual(sentimentData);

    // Other optional stages remain null
    expect(upsertArg.diagnostics.macro_context).toBeNull();
    expect(upsertArg.diagnostics.similarity).toBeNull();
    expect(upsertArg.diagnostics.outcome).toBeNull();
    expect(upsertArg.diagnostics.forecast).toBeNull();
    expect(upsertArg.diagnostics.gemini).toBeNull();

    // Defaults still hold for required fields
    expect(upsertArg.diagnostics.ml_service.called).toBe(false);
    expect(upsertArg.diagnostics.market_context.available).toBe(false);
  });
});

// =============================================================================
// Persist Shape Tests
// =============================================================================

describe('DiagnosticsCollector - persist shape', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('calls supabase.from("batch_diagnostics").upsert() with correct row shape', async () => {
    const mockSupabase = createMockSupabase();
    const collector = new DiagnosticsCollector('USDJPY', 'batch-003', mockSupabase as any);

    const beforePersist = new Date().toISOString();
    await collector.persist();
    const afterPersist = new Date().toISOString();

    // Verify from() is called with correct table name
    expect(mockSupabase.from).toHaveBeenCalledWith('batch_diagnostics');

    // Verify upsert shape
    const upsertArg = mockSupabase._mockUpsert.mock.calls[0][0];
    expect(upsertArg.asset).toBe('USDJPY');
    expect(upsertArg.batch_id).toBe('batch-003');

    // updated_at should be a valid ISO string between before and after
    expect(upsertArg.updated_at).toBeDefined();
    expect(new Date(upsertArg.updated_at).toISOString()).toBe(upsertArg.updated_at);
    expect(upsertArg.updated_at >= beforePersist).toBe(true);
    expect(upsertArg.updated_at <= afterPersist).toBe(true);

    // diagnostics should be the full payload object
    expect(upsertArg.diagnostics).toBeDefined();
    expect(typeof upsertArg.diagnostics).toBe('object');
    expect(upsertArg.diagnostics).toHaveProperty('ml_service');
    expect(upsertArg.diagnostics).toHaveProperty('market_context');

    // Verify onConflict option
    const upsertOptions = mockSupabase._mockUpsert.mock.calls[0][1];
    expect(upsertOptions).toEqual({ onConflict: 'asset' });
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('DiagnosticsCollector - error handling', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('persist does not throw when upsert returns an error, logs to console.error', async () => {
    const mockSupabase = createMockSupabase({ error: { message: 'Connection timeout' } });
    const collector = new DiagnosticsCollector('AUDUSD', 'batch-004', mockSupabase as any);

    // Should not throw
    await expect(collector.persist()).resolves.toBeUndefined();

    // Should log the error
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DiagnosticsCollector]'),
      'Connection timeout',
    );
  });

  it('persist does not throw when from() throws an exception, logs to console.error', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => {
        throw new Error('Unexpected crash');
      }),
    };
    const collector = new DiagnosticsCollector('NZDUSD', 'batch-005', mockSupabase as any);

    // Should not throw
    await expect(collector.persist()).resolves.toBeUndefined();

    // Should log the error
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DiagnosticsCollector]'),
      'Unexpected crash',
    );
  });
});
