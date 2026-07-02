/**
 * Argon2id key hashing and verification utilities.
 *
 * Uses OWASP-recommended Argon2id parameters for secure API key storage.
 * Replaces the previous SHA-256 hashing approach.
 *
 * Requirements: 1.3, 2.1
 */

import argon2 from 'argon2';

/**
 * OWASP-recommended Argon2id parameters:
 * - memoryCost: 19456 KiB (19 MiB)
 * - timeCost: 2 iterations
 * - parallelism: 1 thread
 * - type: Argon2id (hybrid of Argon2i and Argon2d)
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Hash an API key using Argon2id with OWASP-recommended parameters.
 *
 * @param plaintext - The raw API key string to hash
 * @returns The Argon2id hash string (includes algorithm, params, salt, and hash)
 */
export async function hashApiKey(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify an API key against a stored Argon2id hash.
 *
 * @param plaintext - The raw API key string to verify
 * @param hash - The stored Argon2id hash to verify against
 * @returns true if the plaintext matches the hash, false otherwise
 */
export async function verifyApiKey(plaintext: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}
