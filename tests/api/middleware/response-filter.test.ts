/**
 * Tests for the Tier-Based Response Filter Middleware.
 *
 * Validates:
 * - Tier-based field filtering (Req 4.1, 4.2, 4.3, 4.4)
 * - Response filter strips restricted fields before serialisation (Req 4.5)
 * - Default to RETAIL filtering when tier is missing (Req 4.6)
 * - Anonymous access returns minimal fields
 * - Middleware intercepts res.json correctly
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  filterResponse,
  createResponseFilter,
} from '../../../src/api/middleware/response-filter.js';
import { CustomerTier } from '../../../src/types/enums.js';

// =============================================================================
// Test Fixtures
// =============================================================================

/** A full response containing all possible fields for testing field stripping. */
const FULL_RESPONSE: Record<string, unknown> = {
  // RETAIL fields
  direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
  expected_move_pips: 12.5,
  confidence_final: 0.68,
  tradeability_score: 0.82,
  tradeability_label: 'GO',
  forecast_valid_until: '2025-01-15T12:00:00Z',
  // DEVELOPER additional fields
  state_layers: { market_structure: [0.1, 0.2], volatility_profile: [0.3, 0.4] },
  layer_breakdown: { market_structure: 0.95, volatility: 0.88 },
  similarity_matches: [{ fingerprint_id: 'fp-1', similarity_score: 0.95 }],
  match_explanation: { matched_layers: ['market_structure'], mismatched_layers: [], primary_match_reason: 'similar structure' },
  contributing_factors: ['trend_alignment', 'volatility_match'],
  execution_metrics: { spread_penalty: 'low', session_alignment: 'optimal', news_buffer_status: 'clear' },
  // RESEARCH additional fields
  historical_distributions: [{ month: '2024-01', data: [1, 2, 3] }],
  time_series_data: [{ timestamp: '2024-01-01', value: 1.05 }],
  research_metadata: { model_version: '2.1', training_date: '2024-12-01' },
  // INTERNAL-only fields
  trace_id_internal: 'trace-abc-123',
  pipeline_debug: { step: 'similarity', duration_ms: 45 },
  raw_engine_logs: ['log entry 1', 'log entry 2'],
  // Other fields not in any tier's allowed set
  asset: 'EURUSD',
  batch_id: 'batch-001',
};

// =============================================================================
// filterResponse Tests — Anonymous Access
// =============================================================================

describe('filterResponse — anonymous access', () => {
  it('returns only confidence_final, direction_probabilities, tradeability_label', () => {
    const result = filterResponse(FULL_RESPONSE, undefined, true);

    expect(result).toEqual({
      confidence_final: 0.68,
      direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
      tradeability_label: 'GO',
    });
  });

  it('excludes all non-anonymous fields', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.INTERNAL, true);

    // Anonymous flag takes precedence over tier
    expect(Object.keys(result)).toHaveLength(3);
    expect(result).not.toHaveProperty('expected_move_pips');
    expect(result).not.toHaveProperty('state_layers');
    expect(result).not.toHaveProperty('historical_distributions');
    expect(result).not.toHaveProperty('trace_id_internal');
  });

  it('handles empty response', () => {
    const result = filterResponse({}, undefined, true);
    expect(result).toEqual({});
  });
});

// =============================================================================
// filterResponse Tests — RETAIL Tier (Req 4.1)
// =============================================================================

describe('filterResponse — RETAIL tier (Req 4.1)', () => {
  it('returns the 6 retail-authorised fields', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.RETAIL);

    expect(result).toEqual({
      direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
      expected_move_pips: 12.5,
      confidence_final: 0.68,
      tradeability_score: 0.82,
      tradeability_label: 'GO',
      forecast_valid_until: '2025-01-15T12:00:00Z',
    });
  });

  it('excludes developer fields', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.RETAIL);

    expect(result).not.toHaveProperty('state_layers');
    expect(result).not.toHaveProperty('layer_breakdown');
    expect(result).not.toHaveProperty('similarity_matches');
    expect(result).not.toHaveProperty('match_explanation');
    expect(result).not.toHaveProperty('contributing_factors');
    expect(result).not.toHaveProperty('execution_metrics');
  });

  it('excludes research fields', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.RETAIL);

    expect(result).not.toHaveProperty('historical_distributions');
    expect(result).not.toHaveProperty('time_series_data');
    expect(result).not.toHaveProperty('research_metadata');
  });

  it('excludes internal-only fields', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.RETAIL);

    expect(result).not.toHaveProperty('trace_id_internal');
    expect(result).not.toHaveProperty('pipeline_debug');
    expect(result).not.toHaveProperty('raw_engine_logs');
  });
});

// =============================================================================
// filterResponse Tests — DEVELOPER Tier (Req 4.2)
// =============================================================================

