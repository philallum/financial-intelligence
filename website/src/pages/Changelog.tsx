const releases = [
  {
    version: "1.2.0",
    date: "2025-06-15",
    type: "feature" as const,
    changes: [
      "Added historical similarity endpoint with outcome tracking",
      "Improved confidence intervals using regime-aware calibration",
      "New tradeability score included in state response",
    ],
  },
  {
    version: "1.1.0",
    date: "2025-05-20",
    type: "feature" as const,
    changes: [
      "Multi-horizon forecasts (1h, 4h, 1d) now available",
      "Added pagination support for similarity results",
      "RapidAPI Marketplace integration launched",
    ],
  },
  {
    version: "1.0.1",
    date: "2025-05-01",
    type: "fix" as const,
    changes: [
      "Fixed rate limiter not resetting at window boundaries",
      "Improved error messages for invalid API key format",
      "Resolved edge cache returning stale data after regime change",
    ],
  },
  {
    version: "1.0.0",
    date: "2025-04-15",
    type: "feature" as const,
    changes: [
      "Initial public release of the Financial Intelligence API",
      "EUR/USD probabilistic forecasting endpoint",
      "Market regime classification (trending, ranging, volatile)",
      "OpenAPI 3.1 specification with Swagger UI",
      "Tiered access: Free, Starter, Professional, Enterprise",
    ],
  },
];

const typeStyles = {
  feature: { label: "Feature", classes: "bg-green-100 text-green-800" },
  fix: { label: "Fix", classes: "bg-amber-100 text-amber-800" },
  breaking: { label: "Breaking", classes: "bg-red-100 text-red-800" },
};

export default function Changelog() {
  return (
    <div className="py-12 sm:py-16 px-4">
      <div className="max-w-4xl mx-auto">
        <header className="text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-brand-900">
            Changelog
          </h1>
          <p className="mt-4 text-gray-600 max-w-2xl mx-auto">
            Track all updates, improvements, and fixes to the Financial Intelligence API.
          </p>
        </header>

        <section className="mt-12 space-y-8" aria-label="Release history">
          {releases.map((release) => (
            <article key={release.version} className="rounded-lg border border-gray-200 bg-white p-6">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-bold font-mono text-brand-900">
                  v{release.version}
                </h2>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${typeStyles[release.type].classes}`}
                >
                  {typeStyles[release.type].label}
                </span>
                <time className="text-sm text-gray-500 sm:ml-auto" dateTime={release.date}>
                  {new Date(release.date).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </time>
              </div>
              <ul className="mt-4 space-y-2" role="list">
                {release.changes.map((change) => (
                  <li key={change} className="flex items-start gap-2 text-sm text-gray-700">
                    <svg
                      className="w-4 h-4 mt-0.5 text-gray-400 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={2}
                      stroke="currentColor"
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                    {change}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
