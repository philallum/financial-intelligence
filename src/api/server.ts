/**
 * Express API Gateway for the Financial Intelligence Platform.
 *
 * Sets up the Express application with the full middleware chain in strict order:
 * 1. Security headers
 * 2. Request ID
 * 3. Size guard
 * 4. CORS
 * 5. Auth middleware (skipped for public routes)
 * 6. Authorisation middleware
 * 7. Rate limiter (skipped for RapidAPI requests)
 * 8. Response filter (wraps response, uses req.tier)
 * 9. Edge cache
 * 10. Route handlers
 *
 * Routes:
 * - GET /health — Simple health check
 * - GET /v1/forecast/:asset — Cached forecast + real-time tradeability
 * - GET /v1/similarity/:asset — Latest similarity matches
 * - GET /v1/state/:asset — Current regime and session state
 *
 * Requirements: 3.4, 6.1, 10.3, 15.1
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

// Middleware imports
import { securityHeaders } from './middleware/security.js';
import { requestId } from './middleware/request-id.js';
import { sizeGuard } from './middleware/size-guard.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { authorisationMiddleware } from './middleware/authorisation.js';
import { createRateLimiterMiddleware } from './middleware/rate-limiter.js';
import { createResponseFilter } from './middleware/response-filter.js';
import { createEdgeCacheMiddleware, EdgeCacheStore } from './middleware/edge-cache.js';
import { errorHandler } from './middleware/error-handler.js';
import { methodNotAllowed } from './middleware/method-not-allowed.js';

// Route imports
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

  // ==========================================================================
  // 1. Security Headers (Req 15.1)
  // ==========================================================================
  app.use(securityHeaders);

  // ==========================================================================
  // 2. Request ID (Req 10.1)
  // ==========================================================================
  app.use(requestId);

  // ==========================================================================
  // 3. Size Guard (Req 15.2, 15.5)
  // ==========================================================================
  app.use(sizeGuard);

  // ==========================================================================
  // 4. CORS — Allow all origins for MVP
  // ==========================================================================
  app.use((req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization, X-RapidAPI-Proxy-Secret, X-RapidAPI-User, X-RapidAPI-Subscription');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Body parser (after size guard, before routes)
  app.use(express.json());

  // ==========================================================================
  // Public Routes — bypass auth/authorisation/rate-limiter
  // ==========================================================================

  // Health endpoint (Req 10.3) — simple version
  app.get('/health', (_req: Request, res: Response): void => {
    res.status(200).json({ status: 'ok' });
  });

  // ==========================================================================
  // Protected Routes — full middleware chain
  // ==========================================================================

  // 5. Auth Middleware (Req 1.x)
  const authMiddleware = createAuthMiddleware({ supabase });

  // 6. Authorisation Middleware (Req 3.x)
  // 7. Rate Limiter (Req 5.x) — internally skips RapidAPI requests
  const rateLimiterMiddleware = createRateLimiterMiddleware({ supabase });

  // 8. Response Filter (Req 4.x)
  const { middleware: responseFilterMiddleware } = createResponseFilter();

  // 9. Edge Cache
  const edgeCacheStore = new EdgeCacheStore();
  const edgeCacheMiddleware = createEdgeCacheMiddleware(edgeCacheStore);

  // Wire the protected middleware chain for /v1 routes
  const protectedMiddlewareChain = [
    authMiddleware,
    authorisationMiddleware,
    rateLimiterMiddleware,
    responseFilterMiddleware,
    edgeCacheMiddleware,
  ];

  // ==========================================================================
  // 10. Route Handlers
  // ==========================================================================

  // Forecast routes: GET /v1/forecast/:asset
  app.use(
    '/v1/forecast',
    ...protectedMiddlewareChain,
    methodNotAllowed(['GET']),
    createForecastRouter({ supabase }),
  );

  // Similarity routes: GET /v1/similarity/:asset
  app.use(
    '/v1/similarity',
    ...protectedMiddlewareChain,
    methodNotAllowed(['GET']),
    createSimilarityRouter({ supabase }),
  );

  // State routes: GET /v1/state/:asset
  app.use(
    '/v1/state',
    ...protectedMiddlewareChain,
    methodNotAllowed(['GET']),
    createStateRouter({ supabase }),
  );

  // ==========================================================================
  // Global 405 for unmatched routes (catch-all)
  // ==========================================================================
  app.all('*', (req: Request, res: Response): void => {
    res.status(404).json({
      error: 'not_found',
      message: `Route ${req.method} ${req.path} not found.`,
      ...(req.requestId ? { request_id: req.requestId } : {}),
    });
  });

  // ==========================================================================
  // Global Error Handler (MUST be last — Req 14.2, 14.3)
  // ==========================================================================
  app.use(errorHandler);

  return app;
}
