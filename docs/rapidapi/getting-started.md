# Getting Started with the FX Intelligence API

Get probabilistic FX forecasts, tradeability scores, and market regime detection in under 2 minutes.

---

## Step 1: Subscribe to a Plan

Choose a plan on the [FX Intelligence API marketplace page](https://rapidapi.com/fx-intelligence/api/fx-intelligence-api):

| Plan | Price | Requests | Best For |
|------|-------|----------|----------|
| BASIC | Free | 100/day | Evaluating the API |
| PRO | $29/mo | 5,000/mo | Side projects and prototyping |
| ULTRA | $79/mo | 25,000/mo | Production applications |
| MEGA | $149/mo | 100,000/mo | High-frequency use cases |

After subscribing, RapidAPI provides your API key automatically.

---

## Step 2: Make Your First Request

Use the forecast endpoint to get a probabilistic prediction for EUR/USD:

### cURL

```bash
curl -X GET "https://fx-intelligence-api.p.rapidapi.com/forecast/EURUSD" \
  -H "X-RapidAPI-Key: YOUR_RAPIDAPI_KEY" \
  -H "X-RapidAPI-Host: fx-intelligence-api.p.rapidapi.com"
```

### JavaScript (fetch)

```javascript
const response = await fetch(
  'https://fx-intelligence-api.p.rapidapi.com/forecast/EURUSD',
  {
    headers: {
      'X-RapidAPI-Key': 'YOUR_RAPIDAPI_KEY',
      'X-RapidAPI-Host': 'fx-intelligence-api.p.rapidapi.com'
    }
  }
);

const result = await response.json();
console.log(result.data.tradeability_label);
// → "tradeable", "caution", or "avoid"
```

### Python (requests)

```python
import requests

url = "https://fx-intelligence-api.p.rapidapi.com/forecast/EURUSD"
headers = {
    "X-RapidAPI-Key": "YOUR_RAPIDAPI_KEY",
    "X-RapidAPI-Host": "fx-intelligence-api.p.rapidapi.com"
}

response = requests.get(url, headers=headers)
data = response.json()

print(f"Direction: {data['data']['direction_probabilities']}")
print(f"Confidence: {data['data']['confidence_final']}")
print(f"Tradeability: {data['data']['tradeability_label']}")
```

---

## Step 3: Understand the Response

A successful response looks like this:

```json
{
  "data": {
    "asset": "EURUSD",
    "direction_probabilities": {
      "up": 0.45,
      "down": 0.35,
      "flat": 0.20
    },
    "expected_move_pips": 12.5,
    "confidence_final": 0.78,
    "tradeability_score": 0.82,
    "tradeability_label": "tradeable",
    "forecast_valid_until": "2025-01-15T18:00:00Z"
  },
  "meta": {
    "request_id": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2025-01-15T14:30:00Z"
  }
}
```

### Key Fields

| Field | Description |
|-------|-------------|
| `direction_probabilities` | Probability distribution for price moving up, down, or staying flat |
| `confidence_final` | Overall confidence in the forecast (0–1) |
| `tradeability_score` | Real-time tradeability assessment (0–1, higher = more tradeable) |
| `tradeability_label` | Human-readable classification: `tradeable`, `caution`, or `avoid` |
| `expected_move_pips` | Predicted price movement magnitude in pips |
| `forecast_valid_until` | Expiry timestamp — request a fresh forecast after this time |

---

## Step 4: Explore More Endpoints

Depending on your plan, you have access to additional endpoints:

### Market State (PRO and above)

```bash
curl -X GET "https://fx-intelligence-api.p.rapidapi.com/state/EURUSD" \
  -H "X-RapidAPI-Key: YOUR_RAPIDAPI_KEY" \
  -H "X-RapidAPI-Host: fx-intelligence-api.p.rapidapi.com"
```

Returns the current market regime (e.g., `trending_bullish`, `ranging`, `volatile`).

### Historical Similarity (PRO and above)

```bash
curl -X GET "https://fx-intelligence-api.p.rapidapi.com/similarity/EURUSD?limit=5" \
  -H "X-RapidAPI-Key: YOUR_RAPIDAPI_KEY" \
  -H "X-RapidAPI-Host: fx-intelligence-api.p.rapidapi.com"
```

Returns paginated historical periods with similar market fingerprints, including similarity scores and matched regimes.

---

## Step 5: Handle Errors Gracefully

The API uses standard HTTP status codes and returns structured error responses:

```json
{
  "error": "rate_limit_exceeded",
  "message": "Rate limit exceeded. Please retry after 3600 seconds.",
  "request_id": "550e8400-e29b-41d4-a716-446655440013"
}
```

### Common Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | Parse the response |
| 400 | Bad request (invalid asset or parameter) | Check your request parameters |
| 403 | Forbidden (endpoint not in your plan) | Upgrade your plan |
| 429 | Rate limit exceeded | Wait and retry after the indicated period |
| 503 | Service temporarily unavailable | Retry with exponential backoff |

### Retry Strategy

For 429 and 503 responses, implement exponential backoff:

```python
import time
import requests

def fetch_forecast(api_key, max_retries=3):
    url = "https://fx-intelligence-api.p.rapidapi.com/forecast/EURUSD"
    headers = {
        "X-RapidAPI-Key": api_key,
        "X-RapidAPI-Host": "fx-intelligence-api.p.rapidapi.com"
    }

    for attempt in range(max_retries):
        response = requests.get(url, headers=headers)

        if response.status_code == 200:
            return response.json()

        if response.status_code in (429, 503):
            wait = 2 ** attempt  # 1s, 2s, 4s
            time.sleep(wait)
            continue

        response.raise_for_status()

    raise Exception("Max retries exceeded")
```

---

## What's Next?

- **Interactive docs**: Try endpoints directly in the [API Playground](https://api.fxintelligence.dev/docs)
- **Full reference**: See the [OpenAPI specification](https://api.fxintelligence.dev/v1/openapi.json)
- **Plan comparison**: Review [available plans and field access](#) in the pricing section

### Plan Access Summary

| Endpoint | BASIC | PRO | ULTRA | MEGA |
|----------|-------|-----|-------|------|
| `/forecast/{asset}` | ✓ | ✓ | ✓ | ✓ |
| `/state/{asset}` | — | ✓ | ✓ | ✓ |
| `/similarity/{asset}` | — | ✓ | ✓ | ✓ |
| `/health` | ✓ | ✓ | ✓ | ✓ |

### Response Field Access

| Tier (Plan) | Fields Returned |
|-------------|-----------------|
| RETAIL (BASIC) | 6 core forecast fields |
| DEVELOPER (PRO) | Core + analytics, execution metrics, similarity details |
| RESEARCH (ULTRA/MEGA) | All fields except internal debug data |

---

## Support

Having trouble? Check the [status page](https://fxintelligence.dev/status) or reach out via [support](https://fxintelligence.dev/support).
