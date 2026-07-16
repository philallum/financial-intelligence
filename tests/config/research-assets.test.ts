import { describe, it, expect } from 'vitest';
import {
  AssetClass,
  AssetStatus,
  getAssetById,
  getAssetBySymbol,
  getProcessableAssets,
  getActiveSymbols,
  getOpenApiAssetEnum,
} from '../../src/config/research-assets.js';

describe('GBPUSD Registry Entry', () => {
  describe('getAssetById', () => {
    it('returns the correct GBPUSD entry by id', () => {
      const asset = getAssetById('gbpusd');
      expect(asset).toBeDefined();
      expect(asset!.id).toBe('gbpusd');
      expect(asset!.symbol).toBe('GBPUSD');
      expect(asset!.assetClass).toBe(AssetClass.FOREX);
      expect(asset!.status).toBe(AssetStatus.ACTIVE);
      expect(asset!.processingPriority).toBe(2);
      expect(asset!.pipSize).toBe(0.0001);
      expect(asset!.pricePrecision).toBe(5);
      expect(asset!.marketHours).toBe('24x5');
      expect(asset!.supportedTimeframes).toEqual(['4H']);
      expect(asset!.providers).toEqual({ twelveData: 'GBP/USD' });
      expect(asset!.engines).toEqual({
        fingerprint: true,
        similarity: true,
        confidence: true,
        tradeability: true,
        sentiment: true,
        macro: true,
      });
    });
  });

  describe('getAssetBySymbol', () => {
    it('returns the correct GBPUSD entry by symbol', () => {
      const asset = getAssetBySymbol('GBPUSD');
      expect(asset).toBeDefined();
      expect(asset!.id).toBe('gbpusd');
      expect(asset!.symbol).toBe('GBPUSD');
      expect(asset!.assetClass).toBe(AssetClass.FOREX);
      expect(asset!.status).toBe(AssetStatus.ACTIVE);
      expect(asset!.processingPriority).toBe(2);
      expect(asset!.pipSize).toBe(0.0001);
      expect(asset!.pricePrecision).toBe(5);
      expect(asset!.marketHours).toBe('24x5');
      expect(asset!.supportedTimeframes).toEqual(['4H']);
      expect(asset!.providers).toEqual({ twelveData: 'GBP/USD' });
    });
  });

  describe('getProcessableAssets', () => {
    it('returns both EURUSD and GBPUSD in priority order', () => {
      const assets = getProcessableAssets();
      expect(assets.length).toBeGreaterThanOrEqual(2);

      const eurusd = assets.find(a => a.id === 'eurusd');
      const gbpusd = assets.find(a => a.id === 'gbpusd');

      expect(eurusd).toBeDefined();
      expect(gbpusd).toBeDefined();

      // EURUSD (priority 1) should come before GBPUSD (priority 2)
      const eurusdIndex = assets.indexOf(eurusd!);
      const gbpusdIndex = assets.indexOf(gbpusd!);
      expect(eurusdIndex).toBeLessThan(gbpusdIndex);

      // Verify priority ordering
      expect(eurusd!.processingPriority).toBe(1);
      expect(gbpusd!.processingPriority).toBe(2);
    });
  });

  describe('getActiveSymbols', () => {
    it('includes GBPUSD now that it has ACTIVE status', () => {
      const symbols = getActiveSymbols();
      expect(symbols).toContain('EURUSD');
      expect(symbols).toContain('GBPUSD');
    });
  });

  describe('getOpenApiAssetEnum', () => {
    it('includes GBPUSD now that it has ACTIVE status', () => {
      const symbols = getOpenApiAssetEnum();
      expect(symbols).toContain('EURUSD');
      expect(symbols).toContain('GBPUSD');
    });
  });
});
