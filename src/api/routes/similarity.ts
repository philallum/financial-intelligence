/**
 * Similarity Route - GET /v1/similarity/:asset
 *
 * Fetches paginated similarity matches for the given asset from the
 * similarity_matches table.
 *
 * Requirements: 6.5, 6.6, 8.1
 */

import { Router } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errorResponse } from '../utils/response-envelope.js';

/** Assets supported by the MVP */
const SUPPORTED_ASSETS = ['EURUSD'] as const;

/** Pagination defaults and bounds */
const PAGINATION = {
  DEFAULT_LIMIT: 20,
  MIN_LIMIT: 1,
  MAX_LIMIT: 100,
  DEFAULT_OFFSET: 0,
  MIN_OFFSET: 0,
} as const;

export interface SimilarityRouteOptions {
  supabase: SupabaseClient;
}

/**
 * Validates a pagination parameter value.
 * Returns the parsed integer if valid, or null if invalid.
 */
function parsePaginationParam(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null; // Use default
  }

  const str = String(value);
  // Reject floats (contains a dot), non-numeric strings
  if (!/^-?\d+$/.test(str)) {
    return NaN; // Signal invalid
  }

  const num = parseInt(str, 10);
  if (!Number.isFinite(num)) {
    return NaN;
  }

  return num;
}

export function createSimilarityRouter(options: SimilarityRouteOptions): Router {
  const { supabase } = options;
  const router = Router();

  router.get('/:asset', async (req, res) => {
    const { asset } = req.params;
    const upperAsset = asset.toUpperCase();
    const requestId = (req as any).requestId ?? '';

    // Check if asset is supported
    if (!SUPPORTED_ASSETS.includes(upperAsset as typeof SUPPORTED_ASSETS[number])) {
      res.status(400).json(
        errorResponse(
          'asset_not_supported',
          `Asset "${upperAsset}" is not supported. Supported assets: ${SUPPORTED_ASSETS.join(', ')}`,
          requestId,
        ),
      );
      return;
    }

    // Parse and validate pagination parameters (Req 6.6)
    const rawLimit = parsePaginationParam(req.query.limit);
    const rawOffset = parsePaginationParam(req.query.offset);

    // Validate limit
    let limit = PAGINATION.DEFAULT_LIMIT;
    if (rawLimit !== null) {
      if (Number.isNaN(rawLimit) || rawLimit < PAGINATION.MIN_LIMIT || rawLimit > PAGINATION.MAX_LIMIT) {
        res.status(400).json(
          errorResponse(
            'invalid_parameter',
            `Parameter "limit" must be an integer between ${PAGINATION.MIN_LIMIT} and ${PAGINATION.MAX_LIMIT}.`,
            requestId,
          ),
        );
        return;
      }
      limit = rawLimit;
    }

    // Validate offset
    let offset = PAGINATION.DEFAULT_OFFSET;
    if (rawOffset !== null) {
      if (Number.isNaN(rawOffset) || rawOffset < PAGINATION.MIN_OFFSET) {
        res.status(400).json(
          errorResponse(
            'invalid_parameter',
            `Parameter "offset" must be a non-negative integer.`,
            requestId,
          ),
        );
        return;
      }
      offset = rawOffset;
    }

    // Get total count (Req 6.5)
    const { count, error: countError } = await supabase
      .from('similarity_matches')
      .select('*', { count: 'exact', head: true })
      .eq('asset', upperAsset);

    if (countError) {
      res.status(500).json(
        errorResponse(
          'internal_error',
          'Failed to retrieve similarity matches',
          requestId,
        ),
      );
      return;
    }

    const total = count ?? 0;

    // Fetch paginated data
    const { data, error } = await supabase
      .from('similarity_matches')
      .select('*')
      .eq('asset', upperAsset)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      res.status(500).json(
        errorResponse(
          'internal_error',
          'Failed to retrieve similarity matches',
          requestId,
        ),
      );
      return;
    }

    const has_more = (offset + limit) < total;

    // Return paginated response with standard envelope (Req 6.5)
    res.status(200).json({
      data: data ?? [],
      pagination: {
        total,
        limit,
        offset,
        has_more,
      },
      meta: {
        request_id: requestId,
        timestamp: new Date().toISOString(),
      },
    });
  });

  return router;
}
