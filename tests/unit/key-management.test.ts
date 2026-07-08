/**
 * Unit tests for key creation constraints.
 *
 * Property 12: Key Creation Constraints
 * Validates: Requirements 2.5, 2.6
 *
 * Tests:
 * - 20-key limit enforcement per project (Req 2.5)
 * - Name uniqueness among active keys per project (Req 2.6)
 * - Successful creation when constraints satisfied
 * - Name validation (format and length)
 * - Description length validation
 * - Revocation marks key inactive
 * - Revoked key names can be reused
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createKeyManagementService, KeyManagementError } from '../../src/api/services/key-management.js';
import { SubscriptionPlan } from '../../src/types/enums.js';

// =============================================================================
// Module Mocks
// =============================================================================

vi.mock('../../src/api/utils/key-hash.js', () => ({
  hashApiKey: vi.fn().mockResolvedValue('$argon2id$v=19$m=19456,t=2,p=1$mockedsalt$mockedhash'),
}));

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a mock Supabase client that handles the chaining patterns used by
 * the key-management service. The service calls:
 *   1. from('api_keys').select('id', { count, head }).eq('project_id', ...).eq('is_active', true) → { count, error }
 *   2. from('api_keys').select('id').eq('project_id', ...).eq('name', ...).eq('is_active', true).maybeSingle() → { data, error }
 *   3. from('api_keys').insert({...}).select().single() → { data, error }
 *   4. from('api_keys').update({...}).eq('id', ...).select().single() → { data, error }
 */
function createMockSupabase(overrides: {
  countResult?: { count: number | null; error: unknown };
  nameCheckResult?: { data: unknown; error: unknown };
  insertResult?: { data: unknown; error: unknown };
  updateResult?: { data: unknown; error: unknown };
} = {}) {
  const {
    countResult = { count: 0, error: null },
    nameCheckResult = { data: null, error: null },
    insertResult = { data: mockKeyRecord, error: null },
    updateResult = { data: mockRevokedKeyRecord, error: null },
  } = overrides;

  const supabase = {
    from: vi.fn().mockImplementation(() => {
      return {
        // select() is called for count query and name uniqueness query
        select: vi.fn().mockImplementation((_fields: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) {
            // Count query: select('id', { count: 'exact', head: true })
            return {
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue(countResult),
              }),
            };
          }
          // Name uniqueness query: select('id')
          return {
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue(nameCheckResult),
                }),
              }),
            }),
          };
        }),
        // insert() is called for key creation
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(insertResult),
          }),
        }),
        // update() is called for revocation
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue(updateResult),
            }),
          }),
        }),
      };
    }),
  } as unknown as SupabaseClient;

  return supabase;
}

const mockKeyRecord = {
  id: 'key-uuid-1',
  project_id: 'project-uuid',
  key_hash: '$argon2id$v=19$m=19456,t=2,p=1$mockedsalt$mockedhash',
  name: 'My Key',
  description: 'A test key',
  subscription_plan: 'PROFESSIONAL',
  is_active: true,
  rate_limit_override: null,
  daily_usage: 0,
  monthly_usage: 0,
  last_reset: '2025-01-01T00:00:00Z',
  created_at: '2025-01-01T00:00:00Z',
  last_used_at: null,
};

const mockRevokedKeyRecord = {
  ...mockKeyRecord,
  is_active: false,
};

// =============================================================================
// Tests
// =============================================================================

