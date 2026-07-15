/**
 * Unit tests for EventContextService.
 *
 * Tests that:
 * 1. Returns null when no upcoming high-impact events exist (Req 8.1)
 * 2. Returns null when < 3 historical instances found (Req 8.3)
 * 3. Computes correct EventImpactSummary when sufficient data exists (Req 8.2)
 * 4. Handles Supabase query failures gracefully (returns null, logs error) (Req 8.4)
 * 5. Correctly computes median, direction_skew, and vol_expansion_ratio (Req 8.2)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventContextService } from '../event-context-service.js';
import type { EventImpactSummary } from '../event-context-service.js';

// =============================================================================
// Mock Supabase Client Factory
// =============================================================================

interface MockQueryConfig {
  upcomingEvents?: { name: string; event_date: string } | null;
  upcomingEventsError?: { message: string } | null;
  pastInstances?: Array<{ event_date: string }>;
  pastInstancesError?: { message: string } | null;
  outcomeResults?: Array<{ net_return_pips: number } | null>;
  outcomeError?: { message: string } | null;
}

function createMockSupabase(config: MockQueryConfig = {}) {
  const {
    upcomingEvents = null,
    upcomingEventsError = null,
    pastInstances = [],
    pastInstancesError = null,
    outcomeResults = [],
    outcomeError = null,
  } = config;

  let outcomeCallIndex = 0;

  const mockClient: any = {
    from: vi.fn((table: string) => {
      if (table === 'economic_events') {
        // Track whether this is the "upcoming" or "past" query via chaining
        let isUpcomingQuery = false;

        const builder: any = {};
        const chainMethods = ['in', 'eq', 'gte', 'lte', 'lt', 'order', 'limit'];
        for (const method of chainMethods) {
          builder[method] = vi.fn((..._args: any[]) => {
            // Detect if this is the upcoming query (uses gte for event_date)
            if (method === 'gte' && _args[0] === 'event_date') {
              isUpcomingQuery = true;
            }
            // Detect past instances query (uses lt for event_date)
            if (method === 'lt' && _args[0] === 'event_date') {
              isUpcomingQuery = false;
            }
            return builder;
          });
        }
        builder.select = vi.fn(() => builder);
        builder.maybeSingle = vi.fn(() => {
          if (upcomingEventsError) {
            return Promise.resolve({ data: null, error: upcomingEventsError });
          }
          return Promise.resolve({ data: upcomingEvents, error: null });
        });
        // For past instances (non-maybeSingle), make the builder itself thenable
        builder.then = (resolve: any, reject?: any) => {
          if (isUpcomingQuery) {
            // Upcoming query uses maybeSingle — shouldn't reach here normally
            const result = upcomingEventsError
              ? { data: null, error: upcomingEventsError }
              : { data: upcomingEvents, error: null };
            return Promise.resolve(result).then(resolve, reject);
          }
          // Past instances query
          if (pastInstancesError) {
            return Promise.resolve({ data: null, error: pastInstancesError }).then(resolve, reject);
          }
          return Promise.resolve({ data: pastInstances, error: null }).then(resolve, reject);
        };
        return builder;
      }

      if (table === 'market_outcomes') {
        const builder: any = {};
        const chainMethods = ['eq', 'gte', 'lte', 'order', 'limit'];
        for (const method of chainMethods) {
          builder[method] = vi.fn(() => builder);
        }
        builder.select = vi.fn(() => builder);
        builder.maybeSingle = vi.fn(() => {
          if (outcomeError) {
            return Promise.resolve({ data: null, error: outcomeError });
          }
          const result = outcomeResults[outcomeCallIndex] ?? null;
          outcomeCallIndex++;
          return Promise.resolve({ data: result, error: null });
        });
        return builder;
      }

      // Default fallback
      const builder: any = {};
      builder.select = vi.fn(() => builder);
      builder.then = (resolve: any) => Promise.resolve({ data: null, error: null }).then(resolve);
      return builder;
    }),
  };

  return mockClient;
}

// =============================================================================
// Tests
// =============================================================================

describe('EventContextService', () => {
  const currentTime = new Date('2025-01-15T12:00:00Z');
  const asset = 'EURUSD';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('getEventContext', () => {
    it('returns null when no upcoming high-impact events exist', async () => {
      const supabase = createMockSupabase({ upcomingEvents: null });
      const service = new EventContextService(supabase);

      const result = await service.getEventContext(asset, currentTime);

      expect(result).toBeNull();
    });

    it('returns null when fewer than 3 historical instances exist', async () => {
      const supabase = createMockSupabase({
        upcomingEvents: { name: 'NFP', event_date: '2025-01-15T14:00:00Z' },
        pastInstances: [
          { event_date: '2024-12-15T14:00:00Z' },
          { event_date: '2024-11-15T14:00:00Z' },
        ],
      });
      const service = new EventContextService(supabase);

      const result = await service.getEventContext(asset, currentTime);

      expect(result).toBeNull();
    });

    it('returns null when fewer than 3 outcomes are matched', async () => {
      const supabase = createMockSupabase({
        upcomingEvents: { name: 'NFP', event_date: '2025-01-15T14:00:00Z' },
        pastInstances: [
          { event_date: '2024-12-15T14:00:00Z' },
          { event_date: '2024-11-15T14:00:00Z' },
          { event_date: '2024-10-15T14:00:00Z' },
        ],
        outcomeResults: [
          { net_return_pips: 25 },
          null, // No match for second instance
          null, // No match for third instance
        ],
      });
      const service = new EventContextService(supabase);

      const result = await service.getEventContext(asset, currentTime);

      expect(result).toBeNull();
    });

    it('computes correct EventImpactSummary with sufficient data', async () => {
      const supabase = createMockSupabase({
        upcomingEvents: { name: 'NFP', event_date: '2025-01-15T14:00:00Z' },
        pastInstances: [
          { event_date: '2024-12-15T14:00:00Z' },
          { event_date: '2024-11-15T14:00:00Z' },
          { event_date: '2024-10-15T14:00:00Z' },
          { event_date: '2024-09-15T14:00:00Z' },
        ],
        outcomeResults: [
          { net_return_pips: 30 },
          { net_return_pips: -20 },
          { net_return_pips: 15 },
          { net_return_pips: -10 },
        ],
      });
      const service = new EventContextService(supabase);

      const result = await service.getEventContext(asset, currentTime);

      expect(result).not.toBeNull();
      expect(result!.event_type).toBe('NFP');
      expect(result!.instance_count).toBe(4);
      // abs moves: [30, 20, 15, 10] → sorted [10, 15, 20, 30] → median = (15+20)/2 = 17.5
      expect(result!.median_move_pips).toBe(17.5);
      // direction_skew: 2 positive (30, 15) / 4 total = 0.5
      expect(result!.direction_skew).toBe(0.5);
      // vol_expansion: mean abs = (30+20+15+10)/4 = 18.75, ratio = 18.75/17.5 ≈ 1.071
      expect(result!.vol_expansion_ratio).toBeCloseTo(18.75 / 17.5, 5);
    });

    it('computes direction_skew as 1.0 when all moves are positive', async () => {
      const supabase = createMockSupabase({
        upcomingEvents: { name: 'CPI', event_date: '2025-01-15T14:00:00Z' },
        pastInstances: [
          { event_date: '2024-12-15T14:00:00Z' },
          { event_date: '2024-11-15T14:00:00Z' },
          { event_date: '2024-10-15T14:00:00Z' },
        ],
        outcomeResults: [
          { net_return_pips: 10 },
          { net_return_pips: 20 },
          { net_return_pips: 30 },
        ],
      });
      const service = new EventContextService(supabase);

      const result = await service.getEventContext(asset, currentTime);

      expect(result).not.toBeNull();
      expect(result!.direction_skew).toBe(1.0);
    });

    it('handles Supabase query failure for upcoming events gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const supabase = createMockSupabase({
        upcomingEventsError: { message: 'Connection timeout' },
      });
      const service = new EventContextService(supabase);

      const result = await service.getEventContext(asset, currentTime);

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to query upcoming events'),
      );
      consoleSpy.mockRestore();
    });

    it('handles Supabase query failure for past instances gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const supabase = createMockSupabase({
        upcomingEvents: { name: 'NFP', event_date: '2025-01-15T14:00:00Z' },
        pastInstancesError: { message: 'Database error' },
      });
      const service = new EventContextService(supabase);

      const result = await service.getEventContext(asset, currentTime);

      expect(result).toBeNull();
      consoleSpy.mockRestore();
    });

    it('handles Supabase query failure for market_outcomes gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const supabase = createMockSupabase({
        upcomingEvents: { name: 'NFP', event_date: '2025-01-15T14:00:00Z' },
        pastInstances: [
          { event_date: '2024-12-15T14:00:00Z' },
          { event_date: '2024-11-15T14:00:00Z' },
          { event_date: '2024-10-15T14:00:00Z' },
        ],
        outcomeError: { message: 'Timeout' },
      });
      const service = new EventContextService(supabase);

      const result = await service.getEventContext(asset, currentTime);

      // All outcome queries failed, so fewer than 3 matched → null
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('computes median correctly for odd number of instances', async () => {
      const supabase = createMockSupabase({
        upcomingEvents: { name: 'FOMC', event_date: '2025-01-15T14:00:00Z' },
        pastInstances: [
          { event_date: '2024-12-15T14:00:00Z' },
          { event_date: '2024-11-15T14:00:00Z' },
          { event_date: '2024-10-15T14:00:00Z' },
        ],
        outcomeResults: [
          { net_return_pips: -50 },
          { net_return_pips: 30 },
          { net_return_pips: 10 },
        ],
      });
      const service = new EventContextService(supabase);

      const result = await service.getEventContext(asset, currentTime);

      expect(result).not.toBeNull();
      // abs moves: [50, 30, 10] → sorted [10, 30, 50] → median = 30
      expect(result!.median_move_pips).toBe(30);
      // direction_skew: 2 positive (30, 10) / 3 total ≈ 0.667
      expect(result!.direction_skew).toBeCloseTo(2 / 3, 5);
    });
  });
});
