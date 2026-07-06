import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { sanitiseMessage } from '../../src/api/middleware/error-handler.js';

/**
 * Property 17: Internal Error Sanitisation
 * Validates: Requirements 14.2
 *
 * WHEN an internal error occurs, the response body must contain no stack traces,
 * file paths, database queries, or internal service addresses.
 *
 * For ANY random error message containing these patterns, sanitiseMessage strips them.
 */

// =============================================================================
// Detection Patterns (used to assert sanitised output is clean)
// =============================================================================

/** Matches Unix/Windows file paths */
const FILE_PATH_RE = /(?:\/[\w.\-]+){2,}|[A-Z]:\\[\w.\\\-]+/;

/** Matches stack trace lines */
const STACK_TRACE_RE = /\bat\s+\S+.*\(.*\)|^\s+at\s+.+/m;

/** Matches SQL query keywords followed by target clauses */
const DB_QUERY_RE = /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b[\s\S]*?(?:FROM|INTO|SET|WHERE|TABLE|;)/i;

/** Matches internal/private IP addresses and localhost references */
const INTERNAL_ADDRESS_RE = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost(?::\d+)?)\b/;

// =============================================================================
// Generators
// =============================================================================

/** Generator for random surrounding text (noise around sensitive patterns) */
const noiseArb = fc.string({ minLength: 0, maxLength: 30, unit: fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?:- '.split(''),
) });

/** Generator for Unix file paths */
const unixPathArb = fc.tuple(
  fc.array(
    fc.string({ minLength: 1, maxLength: 10, unit: fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyz0123456789-_.'.split(''),
    ) }),
    { minLength: 2, maxLength: 5 },
  ),
).map(([segments]) => '/' + segments.join('/'));

/** Generator for Windows file paths */
const windowsPathArb = fc.tuple(
  fc.constantFrom('C', 'D', 'E'),
  fc.array(
    fc.string({ minLength: 1, maxLength: 10, unit: fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyz0123456789-_.'.split(''),
    ) }),
    { minLength: 2, maxLength: 4 },
  ),
).map(([drive, segments]) => `${drive}:\\${segments.join('\\')}`);

/** Generator for file paths (Unix or Windows) */
const filePathArb = fc.oneof(unixPathArb, windowsPathArb);

/** Generator for stack trace lines */
const stackTraceArb = fc.tuple(
  fc.constantFrom(
    'Module._compile',
    'Object.<anonymous>',
    'Function.Module._load',
    'node:internal/modules/cjs/loader',
    'processTicksAndRejections',
    'async Route.dispatch',
  ),
  unixPathArb,
  fc.nat({ max: 999 }),
  fc.nat({ max: 99 }),
).map(([fn, path, line, col]) => `at ${fn} (${path}:${line}:${col})`);

/** Generator for SQL queries */
const sqlQueryArb = fc.tuple(
  fc.constantFrom('SELECT', 'INSERT', 'UPDATE', 'DELETE'),
  fc.constantFrom('users', 'api_keys', 'customers', 'projects', 'sessions'),
  fc.string({ minLength: 1, maxLength: 15, unit: fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyz_'.split(''),
  ) }),
).map(([verb, table, col]) => {
  switch (verb) {
    case 'SELECT': return `SELECT ${col} FROM ${table} WHERE id = 1`;
    case 'INSERT': return `INSERT INTO ${table} (${col}) VALUES ('test')`;
    case 'UPDATE': return `UPDATE ${table} SET ${col} = 'val' WHERE id = 1`;
    case 'DELETE': return `DELETE FROM ${table} WHERE ${col} = 'x'`;
    default: return `SELECT * FROM ${table};`;
  }
});

/** Generator for internal/private IP addresses */
const internalAddressArb = fc.oneof(
  // 10.x.x.x
  fc.tuple(fc.nat({ max: 255 }), fc.nat({ max: 255 }), fc.nat({ max: 255 }))
    .map(([b, c, d]) => `10.${b}.${c}.${d}`),
  // 192.168.x.x
  fc.tuple(fc.nat({ max: 255 }), fc.nat({ max: 255 }))
    .map(([c, d]) => `192.168.${c}.${d}`),
  // 172.16-31.x.x
  fc.tuple(fc.integer({ min: 16, max: 31 }), fc.nat({ max: 255 }), fc.nat({ max: 255 }))
    .map(([b, c, d]) => `172.${b}.${c}.${d}`),
  // 127.x.x.x
  fc.tuple(fc.nat({ max: 255 }), fc.nat({ max: 255 }), fc.nat({ max: 255 }))
    .map(([b, c, d]) => `127.${b}.${c}.${d}`),
  // localhost:port
  fc.nat({ max: 65535 }).map(port => `localhost:${port}`),
);

// =============================================================================
// Tests
// =============================================================================

describe('Property 17: Internal Error Sanitisation', () => {
  /**
   * Validates: Requirements 14.2
   * For any error message containing file paths, sanitiseMessage strips them.
   */
  it('strips file paths from any error message', () => {
    fc.assert(
      fc.property(noiseArb, filePathArb, noiseArb, (prefix, path, suffix) => {
        const input = `${prefix}${path}${suffix}`;
        const result = sanitiseMessage(input);

        expect(result).not.toMatch(FILE_PATH_RE);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 14.2
   * For any error message containing stack traces, sanitiseMessage strips them.
   */
  it('strips stack trace lines from any error message', () => {
    fc.assert(
      fc.property(noiseArb, stackTraceArb, noiseArb, (prefix, trace, suffix) => {
        const input = `${prefix}\n  ${trace}\n${suffix}`;
        const result = sanitiseMessage(input);

        expect(result).not.toMatch(STACK_TRACE_RE);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 14.2
   * For any error message containing SQL queries, sanitiseMessage strips them.
   */
  it('strips SQL queries from any error message', () => {
    fc.assert(
      fc.property(noiseArb, sqlQueryArb, noiseArb, (prefix, query, suffix) => {
        const input = `${prefix} ${query} ${suffix}`;
        const result = sanitiseMessage(input);

        expect(result).not.toMatch(DB_QUERY_RE);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 14.2
   * For any error message containing internal addresses, sanitiseMessage strips them.
   */
  it('strips internal addresses from any error message', () => {
    fc.assert(
      fc.property(noiseArb, internalAddressArb, noiseArb, (prefix, addr, suffix) => {
        const input = `${prefix} ${addr} ${suffix}`;
        const result = sanitiseMessage(input);

        expect(result).not.toMatch(INTERNAL_ADDRESS_RE);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * Validates: Requirements 14.2
   * For any error message containing multiple sensitive patterns at once,
   * sanitiseMessage strips all of them.
   */
  it('strips all sensitive patterns when combined in a single message', () => {
    fc.assert(
      fc.property(
        filePathArb,
        stackTraceArb,
        sqlQueryArb,
        internalAddressArb,
        noiseArb,
        (path, trace, query, addr, noise) => {
          const input = `Error: ${noise}\n  ${trace}\nFailed at ${path} connecting to ${addr}\n${query}`;
          const result = sanitiseMessage(input);

          expect(result).not.toMatch(FILE_PATH_RE);
          expect(result).not.toMatch(STACK_TRACE_RE);
          expect(result).not.toMatch(DB_QUERY_RE);
          expect(result).not.toMatch(INTERNAL_ADDRESS_RE);
        },
      ),
      { numRuns: 200 },
    );
  });
});
