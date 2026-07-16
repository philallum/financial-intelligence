/**
 * Asset Persistence Module
 *
 * Encapsulates the pure logic for tab switching and asset state management.
 * The key invariant is that switching tabs never resets the selected asset —
 * asset state persists across tab switches within the same browser tab lifetime.
 *
 * This module extracts the core logic from dashboard/index.html for testability.
 */

export interface AssetConfig {
  symbol: string;
  displayName: string;
  baseCurrency: string;
  quoteCurrency: string;
}

export const ACTIVE_ASSETS: AssetConfig[] = [
  { symbol: 'EURUSD', displayName: 'EUR/USD', baseCurrency: 'EUR', quoteCurrency: 'USD' },
  { symbol: 'GBPUSD', displayName: 'GBP/USD', baseCurrency: 'GBP', quoteCurrency: 'USD' },
];

export type TabId = 'trader' | 'developer';

export interface DashboardState {
  selectedAsset: AssetConfig;
  activeTab: TabId;
}

/**
 * Pure function that computes the new dashboard state after a tab switch.
 * The selected asset is NEVER reset by a tab change — only the activeTab changes.
 */
export function switchTab(state: DashboardState, newTab: TabId): DashboardState {
  return {
    selectedAsset: state.selectedAsset,
    activeTab: newTab,
  };
}

/**
 * Pure function that computes the new dashboard state after an asset selection.
 */
export function selectAsset(state: DashboardState, newAsset: AssetConfig): DashboardState {
  return {
    selectedAsset: newAsset,
    activeTab: state.activeTab,
  };
}
