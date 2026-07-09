/**
 * Unit tests for CLI argument parsing and asset validation.
 * Tests the parseArgs function and the asset registry validation logic
 * from scripts/bootstrap-asset.ts.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseArgs } from '../../bootstrap/cli-helpers.js';
import { getAssetBySymbol, AssetStatus, AssetClass } from '../../config/research-assets.js';
import type { ResearchAsset } from '../../config/research-assets.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock process.exit to capture exit calls without actually exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit called with ${code}`);
}) as any);

// Mock console.error to capture error messages
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

// ─── parseArgs Tests ─────────────────────────────────────────────────────────

describe('parseArgs', () => {
  beforeEach(() => {
    mockExit.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleError.mockClear();
  });

  it('returns correct CliArgs when both --asset and --csv provided', () => {
    const result = parseArgs(['--asset', 'GBPUSD', '--csv', '/path/to/file.csv']);

    expect(result).toEqual({ asset: 'GBPUSD', csv: '/path/to/file.csv' });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('handles arguments in any order', () => {
    const result = parseArgs(['--csv', '/data/eurusd.csv', '--asset', 'EURUSD']);

    expect(result).toEqual({ asset: 'EURUSD', csv: '/data/eurusd.csv' });
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('calls process.exit(1) when --asset is missing', () => {
    expect(() => parseArgs(['--csv', '/path/to/file.csv'])).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) when --csv is missing', () => {
    expect(() => parseArgs(['--asset', 'GBPUSD'])).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) when both arguments are missing', () => {
    expect(() => parseArgs([])).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('outputs usage message when --asset is missing', () => {
    expect(() => parseArgs(['--csv', '/path/to/file.csv'])).toThrow('process.exit');

    const errorOutput = mockConsoleError.mock.calls.map(c => c[0]).join('\n');
    expect(errorOutput).toContain('--asset');
    expect(errorOutput).toContain('Usage');
  });

  it('outputs usage message when --csv is missing', () => {
    expect(() => parseArgs(['--asset', 'GBPUSD'])).toThrow('process.exit');

    const errorOutput = mockConsoleError.mock.calls.map(c => c[0]).join('\n');
    expect(errorOutput).toContain('--csv');
    expect(errorOutput).toContain('Usage');
  });

  it('outputs both missing args when neither provided', () => {
    expect(() => parseArgs([])).toThrow('process.exit');

    const errorOutput = mockConsoleError.mock.calls.map(c => c[0]).join('\n');
    expect(errorOutput).toContain('--asset');
    expect(errorOutput).toContain('--csv');
  });
});

// ─── Asset Validation Tests ──────────────────────────────────────────────────

describe('Asset validation logic', () => {
  beforeEach(() => {
    mockExit.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleError.mockClear();
  });

  /**
   * Helper that simulates the asset validation logic from main() in bootstrap-asset.ts.
   * We extract this pattern here to test it in isolation without running the full pipeline.
   */
  function validateAsset(
    asset: string,
    getAssetFn: (symbol: string) => ResearchAsset | undefined
  ): void {
    const assetConfig = getAssetFn(asset);

    if (!assetConfig) {
      console.error(
        `[Bootstrap] ERROR: Asset "${asset}" not found in RESEARCH_ASSETS registry.`
      );
      console.error(
        `[Bootstrap] Please add the asset to src/config/research-assets.ts before running the bootstrap.`
      );
      process.exit(1);
    }

    if (assetConfig.status === AssetStatus.DISABLED) {
      console.error(
        `[Bootstrap] ERROR: Asset "${asset}" has status DISABLED. Cannot bootstrap a disabled asset.`
      );
      process.exit(1);
    }

    if (assetConfig.status === AssetStatus.DEPRECATED) {
      console.error(
        `[Bootstrap] ERROR: Asset "${asset}" has status DEPRECATED. Cannot bootstrap a deprecated asset.`
      );
      process.exit(1);
    }
  }

  function createMockAsset(overrides: Partial<ResearchAsset> = {}): ResearchAsset {
    return {
      id: 'testasset',
      symbol: 'TESTASSET',
      assetClass: AssetClass.FOREX,
      status: AssetStatus.ACTIVE,
      processingPriority: 1,
      pipSize: 0.0001,
      pricePrecision: 5,
      marketHours: '24x5',
      supportedTimeframes: ['4H'],
      providers: { twelveData: 'TEST/ASSET' },
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

  it('exits with error when asset symbol is not found in registry', () => {
    const mockGetAsset = vi.fn().mockReturnValue(undefined);

    expect(() => validateAsset('UNKNOWN', mockGetAsset)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);

    const errorOutput = mockConsoleError.mock.calls.map(c => c[0]).join('\n');
    expect(errorOutput).toContain('not found in RESEARCH_ASSETS registry');
    expect(errorOutput).toContain('add the asset to src/config/research-assets.ts');
  });

  it('exits with error when asset has status DISABLED', () => {
    const disabledAsset = createMockAsset({
      symbol: 'DISABLED1',
      status: AssetStatus.DISABLED,
    });
    const mockGetAsset = vi.fn().mockReturnValue(disabledAsset);

    expect(() => validateAsset('DISABLED1', mockGetAsset)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);

    const errorOutput = mockConsoleError.mock.calls.map(c => c[0]).join('\n');
    expect(errorOutput).toContain('DISABLED');
    expect(errorOutput).toContain('Cannot bootstrap a disabled asset');
  });

  it('exits with error when asset has status DEPRECATED', () => {
    const deprecatedAsset = createMockAsset({
      symbol: 'DEPRECATED1',
      status: AssetStatus.DEPRECATED,
    });
    const mockGetAsset = vi.fn().mockReturnValue(deprecatedAsset);

    expect(() => validateAsset('DEPRECATED1', mockGetAsset)).toThrow('process.exit');
    expect(mockExit).toHaveBeenCalledWith(1);

    const errorOutput = mockConsoleError.mock.calls.map(c => c[0]).join('\n');
    expect(errorOutput).toContain('DEPRECATED');
    expect(errorOutput).toContain('Cannot bootstrap a deprecated asset');
  });

  it('proceeds without error when asset has status ACTIVE', () => {
    const activeAsset = createMockAsset({
      symbol: 'GBPUSD',
      status: AssetStatus.ACTIVE,
    });
    const mockGetAsset = vi.fn().mockReturnValue(activeAsset);

    // Should not throw
    validateAsset('GBPUSD', mockGetAsset);

    expect(mockExit).not.toHaveBeenCalled();
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it('proceeds without error when asset has status BETA', () => {
    const betaAsset = createMockAsset({
      symbol: 'AUDUSD',
      status: AssetStatus.BETA,
    });
    const mockGetAsset = vi.fn().mockReturnValue(betaAsset);

    // Should not throw
    validateAsset('AUDUSD', mockGetAsset);

    expect(mockExit).not.toHaveBeenCalled();
    expect(mockConsoleError).not.toHaveBeenCalled();
  });

  it('validates real EURUSD asset from registry proceeds without error', () => {
    // Use the real getAssetBySymbol to verify EURUSD (ACTIVE) works
    validateAsset('EURUSD', getAssetBySymbol);

    expect(mockExit).not.toHaveBeenCalled();
  });
});
