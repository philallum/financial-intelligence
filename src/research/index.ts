/**
 * Research Namespace — Single Public Export Surface
 *
 * The research namespace groups all research-related functionality:
 * - persistence: Forecast record archival (Phase 1)
 * - evaluation: Forecast accuracy measurement (Phase 2)
 * - archival: Similarity match persistence (Phase 3)
 * - experimentation: A/B engine testing (Phase 5)
 *
 * Dependency direction: research → engines/services/types (never reverse).
 * External consumers import exclusively from this barrel file.
 */

export * from './persistence/index.js';
export * from './evaluation/index.js';
export * from './archival/index.js';
export * from './experimentation/index.js';
