import { useState, useEffect } from "react";

export interface ForecastData {
  confidence_final: number;
  direction_probabilities: {
    up: number;
    down: number;
    flat: number;
  };
  tradeability_label: string;
}

interface ForecastResponse {
  data: ForecastData;
  meta: {
    request_id: string;
    timestamp: string;
    note: string;
  };
}

interface UseForecastResult {
  data: ForecastData | null;
  loading: boolean;
  error: string | null;
}

const TIMEOUT_MS = 3000;

export function useForecast(): UseForecastResult {
  const [data, setData] = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

    fetch(`${baseUrl}/v1/forecast/EURUSD`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`API returned ${res.status}`);
        }
        return res.json() as Promise<ForecastResponse>;
      })
      .then((json) => {
        setData(json.data);
      })
      .catch((err) => {
        if (err.name === "AbortError") {
          setError("Request timed out");
        } else {
          setError(err.message ?? "Failed to fetch forecast");
        }
      })
      .finally(() => {
        clearTimeout(timeoutId);
        setLoading(false);
      });

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  return { data, loading, error };
}
