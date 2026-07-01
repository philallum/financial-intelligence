/**
 * Tests for the Response Mode Filter Middleware.
 *
 * Validates:
 * - Mode resolution and defaults (Req 11.12)
 * - MODE_ACCESS matrix enforcement (Req 11.8, 11.9)
 * - Field stripping per mode (Req 11.8)
 * - Retail tier field restrictions (Req 11.1)
 * - Middleware integration behavior
 *
 * Requirements: 11.1, 11.2, 11.3, 11.8, 11.9, 11.10, 11.12
 */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  resolveMode,
  validateModeAccess,
  filterResponse,
  createResponseFilter,
} from '../../../src/api/middleware/response-filter.js';
import { ResponseMode, CustomerTier } from '../../../src/types/enums.js';

// =============================================================================
// Test Fixtures
// =============================================================================

/** A full response containing all possible fields for testing field stripping. */
const FULL_RESPONSE: Record<string, unknown> = {
  // Forecast fields
  direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
  expected_move_pips: 12.5,
  confidence_final: 0.68,
  // Trade fields
  tradeability_score: 0.82,
  tradeability_label: 'GO',
  execution_metrics: { spread_penalty: 'low', session_alignment: 'optimal', news_buffer_status: 'clear' },
  // Explain fields
  match_explanation: { matched_layers: ['market_structure'], mismatched_layers: [], primary_match_reason: 'similar structure' },
  contributing_factors: ['trend_alignment', 'volatility_match'],
  // Raw fields (vectors/matrices)
  state_layers: { market_structure: [0.1, 0.2], volatility_profile: [0.3, 0.4] },
  layer_breakdown: { market_structure: 0.95, volatility: 0.88 },
  similarity_matches: [{ fingerprint_id: 'fp-1', similarity_score: 0.95 }],
  // Research fields
  historical_distributions: [{ month: '2024-01', data: [1, 2, 3] }],
  time_series_data: [{ timestamp: '2024-01-01', value: 1.05 }],
  // Metadata
  asset: 'EURUSD',
  batch_id: 'batch-001',
};

// =============================================================================
// resolveMode Tests (Req 11.12)
// =============================================================================

describe('resolveMode', () => {
  it('defaults to FORECAST when parameter is undefined', () => {
    expect(resolveMode(undefined)).toBe(ResponseMode.FORECAST);
  });

  it('defaults to FORECAST when parameter is null', () => {
    expect(resolveMode(null)).toBe(ResponseMode.FORECAST);
  });

  it('defaults to FORECAST when parameter is empty string', () => {
    expect(resolveMode('')).toBe(ResponseMode.FORECAST);
  });

  it('defaults to FORECAST when parameter is whitespace only', () => {
    expect(resolveMode('   ')).toBe(ResponseMode.FORECAST);
  });

  it('resolves "forecast" (lowercase) to FORECAST', () => {
    expect(resolveMode('forecast')).toBe(ResponseMode.FORECAST);
  });

  it('resolves "TRADE" (uppercase) to TRADE', () => {
    expect(resolveMode('TRADE')).toBe(ResponseMode.TRADE);
  });

  it('resolves "explain" (lowercase) to EXPLAIN', () => {
    expect(resolveMode('explain')).toBe(ResponseMode.EXPLAIN);
  });

  it('resolves "Raw" (mixed case) to RAW', () => {
    expect(resolveMode('Raw')).toBe(ResponseMode.RAW);
  });

  it('resolves "research" to RESEARCH', () => {
    expect(resolveMode('research')).toBe(ResponseMode.RESEARCH);
  });

  it('defaults to FORECAST for invalid mode string', () => {
    expect(resolveMode('invalid')).toBe(ResponseMode.FORECAST);
  });

  it('trims whitespace before resolving', () => {
    expect(resolveMode('  trade  ')).toBe(ResponseMode.TRADE);
  });
});

// =============================================================================
// validateModeAccess Tests (Req 11.9)
// =============================================================================

