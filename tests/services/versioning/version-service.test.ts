/**
 * Tests for Engine Version Management Service.
 *
 * Covers:
 * - loadActiveVersions() loads and freezes a snapshot from the database
 * - loadActiveVersions() throws when no active versions exist
 * - loadActiveVersions() throws on database errors
 * - loadActiveVersions() returns cached snapshot on subsequent calls (no mid-batch changes)
 * - getVersionSnapshot() throws when versions not loaded
 * - getVersionSnapshot() returns frozen snapshot after load
 * - getVersionMap() returns simplified engine_name → engine_version mapping
 * - incrementEngineVersion() deactivates old, inserts new version
 * - incrementQuantileTableVersion() updates quantile_table_version only
 * - incrementFingerprintSchemaVersion() updates fingerprint_schema_version only
 * - Snapshot immutability: loaded snapshot cannot be mutated
 * - In-memory snapshot is NOT updated after increment (batch consistency)
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VersionService } from '../../../src/services/versioning/version-service.js';
import type { EngineVersionInfo } from '../../../src/services/versioning/version-service.js';

// =============================================================================
// Helpers
// =============================================================================

function createMockSupabase(options?: {
  selectResult?: { data: any[] | null; error: any };
  maybeSingleResult?: { data: any | null; error: any };
  updateResult?: { error: any };
  insertResult?: { data: any | null; error: any };
}) {
  const mockSingle = vi.fn().mockResolvedValue(
    options?.insertResult ?? { data: null, error: null },
  );
  const mockSelect = vi.fn().mockReturnValue({ single: mockSingle });
  const mockInsert = vi.fn().mockReturnValue({ select: mockSelect });
  const mockUpdateEq = vi.fn().mockResolvedValue(
    options?.updateResult ?? { error: null },
  );
  const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEq });
  const mockMaybeSingle = vi.fn().mockResolvedValue(
    options?.maybeSingleResult ?? { data: null, error: null },
  );
  const mockEqIsActive = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
  const mockEqEngineName = vi.fn().mockReturnValue({ eq: mockEqIsActive });

  // For loadActiveVersions() — select with eq('is_active', true) then order
  const mockSelectLoadOrder = vi.fn().mockResolvedValue(
    options?.selectResult ?? { data: [], error: null },
  );
  const mockSelectLoadEq = vi.fn().mockReturnValue({ order: mockSelectLoadOrder });
  const mockSelectLoad = vi.fn().mockReturnValue({ eq: mockSelectLoadEq });

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    return {
      select: mockSelectLoad,
      update: mockUpdate,
      insert: mockInsert,
    };
  });

  return {
    from: mockFrom,
    _mockSelectLoadEq: mockSelectLoadEq,
    _mockInsert: mockInsert,
    _mockUpdate: mockUpdate,
    _mockUpdateEq: mockUpdateEq,
    _mockSingle: mockSingle,
  };
}

/** Sample active engine version rows as returned by the database. */
const SAMPLE_ENGINE_VERSIONS = [
  {
    engine_name: 'fingerprint',
    engine_version: '1.0.0',
    quantile_table_version: '1.0.0',
    fingerprint_schema_version: '1.0.0',
    config: { weights: [0.3, 0.2, 0.2, 0.15, 0.15] },
    activated_at: '2024-01-01T00:00:00.000Z',
    is_active: true,
    id: 'uuid-fp-1',
  },
  {
    engine_name: 'similarity',
    engine_version: '2.0.0',
    quantile_table_version: null,
    fingerprint_schema_version: null,
    config: { threshold: 0.75 },
    activated_at: '2024-01-01T00:00:00.000Z',
    is_active: true,
    id: 'uuid-sim-1',
  },
  {
    engine_name: 'outcome',
    engine_version: '1.1.0',
    quantile_table_version: '2.0.0',
    fingerprint_schema_version: null,
    config: { flat_threshold: 2 },
    activated_at: '2024-01-15T00:00:00.000Z',
    is_active: true,
    id: 'uuid-out-1',
  },
];

// =============================================================================
// loadActiveVersions Tests
// =============================================================================

