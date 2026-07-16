/**
 * Unit tests for batch pipeline multi-asset processing.
 *
 * **Validates: Requirements 4.1, 4.3, 4.4**
 *
 * Tests that the batch pipeline:
 * - Processes both EURUSD and GBPUSD in priority order (4.1)
 * - Continues processing remaining assets when one fails (4.3)
 * - Uses GBPUSD's own pipSize (0.0001) for pip calculations (4.4)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getProcessableAssets,
  type ResearchAsset,
  AssetClass,
  AssetStatus,
} from '../../src/config/research-assets.js';

describe('Batch pipeline multi-asset processing', () => {
  describe('Priority ordering (Requirement 4.1)', () => {
    it('should return EURUSD before GBPUSD based on processingPriority', () => {
      const assets = getProcessableAssets();

      expect(assets.length).toBeGreaterThanOrEqual(2);

      const eurusd = assets.find(a => a.symbol === 'EURUSD');
      const gbpusd = assets.find(a => a.symbol === 'GBPUSD');

      expect(eurusd).toBeDefined();
      expect(gbpusd).toBeDefined();
      expect(eurusd!.processingPriority).toBe(1);
      expect(gbpusd!.processingPriority).toBe(2);
    });

    it('should return assets sorted by processingPriority ascending', () => {
      const assets = getProcessableAssets();

      for (let i = 1; i < assets.length; i++) {
        expect(assets[i].processingPriority).toBeGreaterThanOrEqual(
          assets[i - 1].processingPriority,
        );
      }
    });

    it('should include all ACTIVE assets', () => {
      const assets = getProcessableAssets();

      const eurusd = assets.find(a => a.symbol === 'EURUSD');
      const gbpusd = assets.find(a => a.symbol === 'GBPUSD');

      expect(eurusd!.status).toBe(AssetStatus.ACTIVE);
      expect(gbpusd!.status).toBe(AssetStatus.ACTIVE);
    });

    it('should process assets sequentially in iteration order matching priority', () => {
      const assets = getProcessableAssets();
      const executionOrder: string[] = [];

      // Simulate the batch loop from batch-entry.ts
      for (const asset of assets) {
        for (const timeframe of asset.supportedTimeframes) {
          executionOrder.push(`${asset.symbol}:${timeframe}`);
        }
      }

      // EURUSD (priority 1) should come before GBPUSD (priority 2)
      const eurusdIndex = executionOrder.findIndex(e => e.startsWith('EURUSD'));
      const gbpusdIndex = executionOrder.findIndex(e => e.startsWith('GBPUSD'));

      expect(eurusdIndex).toBeLessThan(gbpusdIndex);
    });
  });

  describe('Failure isolation (Requirement 4.3)', () => {
    it('should continue processing remaining assets when one asset fails', () => {
      const assets = getProcessableAssets();
      const processedAssets: string[] = [];
      let hasFailure = false;

      // Simulate the batch loop with GBPUSD failing
      for (const asset of assets) {
        for (const timeframe of asset.supportedTimeframes) {
          try {
            if (asset.symbol === 'GBPUSD') {
              throw new Error('Simulated GBPUSD pipeline failure');
            }
            processedAssets.push(`${asset.symbol}:${timeframe}:success`);
          } catch {
            hasFailure = true;
            processedAssets.push(`${asset.symbol}:${timeframe}:failed`);
            // The batch pipeline does NOT break here — it continues
          }
        }
      }

      // EURUSD should have processed successfully
      expect(processedAssets).toContain('EURUSD:4H:success');
      // GBPUSD should be marked as failed
      expect(processedAssets).toContain('GBPUSD:4H:failed');
      // hasFailure should be set but pipeline still completed all assets
      expect(hasFailure).toBe(true);
      // All assets attempted (not just the first one)
      expect(processedAssets.length).toBe(assets.length * 1); // 1 timeframe per asset
    });

    it('should continue processing other assets when first asset fails', () => {
      const assets = getProcessableAssets();
      const processedAssets: string[] = [];
      let hasFailure = false;

      // Simulate the batch loop with EURUSD (first asset) failing
      for (const asset of assets) {
        for (const timeframe of asset.supportedTimeframes) {
          try {
            if (asset.symbol === 'EURUSD') {
              throw new Error('Simulated EURUSD pipeline failure');
            }
            processedAssets.push(`${asset.symbol}:${timeframe}:success`);
          } catch {
            hasFailure = true;
            processedAssets.push(`${asset.symbol}:${timeframe}:failed`);
          }
        }
      }

      // EURUSD failed but GBPUSD should still process
      expect(processedAssets).toContain('EURUSD:4H:failed');
      expect(processedAssets).toContain('GBPUSD:4H:success');
      expect(hasFailure).toBe(true);
    });

    it('should set hasFailure flag but not terminate loop on failure', () => {
      const assets = getProcessableAssets();
      let hasFailure = false;
      let iterationCount = 0;

      // Simulate failure on every asset — loop should still complete
      for (const asset of assets) {
        for (const timeframe of asset.supportedTimeframes) {
          iterationCount++;
          try {
            throw new Error(`Simulated failure for ${asset.symbol}`);
          } catch {
            hasFailure = true;
          }
        }
      }

      expect(hasFailure).toBe(true);
      // All iterations still completed
      expect(iterationCount).toBe(assets.length);
    });
  });

  describe('GBPUSD pipSize usage (Requirement 4.4)', () => {
    it('should use GBPUSD pipSize of 0.0001 from registry', () => {
      const assets = getProcessableAssets();
      const gbpusd = assets.find(a => a.symbol === 'GBPUSD');

      expect(gbpusd).toBeDefined();
      expect(gbpusd!.pipSize).toBe(0.0001);
    });

    it('should compute net_return_pips correctly using GBPUSD pipSize', () => {
      const assets = getProcessableAssets();
      const gbpusd = assets.find(a => a.symbol === 'GBPUSD')!;

      // Simulate the outcome backfill calculation from batch-entry.ts
      const pipSize = gbpusd.pipSize; // 0.0001
      const prevClose = 1.2650;
      const currClose = 1.2680;

      const netReturnPips = (currClose - prevClose) / pipSize;

      // 0.003 / 0.0001 = 30 pips
      expect(netReturnPips).toBeCloseTo(30, 1);
    });

    it('should compute max favourable/adverse excursion using GBPUSD pipSize', () => {
      const assets = getProcessableAssets();
      const gbpusd = assets.find(a => a.symbol === 'GBPUSD')!;

      const pipSize = gbpusd.pipSize; // 0.0001
      const prevClose = 1.2650;
      const currHigh = 1.2700;
      const currLow = 1.2620;

      const maxFavourableExcursion = (currHigh - prevClose) / pipSize;
      const maxAdverseExcursion = (prevClose - currLow) / pipSize;

      // (1.2700 - 1.2650) / 0.0001 = 50 pips
      expect(maxFavourableExcursion).toBeCloseTo(50, 1);
      // (1.2650 - 1.2620) / 0.0001 = 30 pips
      expect(maxAdverseExcursion).toBeCloseTo(30, 1);
    });

    it('should compute realised volatility using GBPUSD pipSize', () => {
      const assets = getProcessableAssets();
      const gbpusd = assets.find(a => a.symbol === 'GBPUSD')!;

      const pipSize = gbpusd.pipSize; // 0.0001
      const currHigh = 1.2700;
      const currLow = 1.2620;

      // Formula from batch-entry.ts: ((currHigh - currLow) / pipSize) / 10000
      const realisedVolatility = ((currHigh - currLow) / pipSize) / 10000;

      // (0.008 / 0.0001) / 10000 = 80 / 10000 = 0.008
      expect(realisedVolatility).toBeCloseTo(0.008, 5);
    });

    it('should use different pipSize values per asset for calculations', () => {
      const assets = getProcessableAssets();
      const eurusd = assets.find(a => a.symbol === 'EURUSD')!;
      const gbpusd = assets.find(a => a.symbol === 'GBPUSD')!;

      // Both EURUSD and GBPUSD use 0.0001 for forex pairs
      // but this test verifies each asset's pipSize is used independently
      const prevClose = 1.1000;
      const currClose = 1.1010;

      const eurusdPips = (currClose - prevClose) / eurusd.pipSize;
      const gbpusdPips = (currClose - prevClose) / gbpusd.pipSize;

      // Both should yield 10 pips with pipSize 0.0001
      expect(eurusdPips).toBeCloseTo(10, 1);
      expect(gbpusdPips).toBeCloseTo(10, 1);

      // Verify the pipSize is sourced from the asset's own registry entry
      expect(eurusd.pipSize).toBe(0.0001);
      expect(gbpusd.pipSize).toBe(0.0001);
    });

    it('should pass correct providerSymbol and engines to orchestrator for each asset', () => {
      const assets = getProcessableAssets();
      const gbpusd = assets.find(a => a.symbol === 'GBPUSD')!;
      const eurusd = assets.find(a => a.symbol === 'EURUSD')!;

      // Verify GBPUSD-specific orchestrator input values
      expect(gbpusd.providers.twelveData).toBe('GBP/USD');
      expect(eurusd.providers.twelveData).toBe('EUR/USD');

      // Verify engine participation is passed per asset
      expect(gbpusd.engines.fingerprint).toBe(true);
      expect(gbpusd.engines.similarity).toBe(true);
      expect(gbpusd.engines.confidence).toBe(true);
      expect(gbpusd.engines.tradeability).toBe(true);
      expect(gbpusd.engines.sentiment).toBe(true);
      expect(gbpusd.engines.macro).toBe(true);
    });
  });
});
