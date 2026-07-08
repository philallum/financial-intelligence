/**
 * State Route - GET /v1/state/:asset
 *
 * Returns the current regime and session state from the latest fingerprint
 * for the given asset.
 *
 * Requirements: 6.2, 6.3, 8.1
 */

import { Router } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { successResponse, errorResponse } from '../utils/response-envelope.js';
import { getActiveSymbols } from '../../config/research-assets.js';

export interface StateRouteOptions {
  supabase: SupabaseClient;
}

export function createStateRouter(options: StateRouteOptions): Router {
  const { supabase } = options;
  const router = Router();

  router.get('/:asset', async (req, res) => {
    const { asset } = req.params;
    const upperAsset = asset.toUpperCase();
    const requestId = req.requestId ?? 'unknown';

    // Check if asset is supported
    const activeSymbols = getActiveSymbols();
    if (!activeSymbols.includes(upperAsset)) {
      res.status(400).json(
        errorResponse(
          'asset_not_supported',
          `Asset "${upperAsset}" is not supported. Supported assets: ${activeSymbols.join(', ')}`,
          requestId,
        ),
      );
      return;
    }

    // Fetch the latest fingerprint for the asset to get current regime and session
    const { data, error } = await supabase
      .from('fingerprints')
      .select('fingerprint_id, asset, timestamp_utc, regime, market_state_version')
      .eq('asset', upperAsset)
      .order('timestamp_utc', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      res.status(404).json(
        errorResponse(
          'state_unavailable',
          `No state data is currently available for asset "${upperAsset}"`,
          requestId,
        ),
      );
      return;
    }

    res.status(200).json(
      successResponse(
        {
          asset: upperAsset,
          fingerprint_id: data.fingerprint_id,
          timestamp_utc: data.timestamp_utc,
          regime: data.regime,
          market_state_version: data.market_state_version,
        },
        requestId,
      ),
    );
  });

  return router;
}
