/**
 * Integration tests for customer and project management.
 *
 * Tests the Customer → Project → Key hierarchy and tier inheritance.
 *
 * Requirements: 2.1, 2.4
 *
 * Validates:
 * - Customer → Project → Key hierarchy is correctly maintained
 * - Tier inheritance: auth middleware resolves customer's tier from key
 * - Revoking a key prevents authentication
 * - 20-key limit per project enforcement
 * - Name uniqueness enforcement across active keys in a project
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createKeyManagementService, KeyManagementError } from '../../src/api/services/key-management.js';
import { createAuthMiddleware } from '../../src/api/middleware/auth.js';
import { CustomerTier, SubscriptionPlan } from '../../src/types/enums.js';

// =============================================================================
// Module Mocks
// =============================================================================

vi.mock('../../src/api/utils/key-hash.js', () => ({
  hashApiKey: vi.fn().mockResolvedValue('$argon2id$v=19$m=19456,t=2,p=1$mocksalt$mockhash'),
  verifyApiKey: vi.fn(),
}));

vi.mock('../../src/api/utils/rapidapi-tier-map.js', () => ({
  isRapidApiRequest: vi.fn().mockReturnValue(false),
  resolveRapidApiTier: vi.fn().mockReturnValue('RETAIL'),
}));

import { verifyApiKey } from '../../src/api/utils/key-hash.js';

// =============================================================================
// In-Memory Data Store
// =============================================================================

/**
 * Simulates a Supabase-backed data store for integration testing.
 * Tracks customers, projects, and API keys in memory, allowing us to
 * test the full hierarchy without a real database.
 */
interface InMemoryCustomer {
  id: string;
  email: string;
  name: string;
  tier: string;
  created_at: string;
  updated_at: string;
}

interface InMemoryProject {
  id: string;
  customer_id: string;
  name: string;
  environment: string;
  is_active: boolean;
  created_at: string;
}

interface InMemoryApiKey {
  id: string;
  project_id: string;
  key_hash: string;
  name: string;
  description: string | null;
  subscription_plan: string;
  is_active: boolean;
  rate_limit_override: number | null;
  daily_usage: number;
  monthly_usage: number;
  last_reset: string;
  created_at: string;
  last_used_at: string | null;
}

function createInMemoryStore() {
  const customers: InMemoryCustomer[] = [];
  const projects: InMemoryProject[] = [];
  const apiKeys: InMemoryApiKey[] = [];

  return { customers, projects, apiKeys };
}

// =============================================================================
// Mock Supabase Client Factory
// =============================================================================

/**
 * Creates a mock Supabase client that operates against the in-memory store.
 * Handles the query patterns used by both key-management service and auth middleware.
 */
function createIntegrationSupabase(store: ReturnType<typeof createInMemoryStore>): SupabaseClient {
  let insertCounter = 0;

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'api_keys') {
        return createApiKeysTableMock(store);
      }
      return createDefaultTableMock();
    }),
  } as unknown as SupabaseClient;

  return supabase;
}

function createDefaultTableMock() {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
  };
}

