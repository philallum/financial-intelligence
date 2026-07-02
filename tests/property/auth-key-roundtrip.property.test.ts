import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { hashApiKey, verifyApiKey } from '../../src/api/utils/key-hash.js';

/**
 * Property 1: API Key Verification Round-Trip
 * Validates: Requirements 1.3, 2.1
 *
 * For any randomly generated API key string:
 * 1. Creating a hash and verifying the original plaintext against that hash should succeed (return true)
 * 2. Verifying any DIFFERENT string against that hash should fail (return false)
 */
describe('Property 1: API Key Verification Round-Trip', () => {
  it('should verify the original plaintext against its hash', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 256 }),
        async (plaintext) => {
          const hash = await hashApiKey(plaintext);
          const result = await verifyApiKey(plaintext, hash);
          expect(result).toBe(true);
        }
      ),
      { numRuns: 20 } // Keep low due to Argon2id compute cost
    );
  });

  it('should reject a different string against the hash', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 256 }),
        fc.string({ minLength: 1, maxLength: 256 }),
        async (original, different) => {
          fc.pre(original !== different);
          const hash = await hashApiKey(original);
          const result = await verifyApiKey(different, hash);
          expect(result).toBe(false);
        }
      ),
      { numRuns: 20 } // Keep low due to Argon2id compute cost
    );
  });

  it('should reject verification against an invalid hash string', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 256 }),
        async (plaintext) => {
          const result = await verifyApiKey(plaintext, 'not-a-valid-hash');
          expect(result).toBe(false);
        }
      ),
      { numRuns: 10 }
    );
  });
});