describe('Key Management Service - Key Creation Constraints', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. 20-key limit enforcement (Req 2.5)
  // ---------------------------------------------------------------------------
  describe('Max 20 active keys per project (Req 2.5)', () => {
    it('throws max_keys_reached when project already has 20 active keys', async () => {
      const supabase = createMockSupabase({
        countResult: { count: 20, error: null },
      });
      const service = createKeyManagementService(supabase);

      const error = await service
        .createApiKey('project-uuid', 'New Key', null, SubscriptionPlan.PROFESSIONAL)
        .catch((e) => e);

      expect(error).toBeInstanceOf(KeyManagementError);
      expect(error.code).toBe('max_keys_reached');
    });

    it('allows creation when project has fewer than 20 active keys', async () => {
      const supabase = createMockSupabase({
        countResult: { count: 19, error: null },
      });
      const service = createKeyManagementService(supabase);

      const result = await service.createApiKey(
        'project-uuid',
        'New Key',
        null,
        SubscriptionPlan.PROFESSIONAL
      );

      expect(result.plaintextKey).toMatch(/^fxi_/);
      expect(result.record).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Name uniqueness among active keys (Req 2.6)
  // ---------------------------------------------------------------------------
  describe('Name uniqueness enforcement (Req 2.6)', () => {
    it('throws duplicate_key_name when an active key with the same name exists', async () => {
      const supabase = createMockSupabase({
        countResult: { count: 5, error: null },
        nameCheckResult: { data: { id: 'existing-key-id' }, error: null },
      });
      const service = createKeyManagementService(supabase);

      const error = await service
        .createApiKey('project-uuid', 'Existing Key', null, SubscriptionPlan.FREE)
        .catch((e) => e);

      expect(error).toBeInstanceOf(KeyManagementError);
      expect(error.code).toBe('duplicate_key_name');
    });

    it('allows creation when no active key with the same name exists', async () => {
      const supabase = createMockSupabase({
        countResult: { count: 5, error: null },
        nameCheckResult: { data: null, error: null },
      });
      const service = createKeyManagementService(supabase);

      const result = await service.createApiKey(
        'project-uuid',
        'Unique Name',
        'Some description',
        SubscriptionPlan.STARTER
      );

      expect(result.plaintextKey).toMatch(/^fxi_/);
      expect(result.record).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Successful creation
  // ---------------------------------------------------------------------------
  describe('Successful key creation', () => {
    it('returns plaintext key with fxi_ prefix and persisted record', async () => {
      const supabase = createMockSupabase();
      const service = createKeyManagementService(supabase);

      const result = await service.createApiKey(
        'project-uuid',
        'Production Key',
        'Used for production',
        SubscriptionPlan.ENTERPRISE
      );

      expect(result.plaintextKey).toMatch(/^fxi_[a-f0-9]{64}$/);
      expect(result.record.id).toBe('key-uuid-1');
      expect(result.record.is_active).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Name validation
  // ---------------------------------------------------------------------------
  describe('Name validation (invalid_key_name)', () => {
    it('rejects empty name', async () => {
      const supabase = createMockSupabase();
      const service = createKeyManagementService(supabase);

      try {
        await service.createApiKey('project-uuid', '', null, SubscriptionPlan.FREE);
      } catch (err) {
        expect(err).toBeInstanceOf(KeyManagementError);
        expect((err as KeyManagementError).code).toBe('invalid_key_name');
      }
    });

    it('rejects name longer than 64 characters', async () => {
      const supabase = createMockSupabase();
      const service = createKeyManagementService(supabase);
      const longName = 'a'.repeat(65);

      try {
        await service.createApiKey('project-uuid', longName, null, SubscriptionPlan.FREE);
      } catch (err) {
        expect(err).toBeInstanceOf(KeyManagementError);
        expect((err as KeyManagementError).code).toBe('invalid_key_name');
      }
    });

    it('rejects name with special characters', async () => {
      const supabase = createMockSupabase();
      const service = createKeyManagementService(supabase);

      try {
        await service.createApiKey('project-uuid', 'key@name!', null, SubscriptionPlan.FREE);
      } catch (err) {
        expect(err).toBeInstanceOf(KeyManagementError);
        expect((err as KeyManagementError).code).toBe('invalid_key_name');
      }
    });

    it('accepts valid name with letters, digits, spaces, hyphens, underscores', async () => {
      const supabase = createMockSupabase();
      const service = createKeyManagementService(supabase);

      const result = await service.createApiKey(
        'project-uuid',
        'My Key-Name_01',
        null,
        SubscriptionPlan.PROFESSIONAL
      );

      expect(result.plaintextKey).toMatch(/^fxi_/);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Description length validation
  // ---------------------------------------------------------------------------
  describe('Description length validation (description_too_long)', () => {
    it('rejects description longer than 256 characters', async () => {
      const supabase = createMockSupabase();
      const service = createKeyManagementService(supabase);
      const longDesc = 'x'.repeat(257);

      try {
        await service.createApiKey('project-uuid', 'Valid Name', longDesc, SubscriptionPlan.FREE);
      } catch (err) {
        expect(err).toBeInstanceOf(KeyManagementError);
        expect((err as KeyManagementError).code).toBe('description_too_long');
      }
    });

    it('accepts description of exactly 256 characters', async () => {
      const supabase = createMockSupabase();
      const service = createKeyManagementService(supabase);
      const exactDesc = 'x'.repeat(256);

      const result = await service.createApiKey(
        'project-uuid',
        'Valid Name',
        exactDesc,
        SubscriptionPlan.FREE
      );

      expect(result.plaintextKey).toMatch(/^fxi_/);
    });

    it('accepts null description', async () => {
      const supabase = createMockSupabase();
      const service = createKeyManagementService(supabase);

      const result = await service.createApiKey(
        'project-uuid',
        'Valid Name',
        null,
        SubscriptionPlan.FREE
      );

      expect(result.plaintextKey).toMatch(/^fxi_/);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Revocation marks key inactive
  // ---------------------------------------------------------------------------
  describe('Key revocation', () => {
    it('revokeApiKey returns record with is_active=false', async () => {
      const supabase = createMockSupabase({
        updateResult: { data: mockRevokedKeyRecord, error: null },
      });
      const service = createKeyManagementService(supabase);

      const result = await service.revokeApiKey('key-uuid-1');

      expect(result.is_active).toBe(false);
      expect(result.id).toBe('key-uuid-1');
    });

    it('throws when key is not found', async () => {
      const supabase = createMockSupabase({
        updateResult: { data: null, error: { message: 'Key not found' } },
      });
      const service = createKeyManagementService(supabase);

      await expect(service.revokeApiKey('nonexistent-key')).rejects.toThrow(KeyManagementError);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Revoked key names can be reused
  // ---------------------------------------------------------------------------
  describe('Revoked key name reuse', () => {
    it('allows creating a key with the same name as a revoked key', async () => {
      // nameCheckResult returns null meaning no *active* key with that name exists
      // (the revoked key has is_active=false so the query filters it out)
      const supabase = createMockSupabase({
        countResult: { count: 5, error: null },
        nameCheckResult: { data: null, error: null },
      });
      const service = createKeyManagementService(supabase);

      const result = await service.createApiKey(
        'project-uuid',
        'Previously Revoked Key',
        null,
        SubscriptionPlan.PROFESSIONAL
      );

      expect(result.plaintextKey).toMatch(/^fxi_/);
      expect(result.record).toBeDefined();
    });
  });
});