function createApiKeysTableMock(store: ReturnType<typeof createInMemoryStore>) {
  return {
    // select() — used for count queries, name uniqueness checks, and auth queries
    select: vi.fn().mockImplementation((fields: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) {
        // Count query: select('id', { count: 'exact', head: true })
        return {
          eq: vi.fn().mockImplementation((_field: string, projectId: string) => ({
            eq: vi.fn().mockImplementation(() => {
              const count = store.apiKeys.filter(
                (k) => k.project_id === projectId && k.is_active
              ).length;
              return Promise.resolve({ count, error: null });
            }),
          })),
        };
      }

      // Check if this is the auth middleware query (complex join select)
      if (fields.includes('project:projects')) {
        // Auth middleware query: joins api_keys → projects → customers
        return {
          eq: vi.fn().mockImplementation((_field: string, _value: unknown) => {
            const activeKeys = store.apiKeys.filter((k) => k.is_active);
            const records = activeKeys.map((key) => {
              const project = store.projects.find((p) => p.id === key.project_id);
              const customer = project
                ? store.customers.find((c) => c.id === project.customer_id)
                : null;
              return {
                ...key,
                project: project
                  ? {
                      id: project.id,
                      customer_id: project.customer_id,
                      is_active: project.is_active,
                      customer: customer
                        ? { id: customer.id, tier: customer.tier }
                        : null,
                    }
                  : null,
              };
            });
            return Promise.resolve({ data: records, error: null });
          }),
        };
      }

      // Name uniqueness query: select('id').eq(...).eq(...).eq(...).maybeSingle()
      return {
        eq: vi.fn().mockImplementation((_field: string, projectId: string) => ({
          eq: vi.fn().mockImplementation((_f2: string, name: string) => ({
            eq: vi.fn().mockImplementation(() => ({
              maybeSingle: vi.fn().mockImplementation(() => {
                const existing = store.apiKeys.find(
                  (k) => k.project_id === projectId && k.name === name && k.is_active
                );
                return Promise.resolve({
                  data: existing ? { id: existing.id } : null,
                  error: null,
                });
              }),
            })),
          })),
        })),
      };
    }),

    // insert() — used for key creation
    insert: vi.fn().mockImplementation((record: Record<string, unknown>) => ({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockImplementation(() => {
          const newKey: InMemoryApiKey = {
            id: `key-${crypto.randomUUID()}`,
            project_id: record.project_id as string,
            key_hash: record.key_hash as string,
            name: record.name as string,
            description: (record.description as string) ?? null,
            subscription_plan: record.subscription_plan as string,
            is_active: true,
            rate_limit_override: null,
            daily_usage: 0,
            monthly_usage: 0,
            last_reset: new Date().toISOString(),
            created_at: new Date().toISOString(),
            last_used_at: null,
          };
          store.apiKeys.push(newKey);
          return Promise.resolve({ data: newKey, error: null });
        }),
      }),
    })),

    // update() — used for revocation and usage updates
    update: vi.fn().mockImplementation((updates: Record<string, unknown>) => ({
      eq: vi.fn().mockImplementation((_field: string, keyId: string) => {
        const key = store.apiKeys.find((k) => k.id === keyId);
        if (key) {
          Object.assign(key, updates);
        }
        // Support both .select().single() and direct resolution
        return {
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: key ?? null,
              error: key ? null : { message: 'Key not found' },
            }),
          }),
        };
      }),
    })),
  };
}

// =============================================================================
// Test Helpers
// =============================================================================

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/v1/forecast/GBPUSD',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

