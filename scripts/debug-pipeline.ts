import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { generateFingerprint } from '../src/engines/fingerprint-engine.js';

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // 1. Get latest candle
  const { data: latestCandle } = await supabase
    .from('raw_candles')
    .select('*')
    .eq('asset', 'EURUSD')
    .order('timestamp_utc', { ascending: false })
    .limit(1)
    .single();

  console.log('Latest candle:', latestCandle?.timestamp_utc);

  // 2. Generate fingerprint
  const fp = generateFingerprint({
    asset: 'EURUSD',
    timestamp_utc: latestCandle.timestamp_utc,
    ohlc: { open: Number(latestCandle.open), high: Number(latestCandle.high), low: Number(latestCandle.low), close: Number(latestCandle.close) },
  });
  console.log('Fingerprint ID:', fp.fingerprint_id);

  // 3. Query candidates (same as batch-entry)
  const { data: candidates, error } = await supabase
    .from('market_fingerprints')
    .select('fingerprint_id')
    .eq('asset', 'EURUSD')
    .eq('timeframe', '4H')
    .neq('fingerprint_id', fp.fingerprint_id)
    .limit(50);

  console.log('Candidates from DB:', candidates?.length, 'error:', error?.message);

  if (!candidates || candidates.length === 0) {
    console.log('NO CANDIDATES — this is why outcome fails');
    process.exit(0);
  }

  // 4. Check if outcomes exist for these candidate IDs
  const ids = candidates.map((c: any) => c.fingerprint_id);
  console.log('Sample candidate IDs:', ids.slice(0, 3));

  const { data: outcomes, error: oErr } = await supabase
    .from('market_outcomes')
    .select('fingerprint_id, net_return_pips')
    .in('fingerprint_id', ids.slice(0, 10));

  console.log('Outcomes for candidates:', outcomes?.length, 'error:', oErr?.message);
  if (outcomes && outcomes.length > 0) {
    console.log('Sample outcome:', outcomes[0]);
  } else {
    console.log('NO OUTCOMES for these candidate IDs');
  }
}

main().catch(console.error);