describe('VersionService', () => {
  describe('loadActiveVersions', () => {
    it('loads active versions from the database and returns a frozen snapshot', async () => {
      const mockSupabase = createMockSupabase({
        selectResult: { data: SAMPLE_ENGINE_VERSIONS, error: null },
      });

      const service = new VersionService(mockSupabase as any);
      const snapshot = await service.loadActiveVersions();

      expect(Object.keys(snapshot)).toHaveLength(3);
      expect(snapshot['fingerprint']).toBeDefined();
      expect(snapshot['similarity']).toBeDefined();
      expect(snapshot['outcome']).toBeDefined();

      expect(snapshot['fingerprint'].engine_version).toBe('1.0.0');
      expect(snapshot['fingerprint'].quantile_table_version).toBe('1.0.0');
      expect(snapshot['fingerprint'].fingerprint_schema_version).toBe('1.0.0');
      expect(snapshot['fingerprint'].config).toEqual({ weights: [0.3, 0.2, 0.2, 0.15, 0.15] });

      expect(snapshot['similarity'].engine_version).toBe('2.0.0');
      expect(snapshot['similarity'].quantile_table_version).toBeNull();
    });

    it('returns frozen (immutable) snapshot object', async () => {
      const mockSupabase = createMockSupabase({
        selectResult: { data: SAMPLE_ENGINE_VERSIONS, error: null },
      });

      const service = new VersionService(mockSupabase as any);
      const snapshot = await service.loadActiveVersions();

      // Top-level object is frozen
      expect(Object.isFrozen(snapshot)).toBe(true);

      // Individual version info objects are frozen
      expect(Object.isFrozen(snapshot['fingerprint'])).toBe(true);
      expect(Object.isFrozen(snapshot['similarity'])).toBe(true);
    });

    it('throws when no active engine versions exist', async () => {
      const mockSupabase = createMockSupabase({
        selectResult: { data: [], error: null },
      });

      const service = new VersionService(mockSupabase as any);

      await expect(service.loadActiveVersions()).rejects.toThrow(
        '[VersionService] No active engine versions found',
      );
    });

    it('throws when data is null', async () => {
      const mockSupabase = createMockSupabase({
        selectResult: { data: null, error: null },
      });

      const service = new VersionService(mockSupabase as any);

      await expect(service.loadActiveVersions()).rejects.toThrow(
        '[VersionService] No active engine versions found',
      );
    });

    it('throws on database query error', async () => {
      const mockSupabase = createMockSupabase({
        selectResult: { data: null, error: { message: 'Connection timeout' } },
      });

      const service = new VersionService(mockSupabase as any);

      await expect(service.loadActiveVersions()).rejects.toThrow(
        '[VersionService] Failed to load engine versions: Connection timeout',
      );
    });

    it('returns cached snapshot on subsequent calls (Req 10.6 — no mid-batch changes)', async () => {
      const mockSupabase = createMockSupabase({
        selectResult: { data: SAMPLE_ENGINE_VERSIONS, error: null },
      });

      const service = new VersionService(mockSupabase as any);

      const snapshot1 = await service.loadActiveVersions();
      const snapshot2 = await service.loadActiveVersions();

      // Same reference — no second database call
      expect(snapshot1).toBe(snapshot2);
      // from() should only be called once (for the first load)
      expect(mockSupabase.from).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // getVersionSnapshot Tests
  // ===========================================================================

  describe('getVersionSnapshot', () => {
    it('throws when versions have not been loaded', () => {
      const mockSupabase = createMockSupabase();
      const service = new VersionService(mockSupabase as any);

      expect(() => service.getVersionSnapshot()).toThrow(
        '[VersionService] Version snapshot not loaded. Call loadActiveVersions() first.',
      );
    });

    it('returns the frozen snapshot after loading', async () => {
      const mockSupabase = createMockSupabase({
        selectResult: { data: SAMPLE_ENGINE_VERSIONS, error: null },
      });

      const service = new VersionService(mockSupabase as any);
      await service.loadActiveVersions();

      const snapshot = service.getVersionSnapshot();

      expect(snapshot['fingerprint'].engine_version).toBe('1.0.0');
      expect(snapshot['outcome'].engine_version).toBe('1.1.0');
      expect(Object.isFrozen(snapshot)).toBe(true);
    });
  });

  // ===========================================================================
  // getVersionMap Tests
  // ===========================================================================

  describe('getVersionMap', () => {
    it('throws when versions have not been loaded', () => {
      const mockSupabase = createMockSupabase();
      const service = new VersionService(mockSupabase as any);

      expect(() => service.getVersionMap()).toThrow(
        '[VersionService] Version snapshot not loaded. Call loadActiveVersions() first.',
      );
    });

    it('returns simplified engine_name → engine_version mapping', async () => {
      const mockSupabase = createMockSupabase({
        selectResult: { data: SAMPLE_ENGINE_VERSIONS, error: null },
      });

      const service = new VersionService(mockSupabase as any);
      await service.loadActiveVersions();

      const map = service.getVersionMap();

      expect(map).toEqual({
        fingerprint: '1.0.0',
        similarity: '2.0.0',
        outcome: '1.1.0',
      });
    });
  });

  // ===========================================================================
  // incrementEngineVersion Tests
  // ===========================================================================

  describe('incrementEngineVersion', () => {
    it('deactivates old version and inserts new version with updated engine_version and config', async () => {
      const currentVersion = {
        id: 'uuid-fp-1',
        engine_name: 'fingerprint',
        engine_version: '1.0.0',
        quantile_table_version: '1.0.0',
        fingerprint_schema_version: '1.0.0',
        config: { weights: [0.3, 0.2, 0.2, 0.15, 0.15] },
        activated_at: '2024-01-01T00:00:00.000Z',
        is_active: true,
      };

      const insertedRecord = {
        engine_name: 'fingerprint',
        engine_version: '2.0.0',
        quantile_table_version: '1.0.0',
        fingerprint_schema_version: '1.0.0',
        config: { weights: [0.4, 0.2, 0.15, 0.15, 0.1] },
        activated_at: '2024-02-01T00:00:00.000Z',
      };

      // Build a more specific mock for increment operations
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: currentVersion, error: null });
      const mockEqActive = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
      const mockEqName = vi.fn().mockReturnValue({ eq: mockEqActive });
      const mockSelectAll = vi.fn().mockReturnValue({ eq: mockEqName });

      const mockUpdateEqId = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEqId });

      const mockInsertSingle = vi.fn().mockResolvedValue({ data: insertedRecord, error: null });
      const mockInsertSelect = vi.fn().mockReturnValue({ single: mockInsertSingle });
      const mockInsert = vi.fn().mockReturnValue({ select: mockInsertSelect });

      const mockFrom = vi.fn().mockReturnValue({
        select: mockSelectAll,
        update: mockUpdate,
        insert: mockInsert,
      });

      const mockSupabase = { from: mockFrom };
      const service = new VersionService(mockSupabase as any);

      const result = await service.incrementEngineVersion(
        'fingerprint',
        '2.0.0',
        { weights: [0.4, 0.2, 0.15, 0.15, 0.1] },
      );

      expect(result.engine_name).toBe('fingerprint');
      expect(result.engine_version).toBe('2.0.0');
      expect(result.quantile_table_version).toBe('1.0.0');
      expect(result.fingerprint_schema_version).toBe('1.0.0');
      expect(result.config).toEqual({ weights: [0.4, 0.2, 0.15, 0.15, 0.1] });

      // Verify deactivation was called
      expect(mockUpdate).toHaveBeenCalledWith({ is_active: false });
      // Verify insert was called
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          engine_name: 'fingerprint',
          engine_version: '2.0.0',
          is_active: true,
        }),
      );
    });

    it('throws when no active version exists for the engine', async () => {
      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      const mockEqActive = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
      const mockEqName = vi.fn().mockReturnValue({ eq: mockEqActive });
      const mockSelectAll = vi.fn().mockReturnValue({ eq: mockEqName });

      const mockFrom = vi.fn().mockReturnValue({ select: mockSelectAll });
      const mockSupabase = { from: mockFrom };
      const service = new VersionService(mockSupabase as any);

      await expect(
        service.incrementEngineVersion('nonexistent', '1.0.0', {}),
      ).rejects.toThrow("[VersionService] No active version found for engine 'nonexistent'");
    });

    it('throws on fetch error', async () => {
      const mockMaybeSingle = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'DB error' },
      });
      const mockEqActive = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
      const mockEqName = vi.fn().mockReturnValue({ eq: mockEqActive });
      const mockSelectAll = vi.fn().mockReturnValue({ eq: mockEqName });

      const mockFrom = vi.fn().mockReturnValue({ select: mockSelectAll });
      const mockSupabase = { from: mockFrom };
      const service = new VersionService(mockSupabase as any);

      await expect(
        service.incrementEngineVersion('fingerprint', '2.0.0', {}),
      ).rejects.toThrow("[VersionService] Failed to fetch current version for 'fingerprint': DB error");
    });
  });

  // ===========================================================================
  // incrementQuantileTableVersion Tests
  // ===========================================================================

  describe('incrementQuantileTableVersion', () => {
    it('updates quantile_table_version while preserving other fields', async () => {
      const currentVersion = {
        id: 'uuid-out-1',
        engine_name: 'outcome',
        engine_version: '1.1.0',
        quantile_table_version: '2.0.0',
        fingerprint_schema_version: null,
        config: { flat_threshold: 2 },
        activated_at: '2024-01-15T00:00:00.000Z',
        is_active: true,
      };

      const insertedRecord = {
        engine_name: 'outcome',
        engine_version: '1.1.0',
        quantile_table_version: '3.0.0',
        fingerprint_schema_version: null,
        config: { flat_threshold: 2 },
        activated_at: '2024-02-01T00:00:00.000Z',
      };

      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: currentVersion, error: null });
      const mockEqActive = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
      const mockEqName = vi.fn().mockReturnValue({ eq: mockEqActive });
      const mockSelectAll = vi.fn().mockReturnValue({ eq: mockEqName });

      const mockUpdateEqId = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEqId });

      const mockInsertSingle = vi.fn().mockResolvedValue({ data: insertedRecord, error: null });
      const mockInsertSelect = vi.fn().mockReturnValue({ single: mockInsertSingle });
      const mockInsert = vi.fn().mockReturnValue({ select: mockInsertSelect });

      const mockFrom = vi.fn().mockReturnValue({
        select: mockSelectAll,
        update: mockUpdate,
        insert: mockInsert,
      });

      const mockSupabase = { from: mockFrom };
      const service = new VersionService(mockSupabase as any);

      const result = await service.incrementQuantileTableVersion('outcome', '3.0.0');

      expect(result.engine_name).toBe('outcome');
      expect(result.engine_version).toBe('1.1.0'); // unchanged
      expect(result.quantile_table_version).toBe('3.0.0'); // updated
      expect(result.fingerprint_schema_version).toBeNull(); // unchanged
      expect(result.config).toEqual({ flat_threshold: 2 }); // unchanged

      // Verify insert has the correct quantile_table_version
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          engine_name: 'outcome',
          engine_version: '1.1.0',
          quantile_table_version: '3.0.0',
          is_active: true,
        }),
      );
    });
  });

  // ===========================================================================
  // incrementFingerprintSchemaVersion Tests
  // ===========================================================================

  describe('incrementFingerprintSchemaVersion', () => {
    it('updates fingerprint_schema_version while preserving other fields', async () => {
      const currentVersion = {
        id: 'uuid-fp-1',
        engine_name: 'fingerprint',
        engine_version: '1.0.0',
        quantile_table_version: '1.0.0',
        fingerprint_schema_version: '1.0.0',
        config: { weights: [0.3, 0.2, 0.2, 0.15, 0.15] },
        activated_at: '2024-01-01T00:00:00.000Z',
        is_active: true,
      };

      const insertedRecord = {
        engine_name: 'fingerprint',
        engine_version: '1.0.0',
        quantile_table_version: '1.0.0',
        fingerprint_schema_version: '2.0.0',
        config: { weights: [0.3, 0.2, 0.2, 0.15, 0.15] },
        activated_at: '2024-02-01T00:00:00.000Z',
      };

      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: currentVersion, error: null });
      const mockEqActive = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
      const mockEqName = vi.fn().mockReturnValue({ eq: mockEqActive });
      const mockSelectAll = vi.fn().mockReturnValue({ eq: mockEqName });

      const mockUpdateEqId = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEqId });

      const mockInsertSingle = vi.fn().mockResolvedValue({ data: insertedRecord, error: null });
      const mockInsertSelect = vi.fn().mockReturnValue({ single: mockInsertSingle });
      const mockInsert = vi.fn().mockReturnValue({ select: mockInsertSelect });

      const mockFrom = vi.fn().mockReturnValue({
        select: mockSelectAll,
        update: mockUpdate,
        insert: mockInsert,
      });

      const mockSupabase = { from: mockFrom };
      const service = new VersionService(mockSupabase as any);

      const result = await service.incrementFingerprintSchemaVersion('fingerprint', '2.0.0');

      expect(result.engine_name).toBe('fingerprint');
      expect(result.engine_version).toBe('1.0.0'); // unchanged
      expect(result.quantile_table_version).toBe('1.0.0'); // unchanged
      expect(result.fingerprint_schema_version).toBe('2.0.0'); // updated
      expect(result.config).toEqual({ weights: [0.3, 0.2, 0.2, 0.15, 0.15] }); // unchanged
    });
  });

  // ===========================================================================
  // Batch Consistency (Req 10.6)
  // ===========================================================================

  describe('batch consistency (Req 10.6)', () => {
    it('in-memory snapshot is NOT updated after incrementEngineVersion', async () => {
      // First, set up loadActiveVersions mock
      const loadOrder = vi.fn().mockResolvedValue({
        data: SAMPLE_ENGINE_VERSIONS,
        error: null,
      });
      const loadEq = vi.fn().mockReturnValue({ order: loadOrder });
      const loadSelect = vi.fn().mockReturnValue({ eq: loadEq });

      // Set up increment mocks
      const currentVersion = SAMPLE_ENGINE_VERSIONS[0];
      const insertedRecord = {
        engine_name: 'fingerprint',
        engine_version: '2.0.0',
        quantile_table_version: '1.0.0',
        fingerprint_schema_version: '1.0.0',
        config: { weights: [0.4, 0.2, 0.15, 0.15, 0.1] },
        activated_at: '2024-02-01T00:00:00.000Z',
      };

      const mockMaybeSingle = vi.fn().mockResolvedValue({ data: currentVersion, error: null });
      const mockEqActive = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
      const mockEqName = vi.fn().mockReturnValue({ eq: mockEqActive });
      const mockIncrSelectAll = vi.fn().mockReturnValue({ eq: mockEqName });

      const mockUpdateEqId = vi.fn().mockResolvedValue({ error: null });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockUpdateEqId });

      const mockInsertSingle = vi.fn().mockResolvedValue({ data: insertedRecord, error: null });
      const mockInsertSelect = vi.fn().mockReturnValue({ single: mockInsertSingle });
      const mockInsert = vi.fn().mockReturnValue({ select: mockInsertSelect });

      let callCount = 0;
      const mockFrom = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: loadActiveVersions select
          return { select: loadSelect };
        }
        // Subsequent calls: increment operations
        return {
          select: mockIncrSelectAll,
          update: mockUpdate,
          insert: mockInsert,
        };
      });

      const mockSupabase = { from: mockFrom };
      const service = new VersionService(mockSupabase as any);

      // Load snapshot
      await service.loadActiveVersions();
      const snapshotBefore = service.getVersionSnapshot();
      expect(snapshotBefore['fingerprint'].engine_version).toBe('1.0.0');

      // Increment engine version
      await service.incrementEngineVersion('fingerprint', '2.0.0', {
        weights: [0.4, 0.2, 0.15, 0.15, 0.1],
      });

      // Snapshot should still show old version (batch consistency)
      const snapshotAfter = service.getVersionSnapshot();
      expect(snapshotAfter['fingerprint'].engine_version).toBe('1.0.0');
      expect(snapshotAfter).toBe(snapshotBefore); // Same frozen reference
    });
  });
});
