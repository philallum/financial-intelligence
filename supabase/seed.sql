-- =============================================================================
-- Seed Data for Local Development
-- =============================================================================
-- Requirements: 2.1, 2.2 - API Key Management
--
-- This file populates the database with test customers, projects, API keys,
-- and subscriptions for local development and testing.
--
-- IMPORTANT: The key_hash values below are PLACEHOLDER Argon2id-format hashes.
-- They are NOT real hashes of actual keys. In production, keys are hashed at
-- creation time via the key-management service. These placeholders exist only
-- to satisfy the NOT NULL constraint and allow testing of the lookup/filtering
-- logic without requiring runtime hashing during seeding.
--
-- Placeholder hash format: $argon2id$v=19$m=65536,t=3,p=4$<base64-salt>$<base64-hash>
-- These will NOT verify against any real plaintext key.
-- =============================================================================

-- Clean up existing seed data (idempotent re-seeding)
TRUNCATE api_keys, subscriptions, projects, customers CASCADE;

-- =============================================================================
-- CUSTOMERS (one per tier)
-- =============================================================================

INSERT INTO customers (id, email, name, tier, created_at, updated_at) VALUES
  -- RETAIL tier customer
  ('a0000000-0000-0000-0000-000000000001', 'alice@example.com', 'Alice Retail', 'RETAIL', '2024-01-15 10:00:00+00', '2024-01-15 10:00:00+00'),
  -- DEVELOPER tier customer
  ('b0000000-0000-0000-0000-000000000002', 'bob@devshop.io', 'Bob Developer', 'DEVELOPER', '2024-02-01 12:00:00+00', '2024-02-01 12:00:00+00'),
  -- RESEARCH tier customer
  ('c0000000-0000-0000-0000-000000000003', 'carol@research-lab.org', 'Carol Research', 'RESEARCH', '2024-03-10 09:00:00+00', '2024-03-10 09:00:00+00'),
  -- INTERNAL tier customer (platform operator)
  ('d0000000-0000-0000-0000-000000000004', 'dave@internal.platform', 'Dave Internal', 'INTERNAL', '2024-01-01 00:00:00+00', '2024-01-01 00:00:00+00');

-- =============================================================================
-- PROJECTS (at least one per customer, mix of environments)
-- =============================================================================

