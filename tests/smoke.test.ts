/**
 * Smoke test to verify Vitest + fast-check integration works correctly.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  arbOHLC,
  arbSimilarityScore,
  arbStateLayers,
  arbFingerprint,
} from './helpers/generators.js';
import {
  BULLISH_CANDLE,
  SAMPLE_FINGERPRINT,
  SIMILARITY_SCORES,
} from './helpers/fixtures.js';

describe('Smoke Test: Test Runner', () => {
  it('should run a basic assertion', () => {
    expect(1 + 1).toBe(2);
  });

  it('should import fixtures correctly', () => {
    expect(BULLISH_CANDLE.high).toBeGreaterThanOrEqual(BULLISH_CANDLE.open);
    expect(BULLISH_CANDLE.high).toBeGreaterThanOrEqual(BULLISH_CANDLE.close);
    expect(BULLISH_CANDLE.low).toBeLessThanOrEqual(BULLISH_CANDLE.open);
    expect(BULLISH_CANDLE.low).toBeLessThanOrEqual(BULLISH_CANDLE.close);
  });

  it('should validate sample fingerprint structure', () => {
    expect(SAMPLE_FINGERPRINT.asset).toBe('EURUSD');
    expect(SAMPLE_FINGERPRINT.timeframe).toBe('4H');
    expect(SAMPLE_FINGERPRINT.state_layers.market_structure).toHaveLength(16);
    expect(SAMPLE_FINGERPRINT.state_layers.volatility_profile).toHaveLength(12);
    expect(SAMPLE_FINGERPRINT.state_layers.liquidity_field).toHaveLength(20);
    expect(SAMPLE_FINGERPRINT.state_layers.macro_context).toHaveLength(8);
    expect(SAMPLE_FINGERPRINT.state_layers.sentiment_pressure).toHaveLength(6);
  });

  it('should access similarity score constants', () => {
    expect(SIMILARITY_SCORES.PERFECT_MATCH).toBe(1.0);
    expect(SIMILARITY_SCORES.NO_MATCH).toBe(0.0);
    expect(SIMILARITY_SCORES.HIGH_SIMILARITY).toBeGreaterThan(0.9);
  });
});

describe('Smoke Test: fast-check Integration', () => {
  it('should generate valid OHLC candles satisfying invariants', () => {
    fc.assert(
      fc.property(arbOHLC, (ohlc) => {
        // OHLC invariant: high >= max(open, close), low <= min(open, close)
        expect(ohlc.high).toBeGreaterThanOrEqual(Math.max(ohlc.open, ohlc.close));
        expect(ohlc.low).toBeLessThanOrEqual(Math.min(ohlc.open, ohlc.close));
      })
    );
  });

  it('should generate similarity scores bounded in [0, 1]', () => {
    fc.assert(
      fc.property(arbSimilarityScore, (score) => {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      })
    );
  });

  it('should generate state layers with correct dimensions', () => {
    fc.assert(
      fc.property(arbStateLayers, (layers) => {
        expect(layers.market_structure).toHaveLength(16);
        expect(layers.volatility_profile).toHaveLength(12);
        expect(layers.liquidity_field).toHaveLength(20);
        expect(layers.macro_context).toHaveLength(8);
        expect(layers.sentiment_pressure).toHaveLength(6);
      })
    );
  });

  it('should generate state layer values bounded in [0, 1]', () => {
    fc.assert(
      fc.property(arbStateLayers, (layers) => {
        const allValues = [
          ...layers.market_structure,
          ...layers.volatility_profile,
          ...layers.liquidity_field,
          ...layers.macro_context,
          ...layers.sentiment_pressure,
        ];
        for (const val of allValues) {
          expect(val).toBeGreaterThanOrEqual(0);
          expect(val).toBeLessThanOrEqual(1);
        }
      })
    );
  });

  it('should generate complete fingerprint objects', () => {
    fc.assert(
      fc.property(arbFingerprint, (fp) => {
        expect(fp.asset).toBe('EURUSD');
        expect(fp.timeframe).toBe('4H');
        expect(fp.fingerprint_id).toBeTruthy();
        expect(fp.ohlc.high).toBeGreaterThanOrEqual(Math.max(fp.ohlc.open, fp.ohlc.close));
        expect(fp.ohlc.low).toBeLessThanOrEqual(Math.min(fp.ohlc.open, fp.ohlc.close));
        expect(['LOW', 'NORMAL', 'HIGH']).toContain(fp.regime.volatility_regime);
        expect(['BULLISH', 'BEARISH', 'RANGING']).toContain(fp.regime.trend_regime);
        expect(['ASIA', 'LONDON', 'NY']).toContain(fp.regime.session);
      })
    );
  });
});
