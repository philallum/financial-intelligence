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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

// Middleware imports
import { securityHeaders } from './middleware/security.js';
import { requestId } from './middleware/request-id.js';
import { requestLogger } from './middleware/request-logger.js';
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
  // 2b. Request Logger (Req 10.2, 10.5)
  // ==========================================================================
  app.use(requestLogger);

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

  // Health endpoint (Req 10.3, 10.6) — with dependency checks
  app.get('/health', async (_req: Request, res: Response): Promise<void> => {
    const HEALTH_CHECK_TIMEOUT_MS = 5000;
    let databaseStatus: 'connected' | 'disconnected' = 'disconnected';
    let status: 'healthy' | 'degraded' = 'degraded';

    try {
      const dbCheck = supabase
        .from('customers')
        .select('id', { count: 'exact', head: true });

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Health check timeout')), HEALTH_CHECK_TIMEOUT_MS);
      });

      const result = await Promise.race([dbCheck, timeoutPromise]);

      if (result && !(result as any).error) {
        databaseStatus = 'connected';
        status = 'healthy';
      }
    } catch {
      // Timeout or error — remain degraded/disconnected
    }

    res.status(200).json({
      status,
      database: databaseStatus,
      timestamp: new Date().toISOString(),
    });
  });

  // OpenAPI spec endpoint (Req 7.1, 7.6) — no auth required
  app.get('/v1/openapi.json', (_req: Request, res: Response): void => {
    try {
      // Resolve path to the build-time generated openapi.json
      const specPath = path.resolve(import.meta.dirname, '..', 'openapi.json');
      const content = fs.readFileSync(specPath, 'utf-8');
      res.setHeader('Content-Type', 'application/json');
      res.status(200).send(content);
    } catch {
      res.status(503).json({
        error: 'service_unavailable',
        message: 'OpenAPI specification is temporarily unavailable.',
        request_id: (_req as any).requestId || 'unknown',
      });
    }
  });

  // Swagger UI at /docs (Req 13.3) — serves OpenAPI spec via CDN-based Swagger UI
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  let openapiSpec: object | null = null;
  try {
    const specPath = path.resolve(__dirname, 'openapi', 'openapi.yaml');
    const specContent = fs.readFileSync(specPath, 'utf-8');
    openapiSpec = yaml.load(specContent) as object;
  } catch {
    // Spec will be null if file is missing/unreadable
  }

  app.get('/docs', (_req: Request, res: Response): void => {
    if (!openapiSpec) {
      res.status(503).json({
        error: 'service_unavailable',
        message: 'API documentation is temporarily unavailable.',
      });
      return;
    }

    const specJson = JSON.stringify(openapiSpec);
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FX Intelligence API - Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui.css">
  <style>
    body { margin: 0; padding: 0; }
    #swagger-ui { max-width: 1460px; margin: 0 auto; padding: 20px; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.18.2/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      spec: ${specJson},
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
    });
  </script>
</body>
</html>`);
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
  // Global 404 for unmatched routes (catch-all)
  // ==========================================================================
  app.use((req: Request, res: Response): void => {
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