describe('filterResponse — DEVELOPER tier (Req 4.2)', () => {
  it('returns retail fields plus developer-additional fields (12 total)', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.DEVELOPER);

    expect(result).toEqual({
      // RETAIL fields
      direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
      expected_move_pips: 12.5,
      confidence_final: 0.68,
      tradeability_score: 0.82,
      tradeability_label: 'GO',
      forecast_valid_until: '2025-01-15T12:00:00Z',
      // DEVELOPER additional fields
      state_layers: { market_structure: [0.1, 0.2], volatility_profile: [0.3, 0.4] },
      layer_breakdown: { market_structure: 0.95, volatility: 0.88 },
      similarity_matches: [{ fingerprint_id: 'fp-1', similarity_score: 0.95 }],
      match_explanation: { matched_layers: ['market_structure'], mismatched_layers: [], primary_match_reason: 'similar structure' },
      contributing_factors: ['trend_alignment', 'volatility_match'],
      execution_metrics: { spread_penalty: 'low', session_alignment: 'optimal', news_buffer_status: 'clear' },
    });
  });

  it('excludes research fields', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.DEVELOPER);

    expect(result).not.toHaveProperty('historical_distributions');
    expect(result).not.toHaveProperty('time_series_data');
    expect(result).not.toHaveProperty('research_metadata');
  });

  it('excludes internal-only fields', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.DEVELOPER);

    expect(result).not.toHaveProperty('trace_id_internal');
    expect(result).not.toHaveProperty('pipeline_debug');
    expect(result).not.toHaveProperty('raw_engine_logs');
  });
});

// =============================================================================
// filterResponse Tests — RESEARCH Tier (Req 4.3)
// =============================================================================

describe('filterResponse — RESEARCH tier (Req 4.3)', () => {
  it('returns retail + developer + research fields (15 total)', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.RESEARCH);

    expect(result).toEqual({
      // RETAIL fields
      direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
      expected_move_pips: 12.5,
      confidence_final: 0.68,
      tradeability_score: 0.82,
      tradeability_label: 'GO',
      forecast_valid_until: '2025-01-15T12:00:00Z',
      // DEVELOPER additional fields
      state_layers: { market_structure: [0.1, 0.2], volatility_profile: [0.3, 0.4] },
      layer_breakdown: { market_structure: 0.95, volatility: 0.88 },
      similarity_matches: [{ fingerprint_id: 'fp-1', similarity_score: 0.95 }],
      match_explanation: { matched_layers: ['market_structure'], mismatched_layers: [], primary_match_reason: 'similar structure' },
      contributing_factors: ['trend_alignment', 'volatility_match'],
      execution_metrics: { spread_penalty: 'low', session_alignment: 'optimal', news_buffer_status: 'clear' },
      // RESEARCH additional fields
      historical_distributions: [{ month: '2024-01', data: [1, 2, 3] }],
      time_series_data: [{ timestamp: '2024-01-01', value: 1.05 }],
      research_metadata: { model_version: '2.1', training_date: '2024-12-01' },
    });
  });

  it('excludes internal-only fields (trace_id_internal, pipeline_debug, raw_engine_logs)', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.RESEARCH);

    expect(result).not.toHaveProperty('trace_id_internal');
    expect(result).not.toHaveProperty('pipeline_debug');
    expect(result).not.toHaveProperty('raw_engine_logs');
  });
});

// =============================================================================
// filterResponse Tests — INTERNAL Tier (Req 4.4)
// =============================================================================

describe('filterResponse — INTERNAL tier (Req 4.4)', () => {
  it('returns the complete unfiltered payload', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.INTERNAL);

    // Should contain every key from FULL_RESPONSE
    expect(Object.keys(result).sort()).toEqual(Object.keys(FULL_RESPONSE).sort());
  });

  it('includes internal-only fields', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.INTERNAL);

    expect(result).toHaveProperty('trace_id_internal', 'trace-abc-123');
    expect(result).toHaveProperty('pipeline_debug');
    expect(result).toHaveProperty('raw_engine_logs');
  });

  it('includes all other tier fields', () => {
    const result = filterResponse(FULL_RESPONSE, CustomerTier.INTERNAL);

    expect(result).toHaveProperty('direction_probabilities');
    expect(result).toHaveProperty('state_layers');
    expect(result).toHaveProperty('historical_distributions');
    expect(result).toHaveProperty('research_metadata');
  });
});

// =============================================================================
// filterResponse Tests — Default to RETAIL (Req 4.6)
// =============================================================================

describe('filterResponse — default to RETAIL when tier missing (Req 4.6)', () => {
  it('applies RETAIL filtering when tier is undefined', () => {
    const result = filterResponse(FULL_RESPONSE, undefined);

    expect(result).toEqual({
      direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
      expected_move_pips: 12.5,
      confidence_final: 0.68,
      tradeability_score: 0.82,
      tradeability_label: 'GO',
      forecast_valid_until: '2025-01-15T12:00:00Z',
    });
  });

  it('excludes developer and research fields when tier is undefined', () => {
    const result = filterResponse(FULL_RESPONSE, undefined);

    expect(result).not.toHaveProperty('state_layers');
    expect(result).not.toHaveProperty('historical_distributions');
    expect(result).not.toHaveProperty('trace_id_internal');
  });
});

// =============================================================================
// filterResponse Tests — Edge Cases
// =============================================================================