describe('validateModeAccess', () => {
  describe('RETAIL tier', () => {
    it('allows forecast mode', () => {
      expect(validateModeAccess(ResponseMode.FORECAST, CustomerTier.RETAIL)).toBe(true);
    });

    it('allows trade mode', () => {
      expect(validateModeAccess(ResponseMode.TRADE, CustomerTier.RETAIL)).toBe(true);
    });

    it('rejects explain mode', () => {
      expect(validateModeAccess(ResponseMode.EXPLAIN, CustomerTier.RETAIL)).toBe(false);
    });

    it('rejects raw mode', () => {
      expect(validateModeAccess(ResponseMode.RAW, CustomerTier.RETAIL)).toBe(false);
    });

    it('rejects research mode', () => {
      expect(validateModeAccess(ResponseMode.RESEARCH, CustomerTier.RETAIL)).toBe(false);
    });
  });

  describe('DEVELOPER tier', () => {
    it('allows forecast mode', () => {
      expect(validateModeAccess(ResponseMode.FORECAST, CustomerTier.DEVELOPER)).toBe(true);
    });

    it('allows trade mode', () => {
      expect(validateModeAccess(ResponseMode.TRADE, CustomerTier.DEVELOPER)).toBe(true);
    });

    it('allows explain mode', () => {
      expect(validateModeAccess(ResponseMode.EXPLAIN, CustomerTier.DEVELOPER)).toBe(true);
    });

    it('allows raw mode', () => {
      expect(validateModeAccess(ResponseMode.RAW, CustomerTier.DEVELOPER)).toBe(true);
    });

    it('rejects research mode', () => {
      expect(validateModeAccess(ResponseMode.RESEARCH, CustomerTier.DEVELOPER)).toBe(false);
    });
  });

  describe('RESEARCH tier', () => {
    it('allows all modes including research', () => {
      expect(validateModeAccess(ResponseMode.FORECAST, CustomerTier.RESEARCH)).toBe(true);
      expect(validateModeAccess(ResponseMode.TRADE, CustomerTier.RESEARCH)).toBe(true);
      expect(validateModeAccess(ResponseMode.EXPLAIN, CustomerTier.RESEARCH)).toBe(true);
      expect(validateModeAccess(ResponseMode.RAW, CustomerTier.RESEARCH)).toBe(true);
      expect(validateModeAccess(ResponseMode.RESEARCH, CustomerTier.RESEARCH)).toBe(true);
    });
  });

  describe('INTEGRATOR tier', () => {
    it('allows all modes including research', () => {
      expect(validateModeAccess(ResponseMode.FORECAST, CustomerTier.INTEGRATOR)).toBe(true);
      expect(validateModeAccess(ResponseMode.TRADE, CustomerTier.INTEGRATOR)).toBe(true);
      expect(validateModeAccess(ResponseMode.EXPLAIN, CustomerTier.INTEGRATOR)).toBe(true);
      expect(validateModeAccess(ResponseMode.RAW, CustomerTier.INTEGRATOR)).toBe(true);
      expect(validateModeAccess(ResponseMode.RESEARCH, CustomerTier.INTEGRATOR)).toBe(true);
    });
  });

  describe('INTERNAL tier', () => {
    it('allows all modes including research', () => {
      expect(validateModeAccess(ResponseMode.FORECAST, CustomerTier.INTERNAL)).toBe(true);
      expect(validateModeAccess(ResponseMode.TRADE, CustomerTier.INTERNAL)).toBe(true);
      expect(validateModeAccess(ResponseMode.EXPLAIN, CustomerTier.INTERNAL)).toBe(true);
      expect(validateModeAccess(ResponseMode.RAW, CustomerTier.INTERNAL)).toBe(true);
      expect(validateModeAccess(ResponseMode.RESEARCH, CustomerTier.INTERNAL)).toBe(true);
    });
  });
});

