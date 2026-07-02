import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { resolveRapidApiTier, isRapidApiRequest, RAPIDAPI_TIER_MAP } from '../../src/api/utils/rapidapi-tier-map.js';
import { CustomerTier } from '../../src/types/enums.js';

describe('RapidAPI Subscription Tier Mapping (Property 21)', () => {
  describe('resolveRapidApiTier', () => {
    it('should map BASIC to RETAIL', () => {
      expect(resolveRapidApiTier('BASIC')).toBe(CustomerTier.RETAIL);
    });

    it('should map PRO to DEVELOPER', () => {
      expect(resolveRapidApiTier('PRO')).toBe(CustomerTier.DEVELOPER);
    });

    it('should map ULTRA to RESEARCH', () => {
      expect(resolveRapidApiTier('ULTRA')).toBe(CustomerTier.RESEARCH);
    });

    it('should map MEGA to RESEARCH', () => {
      expect(resolveRapidApiTier('MEGA')).toBe(CustomerTier.RESEARCH);
    });

    it('should map CUSTOM to RESEARCH', () => {
      expect(resolveRapidApiTier('CUSTOM')).toBe(CustomerTier.RESEARCH);
    });

    it('should default to RETAIL for unknown subscription values', () => {
      expect(resolveRapidApiTier('UNKNOWN')).toBe(CustomerTier.RETAIL);
      expect(resolveRapidApiTier('')).toBe(CustomerTier.RETAIL);
      expect(resolveRapidApiTier('invalid')).toBe(CustomerTier.RETAIL);
      expect(resolveRapidApiTier('basic')).toBe(CustomerTier.RETAIL); // case-sensitive
    });
  });

  describe('isRapidApiRequest', () => {
    const MOCK_SECRET = 'test-proxy-secret-123';

    beforeEach(() => {
      process.env.RAPIDAPI_PROXY_SECRET = MOCK_SECRET;
    });

    afterEach(() => {
      delete process.env.RAPIDAPI_PROXY_SECRET;
    });

    it('should return true when proxy-secret matches configured secret', () => {
      const req = {
        headers: { 'x-rapidapi-proxy-secret': MOCK_SECRET },
      } as unknown as Request;
      expect(isRapidApiRequest(req)).toBe(true);
    });

    it('should return false when proxy-secret does not match', () => {
      const req = {
        headers: { 'x-rapidapi-proxy-secret': 'wrong-secret' },
      } as unknown as Request;
      expect(isRapidApiRequest(req)).toBe(false);
    });

    it('should return false when proxy-secret header is missing', () => {
      const req = {
        headers: {},
      } as unknown as Request;
      expect(isRapidApiRequest(req)).toBe(false);
    });

    it('should return false when RAPIDAPI_PROXY_SECRET env var is not set', () => {
      delete process.env.RAPIDAPI_PROXY_SECRET;
      const req = {
        headers: { 'x-rapidapi-proxy-secret': 'some-secret' },
      } as unknown as Request;
      expect(isRapidApiRequest(req)).toBe(false);
    });
  });

  describe('RAPIDAPI_TIER_MAP constant', () => {
    it('should contain exactly 5 known subscription levels', () => {
      const keys = Object.keys(RAPIDAPI_TIER_MAP);
      expect(keys).toHaveLength(5);
      expect(keys).toContain('BASIC');
      expect(keys).toContain('PRO');
      expect(keys).toContain('ULTRA');
      expect(keys).toContain('MEGA');
      expect(keys).toContain('CUSTOM');
    });

    it('should only map to valid CustomerTier values', () => {
      const validTiers = Object.values(CustomerTier);
      for (const tier of Object.values(RAPIDAPI_TIER_MAP)) {
        expect(validTiers).toContain(tier);
      }
    });
  });
});
