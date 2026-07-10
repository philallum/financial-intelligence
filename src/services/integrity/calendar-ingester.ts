/**
 * Calendar Ingester for the Daily Data Integrity module.
 *
 * Fetches and stores upcoming economic events from Alpha Vantage.
 * Classifies event impact based on event name keywords.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 9.3
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RateLimitRegistry } from '../ingestion/rate-limiter.js';
import type {
  CalendarIngestionConfig,
  CalendarIngestionResult,
  EconomicEvent,
} from './types.js';

/** Default time appended to date-only timestamps from Alpha Vantage (09:00 UTC). */
const DEFAULT_EVENT_TIME = 'T09:00:00Z';

/** Alpha Vantage provider name in the rate limit registry. */
const PROVIDER_NAME = 'alpha_vantage';

/**
 * Classify the impact level of an economic event based on its name.
 *
 * - "high" for names containing: NFP, Non-Farm, CPI, GDP, or Rate Decision (case-insensitive)
 * - "medium" for names containing: PMI or Retail Sales (case-insensitive)
 * - "low" for all other names
 *
 * @param eventName - The name of the economic event to classify
 * @returns The impact classification: 'high', 'medium', or 'low'
 */
export function classifyEventImpact(eventName: string): 'high' | 'medium' | 'low' {
  const normalized = eventName.toLowerCase();

  const highImpactKeywords = ['nfp', 'non-farm', 'cpi', 'gdp', 'rate decision'];
  const mediumImpactKeywords = ['pmi', 'retail sales'];

  for (const keyword of highImpactKeywords) {
    if (normalized.includes(keyword)) {
      return 'high';
    }
  }

  for (const keyword of mediumImpactKeywords) {
    if (normalized.includes(keyword)) {
      return 'medium';
    }
  }

  return 'low';
}

/**
 * Ingest economic calendar events from Alpha Vantage.
 *
 * Fetches events for the configured date range (default: previous 1 day to upcoming 7 days),
 * classifies impact, and upserts into the economic_events table. On conflict (name, event_date),
 * only the `actual` column is updated to reflect newly released values.
 *
 * Fail-forward: if Alpha Vantage is unavailable, logs the error and returns an empty result.
 *
 * @param supabase - Supabase client instance
 * @param rateLimits - Rate limit registry for controlling API usage
 * @param config - Calendar ingestion configuration (forwardDays, backwardDays)
 * @returns Calendar ingestion result with counts and any error messages
 */
export async function ingestCalendar(
  supabase: SupabaseClient,
  rateLimits: RateLimitRegistry,
  config: CalendarIngestionConfig
): Promise<CalendarIngestionResult> {
  const result: CalendarIngestionResult = {
    eventsIngested: 0,
    eventsUpdated: 0,
    errors: [],
  };

  // Check rate limits before making the request
  if (!rateLimits.canRequest(PROVIDER_NAME)) {
    const msg = 'Alpha Vantage rate limit exceeded, skipping calendar ingestion';
    logError(msg);
    result.errors.push(msg);
    return result;
  }

  let csvText: string;
  try {
    csvText = await fetchAlphaVantageCalendar();
    rateLimits.recordRequest(PROVIDER_NAME);
  } catch (error: unknown) {
    const msg = `Alpha Vantage calendar fetch failed: ${error instanceof Error ? error.message : String(error)}`;
    logError(msg);
    result.errors.push(msg);
    return result;
  }

  // Parse CSV response into events
  const allEvents = parseCalendarCsv(csvText);

  // Filter events to the configured date range
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const rangeStart = new Date(today.getTime() - config.backwardDays * 24 * 60 * 60 * 1000);
  const rangeEnd = new Date(today.getTime() + config.forwardDays * 24 * 60 * 60 * 1000);

  const filteredEvents = allEvents.filter((event) => {
    const eventDate = new Date(event.event_date);
    return eventDate >= rangeStart && eventDate <= rangeEnd;
  });

  if (filteredEvents.length === 0) {
    return result;
  }

  // Determine today's run_date in YYYY-MM-DD format
  const runDate = today.toISOString().split('T')[0];

  // Build records for insertion
  const records = filteredEvents.map((event) => ({
    name: event.name,
    event_date: event.event_date,
    impact: event.impact,
    actual: event.actual,
    estimate: event.estimate,
    previous: event.previous,
    currency: event.currency,
    run_date: runDate,
  }));

  // Step 1: Insert new events with ignoreDuplicates (skip existing rows)
  try {
    const { data: insertedData, error: insertError } = await supabase
      .from('economic_events')
      .upsert(records, { onConflict: 'name,event_date', ignoreDuplicates: true })
      .select('name');

    if (insertError) {
      const msg = `Failed to insert economic events: ${insertError.message}`;
      logError(msg);
      result.errors.push(msg);
      return result;
    }

    result.eventsIngested = insertedData?.length ?? 0;
  } catch (error: unknown) {
    const msg = `Exception inserting economic events: ${error instanceof Error ? error.message : String(error)}`;
    logError(msg);
    result.errors.push(msg);
    return result;
  }

  // Step 2: Update `actual` column for events that have a non-null actual value
  const eventsWithActual = filteredEvents.filter((e) => e.actual !== null);

  for (const event of eventsWithActual) {
    try {
      const { error: updateError } = await supabase
        .from('economic_events')
        .update({ actual: event.actual })
        .eq('name', event.name)
        .eq('event_date', event.event_date);

      if (updateError) {
        const msg = `Failed to update actual for "${event.name}": ${updateError.message}`;
        logError(msg);
        result.errors.push(msg);
      } else {
        result.eventsUpdated++;
      }
    } catch (error: unknown) {
      const msg = `Exception updating actual for "${event.name}": ${error instanceof Error ? error.message : String(error)}`;
      logError(msg);
      result.errors.push(msg);
    }
  }

  return result;
}

