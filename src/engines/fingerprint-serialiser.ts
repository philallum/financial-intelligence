/**
 * Fingerprint Serialiser
 *
 * Serialises Fingerprint objects into canonical JSON format and parses
 * stored JSON back into validated Fingerprint objects.
 *
 * Key invariants:
 * - CANONICAL: lexicographic key ordering at every nesting level
 * - DETERMINISTIC: consistent number formatting via JSON.stringify
 * - ROUND-TRIP: serialise → parse → serialise produces byte-identical output
 * - STRICT: missing fields, invalid types, and unknown fields are rejected
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5
 */

import type {
  Fingerprint,
  OHLC,
  RegimeClassification,
  SupportResistanceTopology,
  IndicatorProfile,
  OrderFlowSummary,
} from "../types/index.js";

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error class for fingerprint parsing failures.
 * Includes the field name and a description of what went wrong.
 */
export class FingerprintParseError extends Error {
  public readonly field: string;
  public readonly description: string;

  constructor(field: string, description: string) {
    super(`Fingerprint parse error at '${field}': ${description}`);
    this.name = "FingerprintParseError";
    this.field = field;
    this.description = description;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Serialise a Fingerprint object into canonical JSON.
 * Keys are sorted lexicographically at every nesting level.
 * Number formatting uses standard JSON.stringify (deterministic for same value).
 *
 * Requirement 15.1
 */
export function serialise(fingerprint: Fingerprint): string {
  return canonicalStringify(fingerprint);
}

/**
 * Parse a JSON string into a validated Fingerprint object.
 * Validates all required fields, rejects unknown fields.
 *
 * Requirements 15.2, 15.4, 15.5
 */
export function parse(json: string): Fingerprint {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new FingerprintParseError(
      "<root>",
      `Malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FingerprintParseError("<root>", "Expected a JSON object");
  }

  const obj = raw as Record<string, unknown>;

  // Check for unknown top-level fields
  checkUnknownFields(obj, FINGERPRINT_KNOWN_FIELDS, "<root>");

  // Validate and extract each required field
  const fingerprint_id = requireString(obj, "fingerprint_id");
  const asset = requireString(obj, "asset");
  const timeframe = requireString(obj, "timeframe");
  const timestamp_utc = requireString(obj, "timestamp_utc");
  const market_state_version = requireString(obj, "market_state_version");
  const ohlc = parseOHLC(obj);
  const return_profile = parseReturnProfile(obj);
  const regime = parseRegime(obj);
  const state_layers = parseStateLayers(obj);
  const normalisation = parseNormalisation(obj);
  const extended_state = parseExtendedState(obj);

  const result: Fingerprint = {
    fingerprint_id,
    asset,
    timeframe,
    timestamp_utc,
    market_state_version,
    ohlc,
    return_profile,
    regime,
    state_layers,
    normalisation,
  };

  if (extended_state !== undefined) {
    result.extended_state = extended_state;
  }

  return result;
}

// =============================================================================
// Canonical JSON Serialisation
// =============================================================================

/**
 * Recursively serialise a value with lexicographically sorted keys.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    // Normalize -0 to 0 to ensure deterministic round-trip
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalStringify(item));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalStringify(obj[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

// =============================================================================
// Known Field Schemas
// =============================================================================

const FINGERPRINT_KNOWN_FIELDS = new Set([
  "fingerprint_id",
  "asset",
  "timeframe",
  "timestamp_utc",
  "market_state_version",
  "ohlc",
  "return_profile",
  "regime",
  "state_layers",
  "extended_state",
  "normalisation",
]);

const OHLC_KNOWN_FIELDS = new Set(["open", "high", "low", "close"]);

const RETURN_PROFILE_KNOWN_FIELDS = new Set([
  "net_return_pips",
  "range_pips",
]);

const REGIME_KNOWN_FIELDS = new Set([
  "volatility_regime",
  "trend_regime",
  "session",
]);

const STATE_LAYERS_KNOWN_FIELDS = new Set([
  "market_structure",
  "volatility_profile",
  "liquidity_field",
  "macro_context",
  "sentiment_pressure",
]);

const NORMALISATION_KNOWN_FIELDS = new Set([
  "quantile_table_version",
  "scaling_method",
]);

const EXTENDED_STATE_KNOWN_FIELDS = new Set([
  "support_resistance_topology",
  "indicator_profile",
  "order_flow_summary",
]);

const SUPPORT_RESISTANCE_TOPOLOGY_KNOWN_FIELDS = new Set([
  "levels",
  "density_field",
]);

const SR_LEVEL_KNOWN_FIELDS = new Set([
  "price",
  "strength",
  "touch_count",
  "distance_pips",
  "type",
]);

const INDICATOR_PROFILE_KNOWN_FIELDS = new Set([
  "rsi",
  "macd_histogram",
  "atr_percentile",
  "bollinger_position",
]);

const ORDER_FLOW_SUMMARY_KNOWN_FIELDS = new Set([
  "net_flow",
  "buy_pressure",
  "sell_pressure",
  "imbalance_ratio",
]);

// =============================================================================
// Field Validators
// =============================================================================

function checkUnknownFields(
  obj: Record<string, unknown>,
  knownFields: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!knownFields.has(key)) {
      throw new FingerprintParseError(
        `${path}.${key}`,
        `Unexpected field '${key}'`,
      );
    }
  }
}

function requireField(
  obj: Record<string, unknown>,
  field: string,
  path?: string,
): unknown {
  if (!(field in obj)) {
    const fullPath = path ? `${path}.${field}` : field;
    throw new FingerprintParseError(fullPath, "Required field is missing");
  }
  return obj[field];
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  path?: string,
): string {
  const value = requireField(obj, field, path);
  const fullPath = path ? `${path}.${field}` : field;
  if (typeof value !== "string") {
    throw new FingerprintParseError(
      fullPath,
      `Expected string, got ${typeDescription(value)}`,
    );
  }
  return value;
}

function requireNumber(
  obj: Record<string, unknown>,
  field: string,
  path?: string,
): number {
  const value = requireField(obj, field, path);
  const fullPath = path ? `${path}.${field}` : field;
  if (typeof value !== "number" || !isFinite(value)) {
    throw new FingerprintParseError(
      fullPath,
      `Expected finite number, got ${typeDescription(value)}`,
    );
  }
  return value;
}

function requireNumberArray(
  obj: Record<string, unknown>,
  field: string,
  path?: string,
): number[] {
  const value = requireField(obj, field, path);
  const fullPath = path ? `${path}.${field}` : field;
  if (!Array.isArray(value)) {
    throw new FingerprintParseError(
      fullPath,
      `Expected array, got ${typeDescription(value)}`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "number" || !isFinite(value[i])) {
      throw new FingerprintParseError(
        `${fullPath}[${i}]`,
        `Expected finite number, got ${typeDescription(value[i])}`,
      );
    }
  }
  return value as number[];
}

function requireObject(
  obj: Record<string, unknown>,
  field: string,
  path?: string,
): Record<string, unknown> {
  const value = requireField(obj, field, path);
  const fullPath = path ? `${path}.${field}` : field;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FingerprintParseError(
      fullPath,
      `Expected object, got ${typeDescription(value)}`,
    );
  }
  return value as Record<string, unknown>;
}

function requireNullableNumber(
  obj: Record<string, unknown>,
  field: string,
  path?: string,
): number | null {
  const value = requireField(obj, field, path);
  const fullPath = path ? `${path}.${field}` : field;
  if (value === null) return null;
  if (typeof value !== "number" || !isFinite(value)) {
    throw new FingerprintParseError(
      fullPath,
      `Expected finite number or null, got ${typeDescription(value)}`,
    );
  }
  return value;
}

// =============================================================================
// Composite Parsers
// =============================================================================

function parseOHLC(parent: Record<string, unknown>): OHLC {
  const obj = requireObject(parent, "ohlc");
  checkUnknownFields(obj, OHLC_KNOWN_FIELDS, "ohlc");
  return {
    open: requireNumber(obj, "open", "ohlc"),
    high: requireNumber(obj, "high", "ohlc"),
    low: requireNumber(obj, "low", "ohlc"),
    close: requireNumber(obj, "close", "ohlc"),
  };
}

function parseReturnProfile(
  parent: Record<string, unknown>,
): Fingerprint["return_profile"] {
  const obj = requireObject(parent, "return_profile");
  checkUnknownFields(obj, RETURN_PROFILE_KNOWN_FIELDS, "return_profile");
  return {
    net_return_pips: requireNumber(obj, "net_return_pips", "return_profile"),
    range_pips: requireNumber(obj, "range_pips", "return_profile"),
  };
}

function parseRegime(parent: Record<string, unknown>): RegimeClassification {
  const obj = requireObject(parent, "regime");
  checkUnknownFields(obj, REGIME_KNOWN_FIELDS, "regime");

  const volatility_regime = requireString(obj, "volatility_regime", "regime");
  if (!["LOW", "NORMAL", "HIGH"].includes(volatility_regime)) {
    throw new FingerprintParseError(
      "regime.volatility_regime",
      `Expected one of LOW, NORMAL, HIGH; got '${volatility_regime}'`,
    );
  }

  const trend_regime = requireString(obj, "trend_regime", "regime");
  if (!["BULLISH", "BEARISH", "RANGING"].includes(trend_regime)) {
    throw new FingerprintParseError(
      "regime.trend_regime",
      `Expected one of BULLISH, BEARISH, RANGING; got '${trend_regime}'`,
    );
  }

  const session = requireString(obj, "session", "regime");
  if (!["ASIA", "LONDON", "NY"].includes(session)) {
    throw new FingerprintParseError(
      "regime.session",
      `Expected one of ASIA, LONDON, NY; got '${session}'`,
    );
  }

  return {
    volatility_regime: volatility_regime as RegimeClassification["volatility_regime"],
    trend_regime: trend_regime as RegimeClassification["trend_regime"],
    session: session as RegimeClassification["session"],
  };
}

function parseStateLayers(
  parent: Record<string, unknown>,
): Fingerprint["state_layers"] {
  const obj = requireObject(parent, "state_layers");
  checkUnknownFields(obj, STATE_LAYERS_KNOWN_FIELDS, "state_layers");
  return {
    market_structure: requireNumberArray(obj, "market_structure", "state_layers"),
    volatility_profile: requireNumberArray(obj, "volatility_profile", "state_layers"),
    liquidity_field: requireNumberArray(obj, "liquidity_field", "state_layers"),
    macro_context: requireNumberArray(obj, "macro_context", "state_layers"),
    sentiment_pressure: requireNumberArray(obj, "sentiment_pressure", "state_layers"),
  };
}

function parseNormalisation(
  parent: Record<string, unknown>,
): Fingerprint["normalisation"] {
  const obj = requireObject(parent, "normalisation");
  checkUnknownFields(obj, NORMALISATION_KNOWN_FIELDS, "normalisation");
  return {
    quantile_table_version: requireString(
      obj,
      "quantile_table_version",
      "normalisation",
    ),
    scaling_method: requireString(obj, "scaling_method", "normalisation"),
  };
}

function parseExtendedState(
  parent: Record<string, unknown>,
): Fingerprint["extended_state"] | undefined {
  if (!("extended_state" in parent)) {
    return undefined;
  }

  const value = parent.extended_state;
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FingerprintParseError(
      "extended_state",
      `Expected object or undefined, got ${typeDescription(value)}`,
    );
  }

  const obj = value as Record<string, unknown>;
  checkUnknownFields(obj, EXTENDED_STATE_KNOWN_FIELDS, "extended_state");

  const result: NonNullable<Fingerprint["extended_state"]> = {};

  if ("support_resistance_topology" in obj) {
    result.support_resistance_topology = parseSupportResistanceTopology(
      obj.support_resistance_topology,
    );
  }

  if ("indicator_profile" in obj) {
    result.indicator_profile = parseIndicatorProfile(obj.indicator_profile);
  }

  if ("order_flow_summary" in obj) {
    result.order_flow_summary = parseOrderFlowSummary(obj.order_flow_summary);
  }

  return result;
}

function parseSupportResistanceTopology(
  value: unknown,
): SupportResistanceTopology {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FingerprintParseError(
      "extended_state.support_resistance_topology",
      `Expected object, got ${typeDescription(value)}`,
    );
  }

  const obj = value as Record<string, unknown>;
  checkUnknownFields(
    obj,
    SUPPORT_RESISTANCE_TOPOLOGY_KNOWN_FIELDS,
    "extended_state.support_resistance_topology",
  );

  // Parse levels array
  const levelsField = requireField(
    obj,
    "levels",
    "extended_state.support_resistance_topology",
  );
  if (!Array.isArray(levelsField)) {
    throw new FingerprintParseError(
      "extended_state.support_resistance_topology.levels",
      `Expected array, got ${typeDescription(levelsField)}`,
    );
  }

  const levels = levelsField.map((item, i) => {
    const path = `extended_state.support_resistance_topology.levels[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new FingerprintParseError(path, `Expected object, got ${typeDescription(item)}`);
    }
    const levelObj = item as Record<string, unknown>;
    checkUnknownFields(levelObj, SR_LEVEL_KNOWN_FIELDS, path);

    const type = requireString(levelObj, "type", path);
    if (!["support", "resistance", "flip_zone"].includes(type)) {
      throw new FingerprintParseError(
        `${path}.type`,
        `Expected one of support, resistance, flip_zone; got '${type}'`,
      );
    }

    return {
      price: requireNumber(levelObj, "price", path),
      strength: requireNumber(levelObj, "strength", path),
      touch_count: requireNumber(levelObj, "touch_count", path),
      distance_pips: requireNumber(levelObj, "distance_pips", path),
      type: type as "support" | "resistance" | "flip_zone",
    };
  });

  // Parse density_field
  const densityPath = "extended_state.support_resistance_topology";
  const densityObj = obj as Record<string, unknown>;
  const density_field_value = requireField(densityObj, "density_field", densityPath);
  if (!Array.isArray(density_field_value)) {
    throw new FingerprintParseError(
      `${densityPath}.density_field`,
      `Expected array, got ${typeDescription(density_field_value)}`,
    );
  }
  for (let i = 0; i < density_field_value.length; i++) {
    if (typeof density_field_value[i] !== "number" || !isFinite(density_field_value[i])) {
      throw new FingerprintParseError(
        `${densityPath}.density_field[${i}]`,
        `Expected finite number, got ${typeDescription(density_field_value[i])}`,
      );
    }
  }

  return { levels, density_field: density_field_value as number[] };
}

function parseIndicatorProfile(value: unknown): IndicatorProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FingerprintParseError(
      "extended_state.indicator_profile",
      `Expected object, got ${typeDescription(value)}`,
    );
  }

  const obj = value as Record<string, unknown>;
  checkUnknownFields(
    obj,
    INDICATOR_PROFILE_KNOWN_FIELDS,
    "extended_state.indicator_profile",
  );

  return {
    rsi: requireNullableNumber(obj, "rsi", "extended_state.indicator_profile"),
    macd_histogram: requireNullableNumber(
      obj,
      "macd_histogram",
      "extended_state.indicator_profile",
    ),
    atr_percentile: requireNullableNumber(
      obj,
      "atr_percentile",
      "extended_state.indicator_profile",
    ),
    bollinger_position: requireNullableNumber(
      obj,
      "bollinger_position",
      "extended_state.indicator_profile",
    ),
  };
}

function parseOrderFlowSummary(value: unknown): OrderFlowSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FingerprintParseError(
      "extended_state.order_flow_summary",
      `Expected object, got ${typeDescription(value)}`,
    );
  }

  const obj = value as Record<string, unknown>;
  checkUnknownFields(
    obj,
    ORDER_FLOW_SUMMARY_KNOWN_FIELDS,
    "extended_state.order_flow_summary",
  );

  return {
    net_flow: requireNumber(obj, "net_flow", "extended_state.order_flow_summary"),
    buy_pressure: requireNumber(
      obj,
      "buy_pressure",
      "extended_state.order_flow_summary",
    ),
    sell_pressure: requireNumber(
      obj,
      "sell_pressure",
      "extended_state.order_flow_summary",
    ),
    imbalance_ratio: requireNumber(
      obj,
      "imbalance_ratio",
      "extended_state.order_flow_summary",
    ),
  };
}

// =============================================================================
// Utilities
// =============================================================================

function typeDescription(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
