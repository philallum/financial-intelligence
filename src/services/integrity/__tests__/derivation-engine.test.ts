import { describe, it, expect, vi, beforeEach } from "vitest";
import { recomputeDerivations } from "../derivation-engine.js";
import type { DerivationInput } from "../types.js";
import type { ResearchAsset } from "../../../config/research-assets.js";
import { AssetClass, AssetStatus } from "../../../config/research-assets.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeAsset(overrides: Partial<ResearchAsset> = {}): ResearchAsset {
  return {
    id: "eurusd",
    symbol: "EURUSD",
    assetClass: AssetClass.FOREX,
    status: AssetStatus.ACTIVE,
    processingPriority: 1,
    pipSize: 0.0001,
    pricePrecision: 5,
    marketHours: "24x5",
    supportedTimeframes: ["4H"],
    providers: { twelveData: "EUR/USD" },
    engines: {
      fingerprint: true,
      similarity: true,
      confidence: true,
      tradeability: true,
      sentiment: false,
      macro: true,
    },
    ...overrides,
  };
}

function makeOHLC(close = 1.1) {
  return { open: 1.09, high: 1.12, low: 1.08, close };
}

/**
 * Creates a mock Supabase client that handles the various queries
 * the derivation engine makes.
 */
function createMockSupabase(options: {
  candles?: Record<string, { open: number; high: number; low: number; close: number }>;
  nextCandle?: { open: number; high: number; low: number; close: number } | null;
  precedingCandles?: Array<{ open: number; high: number; low: number; close: number }>;
  upsertError?: { message: string } | null;
}) {
  const {
    candles = {},
    nextCandle = makeOHLC(1.11),
    precedingCandles = [],
    upsertError = null,
  } = options;

  const mockSupabase = {
    from: vi.fn((table: string) => {
      if (table === "raw_candles") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockImplementation(async () => {
                    // Return the first candle in the candles map or a default
                    const keys = Object.keys(candles);
                    const ohlc = keys.length > 0 ? candles[keys[0]] : makeOHLC();
                    return { data: ohlc, error: null };
                  }),
                }),
                gt: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({
                        data: nextCandle,
                        error: null,
                      }),
                    }),
                  }),
                }),
                lte: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({
                      data: precedingCandles,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }

      // For market_fingerprints, market_outcomes, fingerprint_topology
      return {
        upsert: vi.fn().mockResolvedValue({ error: upsertError }),
      };
    }),
  };

  return mockSupabase as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("recomputeDerivations", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("empty input handling", () => {
    it("returns zero counts when newCandleTimestamps is empty", async () => {
      const supabase = createMockSupabase({});
      const input: DerivationInput = {
        asset: makeAsset(),
        timeframe: "4H",
        newCandleTimestamps: [],
      };

      const result = await recomputeDerivations(supabase, input);

      expect(result.fingerprintsGenerated).toBe(0);
      expect(result.outcomesComputed).toBe(0);
      expect(result.topologyComputed).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it("does not call supabase when newCandleTimestamps is empty", async () => {
      const supabase = createMockSupabase({});
      const input: DerivationInput = {
        asset: makeAsset(),
        timeframe: "4H",
        newCandleTimestamps: [],
      };

      await recomputeDerivations(supabase, input);

      expect(supabase.from).not.toHaveBeenCalled();
    });
  });

  describe("fingerprint stage", () => {
    it("generates fingerprints for each new candle timestamp", async () => {
      const supabase = createMockSupabase({
        candles: { default: makeOHLC() },
        nextCandle: null,
        precedingCandles: [],
      });
      const input: DerivationInput = {
        asset: makeAsset(),
        timeframe: "4H",
        newCandleTimestamps: [
          "2024-01-15T00:00:00.000Z",
          "2024-01-15T04:00:00.000Z",
        ],
      };

      const result = await recomputeDerivations(supabase, input);

      expect(result.fingerprintsGenerated).toBe(2);
    });

    it("continues processing other timestamps when one fingerprint fails", async () => {
      let callCount = 0;
      const supabase = {
        from: vi.fn((table: string) => {
          if (table === "raw_candles") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      single: vi.fn().mockImplementation(async () => {
                        callCount++;
                        if (callCount === 1) {
                          return { data: null, error: { message: "not found" } };
                        }
                        return { data: makeOHLC(), error: null };
                      }),
                    }),
                    gt: vi.fn().mockReturnValue({
                      order: vi.fn().mockReturnValue({
                        limit: vi.fn().mockReturnValue({
                          maybeSingle: vi.fn().mockResolvedValue({
                            data: null,
                            error: null,
                          }),
                        }),
                      }),
                    }),
                    lte: vi.fn().mockReturnValue({
                      order: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue({
                          data: [],
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return { upsert: vi.fn().mockResolvedValue({ error: null }) };
        }),
      } as any;

      const input: DerivationInput = {
        asset: makeAsset(),
        timeframe: "4H",
        newCandleTimestamps: [
          "2024-01-15T00:00:00.000Z",
          "2024-01-15T04:00:00.000Z",
        ],
      };

      const result = await recomputeDerivations(supabase, input);

      // First fingerprint fails, second succeeds
      expect(result.fingerprintsGenerated).toBe(1);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0].stage).toBe("fingerprint");
      expect(result.errors[0].timestamp).toBe("2024-01-15T00:00:00.000Z");
    });
  });

  describe("outcome stage", () => {
    it("skips outcome when no next candle exists", async () => {
      const supabase = createMockSupabase({
        candles: { default: makeOHLC() },
        nextCandle: null,
        precedingCandles: [],
      });
      const input: DerivationInput = {
        asset: makeAsset(),
        timeframe: "4H",
        newCandleTimestamps: ["2024-01-15T00:00:00.000Z"],
      };

      const result = await recomputeDerivations(supabase, input);

      expect(result.outcomesComputed).toBe(0);
    });

    it("computes outcome when next candle exists", async () => {
      const supabase = createMockSupabase({
        candles: { default: makeOHLC(1.1) },
        nextCandle: makeOHLC(1.11),
        precedingCandles: [],
      });
      const input: DerivationInput = {
        asset: makeAsset(),
        timeframe: "4H",
        newCandleTimestamps: ["2024-01-15T00:00:00.000Z"],
      };

      const result = await recomputeDerivations(supabase, input);

      expect(result.fingerprintsGenerated).toBe(1);
      expect(result.outcomesComputed).toBe(1);
    });
  });

  describe("topology stage", () => {
    it("skips topology when fewer than 30 preceding candles exist", async () => {
      const fewCandles = Array.from({ length: 10 }, () => makeOHLC());
      const supabase = createMockSupabase({
        candles: { default: makeOHLC() },
        nextCandle: makeOHLC(1.11),
        precedingCandles: fewCandles,
      });
      const input: DerivationInput = {
        asset: makeAsset(),
        timeframe: "4H",
        newCandleTimestamps: ["2024-01-15T00:00:00.000Z"],
      };

      const result = await recomputeDerivations(supabase, input);

      expect(result.topologyComputed).toBe(0);
    });

    it("computes topology when 30 or more preceding candles exist", async () => {
      const manyCandles = Array.from({ length: 35 }, (_, i) => ({
        open: 1.09 + i * 0.001,
        high: 1.12 + i * 0.001,
        low: 1.08 + i * 0.001,
        close: 1.1 + i * 0.001,
      }));
      const supabase = createMockSupabase({
        candles: { default: makeOHLC() },
        nextCandle: makeOHLC(1.11),
        precedingCandles: manyCandles,
      });
      const input: DerivationInput = {
        asset: makeAsset(),
        timeframe: "4H",
        newCandleTimestamps: ["2024-01-15T00:00:00.000Z"],
      };

      const result = await recomputeDerivations(supabase, input);

      expect(result.topologyComputed).toBe(1);
    });
  });

  describe("error accumulation (fail-forward)", () => {
    it("accumulates errors from all stages without halting", async () => {
      // Create a supabase mock that fails on fingerprint upsert for the first call
      // but succeeds for subsequent ones
      let upsertCallCount = 0;
      const supabase = {
        from: vi.fn((table: string) => {
          if (table === "raw_candles") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      single: vi.fn().mockResolvedValue({
                        data: makeOHLC(),
                        error: null,
                      }),
                    }),
                    gt: vi.fn().mockReturnValue({
                      order: vi.fn().mockReturnValue({
                        limit: vi.fn().mockReturnValue({
                          maybeSingle: vi.fn().mockResolvedValue({
                            data: null,
                            error: null,
                          }),
                        }),
                      }),
                    }),
                    lte: vi.fn().mockReturnValue({
                      order: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue({
                          data: [],
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          // Market fingerprints upsert - fail first time
          return {
            upsert: vi.fn().mockImplementation(async () => {
              upsertCallCount++;
              if (upsertCallCount === 1) {
                return { error: { message: "db write failed" } };
              }
              return { error: null };
            }),
          };
        }),
      } as any;

      const input: DerivationInput = {
        asset: makeAsset(),
        timeframe: "4H",
        newCandleTimestamps: [
          "2024-01-15T00:00:00.000Z",
          "2024-01-15T04:00:00.000Z",
        ],
      };

      const result = await recomputeDerivations(supabase, input);

      // At least one error occurred but processing continued
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      // The second timestamp should have succeeded for fingerprint
      expect(result.fingerprintsGenerated).toBe(1);
    });

    it("records correct stage in error details", async () => {
      const supabase = {
        from: vi.fn((table: string) => {
          if (table === "raw_candles") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      single: vi.fn().mockResolvedValue({
                        data: null,
                        error: { message: "candle fetch failed" },
                      }),
                    }),
                    gt: vi.fn().mockReturnValue({
                      order: vi.fn().mockReturnValue({
                        limit: vi.fn().mockReturnValue({
                          maybeSingle: vi.fn().mockResolvedValue({
                            data: null,
                            error: null,
                          }),
                        }),
                      }),
                    }),
                    lte: vi.fn().mockReturnValue({
                      order: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue({
                          data: [],
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return { upsert: vi.fn().mockResolvedValue({ error: null }) };
        }),
      } as any;

      const input: DerivationInput = {
        asset: makeAsset(),
        timeframe: "4H",
        newCandleTimestamps: ["2024-01-15T00:00:00.000Z"],
      };

      const result = await recomputeDerivations(supabase, input);

      // Should have errors in fingerprint and outcome stages (both need candle data)
      const fingerprintErrors = result.errors.filter((e) => e.stage === "fingerprint");
      const outcomeErrors = result.errors.filter((e) => e.stage === "outcome");

      expect(fingerprintErrors.length).toBe(1);
      expect(outcomeErrors.length).toBe(1);
      expect(fingerprintErrors[0].reason).toContain("candle fetch failed");
    });
  });

  describe("dependency ordering", () => {
    it("processes all fingerprints before any outcomes", async () => {
      const callOrder: string[] = [];
      const supabase = {
        from: vi.fn((table: string) => {
          if (table === "raw_candles") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      single: vi.fn().mockResolvedValue({
                        data: makeOHLC(),
                        error: null,
                      }),
                    }),
                    gt: vi.fn().mockReturnValue({
                      order: vi.fn().mockReturnValue({
                        limit: vi.fn().mockReturnValue({
                          maybeSingle: vi.fn().mockResolvedValue({
                            data: makeOHLC(1.11),
                            error: null,
                          }),
                        }),
                      }),
                    }),
                    lte: vi.fn().mockReturnValue({
                      order: vi.fn().mockReturnValue({
                        limit: vi.fn().mockResolvedValue({
                          data: Array.from({ length: 35 }, () => makeOHLC()),
                          error: null,
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          callOrder.push(table);
          return { upsert: vi.fn().mockResolvedValue({ error: null }) };
        }),
      } as any;

      const input: DerivationInput = {
        asset: makeAsset(),
        timeframe: "4H",
        newCandleTimestamps: [
          "2024-01-15T00:00:00.000Z",
          "2024-01-15T04:00:00.000Z",
        ],
      };

      await recomputeDerivations(supabase, input);

      // Verify ordering: all fingerprints before outcomes, all outcomes before topology
      const fingerprintIndices = callOrder
        .map((t, i) => (t === "market_fingerprints" ? i : -1))
        .filter((i) => i >= 0);
      const outcomeIndices = callOrder
        .map((t, i) => (t === "market_outcomes" ? i : -1))
        .filter((i) => i >= 0);
      const topologyIndices = callOrder
        .map((t, i) => (t === "fingerprint_topology" ? i : -1))
        .filter((i) => i >= 0);

      // All fingerprints should come before any outcomes
      if (fingerprintIndices.length > 0 && outcomeIndices.length > 0) {
        expect(Math.max(...fingerprintIndices)).toBeLessThan(
          Math.min(...outcomeIndices)
        );
      }

      // All outcomes should come before any topology
      if (outcomeIndices.length > 0 && topologyIndices.length > 0) {
        expect(Math.max(...outcomeIndices)).toBeLessThan(
          Math.min(...topologyIndices)
        );
      }
    });
  });
});
