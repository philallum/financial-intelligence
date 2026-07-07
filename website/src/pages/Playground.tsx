export default function Playground() {
  return (
    <div className="py-12 sm:py-16 px-4">
      <div className="max-w-5xl mx-auto">
        <header className="text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-brand-900">
            API Playground
          </h1>
          <p className="mt-4 text-gray-600 max-w-2xl mx-auto">
            Explore the Financial Intelligence API interactively. Try endpoints,
            view responses, and integrate faster.
          </p>
        </header>

        {/* Swagger UI embed area */}
        <section className="mt-10" aria-labelledby="swagger-heading">
          <h2 id="swagger-heading" className="text-xl font-semibold text-brand-900">
            Interactive API Explorer
          </h2>
          <div className="mt-4 rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="p-6 text-center bg-gray-50 border-b border-gray-200">
              <p className="text-sm text-gray-600">
                The full interactive Swagger UI is available at the API documentation endpoint.
              </p>
              <a
                href="/docs"
                className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand-700 text-white text-sm font-medium hover:bg-brand-800 transition-colors"
                aria-label="Open Swagger UI documentation"
              >
                Open Swagger UI
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </a>
            </div>

            {/* Quick-try example */}
            <div className="p-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Quick Example</h3>
              <div className="bg-gray-900 rounded-md p-4 overflow-x-auto">
                <pre className="text-sm text-green-400 font-mono">
{`GET /v1/forecast/EURUSD

{
  "data": {
    "pair": "EURUSD",
    "horizon": "1h",
    "probability_up": 0.62,
    "probability_down": 0.38,
    "confidence": 0.74,
    "regime": "trending"
  }
}`}
                </pre>
              </div>
            </div>
          </div>
        </section>

        {/* Available endpoints overview */}
        <section className="mt-10" aria-labelledby="endpoints-heading">
          <h2 id="endpoints-heading" className="text-xl font-semibold text-brand-900">
            Available Endpoints
          </h2>
          <div className="mt-4 space-y-3">
            {[
              { method: "GET", path: "/v1/forecast/EURUSD", desc: "Current forecast with probability distributions" },
              { method: "GET", path: "/v1/similarity/EURUSD", desc: "Historical pattern matches for current conditions" },
              { method: "GET", path: "/v1/state", desc: "Current market regime and tradeability score" },
              { method: "GET", path: "/health", desc: "Service health check" },
            ].map((endpoint) => (
              <div key={endpoint.path} className="flex flex-col sm:flex-row sm:items-center gap-2 p-4 rounded-md border border-gray-200 bg-white">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-bold bg-green-100 text-green-800 shrink-0">
                  {endpoint.method}
                </span>
                <code className="text-sm font-mono text-brand-900">{endpoint.path}</code>
                <span className="text-sm text-gray-500 sm:ml-auto">{endpoint.desc}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
