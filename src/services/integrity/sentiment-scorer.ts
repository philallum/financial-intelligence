/**
 * Gemini-Powered Sentiment Scorer
 *
 * Uses Gemini 2.5 Flash via the @google/genai SDK to score news headlines
 * for their impact on EUR/USD direction. Returns a numeric score in [-1, 1].
 *
 * Design:
 * - Batches headlines (up to 10) into a single API call to minimise costs
 * - Falls back to 0.0 (neutral) on any error (fail-forward)
 * - Rate-limited: 1.5s delay between batch calls
 * - Structured JSON output for reliable parsing
 *
 * Cost: ~$0.01-0.02 per batch of 10 headlines (Gemini 2.5 Flash pricing)
 */

import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';

// =============================================================================
// Types
// =============================================================================

export interface ScoredHeadline {
  readonly headline: string;
  readonly score: number; // [-1, 1]
}

// =============================================================================
// Client Initialisation
// =============================================================================

let genaiClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!genaiClient) {
    // Support both env var names (GCP_PROJECT_ID from config/env.ts, GOOGLE_CLOUD_PROJECT from .env)
    const project = process.env['GCP_PROJECT_ID'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? env.GCP_PROJECT_ID;
    const location = process.env['GCP_LOCATION'] ?? env.GCP_LOCATION;

    genaiClient = new GoogleGenAI({
      vertexai: true,
      project,
      location,
    });
  }
  return genaiClient;
}

// =============================================================================
// Scoring Logic
// =============================================================================

const SYSTEM_PROMPT = `You are a forex market analyst. For each headline, rate its likely impact on EUR/USD as a number from -1.0 to +1.0 where:
- -1.0 = strongly bearish for EUR/USD (EUR weakens vs USD)
- 0.0 = neutral / no directional impact
- +1.0 = strongly bullish for EUR/USD (EUR strengthens vs USD)

Consider:
- USD-positive news (strong US data, hawkish Fed) = negative score (bearish EUR/USD)
- EUR-positive news (strong EU data, hawkish ECB) = positive score (bullish EUR/USD)
- Risk-off events = typically negative (USD safe haven)
- General market noise with no FX impact = 0.0

Respond with ONLY a JSON array of numbers in the same order as the headlines. Example: [-0.3, 0.7, 0.0, -0.5]`;

/**
 * Score a batch of headlines using Gemini 2.5 Flash.
 * Returns scores in [-1, 1] for each headline, in order.
 * Falls back to 0.0 for any headline that can't be scored.
 *
 * @param headlines - Array of news headlines to score (max 10 recommended)
 * @returns Array of scores aligned with input headlines
 */
export async function scoreHeadlinesBatch(headlines: readonly string[]): Promise<number[]> {
  if (headlines.length === 0) return [];

  try {
    const client = getClient();

    const numberedList = headlines
      .map((h, i) => `${i + 1}. ${h}`)
      .join('\n');

    const response = await client.models.generateContent({
      model: env.GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [{ text: `Score these headlines for EUR/USD impact:\n\n${numberedList}` }],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.1, // Low temperature for consistent scoring
        maxOutputTokens: 256,
        thinkingConfig: { thinkingBudget: 0 }, // Disable thinking for fast classification
      },
    });

    const text = response.text?.trim() ?? '';

    // Parse JSON array from response
    const scores = parseScoresFromResponse(text, headlines.length);
    return scores;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({
      severity: 'WARNING',
      component: 'integrity',
      stage: 'sentiment_scoring',
      message: `Gemini scoring failed, returning neutral: ${message}`,
      headline_count: headlines.length,
    }));
    return headlines.map(() => 0.0);
  }
}

/**
 * Parse scores from Gemini response text.
 * Handles various response formats: JSON array, comma-separated, etc.
 * Falls back to 0.0 for unparseable values.
 */
function parseScoresFromResponse(text: string, expectedCount: number): number[] {
  // Strip markdown code block wrapping if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  // Try to extract JSON array from the response
  const jsonMatch = cleaned.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown[];
      return normaliseScores(parsed, expectedCount);
    } catch {
      // Fall through to line-by-line parsing
    }
  }

  // Try comma-separated numbers
  const numbers = cleaned.match(/-?\d+\.?\d*/g);
  if (numbers && numbers.length >= expectedCount) {
    return normaliseScores(
      numbers.slice(0, expectedCount).map(Number),
      expectedCount,
    );
  }

  // Fallback: all neutral
  return Array(expectedCount).fill(0.0);
}

/**
 * Normalise parsed values to valid scores in [-1, 1].
 */
function normaliseScores(values: unknown[], expectedCount: number): number[] {
  const result: number[] = [];

  for (let i = 0; i < expectedCount; i++) {
    const raw = values[i];
    if (typeof raw === 'number' && !Number.isNaN(raw)) {
      result.push(Math.max(-1, Math.min(1, raw)));
    } else if (typeof raw === 'string') {
      const num = parseFloat(raw);
      result.push(Number.isNaN(num) ? 0.0 : Math.max(-1, Math.min(1, num)));
    } else {
      result.push(0.0);
    }
  }

  return result;
}

/**
 * Score articles in batches with rate limiting.
 * Modifies articles in place, setting sentiment_hint based on Gemini scores.
 *
 * @param articles - Articles to score (will be mutated)
 * @param batchSize - Number of headlines per Gemini call (default 10)
 * @param delayMs - Delay between batch calls in ms (default 1500)
 */
export async function scoreArticleSentiment(
  articles: Array<{ headline: string; sentiment_hint: 'positive' | 'negative' | 'neutral' }>,
  batchSize: number = 10,
  delayMs: number = 1500,
): Promise<{ scored: number; neutral_fallback: number }> {
  let scored = 0;
  let neutralFallback = 0;

  for (let i = 0; i < articles.length; i += batchSize) {
    const batch = articles.slice(i, i + batchSize);
    const headlines = batch.map((a) => a.headline);

    const scores = await scoreHeadlinesBatch(headlines);

    for (let j = 0; j < batch.length; j++) {
      const score = scores[j] ?? 0.0;
      if (score > 0.2) {
        batch[j].sentiment_hint = 'positive';
        scored++;
      } else if (score < -0.2) {
        batch[j].sentiment_hint = 'negative';
        scored++;
      } else {
        batch[j].sentiment_hint = 'neutral';
        neutralFallback++;
      }
    }

    // Rate limit between batches (skip delay after last batch)
    if (i + batchSize < articles.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { scored, neutral_fallback: neutralFallback };
}

/**
 * Score articles and return numeric scores directly (for updating existing records).
 * Returns a map of headline → score for batch updates.
 */
export async function getNumericScores(
  headlines: readonly string[],
  batchSize: number = 10,
  delayMs: number = 1500,
): Promise<Map<string, number>> {
  const scoreMap = new Map<string, number>();

  for (let i = 0; i < headlines.length; i += batchSize) {
    const batch = headlines.slice(i, i + batchSize);
    const scores = await scoreHeadlinesBatch(batch);

    for (let j = 0; j < batch.length; j++) {
      scoreMap.set(batch[j], scores[j] ?? 0.0);
    }

    if (i + batchSize < headlines.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return scoreMap;
}
