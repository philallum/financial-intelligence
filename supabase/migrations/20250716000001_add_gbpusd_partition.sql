-- Migration: Add GBPUSD partition for market_fingerprints
-- Required for onboarding GBPUSD as the second currency pair.
-- The market_fingerprints table uses LIST partitioning by asset column.
-- Requirements: 1.1 (GBPUSD registry entry), 3.1 (fingerprint storage)

-- Create partition for GBPUSD fingerprints
CREATE TABLE IF NOT EXISTS market_fingerprints_gbpusd PARTITION OF market_fingerprints
    FOR VALUES IN ('GBPUSD');