// =============================================================================
// filterResponse Tests (Req 11.1, 11.8)
// =============================================================================

describe('filterResponse', () => {
  describe('forecast mode', () => {
    it('returns only forecast fields', () => {
      const result = filterResponse(FULL_RESPONSE, ResponseMode.FORECAST, CustomerTier.DEVELOPER);

      expect(result).toEqual({
        direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
        expected_move_pips: 12.5,
        confidence_final: 0.68,
      });
    });

    it('excludes trade, explain, raw, and research fields', () => {
      const result = filterResponse(FULL_RESPONSE, ResponseMode.FORECAST, CustomerTier.DEVELOPER);

      expect(result).not.toHaveProperty('tradeability_score');
      expect(result).not.toHaveProperty('match_explanation');
      expect(result).not.toHaveProperty('state_layers');
      expect(result).not.toHaveProperty('historical_distributions');
    });
  });

  describe('trade mode', () => {
    it('returns only trade fields', () => {
      const result = filterResponse(FULL_RESPONSE, ResponseMode.TRADE, CustomerTier.DEVELOPER);

      expect(result).toEqual({
        tradeability_score: 0.82,
        tradeability_label: 'GO',
        execution_metrics: { spread_penalty: 'low', session_alignment: 'optimal', news_buffer_status: 'clear' },
      });
    });

    it('excludes forecast and raw fields', () => {
      const result = filterResponse(FULL_RESPONSE, ResponseMode.TRADE, CustomerTier.DEVELOPER);

      expect(result).not.toHaveProperty('direction_probabilities');
      expect(result).not.toHaveProperty('state_layers');
    });
  });

  describe('explain mode', () => {
    it('returns forecast fields plus explanation fields', () => {
      const result = filterResponse(FULL_RESPONSE, ResponseMode.EXPLAIN, CustomerTier.DEVELOPER);

      expect(result).toEqual({
        direction_probabilities: { up: 0.55, down: 0.30, flat: 0.15 },
        expected_move_pips: 12.5,
        confidence_final: 0.68,
        match_explanation: { matched_layers: ['market_structure'], mismatched_layers: [], primary_match_reason: 'similar structure' },
        contributing_factors: ['trend_alignment', 'volatility_match'],
      });
    });

    it('excludes raw vectors and trade fields', () => {
      const result = filterResponse(FULL_RESPONSE, ResponseMode.EXPLAIN, CustomerTier.DEVELOPER);

      expect(result).not.toHaveProperty('state_layers');
      expect(result).not.toHaveProperty('tradeability_score');
    });
  });

  describe('raw mode', () => {
    it('returns all fields for non-retail tiers', () => {
      const result = filterResponse(FULL_RESPONSE, ResponseMode.RAW, CustomerTier.DEVELOPER);

      expect(result).toHaveProperty('direction_probabilities');
      expect(result).toHaveProperty('state_layers');
      expect(result).toHaveProperty('layer_breakdown');
      expect(result).toHaveProperty('similarity_matches');
      expect(result).toHaveProperty('match_explanation');
    });
  });

  describe('research mode', () => {
    it('returns all fields including historical data', () => {
      const result = filterResponse(FULL_RESPONSE, ResponseMode.RESEARCH, CustomerTier.RESEARCH);

      expect(result).toHaveProperty('historical_distributions');
      expect(result).toHaveProperty('time_series_data');
      expect(result).toHaveProperty('state_layers');
      expect(result).toHaveProperty('direction_probabilities');
    });
  });

  describe('retail tier field stripping (Req 11.1)', () => {
    it('strips state_layers from retail forecast response', () => {
      const responseWithLayers = {
        ...FULL_RESPONSE,
      };
      const result = filterResponse(responseWithLayers, ResponseMode.FORECAST, CustomerTier.RETAIL);

      expect(result).not.toHaveProperty('state_layers');
    });

    it('strips layer_breakdown from retail trade response', () => {
      const result = filterResponse(FULL_RESPONSE, ResponseMode.TRADE, CustomerTier.RETAIL);

      expect(result).not.toHaveProperty('layer_breakdown');
    });

    it('strips similarity_matches from retail responses', () => {
      const result = filterResponse(FULL_RESPONSE, ResponseMode.FORECAST, CustomerTier.RETAIL);

      expect(result).not.toHaveProperty('similarity_matches');
    });

    it('does not strip restricted fields for developer tier', () => {
      const result = filterResponse(FULL_RESPONSE, ResponseMode.RAW, CustomerTier.DEVELOPER);

      expect(result).toHaveProperty('state_layers');
      expect(result).toHaveProperty('layer_breakdown');
      expect(result).toHaveProperty('similarity_matches');
    });
  });

  describe('edge cases', () => {
    it('handles empty response object gracefully', () => {
      const result = filterResponse({}, ResponseMode.FORECAST, CustomerTier.RETAIL);
      expect(result).toEqual({});
    });

    it('handles response with missing fields (returns only those present)', () => {
      const partial = { direction_probabilities: { up: 0.5, down: 0.3, flat: 0.2 } };
      const result = filterResponse(partial, ResponseMode.FORECAST, CustomerTier.DEVELOPER);

      expect(result).toEqual({ direction_probabilities: { up: 0.5, down: 0.3, flat: 0.2 } });
      expect(result).not.toHaveProperty('expected_move_pips');
    });
  });
});

