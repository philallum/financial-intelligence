/**
 * API Key Management Service
 *
 * Provides key lifecycle operations: creation (with Argon2id hashing),
 * revocation (soft-delete), and constraint enforcement.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SubscriptionPlan } from '../../types/enums.js';
import type { ApiKey } from '../../types/entities.js';
import { hashApiKey } from '../utils/key-hash.js';

// =============================================================================
// Constants
// =============================================================================

/** Prefix for all generated API keys to aid identification. */
const KEY_PREFIX = 'fxi_';

/** Maximum active keys allowed per project (Req 2.5). */
const MAX_ACTIVE_KEYS_PER_PROJECT = 20;

/** Regex for valid key names: 1-64 chars, letters/digits/spaces/hyphens/underscores (Req 2.2). */
const NAME_PATTERN = /^[A-Za-z0-9 \-_]{1,64}$/;

/** Maximum description length (Req 2.2). */
const MAX_DESCRIPTION_LENGTH = 256;

// =============================================================================
// Types
// =============================================================================

export interface CreateApiKeyResult {
  /** The plaintext key — returned exactly once. */
  plaintextKey: string;
  /** The persisted API key record (hash stored, not plaintext). */
  record: ApiKey;
}

export interface KeyManagementService {
  createApiKey(
    projectId: string,
    name: string,
    description: string | null,
    subscriptionPlan: SubscriptionPlan
  ): Promise<CreateApiKeyResult>;

  revokeApiKey(keyId: string): Promise<ApiKey>;
}

// =============================================================================
// Errors
// =============================================================================

export class KeyManagementError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'KeyManagementError';
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a KeyManagementService instance.
 *
 * @param supabase - An authenticated SupabaseClient (service-role recommended).
 */
export function createKeyManagementService(supabase: SupabaseClient): KeyManagementService {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Generate a random API key with the `fxi_` prefix.
   * Uses 32 random bytes → 64 hex characters for high entropy.
   */
  function generatePlaintextKey(): string {
    const random = crypto.randomBytes(32).toString('hex');
    return `${KEY_PREFIX}${random}`;
  }

  /**
   * Validate key name format (Req 2.2).
   * Must be 1-64 characters; only letters, digits, spaces, hyphens, underscores.
   */
  function validateName(name: string): void {
    if (!NAME_PATTERN.test(name)) {
      throw new KeyManagementError(
        'Key name must be 1-64 characters and contain only letters, digits, spaces, hyphens, or underscores.',
        'invalid_key_name'
      );
    }
  }

  /**
   * Validate description length (Req 2.2).
   * If provided, must be at most 256 characters.
   */
  function validateDescription(description: string | null): void {
    if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
      throw new KeyManagementError(
        `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
        'description_too_long'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Service Methods
  // ---------------------------------------------------------------------------

  async function createApiKey(
    projectId: string,
    name: string,
    description: string | null,
    subscriptionPlan: SubscriptionPlan
  ): Promise<CreateApiKeyResult> {
    // 1. Validate inputs
    validateName(name);
    validateDescription(description);

    // 2. Check active key count (Req 2.5: max 20 active keys per project)
    const { count, error: countError } = await supabase
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('is_active', true);

    if (countError) {
      throw new KeyManagementError(
        `Failed to check active key count: ${countError.message}`,
        'database_error'
      );
    }

    if ((count ?? 0) >= MAX_ACTIVE_KEYS_PER_PROJECT) {
      throw new KeyManagementError(
        `Maximum of ${MAX_ACTIVE_KEYS_PER_PROJECT} active API keys per project reached.`,
        'max_keys_reached'
      );
    }

    // 3. Check name uniqueness among active keys (Req 2.6)
    const { data: existingKey, error: nameError } = await supabase
      .from('api_keys')
      .select('id')
      .eq('project_id', projectId)
      .eq('name', name)
      .eq('is_active', true)
      .maybeSingle();

    if (nameError) {
      throw new KeyManagementError(
        `Failed to check name uniqueness: ${nameError.message}`,
        'database_error'
      );
    }

    if (existingKey) {
      throw new KeyManagementError(
        `An active API key with the name "${name}" already exists in this project.`,
        'duplicate_key_name'
      );
    }

    // 4. Generate plaintext key and Argon2id hash (Req 2.1)
    const plaintextKey = generatePlaintextKey();
    const keyHash = await hashApiKey(plaintextKey);

    // 5. Persist the key record (Req 2.4)
    const { data: record, error: insertError } = await supabase
      .from('api_keys')
      .insert({
        project_id: projectId,
        key_hash: keyHash,
        name,
        description,
        subscription_plan: subscriptionPlan,
        is_active: true,
        rate_limit_override: null,
        daily_usage: 0,
        monthly_usage: 0,
        last_reset: new Date().toISOString(),
        last_used_at: null,
      })
      .select()
      .single();

    if (insertError || !record) {
      throw new KeyManagementError(
        `Failed to create API key: ${insertError?.message ?? 'No record returned'}`,
        'database_error'
      );
    }

    return {
      plaintextKey,
      record: record as ApiKey,
    };
  }

  async function revokeApiKey(keyId: string): Promise<ApiKey> {
    // Mark the key as inactive without deleting (Req 2.3)
    const { data: record, error } = await supabase
      .from('api_keys')
      .update({ is_active: false })
      .eq('id', keyId)
      .select()
      .single();

    if (error || !record) {
      throw new KeyManagementError(
        `Failed to revoke API key: ${error?.message ?? 'Key not found'}`,
        'revocation_failed'
      );
    }

    return record as ApiKey;
  }

  // ---------------------------------------------------------------------------
  // Return service object
  // ---------------------------------------------------------------------------

  return {
    createApiKey,
    revokeApiKey,
  };
}