describe('filterResponse — edge cases', () => {
  it('handles empty response object', () => {
    const result = filterResponse({}, CustomerTier.RETAIL);
    expect(result).toEqual({});
  });

  it('returns only fields that exist in the source', () => {
    const partial = { direction_probabilities: { up: 0.5, down: 0.3, flat: 0.2 } };
    const result = filterResponse(partial, CustomerTier.RETAIL);

    expect(result).toEqual({ direction_probabilities: { up: 0.5, down: 0.3, flat: 0.2 } });
    expect(result).not.toHaveProperty('expected_move_pips');
  });

  it('does not mutate the original response object', () => {
    const original = { ...FULL_RESPONSE };
    const originalKeys = Object.keys(original).sort();

    filterResponse(original, CustomerTier.RETAIL);

    expect(Object.keys(original).sort()).toEqual(originalKeys);
  });
});

// =============================================================================
// createResponseFilter Middleware Tests
// =============================================================================

describe('createResponseFilter middleware', () => {
  /** Helper to create a mock request with tier and anonymous flags. */
  function createMockRequest(opts: { tier?: string; anonymous?: boolean } = {}): Request {
    return {
      tier: opts.tier,
      anonymous: opts.anonymous ?? false,
    } as unknown as Request;
  }

  /** Helper to create a mock response with json method. */
  function createMockResponse() {
    const res: Partial<Response> = {};
    const sentData: unknown[] = [];
    res.json = vi.fn((body: unknown) => {
      sentData.push(body);
      return res as Response;
    });
    res.status = vi.fn().mockReturnValue(res);
    (res as Record<string, unknown>).__sentData = sentData;
    return res as Response;
  }

  it('calls next() to register the interceptor', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ tier: 'RETAIL' });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('filters response data based on tier when res.json is called', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ tier: 'RETAIL' });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    // Simulate route handler calling res.json with full data
    res.json(FULL_RESPONSE);

    const sentData = (res as Record<string, unknown>).__sentData as unknown[];
    const filtered = sentData[0] as Record<string, unknown>;

    expect(filtered).toHaveProperty('direction_probabilities');
    expect(filtered).toHaveProperty('confidence_final');
    expect(filtered).not.toHaveProperty('state_layers');
    expect(filtered).not.toHaveProperty('historical_distributions');
  });

  it('filters enveloped responses (data field)', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ tier: 'RETAIL' });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    // Simulate route handler calling res.json with envelope format
    res.json({
      data: FULL_RESPONSE,
      meta: { request_id: 'uuid-123', timestamp: '2025-01-15T00:00:00Z' },
    });

    const sentData = (res as Record<string, unknown>).__sentData as unknown[];
    const envelope = sentData[0] as Record<string, unknown>;
    const data = envelope.data as Record<string, unknown>;

    expect(data).toHaveProperty('direction_probabilities');
    expect(data).not.toHaveProperty('state_layers');
    // Meta is preserved
    expect(envelope).toHaveProperty('meta');
  });

  it('does not filter error responses', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ tier: 'RETAIL' });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    const errorBody = {
      error: 'not_found',
      message: 'Resource not found',
      request_id: 'uuid-123',
    };
    res.json(errorBody);

    const sentData = (res as Record<string, unknown>).__sentData as unknown[];
    expect(sentData[0]).toEqual(errorBody);
  });

  it('applies anonymous filtering when req.anonymous is true', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ anonymous: true });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    res.json(FULL_RESPONSE);

    const sentData = (res as Record<string, unknown>).__sentData as unknown[];
    const filtered = sentData[0] as Record<string, unknown>;

    expect(Object.keys(filtered).sort()).toEqual(
      ['confidence_final', 'direction_probabilities', 'tradeability_label'].sort()
    );
  });

  it('defaults to RETAIL filtering when tier is not set (Req 4.6)', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({}); // No tier, not anonymous
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    res.json(FULL_RESPONSE);

    const sentData = (res as Record<string, unknown>).__sentData as unknown[];
    const filtered = sentData[0] as Record<string, unknown>;

    expect(filtered).toHaveProperty('direction_probabilities');
    expect(filtered).toHaveProperty('expected_move_pips');
    expect(filtered).toHaveProperty('confidence_final');
    expect(filtered).toHaveProperty('tradeability_score');
    expect(filtered).toHaveProperty('tradeability_label');
    expect(filtered).toHaveProperty('forecast_valid_until');
    expect(filtered).not.toHaveProperty('state_layers');
  });

  it('INTERNAL tier returns complete payload through middleware', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ tier: 'INTERNAL' });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    res.json(FULL_RESPONSE);

    const sentData = (res as Record<string, unknown>).__sentData as unknown[];
    const filtered = sentData[0] as Record<string, unknown>;

    expect(Object.keys(filtered).sort()).toEqual(Object.keys(FULL_RESPONSE).sort());
  });

  it('passes through null/undefined/array bodies unchanged', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ tier: 'RETAIL' });
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    res.json(null);
    res.json([1, 2, 3]);

    const sentData = (res as Record<string, unknown>).__sentData as unknown[];
    expect(sentData[0]).toBeNull();
    expect(sentData[1]).toEqual([1, 2, 3]);
  });
});
