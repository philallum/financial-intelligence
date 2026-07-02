/**
 * Enums and string literal union types for the Financial Intelligence Platform.
 *
 * Uses TypeScript string literal unions for type safety and
 * runtime-accessible const objects for iteration and validation.
 */

// --- Regime Types ---

export const VolatilityRegime = {
  LOW: "LOW",
  NORMAL: "NORMAL",
  HIGH: "HIGH",
} as const;
export type VolatilityRegime =
  (typeof VolatilityRegime)[keyof typeof VolatilityRegime];

export const TrendRegime = {
  BULLISH: "BULLISH",
  BEARISH: "BEARISH",
  RANGING: "RANGING",
} as const;
export type TrendRegime = (typeof TrendRegime)[keyof typeof TrendRegime];

// --- Session Types ---

export const Session = {
  ASIA: "ASIA",
  LONDON: "LONDON",
  NY: "NY",
} as const;
export type Session = (typeof Session)[keyof typeof Session];

// --- API Response Modes ---

export const ResponseMode = {
  RAW: "RAW",
  FORECAST: "FORECAST",
  EXPLAIN: "EXPLAIN",
  TRADE: "TRADE",
  RESEARCH: "RESEARCH",
} as const;
export type ResponseMode = (typeof ResponseMode)[keyof typeof ResponseMode];

// --- Customer Tiers ---

export const CustomerTier = {
  RETAIL: "RETAIL",
  DEVELOPER: "DEVELOPER",
  RESEARCH: "RESEARCH",
  INTERNAL: "INTERNAL",
} as const;
export type CustomerTier = (typeof CustomerTier)[keyof typeof CustomerTier];

// --- Subscription Plans ---

export const SubscriptionPlan = {
  FREE: "FREE",
  STARTER: "STARTER",
  PROFESSIONAL: "PROFESSIONAL",
  ENTERPRISE: "ENTERPRISE",
} as const;
export type SubscriptionPlan =
  (typeof SubscriptionPlan)[keyof typeof SubscriptionPlan];

// --- RapidAPI Subscription Tiers ---

export const RapidApiSubscription = {
  BASIC: "BASIC",
  PRO: "PRO",
  ULTRA: "ULTRA",
  MEGA: "MEGA",
  CUSTOM: "CUSTOM",
} as const;
export type RapidApiSubscription =
  (typeof RapidApiSubscription)[keyof typeof RapidApiSubscription];

// --- Tradeability Labels ---

export const TradeabilityLabel = {
  GO: "GO",
  CONDITIONAL: "CONDITIONAL",
  NO_GO: "NO_GO",
} as const;
export type TradeabilityLabel =
  (typeof TradeabilityLabel)[keyof typeof TradeabilityLabel];

// --- Batch Status ---

export const BatchStatus = {
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  TIMEOUT: "TIMEOUT",
} as const;
export type BatchStatus = (typeof BatchStatus)[keyof typeof BatchStatus];

// --- Spread Penalty Levels ---

export const SpreadPenalty = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;
export type SpreadPenalty = (typeof SpreadPenalty)[keyof typeof SpreadPenalty];

// --- Session Alignment ---

export const SessionAlignment = {
  OPTIMAL: "optimal",
  SUBOPTIMAL: "suboptimal",
  POOR: "poor",
} as const;
export type SessionAlignment =
  (typeof SessionAlignment)[keyof typeof SessionAlignment];

// --- News Buffer Status ---

export const NewsBufferStatus = {
  CLEAR: "clear",
  WARNING: "warning",
  BLOCKED: "blocked",
} as const;
export type NewsBufferStatus =
  (typeof NewsBufferStatus)[keyof typeof NewsBufferStatus];