// =============================================================================
// createResponseFilter Middleware Tests (Req 11.9, 11.12)
// =============================================================================

describe('createResponseFilter middleware', () => {
  /** Helper to create a mock request with query and tier. */
  function createMockRequest(query: Record<string, string> = {}, tier?: string): Request {
    return {
      query,
      tier,
    } as unknown as Request;
  }

  /** Helper to create a mock response with json and status. */
  function createMockResponse() {
    const res: Partial<Response> = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res as Response;
  }

  it('attaches resolved mode to request and calls next()', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ mode: 'trade' }, 'DEVELOPER');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect((req as Record<string, unknown>).responseMode).toBe(ResponseMode.TRADE);
    expect(next).toHaveBeenCalledOnce();
  });

  it('defaults to FORECAST when mode query param is absent (Req 11.12)', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({}, 'RETAIL');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect((req as Record<string, unknown>).responseMode).toBe(ResponseMode.FORECAST);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 403 when tier does not authorize requested mode (Req 11.9)', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ mode: 'raw' }, 'RETAIL');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'mode_not_available',
      mode: 'RAW',
      tier: 'RETAIL',
      message: 'Response mode "RAW" is not available for tier "RETAIL"',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when retail requests research mode', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ mode: 'research' }, 'RETAIL');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'mode_not_available',
        mode: 'RESEARCH',
        tier: 'RETAIL',
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when developer requests research mode', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ mode: 'research' }, 'DEVELOPER');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'mode_not_available',
        mode: 'RESEARCH',
        tier: 'DEVELOPER',
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('allows research tier to access research mode', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ mode: 'research' }, 'RESEARCH');
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    expect((req as Record<string, unknown>).responseMode).toBe(ResponseMode.RESEARCH);
    expect(next).toHaveBeenCalledOnce();
  });

  it('defaults to RETAIL tier when tier is not set on request', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({ mode: 'raw' }); // No tier set
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    // Should reject since RETAIL cannot access RAW
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows request through when no mode and no tier (defaults to FORECAST + RETAIL)', () => {
    const { middleware } = createResponseFilter();
    const req = createMockRequest({}); // No mode, no tier
    const res = createMockResponse();
    const next = vi.fn() as unknown as NextFunction;

    middleware(req, res, next);

    // FORECAST is allowed for RETAIL
    expect((req as Record<string, unknown>).responseMode).toBe(ResponseMode.FORECAST);
    expect(next).toHaveBeenCalledOnce();
  });
});