/**
 * Fetch economic calendar CSV data from Alpha Vantage.
 *
 * @returns Raw CSV response text
 */
async function fetchAlphaVantageCalendar(): Promise<string> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    throw new Error('ALPHA_VANTAGE_API_KEY environment variable is not set');
  }

  const url = `https://www.alphavantage.co/query?function=ECONOMIC_CALENDAR&apikey=${apiKey}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.text();
}

/**
 * Parse Alpha Vantage economic calendar CSV response into EconomicEvent objects.
 *
 * Expected CSV columns: timestamp, name, country, actual, estimate, previous, currency
 * If timestamps are date-only (YYYY-MM-DD), a default time of 09:00:00Z is appended
 * to produce full ISO-8601 timestamptz values.
 *
 * @param csvText - Raw CSV text from Alpha Vantage
 * @returns Array of parsed EconomicEvent objects
 */
export function parseCalendarCsv(csvText: string): EconomicEvent[] {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const timestampIdx = headers.indexOf('timestamp');
  const nameIdx = headers.indexOf('name');
  const actualIdx = headers.indexOf('actual');
  const estimateIdx = headers.indexOf('estimate');
  const previousIdx = headers.indexOf('previous');
  const currencyIdx = headers.indexOf('currency');

  // Validate required columns exist
  if (timestampIdx === -1 || nameIdx === -1) {
    return [];
  }

  const events: EconomicEvent[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',').map((c) => c.trim());

    const rawTimestamp = cols[timestampIdx] || '';
    const name = cols[nameIdx] || '';
    const currency = cols[currencyIdx] || 'USD';

    if (!rawTimestamp || !name) continue;

    // Convert date-only to full timestamptz
    const eventDate = normalizeTimestamp(rawTimestamp);

    const actual = parseNumericValue(cols[actualIdx]);
    const estimate = parseNumericValue(cols[estimateIdx]);
    const previous = parseNumericValue(cols[previousIdx]);

    const impact = classifyEventImpact(name);

    events.push({
      name,
      event_date: eventDate,
      impact,
      actual,
      estimate,
      previous,
      currency,
    });
  }

  return events;
}

/**
 * Normalize a timestamp string to full ISO-8601 with timezone.
 * If the input is date-only (YYYY-MM-DD), appends default time T09:00:00Z.
 * If already a full ISO timestamp, returns as-is.
 *
 * @param raw - Raw timestamp string from CSV
 * @returns Normalized ISO-8601 timestamp with timezone
 */
function normalizeTimestamp(raw: string): string {
  // If it looks like a date-only value (YYYY-MM-DD with no time part)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw + DEFAULT_EVENT_TIME;
  }
  // If it already has time info, ensure it ends with Z or timezone
  if (raw.includes('T')) {
    return raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw) ? raw : raw + 'Z';
  }
  // Fallback: treat as date-only
  return raw + DEFAULT_EVENT_TIME;
}

/**
 * Parse a string value to a number, returning null for empty or non-numeric values.
 *
 * @param value - String value to parse
 * @returns Parsed number or null
 */
function parseNumericValue(value: string | undefined): number | null {
  if (!value || value === '' || value === '-') return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
}

/**
 * Emit a structured JSON error log for the calendar ingestion stage.
 */
function logError(message: string): void {
  console.log(
    JSON.stringify({
      severity: 'ERROR',
      component: 'integrity',
      stage: 'calendar_ingestion',
      message,
      timestamp: new Date().toISOString(),
    })
  );
}