function createMockRes() {
  const res = {
    statusCode: 200,
    jsonBody: null as unknown,
    status: vi.fn().mockImplementation(function (this: typeof res, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn().mockImplementation(function (this: typeof res, body: unknown) {
      this.jsonBody = body;
      return this;
    }),
  };
  return res as unknown as Response & { statusCode: number; jsonBody: unknown };
}

// =============================================================================
// Tests
// =============================================================================

describe('Integration: Customer → Project → Key Hierarchy', () => {
  let store: ReturnType<typeof createInMemoryStore>;

  beforeEach(() => {
    vi.resetAllMocks();
    store = createInMemoryStore();

    // Seed a customer hierarchy
    store.customers.push({
      id: 'customer-1',
      email: 'dev@example.com',
      name: 'Developer Corp',
      tier: CustomerTier.DEVELOPER,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    });

    store.projects.push({
      id: 'project-1',
      customer_id: 'customer-1',
      name: 'Production',
      environment: 'production',
      is_active: true,
      created_at: '2025-01-01T00:00:00Z',
    });

    // Re-mock verifyApiKey to default false
    vi.mocked(verifyApiKey).mockResolvedValue(false);
  });

  // ---------------------------------------------------------------------------
  // 1. Customer → Project → Key hierarchy maintained (Req 2.1, 2.4)
  // ---------------------------------------------------------------------------
  describe('Hierarchy creation and maintenance', () => {
    it('creates keys under a project that belongs to a customer', async () => {
      const supabase = createIntegrationSupabase(store);
      const service = createKeyManagementService(supabase);

      const result = await service.createApiKey(
        'project-1',
        'API Key Alpha',
        'Primary production key',
        SubscriptionPlan.PROFESSIONAL
      );

      expect(result.plaintextKey).toMatch(/^fxi_[a-f0-9]{64}$/);
      expect(result.record.project_id).toBe('project-1');
      expect(result.record.is_active).toBe(true);
      expect(result.record.name).toBe('API Key Alpha');

      // Verify the key is stored in the in-memory store under the correct project
      const storedKey = store.apiKeys.find((k) => k.name === 'API Key Alpha');
      expect(storedKey).toBeDefined();
      expect(storedKey!.project_id).toBe('project-1');

      // Verify the hierarchy chain: key → project → customer
      const project = store.projects.find((p) => p.id === storedKey!.project_id);
      expect(project).toBeDefined();
      expect(project!.customer_id).toBe('customer-1');

      const customer = store.customers.find((c) => c.id === project!.customer_id);
      expect(customer).toBeDefined();
      expect(customer!.tier).toBe(CustomerTier.DEVELOPER);
    });

    it('supports multiple projects under a single customer', async () => {
      store.projects.push({
        id: 'project-2',
        customer_id: 'customer-1',
        name: 'Development',
        environment: 'development',
        is_active: true,
        created_at: '2025-01-01T00:00:00Z',
      });

      const supabase = createIntegrationSupabase(store);
      const service = createKeyManagementService(supabase);

      const key1 = await service.createApiKey(
        'project-1',
        'Prod Key',
        null,
        SubscriptionPlan.PROFESSIONAL
      );
      const key2 = await service.createApiKey(
        'project-2',
        'Dev Key',
        null,
        SubscriptionPlan.FREE
      );

      expect(key1.record.project_id).toBe('project-1');
      expect(key2.record.project_id).toBe('project-2');

      // Both projects belong to the same customer
      const proj1 = store.projects.find((p) => p.id === 'project-1');
      const proj2 = store.projects.find((p) => p.id === 'project-2');
      expect(proj1!.customer_id).toBe(proj2!.customer_id);
    });

    it('supports multiple keys under a single project', async () => {
      const supabase = createIntegrationSupabase(store);
      const service = createKeyManagementService(supabase);

      const key1 = await service.createApiKey(
        'project-1',
        'Key One',
        null,
        SubscriptionPlan.PROFESSIONAL
      );
      const key2 = await service.createApiKey(
        'project-1',
        'Key Two',
        null,
        SubscriptionPlan.STARTER
      );

      expect(key1.record.project_id).toBe('project-1');
      expect(key2.record.project_id).toBe('project-1');
      expect(store.apiKeys.filter((k) => k.project_id === 'project-1')).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Tier inheritance: customer tier resolved through key (Req 2.1, 2.4)
  // ---------------------------------------------------------------------------
  describe('Tier inheritance from customer to key', () => {
    it('auth middleware resolves DEVELOPER tier from customer record via key → project → customer chain', async () => {
      // Seed a key in the store
      store.apiKeys.push({
        id: 'key-dev-1',
        project_id: 'project-1',
        key_hash: '$argon2id$v=19$m=19456,t=2,p=1$salt$hash',
        name: 'Dev Key',
        description: null,
        subscription_plan: 'PROFESSIONAL',
        is_active: true,
        rate_limit_override: null,
        daily_usage: 0,
        monthly_usage: 0,
        last_reset: '2025-01-01T00:00:00Z',
        created_at: '2025-01-01T00:00:00Z',
        last_used_at: null,
      });

      const supabase = createIntegrationSupabase(store);
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({ headers: { 'x-api-key': 'fxi_testkey123' } });
      const res = createMockRes();
      const next: NextFunction = vi.fn();

      // verifyApiKey matches the seeded key
      vi.mocked(verifyApiKey).mockResolvedValue(true);

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.tier).toBe(CustomerTier.DEVELOPER);
      expect(req.subscriptionPlan).toBe(SubscriptionPlan.PROFESSIONAL);
      expect(req.customerId).toBe('customer-1');
      expect(req.projectId).toBe('project-1');
      expect(req.apiKeyId).toBe('key-dev-1');
    });

    it('auth middleware resolves RESEARCH tier for a research customer', async () => {
      // Add a research customer with project and key
      store.customers.push({
        id: 'customer-research',
        email: 'research@university.edu',
        name: 'Research University',
        tier: CustomerTier.RESEARCH,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });
      store.projects.push({
        id: 'project-research',
        customer_id: 'customer-research',
        name: 'Research Project',
        environment: 'production',
        is_active: true,
        created_at: '2025-01-01T00:00:00Z',
      });
      store.apiKeys.push({
        id: 'key-research-1',
        project_id: 'project-research',
        key_hash: '$argon2id$v=19$m=19456,t=2,p=1$salt$hash2',
        name: 'Research Key',
        description: null,
        subscription_plan: 'ENTERPRISE',
        is_active: true,
        rate_limit_override: 50000,
        daily_usage: 0,
        monthly_usage: 0,
        last_reset: '2025-01-01T00:00:00Z',
        created_at: '2025-01-01T00:00:00Z',
        last_used_at: null,
      });

      const supabase = createIntegrationSupabase(store);
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({ headers: { 'x-api-key': 'fxi_researchkey' } });
      const res = createMockRes();
      const next: NextFunction = vi.fn();

      // Only match the research key
      vi.mocked(verifyApiKey).mockImplementation(async (_plain, hash) => {
        return hash === '$argon2id$v=19$m=19456,t=2,p=1$salt$hash2';
      });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.tier).toBe(CustomerTier.RESEARCH);
      expect(req.subscriptionPlan).toBe(SubscriptionPlan.ENTERPRISE);
      expect(req.customerId).toBe('customer-research');
      expect(req.projectId).toBe('project-research');
    });

    it('auth middleware resolves RETAIL tier for a retail customer', async () => {
      store.customers.push({
        id: 'customer-retail',
        email: 'retail@user.com',
        name: 'Retail User',
        tier: CustomerTier.RETAIL,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      });
      store.projects.push({
        id: 'project-retail',
        customer_id: 'customer-retail',
        name: 'My App',
        environment: 'production',
        is_active: true,
        created_at: '2025-01-01T00:00:00Z',
      });
      store.apiKeys.push({
        id: 'key-retail-1',
        project_id: 'project-retail',
        key_hash: '$argon2id$v=19$m=19456,t=2,p=1$salt$retailhash',
        name: 'Retail Key',
        description: null,
        subscription_plan: 'FREE',
        is_active: true,
        rate_limit_override: null,
        daily_usage: 50,
        monthly_usage: 80,
        last_reset: '2025-01-01T00:00:00Z',
        created_at: '2025-01-01T00:00:00Z',
        last_used_at: null,
      });

      const supabase = createIntegrationSupabase(store);
      const middleware = createAuthMiddleware({ supabase });
      const req = createMockReq({ headers: { 'x-api-key': 'fxi_retailkey' } });
      const res = createMockRes();
      const next: NextFunction = vi.fn();

      vi.mocked(verifyApiKey).mockImplementation(async (_plain, hash) => {
        return hash === '$argon2id$v=19$m=19456,t=2,p=1$salt$retailhash';
      });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.tier).toBe(CustomerTier.RETAIL);
      expect(req.subscriptionPlan).toBe(SubscriptionPlan.FREE);
      expect(req.customerId).toBe('customer-retail');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Revoking a key prevents authentication (Req 2.1)
  // ---------------------------------------------------------------------------
  describe('Key revocation prevents authentication', () => {
    it('revoked key is not returned in active key query, causing auth to fail', async () => {
      // Seed an active key
      store.apiKeys.push({
        id: 'key-to-revoke',
        project_id: 'project-1',
        key_hash: '$argon2id$v=19$m=19456,t=2,p=1$salt$revokehash',
        name: 'Revocable Key',
        description: null,
        subscription_plan: 'PROFESSIONAL',
        is_active: true,
        rate_limit_override: null,
        daily_usage: 0,
        monthly_usage: 0,
        last_reset: '2025-01-01T00:00:00Z',
        created_at: '2025-01-01T00:00:00Z',
        last_used_at: null,
      });

      const supabase = createIntegrationSupabase(store);
      const service = createKeyManagementService(supabase);

      // Revoke the key
      const revoked = await service.revokeApiKey('key-to-revoke');
      expect(revoked.is_active).toBe(false);

      // Now attempt authentication with the revoked key
      const middleware = createAuthMiddleware({ supabase: createIntegrationSupabase(store) });
      const req = createMockReq({ headers: { 'x-api-key': 'fxi_revokedkey' } });
      const res = createMockRes();
      const next: NextFunction = vi.fn();

      // Even if hash matches, the key is filtered out (is_active=false)
      vi.mocked(verifyApiKey).mockResolvedValue(true);

      await middleware(req, res, next);

      // Should get 401 because the revoked key is not in the active set
      expect(res.statusCode).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. 20-key limit per project (Req 2.5)
  // ---------------------------------------------------------------------------
  describe('Max 20 active keys per project', () => {
    it('rejects key creation when project has 20 active keys', async () => {
      // Seed 20 active keys for project-1
      for (let i = 0; i < 20; i++) {
        store.apiKeys.push({
          id: `key-${i}`,
          project_id: 'project-1',
          key_hash: `hash-${i}`,
          name: `Key ${i}`,
          description: null,
          subscription_plan: 'FREE',
          is_active: true,
          rate_limit_override: null,
          daily_usage: 0,
          monthly_usage: 0,
          last_reset: '2025-01-01T00:00:00Z',
          created_at: '2025-01-01T00:00:00Z',
          last_used_at: null,
        });
      }

      const supabase = createIntegrationSupabase(store);
      const service = createKeyManagementService(supabase);

      const error = await service
        .createApiKey('project-1', 'Key 21', null, SubscriptionPlan.FREE)
        .catch((e) => e);

      expect(error).toBeInstanceOf(KeyManagementError);
      expect(error.code).toBe('max_keys_reached');
    });

    it('allows creation after a key is revoked (bringing count below 20)', async () => {
      // Seed 20 active keys
      for (let i = 0; i < 20; i++) {
        store.apiKeys.push({
          id: `key-limit-${i}`,
          project_id: 'project-1',
          key_hash: `hash-limit-${i}`,
          name: `Limit Key ${i}`,
          description: null,
          subscription_plan: 'FREE',
          is_active: true,
          rate_limit_override: null,
          daily_usage: 0,
          monthly_usage: 0,
          last_reset: '2025-01-01T00:00:00Z',
          created_at: '2025-01-01T00:00:00Z',
          last_used_at: null,
        });
      }

      const supabase = createIntegrationSupabase(store);
      const service = createKeyManagementService(supabase);

      // Revoke one key to bring count to 19
      await service.revokeApiKey('key-limit-0');
      expect(store.apiKeys.find((k) => k.id === 'key-limit-0')!.is_active).toBe(false);

      // Now creation should succeed
      const result = await service.createApiKey(
        'project-1',
        'New Key After Revoke',
        null,
        SubscriptionPlan.STARTER
      );

      expect(result.plaintextKey).toMatch(/^fxi_/);
      expect(result.record.is_active).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Name uniqueness enforcement (Req 2.6)
  // ---------------------------------------------------------------------------
  describe('Name uniqueness among active keys', () => {
    it('rejects duplicate name within the same project', async () => {
      const supabase = createIntegrationSupabase(store);
      const service = createKeyManagementService(supabase);

      // Create first key
      await service.createApiKey('project-1', 'Unique Name', null, SubscriptionPlan.FREE);

      // Attempt duplicate name
      const error = await service
        .createApiKey('project-1', 'Unique Name', null, SubscriptionPlan.STARTER)
        .catch((e) => e);

      expect(error).toBeInstanceOf(KeyManagementError);
      expect(error.code).toBe('duplicate_key_name');
    });

    it('allows same name in different projects', async () => {
      store.projects.push({
        id: 'project-other',
        customer_id: 'customer-1',
        name: 'Other Project',
        environment: 'development',
        is_active: true,
        created_at: '2025-01-01T00:00:00Z',
      });

      const supabase = createIntegrationSupabase(store);
      const service = createKeyManagementService(supabase);

      const key1 = await service.createApiKey(
        'project-1',
        'Shared Name',
        null,
        SubscriptionPlan.FREE
      );
      const key2 = await service.createApiKey(
        'project-other',
        'Shared Name',
        null,
        SubscriptionPlan.FREE
      );

      expect(key1.record.project_id).toBe('project-1');
      expect(key2.record.project_id).toBe('project-other');
    });

    it('allows reuse of a revoked key name', async () => {
      const supabase = createIntegrationSupabase(store);
      const service = createKeyManagementService(supabase);

      // Create and then revoke a key
      const original = await service.createApiKey(
        'project-1',
        'Recyclable Name',
        null,
        SubscriptionPlan.FREE
      );
      await service.revokeApiKey(original.record.id);

      // Should be able to reuse the name
      const recycled = await service.createApiKey(
        'project-1',
        'Recyclable Name',
        null,
        SubscriptionPlan.PROFESSIONAL
      );

      expect(recycled.plaintextKey).toMatch(/^fxi_/);
      expect(recycled.record.name).toBe('Recyclable Name');
      expect(recycled.record.is_active).toBe(true);
    });
  });
});
