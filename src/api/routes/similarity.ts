/**
 * Similarity Route - GET /v1/similarity/:asset
 *
 * Fetches the latest similarity matches for the given asset from the
 * similarity_matches table.
 *
 * Requirements: 8.1
 */

import { Router } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Assets supported by the MVP */
const SUPPORTED_ASSETS = ['EURUSD'] as const;

export interface SimilarityRouteOptions {
  supabase: SupabaseClient;
}

export function createSimilarityRouter(options: SimilarityRouteOptions): Router {
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

    // Fetch the latest batch of similarity matches for the asset
    const { data, error } = await supabase
      .from('similarity_matches')
      .select('*')
      .eq('asset', upperAsset)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      res.status(500).json({
        error: 'internal_error',
        message: 'Failed to retrieve similarity matches',
      });
      return;
    }

    if (!data || data.length === 0) {
      res.status(404).json({
        error: 'no_matches_available',
        asset: upperAsset,
        message: `No similarity matches are currently available for asset "${upperAsset}"`,
      });
      return;
    }

    res.status(200).json({
      asset: upperAsset,
      match_count: data.length,
      matches: data,
    });
  });

  return router;
}
