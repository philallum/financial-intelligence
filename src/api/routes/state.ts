/**
 * State Route - GET /v1/state/:asset
 *
 * Returns the current regime and session state from the latest fingerprint
 * for the given asset.
 *
 * Requirements: 8.1
 */

import { Router } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Assets supported by the MVP */
const SUPPORTED_ASSETS = ['EURUSD'] as const;

export interface StateRouteOptions {
  supabase: SupabaseClient;
}

export function createStateRouter(options: StateRouteOptions): Router {
  const { supabase } = options;
  const router = Router();

  router.get('/:asset', async (req, res) => {
    const { asset } = req.params;
    const upperAsset = asset.toUpperCase();

    // Check if asset is supported
    if (!SUPPORTED_ASSETS.includes(upperAsset as typeof SUPPORTED_ASSETS[number])) {
      res.status(400).json({
        error: 'asset_not_supported',
        asset: upperAsset,
        message: `Asset "${upperAsset}" is not supported. Supported assets: ${SUPPORTED_ASSETS.join(', ')}`,
      });
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
      res.status(404).json({
        error: 'state_unavailable',
        asset: upperAsset,
        message: `No state data is currently available for asset "${upperAsset}"`,
      });
      return;
    }

    res.status(200).json({
      asset: upperAsset,
      fingerprint_id: data.fingerprint_id,
      timestamp_utc: data.timestamp_utc,
      regime: data.regime,
      market_state_version: data.market_state_version,
    });
  });

  return router;
}
