/**
 * Engine Version Management Service
 *
 * Manages engine version snapshots for batch processing. Ensures a single,
 * immutable version set is used for the entire batch execution (no mid-batch changes).
 *
 * Responsibilities:
 * - Load active engine versions from the `engine_versions` table at batch start
 * - Freeze the version snapshot for the duration of the batch
 * - Propagate version identifiers to every engine output record
 * - Provide version increment logic for engine_version, quantile_table_version,
 *   and fingerprint_schema_version
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { EngineVersion } from '../../types/config.js';

// =============================================================================
// Types
// =============================================================================

/** Version info for a single engine, as stored in the snapshot. */
export interface EngineVersionInfo {
  engine_name: string;
  engine_version: string;
  quantile_table_version: string | null;
  fingerprint_schema_version: string | null;
  config: Record<string, unknown>;
  activated_at: string;
}

/** Frozen snapshot mapping engine names to their version info. */
export type VersionSnapshot = Readonly<Record<string, Readonly<EngineVersionInfo>>>;

// =============================================================================
// Version Service
// =============================================================================

/**
 * Manages engine version loading and consistency for batch runs.
 *
 * Usage:
 *   const service = new VersionService(supabaseClient);
 *   await service.loadActiveVersions();
 *   const snapshot = service.getVersionSnapshot();
 */
export class VersionService {
  private readonly supabase: SupabaseClient;
  private snapshot: VersionSnapshot | null = null;

  constructor(supabaseClient: SupabaseClient) {
    this.supabase = supabaseClient;
  }

  /**
   * Load all active engine versions from the database and freeze the snapshot.
   * Once loaded, the snapshot is immutable for the lifetime of this service instance.
   *
   * @returns The frozen version snapshot
   * @throws If no active engine versions are found or database query fails
   */
  async loadActiveVersions(): Promise<VersionSnapshot> {
    if (this.snapshot !== null) {
      return this.snapshot;
    }

    const { data, error } = await this.supabase
      .from('engine_versions')
      .select('engine_name, engine_version, quantile_table_version, fingerprint_schema_version, config, activated_at')
      .eq('is_active', true);

    if (error) {
      throw new Error(`[VersionService] Failed to load engine versions: ${error.message}`);
    }

    if (!data || data.length === 0) {
      throw new Error('[VersionService] No active engine versions found');
    }

    const snapshotMap: Record<string, EngineVersionInfo> = {};

    for (const row of data as EngineVersion[]) {
      snapshotMap[row.engine_name] = Object.freeze({
        engine_name: row.engine_name,
        engine_version: row.engine_version,
        quantile_table_version: row.quantile_table_version,
        fingerprint_schema_version: row.fingerprint_schema_version,
        config: row.config,
        activated_at: row.activated_at,
      });
    }

    this.snapshot = Object.freeze(snapshotMap);
    return this.snapshot;
  }

  /**
   * Returns the current frozen version snapshot.
   *
   * @returns The immutable version snapshot
   * @throws If versions have not been loaded yet
   */
  getVersionSnapshot(): VersionSnapshot {
    if (this.snapshot === null) {
      throw new Error(
        '[VersionService] Version snapshot not loaded. Call loadActiveVersions() first.',
      );
    }
    return this.snapshot;
  }

  /**
   * Get a simplified version map (engine_name → engine_version) suitable for
   * storing in batch_runs.engine_versions.
   *
   * @returns Record mapping engine names to their version strings
   * @throws If versions have not been loaded yet
   */
  getVersionMap(): Record<string, string> {
    const snapshot = this.getVersionSnapshot();
    const map: Record<string, string> = {};
    for (const [name, info] of Object.entries(snapshot)) {
      map[name] = info.engine_version;
    }
    return map;
  }

