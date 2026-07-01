/**
 * API Service Entry Point
 *
 * Cloud Run entry point for the HTTP API service.
 * Starts an Express server that serves cached forecasts and runtime tradeability assessments.
 *
 * Behavior:
 * - Creates a Supabase client with service role credentials
 * - Initialises the Express app via createApp()
 * - Listens on PORT (default 8080, set by Cloud Run)
 * - Responds to health checks at /health
 * - Handles graceful shutdown on SIGTERM (Cloud Run sends this before terminating)
 *
 * Requirements: 12.1, 8.1
 */

import { createClient } from '@supabase/supabase-js';
import { env } from './config/env.js';
import { createApp } from './api/server.js';

const PORT = env.PORT;

/**
 * Main API server startup function.
 */
async function main(): Promise<void> {
  console.log(`[APIEntry] Starting API server on port ${PORT}`);
  console.log(`[APIEntry] Environment: ${env.NODE_ENV}`);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const app = createApp({ supabase });

  const server = app.listen(PORT, () => {
    console.log(`[APIEntry] API server listening on port ${PORT}`);
    console.log(`[APIEntry] Health check: http://localhost:${PORT}/health`);
  });

  // Graceful shutdown handler for Cloud Run
  // Cloud Run sends SIGTERM before terminating an instance
  const shutdown = () => {
    console.log('[APIEntry] Received shutdown signal, closing server...');
    server.close(() => {
      console.log('[APIEntry] Server closed');
      process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
      console.error('[APIEntry] Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Execute
main().catch((error) => {
  console.error('[APIEntry] Fatal error:', error);
  process.exit(1);
});
