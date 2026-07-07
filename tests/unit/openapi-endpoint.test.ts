/**
 * Tests for the GET /v1/openapi.json endpoint.
 *
 * Validates:
 * - Serves OpenAPI spec as JSON without auth (Req 7.1)
 * - Returns Content-Type: application/json
 * - Returns 503 if spec file is missing/unreadable (Req 7.6)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/api/server.js';

// =============================================================================
// Mock Supabase Client (minimal — OpenAPI endpoint doesn't need Supabase)
// =============================================================================

function createMockSupabase() {
  return {
    from: vi.fn(() => {
      const chain: any = {};
      chain.select = vi.fn(() => {
        const result = { data: null, error: null, count: 0 };
        return {
          eq: vi.fn(() => Promise.resolve(result)),
          then: (resolve?: ((v: unknown) => unknown) | null) =>
            Promise.resolve(result).then(resolve),
        };
      });
      return chain;
    }),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('GET /v1/openapi.json', () => {
  let originalReadFileSync: typeof fs.readFileSync;

  beforeEach(() => {
    originalReadFileSync = fs.readFileSync;
  });

  afterEach(() => {
    // Restore original readFileSync
    (fs as any).readFileSync = originalReadFileSync;
    vi.restoreAllMocks();
  });

  it('returns 200 with JSON content when spec file exists', async () => {
    const mockSpec = { openapi: '3.1.0', info: { title: 'Test', version: '1.0.0' } };

    // Mock fs.readFileSync to return the spec
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any, encoding?: any) => {
      if (typeof filePath === 'string' && filePath.endsWith('openapi.json')) {
        return JSON.stringify(mockSpec);
      }
      return originalReadFileSync(filePath, encoding);
    });

    const supabase = createMockSupabase();
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/openapi.json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual(mockSpec);
  });

  it('serves spec without requiring authentication', async () => {
    const mockSpec = { openapi: '3.1.0', info: { title: 'Test', version: '1.0.0' } };

    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any, encoding?: any) => {
      if (typeof filePath === 'string' && filePath.endsWith('openapi.json')) {
        return JSON.stringify(mockSpec);
      }
      return originalReadFileSync(filePath, encoding);
    });

    const supabase = createMockSupabase();
    const app = createApp({ supabase: supabase as never });

    // No X-API-Key or Authorization header provided
    const res = await request(app).get('/v1/openapi.json');

    expect(res.status).toBe(200);
    // Should NOT be 401 or 403
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('returns 503 with service_unavailable when spec file is missing', async () => {
    // Mock fs.readFileSync to throw ENOENT
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any, encoding?: any) => {
      if (typeof filePath === 'string' && filePath.endsWith('openapi.json')) {
        const error: any = new Error('ENOENT: no such file or directory');
        error.code = 'ENOENT';
        throw error;
      }
      return originalReadFileSync(filePath, encoding);
    });

    const supabase = createMockSupabase();
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/openapi.json');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('service_unavailable');
    expect(res.body.message).toContain('unavailable');
  });

  it('returns 503 with service_unavailable when spec file is unreadable', async () => {
    // Mock fs.readFileSync to throw EACCES
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any, encoding?: any) => {
      if (typeof filePath === 'string' && filePath.endsWith('openapi.json')) {
        const error: any = new Error('EACCES: permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalReadFileSync(filePath, encoding);
    });

    const supabase = createMockSupabase();
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/openapi.json');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('service_unavailable');
  });

  it('includes request_id in 503 error response', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation((filePath: any, encoding?: any) => {
      if (typeof filePath === 'string' && filePath.endsWith('openapi.json')) {
        throw new Error('File not found');
      }
      return originalReadFileSync(filePath, encoding);
    });

    const supabase = createMockSupabase();
    const app = createApp({ supabase: supabase as never });

    const res = await request(app).get('/v1/openapi.json');

    expect(res.status).toBe(503);
    expect(res.body.request_id).toBeDefined();
  });
});