  /**
   * Increment the engine version for a given engine.
   * Deactivates the current active version and inserts a new active record.
   *
   * Requirement 10.2: Increment engine_version when an engine algorithm is modified.
   *
   * @param engineName - The engine to version-bump
   * @param newVersion - The new version string (e.g., "2.0.0")
   * @param config - The frozen configuration for this version
   * @throws On database errors
   */
  async incrementEngineVersion(
    engineName: string,
    newVersion: string,
    config: Record<string, unknown>,
  ): Promise<EngineVersionInfo> {
    return this.incrementVersion(engineName, { engine_version: newVersion, config });
  }

  /**
   * Increment the quantile table version for a given engine.
   *
   * Requirement 10.3: Increment quantile_table_version when quantile reference table is updated.
   *
   * @param engineName - The engine whose quantile table changed
   * @param newVersion - The new quantile table version string
   * @throws On database errors
   */
  async incrementQuantileTableVersion(
    engineName: string,
    newVersion: string,
  ): Promise<EngineVersionInfo> {
    return this.incrementVersion(engineName, { quantile_table_version: newVersion });
  }

  /**
   * Increment the fingerprint schema version for a given engine.
   *
   * Requirement 10.4: Increment fingerprint_schema_version when fingerprint structure changes.
   *
   * @param engineName - The engine whose fingerprint schema changed
   * @param newVersion - The new fingerprint schema version string
   * @throws On database errors
   */
  async incrementFingerprintSchemaVersion(
    engineName: string,
    newVersion: string,
  ): Promise<EngineVersionInfo> {
    return this.incrementVersion(engineName, { fingerprint_schema_version: newVersion });
  }

  /**
   * Internal: perform a version increment by deactivating the current active version
   * and inserting a new active version record with the updated fields.
   */
  private async incrementVersion(
    engineName: string,
    updates: Partial<Pick<EngineVersionInfo, 'engine_version' | 'quantile_table_version' | 'fingerprint_schema_version' | 'config'>>,
  ): Promise<EngineVersionInfo> {
    // Fetch current active version for this engine
    const { data: current, error: fetchError } = await this.supabase
      .from('engine_versions')
      .select('*')
      .eq('engine_name', engineName)
      .eq('is_active', true)
      .maybeSingle();

    if (fetchError) {
      throw new Error(
        `[VersionService] Failed to fetch current version for '${engineName}': ${fetchError.message}`,
      );
    }

    if (!current) {
      throw new Error(
        `[VersionService] No active version found for engine '${engineName}'`,
      );
    }

    const typedCurrent = current as EngineVersion;

    // Deactivate current version
    const { error: deactivateError } = await this.supabase
      .from('engine_versions')
      .update({ is_active: false })
      .eq('id', typedCurrent.id);

    if (deactivateError) {
      throw new Error(
        `[VersionService] Failed to deactivate version for '${engineName}': ${deactivateError.message}`,
      );
    }

    // Build new version record
    const newRecord = {
      engine_name: engineName,
      engine_version: updates.engine_version ?? typedCurrent.engine_version,
      quantile_table_version: updates.quantile_table_version ?? typedCurrent.quantile_table_version,
      fingerprint_schema_version: updates.fingerprint_schema_version ?? typedCurrent.fingerprint_schema_version,
      config: updates.config ?? typedCurrent.config,
      activated_at: new Date().toISOString(),
      is_active: true,
    };

    const { data: inserted, error: insertError } = await this.supabase
      .from('engine_versions')
      .insert(newRecord)
      .select('engine_name, engine_version, quantile_table_version, fingerprint_schema_version, config, activated_at')
      .single();

    if (insertError || !inserted) {
      throw new Error(
        `[VersionService] Failed to insert new version for '${engineName}': ${insertError?.message ?? 'No data returned'}`,
      );
    }

    const info: EngineVersionInfo = {
      engine_name: inserted.engine_name,
      engine_version: inserted.engine_version,
      quantile_table_version: inserted.quantile_table_version,
      fingerprint_schema_version: inserted.fingerprint_schema_version,
      config: inserted.config,
      activated_at: inserted.activated_at,
    };

    // Note: The in-memory snapshot is NOT updated — it remains frozen for the current batch.
    // A new batch must call loadActiveVersions() fresh to pick up changes.

    return info;
  }
}
