/**
 * Deterministic test fixtures for the Financial Intelligence Platform.
 * All values are hand-crafted for reproducibility across test runs.
 */
import type { OHLC, StateLayers, Regime, Fingerprint } from './generators.js';

// --- Deterministic OHLC Fixtures ---

/** Bullish candle: close > open */
export const BULLISH_CANDLE: OHLC = {
  open: 1.08500,
  high: 1.09200,
  low: 1.08350,
  close: 1.09100,
};

/** Bearish candle: close < open */
export const BEARISH_CANDLE: OHLC = {
  open: 1.09100,
  high: 1.09250,
  low: 1.08400,
  close: 1.08500,
};

/** Doji candle: open ≈ close */
export const DOJI_CANDLE: OHLC = {
  open: 1.08750,
  high: 1.08900,
  low: 1.08600,
  close: 1.08755,
};

// --- Deterministic State Layer Fixtures ---

/** All zeros — represents a fully neutral/inactive state */
export const ZERO_STATE_LAYERS: StateLayers = {
  market_structure: Array(16).fill(0),
  volatility_profile: Array(12).fill(0),
  liquidity_field: Array(20).fill(0),
  macro_context: Array(8).fill(0),
  sentiment_pressure: Array(6).fill(0),
};

/** All ones — represents maximum activation across all dimensions */
export const MAX_STATE_LAYERS: StateLayers = {
  market_structure: Array(16).fill(1),
  volatility_profile: Array(12).fill(1),
  liquidity_field: Array(20).fill(1),
  macro_context: Array(8).fill(1),
  sentiment_pressure: Array(6).fill(1),
};

/** Mid-range state — 0.5 across all dimensions */
export const MID_STATE_LAYERS: StateLayers = {
  market_structure: Array(16).fill(0.5),
  volatility_profile: Array(12).fill(0.5),
  liquidity_field: Array(20).fill(0.5),
  macro_context: Array(8).fill(0.5),
  sentiment_pressure: Array(6).fill(0.5),
};

// --- Deterministic Regime Fixtures ---

export const TRENDING_HIGH_VOL_REGIME: Regime = {
  volatility_regime: 'HIGH',
  trend_regime: 'BULLISH',
  session: 'LONDON',
};

export const RANGING_LOW_VOL_REGIME: Regime = {
  volatility_regime: 'LOW',
  trend_regime: 'RANGING',
  session: 'ASIA',
};

export const NORMAL_BEARISH_REGIME: Regime = {
  volatility_regime: 'NORMAL',
  trend_regime: 'BEARISH',
  session: 'NY',
};

// --- Deterministic Fingerprint Fixtures ---

export const SAMPLE_FINGERPRINT: Fingerprint = {
  fingerprint_id: '550e8400-e29b-41d4-a716-446655440000',
  asset: 'EURUSD',
  timeframe: '4H',
  timestamp_utc: '2024-06-15T08:00:00.000Z',
  market_state_version: '1.0.0',
  ohlc: BULLISH_CANDLE,
  return_profile: {
    net_return_pips: 12.5,
    range_pips: 85.0,
  },
  regime: TRENDING_HIGH_VOL_REGIME,
  state_layers: MID_STATE_LAYERS,
  session: 'LONDON',
};

export const SAMPLE_FINGERPRINT_2: Fingerprint = {
  fingerprint_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  asset: 'EURUSD',
  timeframe: '4H',
  timestamp_utc: '2024-06-15T12:00:00.000Z',
  market_state_version: '1.0.0',
  ohlc: BEARISH_CANDLE,
  return_profile: {
    net_return_pips: -8.3,
    range_pips: 65.0,
  },
  regime: NORMAL_BEARISH_REGIME,
  state_layers: ZERO_STATE_LAYERS,
  session: 'NY',
};

// --- Deterministic Similarity Score Fixtures ---

export const SIMILARITY_SCORES = {
  PERFECT_MATCH: 1.0,
  HIGH_SIMILARITY: 0.923456,
  MODERATE_SIMILARITY: 0.654321,
  LOW_SIMILARITY: 0.234567,
  NO_MATCH: 0.0,
} as const;

// --- Deterministic Return Fixtures ---

export const RETURN_VALUES = {
  STRONG_BULLISH: 45.5,
  MODERATE_BULLISH: 12.3,
  FLAT: 1.5,
  MODERATE_BEARISH: -15.7,
  STRONG_BEARISH: -52.0,
} as const;
