/**
 * Express API Gateway for the Financial Intelligence Platform.
 *
 * Sets up the Express application with versioned routes under /v1/.
 * This module exports the app without calling listen() — the entry point
 * or test harness is responsible for starting the server.
 *
 * Routes:
 * - GET /v1/forecast/:asset — Cached forecast + real-time tradeability
 * - GET /v1/similarity/:asset — Latest similarity matches
 * - GET /v1/state/:asset — Current regime and session state
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import express from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createForecastRouter } from './routes/forecast.js';
import { createSimilarityRouter } from './routes/similarity.js';
import { createStateRouter } from './routes/state.js';

export interface CreateAppOptions {
  supabase: SupabaseClient;
}

/**
 * Creates and configures the Express application.
 * Uses dependency injection for the Supabase client to support testing.
 */
export function createApp(options: CreateAppOptions): express.Express {
  const { supabase } = options;
  const app = express();

  // Middleware
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Versioned API routes
  app.use('/v1/forecast', createForecastRouter({ supabase }));
  app.use('/v1/similarity', createSimilarityRouter({ supabase }));
  app.use('/v1/state', createStateRouter({ supabase }));

  return app;
}
