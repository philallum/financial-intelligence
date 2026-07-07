import { useForecast } from "../hooks/useForecast";

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-5 bg-gray-200 rounded w-1/3 mx-auto" />
      <div className="h-8 bg-gray-200 rounded w-1/2 mx-auto" />
      <div className="flex gap-4 justify-center">
        <div className="h-16 w-24 bg-gray-200 rounded" />
        <div className="h-16 w-24 bg-gray-200 rounded" />
        <div className="h-16 w-24 bg-gray-200 rounded" />
      </div>
      <div className="h-6 bg-gray-200 rounded w-1/4 mx-auto" />
    </div>
  );
}

function ErrorPlaceholder() {
  return (
    <div className="text-center py-8 px-4 border border-gray-200 rounded-lg bg-gray-50">
      <svg
        className="mx-auto h-10 w-10 text-gray-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 9v3m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <p className="mt-3 text-sm text-gray-600">
        Live data temporarily unavailable
      </p>
      <p className="mt-1 text-xs text-gray-400">
        Please check back shortly
      </p>
    </div>
  );
}

function tradeabilityColor(label: string): string {
  switch (label.toUpperCase()) {
    case "HIGH":
      return "bg-green-100 text-green-800";
    case "MODERATE":
      return "bg-yellow-100 text-yellow-800";
    case "LOW":
      return "bg-red-100 text-red-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
}

function DirectionBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex-1 text-center">
      <p className="text-xs font-medium text-gray-500 uppercase mb-1">
        {label}
      </p>
      <div className="w-full bg-gray-200 rounded-full h-2">
        <div
          className="bg-blue-600 h-2 rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-sm font-semibold text-gray-900 mt-1">{pct}%</p>
    </div>
  );
}

export default function LiveForecast() {
  const { data, loading, error } = useForecast();

  return (
    <section
      className="max-w-xl mx-auto mt-12 p-6 border border-gray-200 rounded-xl bg-white shadow-sm min-h-[280px]"
      aria-label="Live EUR/USD forecast preview"
    >
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide text-center mb-4">
        Live EUR/USD Forecast Preview
      </h2>

      {loading && <LoadingSkeleton />}

      {!loading && error && <ErrorPlaceholder />}

      {!loading && data && (
        <div className="space-y-5">
          {/* Confidence */}
          <div className="text-center">
            <p className="text-xs font-medium text-gray-500 uppercase">
              Confidence
            </p>
            <p className="text-3xl font-bold text-gray-900">
              {Math.round(data.confidence_final * 100)}%
            </p>
          </div>

          {/* Direction Probabilities */}
          <div className="flex gap-4">
            <DirectionBar label="Up" value={data.direction_probabilities.up} />
            <DirectionBar
              label="Down"
              value={data.direction_probabilities.down}
            />
            <DirectionBar
              label="Flat"
              value={data.direction_probabilities.flat}
            />
          </div>

          {/* Tradeability Label */}
          <div className="text-center">
            <span
              className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${tradeabilityColor(data.tradeability_label)}`}
            >
              Tradeability: {data.tradeability_label}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
