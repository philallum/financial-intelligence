/**
 * Research Evaluation — Phase 2: Evaluation Engine
 *
 * Provides accuracy measurement of matured forecasts against realised market outcomes.
 * All exports from this module are available via src/research/index.ts.
 */

export * from './types.js';
export { createEvaluationEngine } from './evaluation-engine.js';
export {
  computeCalibrationReport,
  type CalibrationFilter,
  type CalibrationBucketResult,
  type CalibrationReport,
} from './calibration.js';
