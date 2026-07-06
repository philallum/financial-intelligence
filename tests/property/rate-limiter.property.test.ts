import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { createRateLimiterMiddleware } from '../../src/api/middleware/rate-limiter.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Property 7: Rate Limit Scope Isolation
 * Validates: Requirements 5.7
 *
 * For any two distinct API key identifiers, incrementing the usage counter for
 * one key should have no effect on the remaining quota of the other key.
 *
 * We verify this by generating pairs of random API key UUIDs with independent
 * usage counters — one at/above its limit, and one below — and confirming
 * that the rate limiter evaluates each independently.
 */
describe('Property 7: Rate Limit Scope Isolation', () => {
  /**
   * Generator: a pair of distinct UUIDs with independent usage levels.
   * keyA is at or above its limit (should be rejected).
   * keyB is below its limit (should be allowed).
   */
  const keyPairArb = fc.record({
    keyIdA: fc.uuid(),
    keyIdB: fc.uuid(),
    plan: fc.constantFrom('FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE') as fc.Arbitrary<'FREE' | 'STARTER' | 'PROFESSIONAL' | 'ENTERPRISE'>,
    usageA: fc.integer({ min: 100, max: 200 }), // at or above FREE limit (100)
    usageB: fc.integer({ min: 0, max: 50 }),    // well below FREE limit
  }).filter(({ keyIdA, keyIdB }) => keyIdA !== keyIdB);

  it('exceeding the rate limit for one key does NOT affect the other key', async () => {
    await fc.assert(
      fc.asyncProperty(keyPairArb, async ({ keyIdA, keyIdB, plan, usageA, usageB }) => {
        // Use FREE plan for both keys so we have a concrete limit of 100/day
        const planToUse = 'FREE';
        const limit = 100;
        const now = new Date().toISOString();

        // Mock Supabase to return different records per key ID
        const mockSupabase = {
          from: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation((_field: string, value: string) => ({
                single: vi.fn().mockImplementation(() => {
                  if (value === keyIdA) {
                    return Promise.resolve({
                      data: {
                        id: keyIdA,
                        subscription_plan: planToUse,
                        rate_limit_override: null,
                        daily_usage: usageA,
                        monthly_usage: 0,
                        last_reset: now,
                      },
                      error: null,
                    });
                  } else if (value === keyIdB) {
                    return Promise.resolve({
                      data: {
                        id: keyIdB,
                        subscription_plan: planToUse,
                        rate_limit_override: null,
                        daily_usage: usageB,
                        monthly_usage: 0,
                        last_reset: now,
                      },
                      error: null,
                    });
                  }
                  return Promise.resolve({ data: null, error: { message: 'Not found' } });
                }),
              })),
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: null }),
            }),
          }),
        } as any;

        const middleware = createRateLimiterMiddleware({ supabase: mockSupabase });

        // --- Request A (at/above limit) should be rejected ---
        const reqA = {
          apiKeyId: keyIdA,
          subscriptionPlan: planToUse,
          isMarketplaceRequest: false,
          anonymous: false,
        } as unknown as Request;

        let statusA: number | undefined;
        let jsonA: any;
        const resA = {
          status: vi.fn().mockImplementation((code: number) => {
            statusA = code;
            return resA;
          }),
          json: vi.fn().mockImplementation((body: any) => { jsonA = body; }),
          setHeader: vi.fn(),
        } as unknown as Response;

        let nextCalledA = false;
        const nextA: NextFunction = () => { nextCalledA = true; };

        await middleware(reqA, resA, nextA);

        // Key A is at or above limit — should be rejected (429) or allowed (if reset logic applied)
        // Since usageA >= 100 (the FREE limit), expect 429
        expect(statusA).toBe(429);
        expect(nextCalledA).toBe(false);

        // --- Request B (below limit) should be allowed ---
        const reqB = {
          apiKeyId: keyIdB,
          subscriptionPlan: planToUse,
          isMarketplaceRequest: false,
          anonymous: false,
        } as unknown as Request;

        let statusB: number | undefined;
        const resB = {
          status: vi.fn().mockImplementation((code: number) => {
            statusB = code;
            return resB;
          }),
          json: vi.fn(),
          setHeader: vi.fn(),
        } as unknown as Response;

        let nextCalledB = false;
        const nextB: NextFunction = () => { nextCalledB = true; };

        await middleware(reqB, resB, nextB);

        // Key B is below limit — should proceed (next called)
        expect(nextCalledB).toBe(true);
        expect(statusB).toBeUndefined();
      }),
      { numRuns: 100 }
    );
  });

  it('two keys with different plans are evaluated independently', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.integer({ min: 90, max: 100 }), // near/at FREE limit of 100
        fc.integer({ min: 4900, max: 5000 }), // near/at STARTER limit of 5000
        async (keyIdA, keyIdB, usageA, usageB) => {
          fc.pre(keyIdA !== keyIdB);

          const now = new Date().toISOString();

          const mockSupabase = {
            from: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockImplementation((_field: string, value: string) => ({
                  single: vi.fn().mockImplementation(() => {
                    if (value === keyIdA) {
                      return Promise.resolve({
                        data: {
                          id: keyIdA,
                          subscription_plan: 'FREE',
                          rate_limit_override: null,
                          daily_usage: usageA,
                          monthly_usage: 0,
                          last_reset: now,
                        },
                        error: null,
                      });
                    } else if (value === keyIdB) {
                      return Promise.resolve({
                        data: {
                          id: keyIdB,
                          subscription_plan: 'STARTER',
                          rate_limit_override: null,
                          daily_usage: 0,
                          monthly_usage: usageB,
                          last_reset: now,
                        },
                        error: null,
                      });
                    }
                    return Promise.resolve({ data: null, error: { message: 'Not found' } });
                  }),
                })),
              }),
              update: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          } as any;

          const middleware = createRateLimiterMiddleware({ supabase: mockSupabase });

          // Evaluate key A (FREE plan, usage at or near 100)
          const reqA = {
            apiKeyId: keyIdA,
            subscriptionPlan: 'FREE',
            isMarketplaceRequest: false,
            anonymous: false,
          } as unknown as Request;

          let statusA: number | undefined;
          const resA = {
            status: vi.fn().mockImplementation((code: number) => { statusA = code; return resA; }),
            json: vi.fn(),
            setHeader: vi.fn(),
          } as unknown as Response;

          let nextCalledA = false;
          const nextA: NextFunction = () => { nextCalledA = true; };

          await middleware(reqA, resA, nextA);

          const keyARejected = statusA === 429;
          const keyAAllowed = nextCalledA;

          // Evaluate key B (STARTER plan, usage at or near 5000)
          const reqB = {
            apiKeyId: keyIdB,
            subscriptionPlan: 'STARTER',
            isMarketplaceRequest: false,
            anonymous: false,
          } as unknown as Request;

          let statusB: number | undefined;
          const resB = {
            status: vi.fn().mockImplementation((code: number) => { statusB = code; return resB; }),
            json: vi.fn(),
            setHeader: vi.fn(),
          } as unknown as Response;

          let nextCalledB = false;
          const nextB: NextFunction = () => { nextCalledB = true; };

          await middleware(reqB, resB, nextB);

          const keyBRejected = statusB === 429;
          const keyBAllowed = nextCalledB;

          // The key property: each key's decision is independent of the other.
          // Key A's result depends only on usageA vs FREE limit (100)
          if (usageA >= 100) {
            expect(keyARejected).toBe(true);
          } else {
            expect(keyAAllowed).toBe(true);
          }

          // Key B's result depends only on usageB vs STARTER limit (5000)
          if (usageB >= 5000) {
            expect(keyBRejected).toBe(true);
          } else {
            expect(keyBAllowed).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
