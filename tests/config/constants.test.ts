import { describe, it, expect } from 'vitest';
import {
  FLAT_THRESHOLD,
  UTC_GRID_BOUNDARIES,
  BATCH_TRIGGER_OFFSET_SECONDS,
  BATCH_TIMEOUT_MS,
  MAX_SIMILARITY_MATCHES,
  SAMPLE_SIZE_THRESHOLD,
  API_RESPONSE_TARGET_MS,
  CACHE_MIN_TTL_SECONDS,
} from '../../src/config/constants.js';

describe('Platform Constants', () => {
  it('FLAT_THRESHOLD should be 2 pips', () => {
    expect(FLAT_THRESHOLD).toBe(2);
  });

  it('UTC_GRID_BOUNDARIES should define 6 four-hour windows starting at midnight', () => {
    expect(UTC_GRID_BOUNDARIES).toEqual([0, 4, 8, 12, 16, 20]);
    expect(UTC_GRID_BOUNDARIES).toHaveLength(6);
  });

  it('UTC_GRID_BOUNDARIES should be spaced 4 hours apart', () => {
    for (let i = 1; i < UTC_GRID_BOUNDARIES.length; i++) {
      expect(UTC_GRID_BOUNDARIES[i] - UTC_GRID_BOUNDARIES[i - 1]).toBe(4);
    }
  });

  it('BATCH_TRIGGER_OFFSET_SECONDS should be within 60-180s range', () => {
    expect(BATCH_TRIGGER_OFFSET_SECONDS).toBeGreaterThanOrEqual(60);
    expect(BATCH_TRIGGER_OFFSET_SECONDS).toBeLessThanOrEqual(180);
  });

  it('BATCH_TIMEOUT_MS should be 15 minutes in milliseconds', () => {
    expect(BATCH_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });

  it('MAX_SIMILARITY_MATCHES should be 50', () => {
    expect(MAX_SIMILARITY_MATCHES).toBe(50);
  });

  it('SAMPLE_SIZE_THRESHOLD should be 30', () => {
    expect(SAMPLE_SIZE_THRESHOLD).toBe(30);
  });

  it('API_RESPONSE_TARGET_MS should be 300ms', () => {
    expect(API_RESPONSE_TARGET_MS).toBe(300);
  });

  it('CACHE_MIN_TTL_SECONDS should be 60 seconds', () => {
    expect(CACHE_MIN_TTL_SECONDS).toBe(60);
  });

  it('all constants should be positive numbers', () => {
    const allConstants = [
      FLAT_THRESHOLD,
      BATCH_TRIGGER_OFFSET_SECONDS,
      BATCH_TIMEOUT_MS,
      MAX_SIMILARITY_MATCHES,
      SAMPLE_SIZE_THRESHOLD,
      API_RESPONSE_TARGET_MS,
      CACHE_MIN_TTL_SECONDS,
    ];
    for (const c of allConstants) {
      expect(c).toBeGreaterThan(0);
    }
  });
});
