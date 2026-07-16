/** Asset class classification */
export enum AssetClass {
  FOREX = 'FOREX',
  INDICES = 'INDICES',
  CRYPTO = 'CRYPTO',
  COMMODITIES = 'COMMODITIES',
  BONDS = 'BONDS',
}

/** Asset lifecycle status */
export enum AssetStatus {
  ACTIVE = 'ACTIVE',
  BETA = 'BETA',
  DISABLED = 'DISABLED',
  DEPRECATED = 'DEPRECATED',
}

/** Provider symbol mapping — twelveData is always required */
export interface ProviderMap {
  readonly twelveData: string; // 3–15 chars, e.g. "EUR/USD"
  readonly massive?: string;
  readonly yahoo?: string;
}

/** Boolean map declaring which engines process this asset */
export interface EngineParticipationMap {
  readonly fingerprint: boolean;
  readonly similarity: boolean;
  readonly confidence: boolean;
  readonly tradeability: boolean;
  readonly sentiment: boolean;
  readonly macro: boolean;
}

/** Full asset definition */
export interface ResearchAsset {
  readonly id: string;                      // lowercase alphanumeric slug, unique
  readonly symbol: string;                  // 3–10 uppercase alphanumeric, unique
  readonly assetClass: AssetClass;
  readonly status: AssetStatus;
  readonly processingPriority: number;      // positive integer >= 1
  readonly pipSize: number;                 // 0.000001 – 1
  readonly pricePrecision: number;          // 0 – 10 (integer)
  readonly marketHours: string;             // e.g. "24x5", "24x7"
  readonly supportedTimeframes: readonly string[]; // non-empty
  readonly providers: ProviderMap;
  readonly engines: EngineParticipationMap;
}

/**
 * Runtime assertion executed when the module is first imported.
 * Throws on duplicate id or symbol — fail-fast at startup.
 */
export function assertNoDuplicates(assets: readonly ResearchAsset[]): void {
  const ids = new Set<string>();
  const symbols = new Set<string>();

  for (const asset of assets) {
    if (ids.has(asset.id)) {
      throw new Error(`[ResearchAssetRegistry] Duplicate id: "${asset.id}"`);
    }
    if (symbols.has(asset.symbol)) {
      throw new Error(`[ResearchAssetRegistry] Duplicate symbol: "${asset.symbol}"`);
    }
    if (asset.supportedTimeframes.length === 0) {
      throw new Error(`[ResearchAssetRegistry] Asset "${asset.id}" has empty supportedTimeframes`);
    }
    ids.add(asset.id);
    symbols.add(asset.symbol);
  }
}

/**
 * The registry — single source of truth for all research assets.
 * Add new assets here. That's it. No other file changes needed.
 */
export const RESEARCH_ASSETS: readonly ResearchAsset[] = [
  {
    id: 'eurusd',
    symbol: 'EURUSD',
    assetClass: AssetClass.FOREX,
    status: AssetStatus.ACTIVE,
    processingPriority: 1,
    pipSize: 0.0001,
    pricePrecision: 5,
    marketHours: '24x5',
    supportedTimeframes: ['4H'],
    providers: { twelveData: 'EUR/USD' },
    engines: {
      fingerprint: true,
      similarity: true,
      confidence: true,
      tradeability: true,
      sentiment: true,
      macro: true,
    },
  },
  {
    id: 'gbpusd',
    symbol: 'GBPUSD',
    assetClass: AssetClass.FOREX,
    status: AssetStatus.ACTIVE,
    processingPriority: 2,
    pipSize: 0.0001,
    pricePrecision: 5,
    marketHours: '24x5',
    supportedTimeframes: ['4H'],
    providers: { twelveData: 'GBP/USD' },
    engines: {
      fingerprint: true,
      similarity: true,
      confidence: true,
      tradeability: true,
      sentiment: true,
      macro: true,
    },
  },
] as const;

// Execute validation at module initialization
assertNoDuplicates(RESEARCH_ASSETS);

// ─── Query Utilities ────────────────────────────────────────────────────────

/**
 * Returns all ACTIVE and BETA assets sorted by processingPriority ascending.
 * Used by the batch pipeline to determine what to process.
 */
export function getProcessableAssets(): ResearchAsset[] {
  return RESEARCH_ASSETS
    .filter(a => a.status === AssetStatus.ACTIVE || a.status === AssetStatus.BETA)
    .sort((a, b) => a.processingPriority - b.processingPriority);
}

/**
 * Returns symbols of all ACTIVE assets sorted by processingPriority ascending.
 * Used by API routes for request validation.
 */
export function getActiveSymbols(): string[] {
  return RESEARCH_ASSETS
    .filter(a => a.status === AssetStatus.ACTIVE)
    .sort((a, b) => a.processingPriority - b.processingPriority)
    .map(a => a.symbol);
}

/**
 * Case-insensitive lookup by id. Searches ALL statuses.
 */
export function getAssetById(id: string): ResearchAsset | undefined {
  const lower = id.toLowerCase();
  return RESEARCH_ASSETS.find(a => a.id === lower);
}

/**
 * Case-insensitive lookup by symbol. Searches ALL statuses.
 */
export function getAssetBySymbol(symbol: string): ResearchAsset | undefined {
  const upper = symbol.toUpperCase();
  return RESEARCH_ASSETS.find(a => a.symbol === upper);
}

/**
 * Returns ACTIVE asset symbols in alphabetical order for OpenAPI enum injection.
 */
export function getOpenApiAssetEnum(): string[] {
  return RESEARCH_ASSETS
    .filter(a => a.status === AssetStatus.ACTIVE)
    .map(a => a.symbol)
    .sort(); // alphabetical
}

/**
 * Returns processable (ACTIVE + BETA) assets of a given class, sorted by priority.
 */
export function getAssetsByClass(assetClass: AssetClass): ResearchAsset[] {
  return getProcessableAssets().filter(a => a.assetClass === assetClass);
}
