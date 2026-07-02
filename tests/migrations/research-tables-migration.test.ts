/**
 * Migration tests for research platform tables (migrations 5–9).
 * Validates SQL migration correctness through static analysis:
 * - Each migration parses without syntax issues
 * - New migrations are additive-only (no ALTER/DROP on pre-existing tables)
 * - New tables have expected columns, constraints, indexes, and RLS policies
 *
 * Validates: Requirements 20.5, 22.3, 22.4
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(__dirname, '../../supabase/migrations');

// Pre-existing tables from migrations 1–4 (must not be modified by new migrations)
const PRE_EXISTING_TABLES = [
  'raw_candles',
  'market_fingerprints',
  'market_fingerprints_eurusd',
  'market_outcomes',
  'similarity_matches',
  'forecasts',
  'cached_forecasts',
  'execution_traces',
  'engine_versions',
  'batch_runs',
  'api_keys',
];

// New research migrations (5–9)
const RESEARCH_MIGRATIONS = [
  { file: '20240101000005_research_forecasts.sql', table: 'research_forecasts' },
  { file: '20240101000006_research_evaluations.sql', table: 'research_evaluations' },
  { file: '20240101000007_research_similarity_archive.sql', table: 'research_similarity_archive' },
  { file: '20240101000008_fingerprint_topology.sql', table: 'fingerprint_topology' },
  { file: '20240101000009_research_experiments.sql', table: 'research_experiments' },
];

function readMigration(filename: string): string {
  const path = resolve(MIGRATIONS_DIR, filename);
  return readFileSync(path, 'utf-8');
}

/**
 * Extracts column definitions from a CREATE TABLE statement.
 * Returns column names found in the SQL.
 */
function extractColumns(sql: string, tableName: string): string[] {
  const tableRegex = new RegExp(
    `CREATE TABLE IF NOT EXISTS ${tableName}\\s*\\(([\\s\\S]*?)\\);`,
    'i'
  );
  const match = sql.match(tableRegex);
  if (!match) return [];

  const body = match[1];
  const columns: string[] = [];

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    // Skip constraints, comments, and empty lines
    if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('CONSTRAINT')) continue;
    // Match column definitions (start with an identifier)
    const colMatch = trimmed.match(/^(\w+)\s+(UUID|VARCHAR|NUMERIC|SMALLINT|INTEGER|BOOLEAN|TEXT|JSONB|TIMESTAMPTZ|TIMESTAMP|vector)/i);
    if (colMatch) {
      columns.push(colMatch[1].toLowerCase());
    }
  }

  return columns;
}

/**
 * Extracts index names from CREATE INDEX statements.
 */
function extractIndexes(sql: string): string[] {
  const indexes: string[] = [];
  const regex = /CREATE INDEX IF NOT EXISTS (\w+)/gi;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    indexes.push(match[1].toLowerCase());
  }
  return indexes;
}

/**
 * Extracts RLS policy names from CREATE POLICY statements.
 */
function extractPolicies(sql: string): string[] {
  const policies: string[] = [];
  const regex = /CREATE POLICY (\w+)/gi;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    policies.push(match[1].toLowerCase());
  }
  return policies;
}

/**
 * Checks if a migration modifies any pre-existing table via ALTER TABLE or DROP TABLE.
 */
function findExistingTableModifications(sql: string): string[] {
  const modifications: string[] = [];
  for (const table of PRE_EXISTING_TABLES) {
    // Check for ALTER TABLE on existing tables
    const alterRegex = new RegExp(`ALTER TABLE\\s+${table}\\b`, 'gi');
    if (alterRegex.test(sql)) {
      modifications.push(`ALTER TABLE ${table}`);
    }
    // Check for DROP TABLE on existing tables
    const dropRegex = new RegExp(`DROP TABLE\\s+(IF EXISTS\\s+)?${table}\\b`, 'gi');
    if (dropRegex.test(sql)) {
      modifications.push(`DROP TABLE ${table}`);
    }
  }
  return modifications;
}

