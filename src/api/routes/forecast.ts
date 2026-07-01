/**
 * Forecast Route - GET /v1/forecast/:asset
 *
 * Fetches cached forecast, injects runtime conditions, executes the
 * Tradeability Engine, and returns the combined response.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { Router } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeTradeabilityFromInput } from '../../engines/tradeability-engine.js';
import type { Forecast } from '../../types/index.js';
import { Session } from '../../types/enums.js';

/** Assets supported by the MVP */
const SUPPORTED_ASSETS = ['EURUSD'] as const;

export interface ForecastRouteOptions {
  supabase: SupabaseClient;
}

/**
 * Determines the current trading session based on UTC hour.
 * London: 07:00–15:00, NY: 12:00–21:00 (overlap goes to NY), Asia: 21:00–07:00
 */
function getCurrentSession(): Session {
  const hour = new Date().getUTCHours();
  if (hour >= 12 && hour < 21) return Session.NY;
  if (hour >= 7 && hour < 12) return Session.LONDON;
  return Session.ASIA;
}

export function createForecastRouter(options: ForecastRouteOptions): Router {
  const { supabase } = options;
  const router = Router();

  router.get('/:asset', async (req, res) => {
    const { asset } = req.params;
    const upperAsset = asset.toUpperCase();

    // Req 8.5: Check if asset is supported
    if (!SUPPORTED_ASSETS.includes(upperAsset as typeof SUPPORTED_ASSETS[number])) {
      res.status(400).json({
        error: 'asset_not_supported',
        asset: upperAsset,
        message: `Asset "${upperAsset}" is not supported. Supported assets: ${SUPPORTED_ASSETS.join(', ')}`,
      });
      return;
    }

    // Fetch cached forecast from database
    const { data, error } = await supabase
      .from('cached_forecasts')
      .select('payload, valid_until')
      .eq('asset', upperAsset)
      .single();

    // Req 8.4: Return error if no cached forecast exists
    if (error || !data) {
      res.status(404).json({
        error: 'forecast_unavailable',
        asset: upperAsset,
        message: `No forecast is currently available for asset "${upperAsset}"`,
      });
      return;
    }

    const forecast = data.payload as Forecast;
    const forecastValidUntil = data.valid_until as string;

    // Inject runtime conditions and execute Tradeability Engine
    const session = getCurrentSession();
    const tradeabilityResult = computeTradeabilityFromInput({
      forecast,
      spread_pips: 1.5, // Default spread for MVP — would come from live feed
      session_state: session,
      live_liquidity_proxy: 0.75, // Default liquidity for MVP
      news_risk_flag: false, // Default no news risk for MVP
    });

    // Req 8.2: Return combined response
    res.status(200).json({
      asset: upperAsset,
      direction_probabilities: forecast.direction_probabilities,
      expected_move_pips: forecast.expected_move_pips,
      confidence_final: forecast.confidence_final,
      tradeability_score: tradeabilityResult.tradeability_score,
      tradeability_label: tradeabilityResult.tradeability_label,
      forecast_valid_until: forecastValidUntil,
      execution_metrics: tradeabilityResult.execution_metrics,
    });
  });

  return router;
}