INSERT INTO projects (id, customer_id, name, environment, is_active, created_at) VALUES
  -- Alice (RETAIL) - 1 project
  ('10000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Personal Trading', 'production', true, '2024-01-20 10:00:00+00'),

  -- Bob (DEVELOPER) - 2 projects (dev + prod)
  ('20000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'FX Dashboard', 'development', true, '2024-02-05 12:00:00+00'),
  ('20000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000002', 'FX Dashboard', 'production', true, '2024-02-10 12:00:00+00'),

  -- Carol (RESEARCH) - 2 projects (one active, one inactive for testing)
  ('30000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000003', 'Backtesting Engine', 'production', true, '2024-03-15 09:00:00+00'),
  ('30000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000003', 'Old Research Tool', 'staging', false, '2024-01-01 09:00:00+00'),

  -- Dave (INTERNAL) - 1 project
  ('40000000-0000-0000-0000-000000000006', 'd0000000-0000-0000-0000-000000000004', 'Platform Operations', 'production', true, '2024-01-01 00:00:00+00');

-- =============================================================================
-- API KEYS
-- =============================================================================
-- Covers every subscription plan (FREE, STARTER, PROFESSIONAL, ENTERPRISE).
-- Includes a mix of active and inactive (revoked) keys for testing revocation logic.
--
-- NOTE: key_hash values are TEST-ONLY placeholders in Argon2id format.
-- They will NOT verify against any real plaintext. Real hashes are generated
-- by the key-management service at runtime using argon2.hash().
-- =============================================================================

INSERT INTO api_keys (id, project_id, key_hash, name, description, subscription_plan, is_active, rate_limit_override, daily_usage, monthly_usage, last_reset, created_at, last_used_at) VALUES
  -- Alice (RETAIL) - FREE plan, active key
  (
    'aa000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1zYWx0LWFsaWNl$dGVzdC1oYXNoLWFsaWNlLWZyZWUtMDAxLXBsYWNlaG9sZGVy',
    'My Trading Key',
    'Primary key for personal trading alerts',
    'FREE',
    true,
    NULL,
    42,
    42,
    '2024-06-01 00:00:00+00',
    '2024-01-20 10:00:00+00',
    '2024-06-15 14:30:00+00'
  ),

  -- Alice (RETAIL) - FREE plan, REVOKED key (tests revocation logic)
  (
    'aa000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001',
    '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1zYWx0LWFsaWNl$dGVzdC1oYXNoLWFsaWNlLWZyZWUtMDAyLXJldm9rZWQtcGxh',
    'Old Key',
    'Revoked after suspected compromise',
    'FREE',
    false,
    NULL,
    0,
    87,
    '2024-05-01 00:00:00+00',
    '2024-01-25 10:00:00+00',
    '2024-05-20 08:00:00+00'
  ),

  -- Bob (DEVELOPER) - STARTER plan, dev environment key
  (
    'bb000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000002',
    '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1zYWx0LWJvYi0x$dGVzdC1oYXNoLWJvYi1zdGFydGVyLTAwMy1wbGFjZWhvbGRl',
    'Dev Local Key',
    'Local development and testing',
    'STARTER',
    true,
    NULL,
    0,
    1523,
    '2024-06-01 00:00:00+00',
    '2024-02-05 12:00:00+00',
    '2024-06-14 22:15:00+00'
  ),

  -- Bob (DEVELOPER) - STARTER plan, production key
  (
    'bb000000-0000-0000-0000-000000000004',
    '20000000-0000-0000-0000-000000000003',
    '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1zYWx0LWJvYi0y$dGVzdC1oYXNoLWJvYi1zdGFydGVyLTAwNC1wbGFjZWhvbGRl',
    'Prod Main Key',
    'Production application key',
    'STARTER',
    true,
    NULL,
    0,
    3847,
    '2024-06-01 00:00:00+00',
    '2024-02-10 12:00:00+00',
    '2024-06-15 16:45:00+00'
  ),

  -- Bob (DEVELOPER) - STARTER plan, REVOKED production key (tests revocation)
  (
    'bb000000-0000-0000-0000-000000000005',
    '20000000-0000-0000-0000-000000000003',
    '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1zYWx0LWJvYi0z$dGVzdC1oYXNoLWJvYi1zdGFydGVyLTAwNS1yZXZva2VkLXBs',
    'Prod Backup Key',
    'Rotated out during key rotation exercise',
    'STARTER',
    false,
    NULL,
    0,
    250,
    '2024-04-01 00:00:00+00',
    '2024-02-15 12:00:00+00',
    '2024-04-10 11:00:00+00'
  ),

  -- Carol (RESEARCH) - PROFESSIONAL plan, active key
  (
    'cc000000-0000-0000-0000-000000000006',
    '30000000-0000-0000-0000-000000000004',
    '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1zYWx0LWNhcm9s$dGVzdC1oYXNoLWNhcm9sLXByby0wMDYtcGxhY2Vob2xkZXJy',
    'Research Primary',
    'Main key for backtesting research',
    'PROFESSIONAL',
    true,
    NULL,
    0,
    18742,
    '2024-06-01 00:00:00+00',
    '2024-03-15 09:00:00+00',
    '2024-06-15 23:59:00+00'
  ),

  -- Carol (RESEARCH) - PROFESSIONAL plan, second active key
  (
    'cc000000-0000-0000-0000-000000000007',
    '30000000-0000-0000-0000-000000000004',
    '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1zYWx0LWNhcm9s$dGVzdC1oYXNoLWNhcm9sLXByby0wMDctcGxhY2Vob2xkZXJy',
    'Research CI Runner',
    'Automated test suite key',
    'PROFESSIONAL',
    true,
    NULL,
    0,
    5210,
    '2024-06-01 00:00:00+00',
    '2024-04-01 09:00:00+00',
    '2024-06-15 06:00:00+00'
  ),

  -- Dave (INTERNAL) - ENTERPRISE plan with custom rate limit override
  (
    'dd000000-0000-0000-0000-000000000008',
    '40000000-0000-0000-0000-000000000006',
    '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1zYWx0LWRhdmUx$dGVzdC1oYXNoLWRhdmUtZW50LTAwOC1wbGFjZWhvbGRlcnJy',
    'Ops Dashboard',
    'Internal operations dashboard key',
    'ENTERPRISE',
    true,
    100000,
    0,
    52341,
    '2024-06-01 00:00:00+00',
    '2024-01-01 00:00:00+00',
    '2024-06-15 23:59:59+00'
  ),

  -- Dave (INTERNAL) - ENTERPRISE plan, key without rate limit override (uses default)
  (
    'dd000000-0000-0000-0000-000000000009',
    '40000000-0000-0000-0000-000000000006',
    '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1zYWx0LWRhdmUy$dGVzdC1oYXNoLWRhdmUtZW50LTAwOS1wbGFjZWhvbGRlcnJy',
    'Monitoring Agent',
    'Health check and monitoring key',
    'ENTERPRISE',
    true,
    NULL,
    0,
    8900,
    '2024-06-01 00:00:00+00',
    '2024-01-05 00:00:00+00',
    '2024-06-15 12:00:00+00'
  ),

  -- Dave (INTERNAL) - ENTERPRISE plan, REVOKED key (tests revocation for internal)
  (
    'dd000000-0000-0000-0000-000000000010',
    '40000000-0000-0000-0000-000000000006',
    '$argon2id$v=19$m=65536,t=3,p=4$c2VlZC1zYWx0LWRhdmUz$dGVzdC1oYXNoLWRhdmUtZW50LTAxMC1yZXZva2VkLXBsYWNl',
    'Deprecated Script',
    'Used by old deployment script — revoked',
    'ENTERPRISE',
    false,
    50000,
    0,
    0,
    '2024-03-01 00:00:00+00',
    '2024-01-10 00:00:00+00',
    '2024-03-05 18:00:00+00'
  );

-- =============================================================================
-- SUBSCRIPTIONS (one per customer)
-- =============================================================================

INSERT INTO subscriptions (id, customer_id, plan, status, current_period_start, current_period_end, created_at) VALUES
  -- Alice - FREE plan, active
  (
    's0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    'FREE',
    'active',
    '2024-06-01 00:00:00+00',
    '2024-07-01 00:00:00+00',
    '2024-01-15 10:00:00+00'
  ),

  -- Bob - STARTER plan, active
  (
    's0000000-0000-0000-0000-000000000002',
    'b0000000-0000-0000-0000-000000000002',
    'STARTER',
    'active',
    '2024-06-01 00:00:00+00',
    '2024-07-01 00:00:00+00',
    '2024-02-01 12:00:00+00'
  ),

  -- Carol - PROFESSIONAL plan, active
  (
    's0000000-0000-0000-0000-000000000003',
    'c0000000-0000-0000-0000-000000000003',
    'PROFESSIONAL',
    'active',
    '2024-06-01 00:00:00+00',
    '2024-07-01 00:00:00+00',
    '2024-03-10 09:00:00+00'
  ),

  -- Dave - ENTERPRISE plan, active
  (
    's0000000-0000-0000-0000-000000000004',
    'd0000000-0000-0000-0000-000000000004',
    'ENTERPRISE',
    'active',
    '2024-06-01 00:00:00+00',
    '2024-07-01 00:00:00+00',
    '2024-01-01 00:00:00+00'
  );

-- =============================================================================
-- Summary of seed data:
--
-- Customers (4):
--   - Alice (RETAIL)     → 1 project, 2 keys (1 active FREE, 1 revoked FREE)
--   - Bob (DEVELOPER)    → 2 projects, 3 keys (2 active STARTER, 1 revoked STARTER)
--   - Carol (RESEARCH)   → 2 projects (1 inactive), 2 keys (both active PROFESSIONAL)
--   - Dave (INTERNAL)    → 1 project, 3 keys (2 active ENTERPRISE, 1 revoked ENTERPRISE)
--
-- Subscription Plans covered: FREE, STARTER, PROFESSIONAL, ENTERPRISE
-- Customer Tiers covered: RETAIL, DEVELOPER, RESEARCH, INTERNAL
--
-- Revocation testing:
--   - 4 revoked keys total (1 per tier/plan combination that has them)
--   - Active/inactive mix for testing is_active filtering
--
-- Rate limit testing:
--   - Keys with varying daily_usage and monthly_usage values
--   - One ENTERPRISE key with rate_limit_override = 100000
--   - One ENTERPRISE key with NULL rate_limit_override (uses default)
--
-- Environment testing:
--   - development, staging, production environments represented
--   - One inactive project for testing project deactivation
-- =============================================================================
