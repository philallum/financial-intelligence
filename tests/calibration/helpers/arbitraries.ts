/**
 * Custom fast-check arbitraries for the Continuous Learning Pipeline calibration tests.
 * Provides constrained generators for calibration-specific domain types.
 */
import * as fc from 'fast-check';

// --- Domain Interfaces (mirroring src/calibration/types.ts) ---

export interface LayerBreakdown {
  market_structure: number;
  volatility: number;
  liquidity: number;
  macro: number;
  sentiment: number;
}

export type VolatilityRegime = 'LOW' | 'NORMAL' | 'HIGH';
export type TrendRegime = 'BULLISH' | 'BEARISH' | 'RANGING';

/** 9 combined regime types: volatility × trend */
export type CombinedRegime =
  | 'LOW_BULLISH' | 'LOW_BEARISH' | 'LOW_RANGING'
  | 'NORMAL_BULLISH' | 'NORMAL_BEARISH' | 'NORMAL_RANGING'
  | 'HIGH_BULLISH' | 'HIGH_BEARISH' | 'HIGH_RANGING';

export type Asset = 'EURUSD' | 'GBPUSD';
export type Direction = 'up' | 'down' | 'flat';

export interface EvaluationRecord {
  id: string;
  asset: Asset;
  regime: CombinedRegime;
  direction_predicted: Direction;
  direction_actual: Direction;
  direction_accuracy: 0 | 1;
  confidence: number;
  created_at: string;
}

export interface RegimeWeightVector {
  market_structure: number;
  volatility: number;
  liquidity: number;
  macro: number;
  sentiment: number;
}

// --- Arbitraries ---

/**
 * Generates a valid LayerBreakdown with each score in [0.0, 1.0].
 */
export const arbLayerBreakdown: fc.Arbitrary<LayerBreakdown> = fc.record({
  market_structure: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  volatility: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  liquidity: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  macro: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  sentiment: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
});

/** All 9 combined regime type strings */
const ALL_REGIMES: CombinedRegime[] = [
  'LOW_BULLISH', 'LOW_BEARISH', 'LOW_RANGING',
  'NORMAL_BULLISH', 'NORMAL_BEARISH', 'NORMAL_RANGING',
  'HIGH_BULLISH', 'HIGH_BEARISH', 'HIGH_RANGING',
];

/**
 * Generates one of the 9 combined regime type strings.
 */
export const arbRegime: fc.Arbitrary<CombinedRegime> = fc.constantFrom(...ALL_REGIMES);

/**
 * Generates one of the supported asset pairs.
 */
export const arbAsset: fc.Arbitrary<Asset> = fc.constantFrom('EURUSD', 'GBPUSD');

/**
 * Generates a direction value: 'up', 'down', or 'flat'.
 */
export const arbDirection: fc.Arbitrary<Direction> = fc.constantFrom('up', 'down', 'flat');

/**
 * Generates a complete EvaluationRecord.
 * direction_accuracy is derived: 1 if predicted === actual, 0 otherwise.
 */
export const arbEvaluationRecord: fc.Arbitrary<EvaluationRecord> = fc
  .record({
    id: fc.uuid(),
    asset: arbAsset,
    regime: arbRegime,
    direction_predicted: arbDirection,
    direction_actual: arbDirection,
    confidence: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    created_at: fc.integer({
      min: new Date('2023-01-01').getTime(),
      max: new Date('2025-06-01').getTime(),
    }).map((ts) => new Date(ts).toISOString()),
  })
  .map((rec) => ({
    ...rec,
    direction_accuracy: (rec.direction_predicted === rec.direction_actual ? 1 : 0) as 0 | 1,
  }));

/**
 * Generates a regime weight vector where all 5 values sum to 1.0.
 * Uses Dirichlet-like approach: generate 5 positive random values then normalize.
 */
export const arbRegimeWeightVector: fc.Arbitrary<RegimeWeightVector> = fc
  .array(
    fc.double({ min: 0.001, max: 1, noNaN: true, noDefaultInfinity: true }),
    { minLength: 5, maxLength: 5 },
  )
  .map((values) => {
    const sum = values[0] + values[1] + values[2] + values[3] + values[4];
    return {
      market_structure: values[0] / sum,
      volatility: values[1] / sum,
      liquidity: values[2] / sum,
      macro: values[3] / sum,
      sentiment: values[4] / sum,
    };
  });
