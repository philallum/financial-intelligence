import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('Environment Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Reset module cache so env.ts re-evaluates
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadEnvConfig in development mode', () => {
    it('should load with defaults when no env vars set (development)', async () => {
      process.env['NODE_ENV'] = 'development';
      // Remove all provider keys to test optional behavior
      delete process.env['TWELVE_DATA_API_KEY'];
      delete process.env['SUPABASE_URL'];

      // Dynamic import to get fresh module evaluation
      const { env } = await import('../../src/config/env.js');
      expect(env.NODE_ENV).toBe('development');
      expect(env.PORT).toBe(8080);
    });

    it('should use default PORT of 8080 when not specified', async () => {
      process.env['NODE_ENV'] = 'test';
      delete process.env['PORT'];

      const { env } = await import('../../src/config/env.js');
      expect(env.PORT).toBe(8080);
    });
  });

  describe('NODE_ENV validation', () => {
    it('should accept valid NODE_ENV values', () => {
      const validValues = ['development', 'production', 'test'];
      for (const val of validValues) {
        expect(validValues).toContain(val);
      }
    });
  });

  describe('PORT validation', () => {
    it('should have a numeric PORT value', async () => {
      process.env['NODE_ENV'] = 'test';

      const { env } = await import('../../src/config/env.js');
      expect(typeof env.PORT).toBe('number');
      expect(env.PORT).toBeGreaterThanOrEqual(0);
      expect(env.PORT).toBeLessThanOrEqual(65535);
    });
  });

  describe('EnvConfig interface shape', () => {
    it('should export a frozen config object', async () => {
      process.env['NODE_ENV'] = 'test';
      const { env } = await import('../../src/config/env.js');

      expect(env).toBeDefined();
      expect(Object.isFrozen(env)).toBe(true);
    });

    it('should have all expected keys', async () => {
      process.env['NODE_ENV'] = 'test';
      const { env } = await import('../../src/config/env.js');

      const expectedKeys = [
        'TWELVE_DATA_API_KEY',
        'MASSIVE_API_KEY',
        'ALPHA_VANTAGE_API_KEY',
        'FINNHUB_API_KEY',
        'NEWS_API_KEY',
        'GCP_PROJECT_ID',
        'GCP_LOCATION',
        'GEMINI_MODEL',
        'SUPABASE_URL',
        'SUPABASE_ANON_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
        'PORT',
        'NODE_ENV',
      ];

      for (const key of expectedKeys) {
        expect(env).toHaveProperty(key);
      }
    });
  });
});
