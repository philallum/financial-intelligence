import { createClient } from '@supabase/supabase-js';
import { env } from './src/config/env.js';

async function main() {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data, error, count } = await supabase
    .from('economic_events')
    .select('*', { count: 'exact' })
    .order('event_date', { ascending: false })
    .limit(10);

  console.log('Total count:', count);
  console.log('Error:', error?.message || 'none');
  if (data && data.length > 0) {
    console.log('Latest events:');
    data.forEach((e: any) => console.log(`  [${e.impact}] ${e.name} - ${e.currency} - ${e.event_date} (actual: ${e.actual}, estimate: ${e.estimate})`));
  } else {
    console.log('No economic events found in database');
  }

  // Also check news_articles
  const { data: newsData, count: newsCount } = await supabase
    .from('news_articles')
    .select('*', { count: 'exact' })
    .order('published_at', { ascending: false })
    .limit(5);

  console.log('\nNews articles count:', newsCount);
  if (newsData && newsData.length > 0) {
    console.log('Latest articles:');
    newsData.forEach((a: any) => console.log(`  [${a.relevance_score}] ${a.headline} - ${a.asset_id} - ${a.published_at}`));
  }
}

main().catch(console.error);
