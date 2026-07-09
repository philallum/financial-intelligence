# Adding a New Asset

This guide walks through the complete process of onboarding a new currency pair (or other asset) to the Financial Intelligence Platform.

## Prerequisites

- Node.js >= 22
- Access to the Dukascopy historical data export (or equivalent CSV source)
- A `.env` file with valid `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

## Step 1: Register the Asset

Open `src/config/research-assets.ts` and add a new entry to the `RESEARCH_ASSETS` array.

```typescript
{
  id: 'gbpusd',                          // lowercase slug, must be unique
  symbol: 'GBPUSD',                      // uppercase, 3–10 chars, must be unique
  assetClass: AssetClass.FOREX,          // FOREX | INDICES | CRYPTO | COMMODITIES | BONDS
  status: AssetStatus.ACTIVE,            // ACTIVE or BETA for new assets
  processingPriority: 2,                 // positive integer, lower = processed first
  pipSize: 0.0001,                       // pip size (0.01 for JPY pairs)
  pricePrecision: 5,                     // decimal places in price quotes
  marketHours: '24x5',                   // '24x5' for forex, '24x7' for crypto
  supportedTimeframes: ['4H'],           // only '4H' is supported currently
  providers: { twelveData: 'GBP/USD' },  // data provider symbol mapping
  engines: {
    fingerprint: true,
    similarity: true,
    confidence: true,
    tradeability: true,
    sentiment: false,
    macro: true,
  },
}
```

Key fields to get right:

| Field | Notes |
|-------|-------|
| `pipSize` | `0.0001` for most pairs, `0.01` for JPY pairs, `0.001` for gold |
| `pricePrecision` | Number of decimal places the exchange quotes (5 for most FX, 3 for JPY) |
| `processingPriority` | Determines batch processing order; assign the next available integer |
| `status` | Use `BETA` if you want the asset processable but not yet public via the API |

## Step 2: Export Historical Data from Dukascopy

1. Go to [Dukascopy Historical Data](https://www.dukascopy.com/swiss/english/marketwatch/historical/)
2. Select your currency pair
3. Set timeframe to **4 Hours (H4)**
4. Set the date range — aim for approximately **5 years** of data
5. Export as CSV

The exported file will have rows in this format:

```
DD.MM.YYYY HH:MM:SS.000,open,high,low,close,volume
```

Example:
```
06.01.2020 00:00:00.000,1.11655,1.11742,1.11589,1.11699,45832.3
```

## Step 3: Run the Bootstrap Pipeline

```bash
npx tsx scripts/bootstrap-asset.ts --asset GBPUSD --csv ./data/gbpusd-4h.csv
```

Arguments:
- `--asset` — The uppercase symbol exactly as registered in Step 1
- `--csv` — Path to the Dukascopy CSV file from Step 2

The pipeline executes these stages in sequence:

1. **Parse CSV** — Reads and parses all candle records
2. **Validate** — Checks OHLC invariants and detects gaps in the trading schedule
3. **Import candles** — Batch-upserts into `raw_candles` with deduplication
4. **Generate fingerprints** — Creates market fingerprints for each candle
5. **Compute outcomes** — Calculates forward 4H return metrics for each fingerprint
6. **Backfill topology** — Computes topology vectors using preceding candle history

## What to Expect

For a typical 5-year forex dataset (~6,500 candles):

- Runtime: 2–5 minutes depending on network latency to Supabase
- Gaps are expected and reported as warnings (holidays, data provider outages)
- The first 30 candles won't get topology vectors (insufficient history) — this is normal

A successful run prints a summary like:

```
═══════════════════════════════════════════════════════
  BOOTSTRAP PIPELINE COMPLETE
═══════════════════════════════════════════════════════
  Asset:                 GBPUSD
  CSV Path:              ./data/gbpusd-4h.csv
───────────────────────────────────────────────────────
  Candles Parsed:        6528
  Candles Imported:      6528 (new)
  Candles Skipped:       0 (duplicates)
  Fingerprints Generated:6528
  Outcomes Computed:     6527
  Topology Created:      6498
  Topology Skipped:      30
  Gaps Detected:         12
───────────────────────────────────────────────────────
  Date Range:            2020-01-06T00:00:00.000Z → 2024-12-27T20:00:00.000Z
  Elapsed Time:          187.42s
═══════════════════════════════════════════════════════
```

## Re-running is Safe

The pipeline is fully idempotent. All database operations use upsert with ignore-duplicates semantics. Running the bootstrap again with the same CSV will:

- Skip all previously imported candles
- Skip all previously generated fingerprints, outcomes, and topology vectors
- Complete quickly with 0 new inserts

This means you can safely retry after a network failure or extend an existing dataset by running again with a CSV that overlaps the previous import range.

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Asset "X" not found in RESEARCH_ASSETS registry` | Step 1 was skipped or symbol doesn't match | Add the asset to `src/config/research-assets.ts` |
| `Asset "X" has status DISABLED` | Asset exists but is disabled | Change status to `ACTIVE` or `BETA` |
| `OHLC violation at row N` | Bad data in the CSV (high < open, etc.) | Inspect the CSV row, fix or remove the corrupt candle |
| `File not found` | Wrong path to CSV | Check the `--csv` path is correct |
| `Empty file` | CSV has no data rows | Verify the Dukascopy export completed successfully |
| `Non-numeric value at row N, column "X"` | Malformed CSV row | Check for encoding issues or incomplete downloads |

## After Bootstrap

Once the pipeline completes:

- The similarity engine can immediately produce forecasts for the new asset
- The batch pipeline will begin processing new 4H candles on the next scheduled run
- The API will serve the new asset if its status is `ACTIVE`

No deployment or restart is required — the Supabase data is live immediately.