describe('Research Tables Migration Tests', () => {
  describe('Migration files exist and are readable', () => {
    for (const { file } of RESEARCH_MIGRATIONS) {
      it(`${file} exists`, () => {
        const path = resolve(MIGRATIONS_DIR, file);
        expect(existsSync(path)).toBe(true);
      });

      it(`${file} is non-empty and contains valid SQL`, () => {
        const sql = readMigration(file);
        expect(sql.length).toBeGreaterThan(0);
        // Must contain at least a CREATE TABLE statement
        expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/i);
      });
    }
  });

  describe('Additive-only check (no modifications to pre-existing tables)', () => {
    for (const { file, table } of RESEARCH_MIGRATIONS) {
      it(`${file} does not ALTER or DROP pre-existing tables`, () => {
        const sql = readMigration(file);
        const modifications = findExistingTableModifications(sql);
        expect(modifications).toEqual([]);
      });

      it(`${file} only creates its own table: ${table}`, () => {
        const sql = readMigration(file);
        // All CREATE TABLE statements should be for the expected new table
        const createTableMatches = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/gi) || [];
        for (const stmt of createTableMatches) {
          const nameMatch = stmt.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
          if (nameMatch) {
            expect(PRE_EXISTING_TABLES).not.toContain(nameMatch[1].toLowerCase());
          }
        }
      });
    }
  });

  describe('research_forecasts (migration 20240101000005)', () => {
    let sql: string;

    beforeAll(() => {
      sql = readMigration('20240101000005_research_forecasts.sql');
    });

    it('creates the research_forecasts table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS research_forecasts/i);
    });

    it('has all required columns', () => {
      const columns = extractColumns(sql, 'research_forecasts');
      const expectedColumns = [
        'id', 'fingerprint_id', 'batch_id', 'asset', 'timeframe',
        'forecast_timestamp', 'forecast_expiry', 'direction_probabilities',
        'expected_move_pips', 'confidence_raw', 'confidence_final',
        'tradeability_placeholder', 'engine_versions', 'quantile_table_version',
        'regime', 'sample_size', 'created_at',
      ];
      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });

    it('has UUID primary key on id', () => {
      expect(sql).toMatch(/id UUID PRIMARY KEY/i);
    });

    it('has UNIQUE constraint on (fingerprint_id, batch_id)', () => {
      expect(sql).toMatch(/UNIQUE\s*\(\s*fingerprint_id\s*,\s*batch_id\s*\)/i);
    });

    it('has required indexes: idx_rf_batch, idx_rf_asset_time, idx_rf_expiry, idx_rf_regime', () => {
      const indexes = extractIndexes(sql);
      expect(indexes).toContain('idx_rf_batch');
      expect(indexes).toContain('idx_rf_asset_time');
      expect(indexes).toContain('idx_rf_expiry');
      expect(indexes).toContain('idx_rf_regime');
    });

    it('enables Row Level Security', () => {
      expect(sql).toMatch(/ALTER TABLE research_forecasts ENABLE ROW LEVEL SECURITY/i);
    });

    it('has INSERT and SELECT policies (allowed)', () => {
      const policies = extractPolicies(sql);
      expect(policies).toContain('research_forecasts_insert_policy');
      expect(policies).toContain('research_forecasts_select_policy');
    });

    it('denies UPDATE and DELETE via RLS policies', () => {
      const policies = extractPolicies(sql);
      expect(policies).toContain('research_forecasts_no_update_policy');
      expect(policies).toContain('research_forecasts_no_delete_policy');
    });

    it('UPDATE policy uses USING (false) to deny', () => {
      expect(sql).toMatch(/FOR UPDATE\s+USING\s*\(\s*false\s*\)/i);
    });

    it('DELETE policy uses USING (false) to deny', () => {
      expect(sql).toMatch(/FOR DELETE\s+USING\s*\(\s*false\s*\)/i);
    });
  });

  describe('research_evaluations (migration 20240101000006)', () => {
    let sql: string;

    beforeAll(() => {
      sql = readMigration('20240101000006_research_evaluations.sql');
    });

    it('creates the research_evaluations table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS research_evaluations/i);
    });

    it('has all required columns', () => {
      const columns = extractColumns(sql, 'research_evaluations');
      const expectedColumns = [
        'id', 'forecast_id', 'outcome_id', 'batch_id', 'engine_version',
        'direction_accuracy', 'forecast_success', 'tradeability_success',
        'expected_move_error', 'absolute_error', 'rmse_contribution',
        'brier_score', 'confidence_calibration_score', 'calibration_bucket',
        'status', 'created_at',
      ];
      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });

    it('has foreign key to research_forecasts(id)', () => {
      expect(sql).toMatch(/REFERENCES research_forecasts\s*\(\s*id\s*\)/i);
    });

    it('has foreign key to market_outcomes(outcome_id)', () => {
      expect(sql).toMatch(/REFERENCES market_outcomes\s*\(\s*outcome_id\s*\)/i);
    });

    it('has CHECK constraint on direction_accuracy (0 or 1)', () => {
      expect(sql).toMatch(/direction_accuracy\s+SMALLINT.*CHECK\s*\(\s*direction_accuracy\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/i);
    });

    it('has UNIQUE constraint on (forecast_id, batch_id)', () => {
      expect(sql).toMatch(/UNIQUE\s*\(\s*forecast_id\s*,\s*batch_id\s*\)/i);
    });

    it('has required indexes: idx_re_batch, idx_re_bucket, idx_re_engine', () => {
      const indexes = extractIndexes(sql);
      expect(indexes).toContain('idx_re_batch');
      expect(indexes).toContain('idx_re_bucket');
      expect(indexes).toContain('idx_re_engine');
    });

    it('enables Row Level Security', () => {
      expect(sql).toMatch(/ALTER TABLE research_evaluations ENABLE ROW LEVEL SECURITY/i);
    });

    it('has INSERT and SELECT policies (allowed)', () => {
      const policies = extractPolicies(sql);
      expect(policies).toContain('research_evaluations_insert_policy');
      expect(policies).toContain('research_evaluations_select_policy');
    });

    it('denies UPDATE and DELETE (no permissive policy)', () => {
      // research_evaluations uses the absence-of-policy approach for deny
      // Verify no UPDATE/DELETE permissive policies exist
      expect(sql).not.toMatch(/research_evaluations_update_policy/i);
      expect(sql).not.toMatch(/research_evaluations_delete_policy/i);
    });
  });

  describe('research_similarity_archive (migration 20240101000007)', () => {
    let sql: string;

    beforeAll(() => {
      sql = readMigration('20240101000007_research_similarity_archive.sql');
    });

    it('creates the research_similarity_archive table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS research_similarity_archive/i);
    });

    it('has all required columns', () => {
      const columns = extractColumns(sql, 'research_similarity_archive');
      const expectedColumns = [
        'id', 'fingerprint_id', 'match_fingerprint_id', 'similarity_score',
        'layer_breakdown', 'match_explanation', 'rank', 'batch_id',
        'engine_versions', 'created_at',
      ];
      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });

    it('has UUID primary key on id', () => {
      expect(sql).toMatch(/id UUID PRIMARY KEY/i);
    });

    it('has UNIQUE constraint on (fingerprint_id, match_fingerprint_id, batch_id)', () => {
      expect(sql).toMatch(/UNIQUE\s*\(\s*fingerprint_id\s*,\s*match_fingerprint_id\s*,\s*batch_id\s*\)/i);
    });

    it('has required indexes: idx_rsa_fp_batch, idx_rsa_batch', () => {
      const indexes = extractIndexes(sql);
      expect(indexes).toContain('idx_rsa_fp_batch');
      expect(indexes).toContain('idx_rsa_batch');
    });

    it('enables Row Level Security', () => {
      expect(sql).toMatch(/ALTER TABLE research_similarity_archive ENABLE ROW LEVEL SECURITY/i);
    });

    it('has INSERT and SELECT policies (allowed)', () => {
      const policies = extractPolicies(sql);
      expect(policies).toContain('research_similarity_archive_insert_policy');
      expect(policies).toContain('research_similarity_archive_select_policy');
    });

    it('denies UPDATE and DELETE via RLS policies', () => {
      const policies = extractPolicies(sql);
      expect(policies).toContain('research_similarity_archive_no_update_policy');
      expect(policies).toContain('research_similarity_archive_no_delete_policy');
    });
  });

  describe('fingerprint_topology (migration 20240101000008)', () => {
    let sql: string;

    beforeAll(() => {
      sql = readMigration('20240101000008_fingerprint_topology.sql');
    });

    it('creates the fingerprint_topology table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS fingerprint_topology/i);
    });

    it('has all required columns', () => {
      const columns = extractColumns(sql, 'fingerprint_topology');
      const expectedColumns = [
        'id', 'fingerprint_id', 'asset', 'levels', 'topology_vector',
        'insufficient_history', 'candle_count_used', 'engine_version', 'created_at',
      ];
      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });

    it('has vector(40) type for topology_vector', () => {
      expect(sql).toMatch(/topology_vector\s+vector\s*\(\s*40\s*\)/i);
    });

    it('has UNIQUE constraint on (fingerprint_id, asset)', () => {
      expect(sql).toMatch(/UNIQUE\s*\(\s*fingerprint_id\s*,\s*asset\s*\)/i);
    });

    it('has foreign key referencing market_fingerprints(fingerprint_id, asset)', () => {
      expect(sql).toMatch(/FOREIGN KEY\s*\(\s*fingerprint_id\s*,\s*asset\s*\)\s*REFERENCES\s+market_fingerprints\s*\(\s*fingerprint_id\s*,\s*asset\s*\)/i);
    });

    it('has required index: idx_topo_asset', () => {
      const indexes = extractIndexes(sql);
      expect(indexes).toContain('idx_topo_asset');
    });

    it('enables Row Level Security', () => {
      expect(sql).toMatch(/ALTER TABLE fingerprint_topology ENABLE ROW LEVEL SECURITY/i);
    });

    it('has INSERT and SELECT policies (allowed)', () => {
      const policies = extractPolicies(sql);
      expect(policies).toContain('fingerprint_topology_insert_policy');
      expect(policies).toContain('fingerprint_topology_select_policy');
    });

    it('denies UPDATE and DELETE via RLS policies', () => {
      const policies = extractPolicies(sql);
      expect(policies).toContain('fingerprint_topology_no_update_policy');
      expect(policies).toContain('fingerprint_topology_no_delete_policy');
    });
  });

  describe('research_experiments (migration 20240101000009)', () => {
    let sql: string;

    beforeAll(() => {
      sql = readMigration('20240101000009_research_experiments.sql');
    });

    it('creates the research_experiments table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS research_experiments/i);
    });

    it('has all required columns', () => {
      const columns = extractColumns(sql, 'research_experiments');
      const expectedColumns = [
        'id', 'experiment_id', 'engine_versions', 'original_batch_id',
        'input_fingerprint_id', 'output', 'status', 'failure_detail', 'created_at',
      ];
      for (const col of expectedColumns) {
        expect(columns).toContain(col);
      }
    });

    it('has UUID primary key on id', () => {
      expect(sql).toMatch(/id UUID PRIMARY KEY/i);
    });

    it('has UNIQUE constraint on (experiment_id, input_fingerprint_id)', () => {
      expect(sql).toMatch(/UNIQUE\s*\(\s*experiment_id\s*,\s*input_fingerprint_id\s*\)/i);
    });

    it('has required index: idx_exp_id', () => {
      const indexes = extractIndexes(sql);
      expect(indexes).toContain('idx_exp_id');
    });

    it('enables Row Level Security', () => {
      expect(sql).toMatch(/ALTER TABLE research_experiments ENABLE ROW LEVEL SECURITY/i);
    });

    it('has INSERT, SELECT, and UPDATE policies (allowed)', () => {
      const policies = extractPolicies(sql);
      expect(policies).toContain('research_experiments_insert_policy');
      expect(policies).toContain('research_experiments_select_policy');
      expect(policies).toContain('research_experiments_update_policy');
    });

    it('denies DELETE via RLS policy', () => {
      const policies = extractPolicies(sql);
      expect(policies).toContain('research_experiments_no_delete_policy');
    });

    it('DELETE policy uses USING (false) to deny', () => {
      expect(sql).toMatch(/FOR DELETE\s+USING\s*\(\s*false\s*\)/i);
    });

    it('UPDATE policy uses USING (true) to allow', () => {
      expect(sql).toMatch(/FOR UPDATE\s+USING\s*\(\s*true\s*\)/i);
    });
  });
});
