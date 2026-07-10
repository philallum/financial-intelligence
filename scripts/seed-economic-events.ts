/**
 * Seed script: Inserts realistic economic events into the economic_events table.
 * Used to enable testing of the Macro Context Engine and News Risk Evaluator
 * when Alpha Vantage data is unavailable.
 */
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config/env.js';

async function main() {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // Helper: create a date offset from now in hours
  const hoursFromNow = (h: number) => new Date(now.getTime() + h * 3600000).toISOString();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600000).toISOString();

  const events = [
    // Past high-impact events (with actual values - for surprise factor computation)
    {
      name: 'US CPI (YoY)',
      event_date: hoursAgo(48),
      impact: 'high',
      actual: 3.2,
      estimate: 3.0,
      previous: 2.9,
      currency: 'USD',
      run_date: today,
    },
    {
      name: 'ECB Rate Decision',
      event_date: hoursAgo(36),
      impact: 'high',
      actual: 4.25,
      estimate: 4.25,
      previous: 4.0,
      currency: 'EUR',
      run_date: today,
    },
    {
      name: 'US GDP (QoQ)',
      event_date: hoursAgo(24),
      impact: 'high',
      actual: 2.8,
      estimate: 2.5,
      previous: 2.3,
      currency: 'USD',
      run_date: today,
    },
    {
      name: 'Eurozone CPI (YoY)',
      event_date: hoursAgo(12),
      impact: 'high',
      actual: 2.5,
      estimate: 2.6,
      previous: 2.4,
      currency: 'EUR',
      run_date: today,
    },

    // Past medium-impact events
    {
      name: 'US PMI Manufacturing',
      event_date: hoursAgo(20),
      impact: 'medium',
      actual: 51.3,
      estimate: 50.8,
      previous: 50.2,
      currency: 'USD',
      run_date: today,
    },
    {
      name: 'Eurozone Retail Sales (MoM)',
      event_date: hoursAgo(16),
      impact: 'medium',
      actual: 0.3,
      estimate: 0.2,
      previous: -0.1,
      currency: 'EUR',
      run_date: today,
    },
    {
      name: 'US Retail Sales (MoM)',
      event_date: hoursAgo(8),
      impact: 'medium',
      actual: 0.5,
      estimate: 0.4,
      previous: 0.3,
      currency: 'USD',
      run_date: today,
    },

    // Past low-impact events
    {
      name: 'US Consumer Confidence',
      event_date: hoursAgo(6),
      impact: 'low',
      actual: 102.5,
      estimate: 101.0,
      previous: 99.8,
      currency: 'USD',
      run_date: today,
    },

    // Upcoming events (no actual values yet - for proximity computation)
    {
      name: 'US Nonfarm Payrolls',
      event_date: hoursFromNow(4),
      impact: 'high',
      actual: null,
      estimate: 180000,
      previous: 175000,
      currency: 'USD',
      run_date: today,
    },
    {
      name: 'Fed Rate Decision',
      event_date: hoursFromNow(18),
      impact: 'high',
      actual: null,
      estimate: 5.5,
      previous: 5.5,
      currency: 'USD',
      run_date: today,
    },
    {
      name: 'Eurozone PMI Composite',
      event_date: hoursFromNow(8),
      impact: 'medium',
      actual: null,
      estimate: 52.1,
      previous: 51.8,
      currency: 'EUR',
      run_date: today,
    },
    {
      name: 'US Initial Jobless Claims',
      event_date: hoursFromNow(12),
      impact: 'low',
      actual: null,
      estimate: 220000,
      previous: 218000,
      currency: 'USD',
      run_date: today,
    },
    {
      name: 'German Industrial Production',
      event_date: hoursFromNow(20),
      impact: 'medium',
      actual: null,
      estimate: 0.4,
      previous: 0.2,
      currency: 'EUR',
      run_date: today,
    },
  ];

  console.log(`Seeding ${events.length} economic events...`);

  const { data, error } = await supabase
    .from('economic_events')
    .upsert(events, { onConflict: 'name,event_date' })
    .select('name');

  if (error) {
    console.error('Failed to seed events:', error.message);
    process.exit(1);
  }

  console.log(`Successfully seeded ${data?.length ?? 0} economic events`);
  console.log('\nSeeded events:');
  events.forEach(e => {
    const status = e.actual !== null ? `actual=${e.actual}` : 'upcoming';
    console.log(`  [${e.impact}] ${e.name} (${e.currency}) - ${status}`);
  });
}

main().catch(console.error);
