/**
 * Platform-wide constants for the Financial Intelligence Platform.
 * All values are readonly and derived from requirements.
 */

/** Pip threshold below which a return is classified as FLAT (Requirement 3.3) */
export const FLAT_THRESHOLD = 2 as const;

/** UTC hour boundaries for 4H grid windows (Requirement 1.1) */
export const UTC_GRID_BOUNDARIES = [0, 4, 8, 12, 16, 20] as const;

/** Seconds after candle close before batch triggers (60-180s range, using 120) */
export const BATCH_TRIGGER_OFFSET_SECONDS = 120 as const;

/** Maximum batch processing duration in milliseconds (15 minutes per Requirement 12.8) */
export const BATCH_TIMEOUT_MS = 900_000 as const;

/** Maximum number of similarity matches to retrieve (Requirement 2.1) */
export const MAX_SIMILARITY_MATCHES = 50 as const;

/** Minimum sample size before confidence dampener applies (Requirement 5.3) */
export const SAMPLE_SIZE_THRESHOLD = 30 as const;

/** Target API response time in milliseconds (Requirement 8.3) */
export const API_RESPONSE_TARGET_MS = 300 as const;

/** Minimum TTL in seconds; skip caching if less time remains (Requirement 6.2) */
export const CACHE_MIN_TTL_SECONDS = 60 as const;

/** Topology layer weight for similarity scoring (Requirements 2.4, 2.5) */
export const TOPOLOGY_SIMILARITY_WEIGHT = 0.10 as const;
