/**
 * Backfill Sentiment Scores
 *
 * One-time script to score existing news articles that have neutral (0.0) sentiment_hint.
 * Uses Gemini 2.5 Flash to produce EUR/USD-specific sentiment scores.
 *
 * Usage: npx tsx scripts/backfill-sentiment-scores.ts
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { resolve } from 'path';
import { scoreHeadlinesBatch } from '../src/services/integrity/sentiment-scorer.js';

dotenv.config({ path: resolve(import.meta.dirname!, '..', '.env') });

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Fetch all articles with neutral sentiment (0.0 or null)
  const { data: articles, error } = await supabase
    .from('news_articles')
    .select('id, headline, sentiment_hint')
    .or('sentiment_hint.eq.0,sentiment_hint.is.null')
    .order('published_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch articles:', error.message);
    process.exit(1);
  }

  if (!articles || articles.length === 0) {
    console.log('No articles with neutral sentiment found. Nothing to backfill.');
    process.exit(0);
  }

  console.log(`Found ${articles.length} articles to score.`);

  // Score in batches of 10
  const batchSize = 10;
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < articles.length; i += batchSize) {
    const batch = articles.slice(i, i + batchSize);
    const headlines = batch.map((a) => a.headline);

    console.log(`\nBatch ${Math.floor(i / batchSize) + 1}/${Math.ceil(articles.length / batchSize)}:`);

    const scores = await scoreHeadlinesBatch(headlines);

    for (let j = 0; j < batch.length; j++) {
      const article = batch[j];
      const score = scores[j] ?? 0.0;

      // Round to 3 decimal places (matches DB numeric(4,3) column)
      const roundedScore = Math.round(score * 1000) / 1000;

      const { error: updateError } = await supabase
        .from('news_articles')
        .update({ sentiment_hint: roundedScore })
        .eq('id', article.id);

      if (updateError) {
        console.log(`  ✗ "${article.headline.slice(0, 50)}..." → update failed: ${updateError.message}`);
        failed++;
      } else {
        const label = roundedScore > 0.2 ? '📈' : roundedScore < -0.2 ? '📉' : '➖';
        console.log(`  ${label} ${roundedScore.toFixed(3)} "${article.headline.slice(0, 60)}..."`);
        updated++;
      }
    }

    // Rate limit between batches
    if (i + batchSize < articles.length) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  console.log(`\n✓ Done. Updated: ${updated}, Failed: ${failed}, Total: ${articles.length}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
