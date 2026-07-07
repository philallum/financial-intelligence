import LiveForecast from "../components/LiveForecast";

export default function Home() {
  return (
    <div className="font-sans">
      {/* Hero section */}
      <section className="bg-brand-50 py-16 sm:py-20 lg:py-28 px-4">
        <div className="max-w-5xl mx-auto text-center">
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-brand-900 leading-tight">
            Probabilistic FX Forecasting
          </h1>
          <p className="mt-4 sm:mt-6 text-lg sm:text-xl text-gray-700 max-w-3xl mx-auto">
            Institutional-grade EUR/USD intelligence powered by regime detection,
            historical pattern recognition, and real-time tradeability scoring.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
            <a
              href="/playground"
              className="inline-flex items-center justify-center px-6 py-3 rounded-lg bg-brand-700 text-white font-semibold hover:bg-brand-800 transition-colors"
            >
              Try Live Demo
            </a>
            <a
              href="/docs"
              className="inline-flex items-center justify-center px-6 py-3 rounded-lg border-2 border-brand-700 text-brand-700 font-semibold hover:bg-brand-50 transition-colors"
            >
              View Documentation
            </a>
          </div>
        </div>
      </section>

      {/* Live demo preview */}
      <section className="py-12 sm:py-16 px-4 bg-white" aria-labelledby="demo-heading">
        <div className="max-w-5xl mx-auto">
          <h2 id="demo-heading" className="sr-only">
            Live Forecast Preview
          </h2>
          <LiveForecast />
        </div>
      </section>

      {/* Value proposition cards */}
      <section className="py-12 sm:py-16 px-4 bg-gray-50" aria-labelledby="features-heading">
        <div className="max-w-6xl mx-auto">
          <h2 id="features-heading" className="text-2xl sm:text-3xl font-bold text-brand-900 text-center">
            Intelligence, Not Endpoints
          </h2>
          <p className="mt-3 text-center text-gray-600 max-w-2xl mx-auto">
            We deliver actionable financial intelligence — the API is simply how it reaches you.
          </p>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <article className="bg-white rounded-lg p-6 shadow-sm border border-gray-100">
              <div className="w-10 h-10 rounded-md bg-brand-100 flex items-center justify-center mb-4" aria-hidden="true">
                <svg className="w-5 h-5 text-brand-700" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-brand-900">Probabilistic Forecasting</h3>
              <p className="mt-2 text-gray-600 text-sm">
                Multi-horizon EUR/USD probability distributions with confidence intervals,
                not single-point predictions.
              </p>
            </article>

            <article className="bg-white rounded-lg p-6 shadow-sm border border-gray-100">
              <div className="w-10 h-10 rounded-md bg-brand-100 flex items-center justify-center mb-4" aria-hidden="true">
                <svg className="w-5 h-5 text-brand-700" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-brand-900">Real-time Tradeability</h3>
              <p className="mt-2 text-gray-600 text-sm">
                Dynamic scoring that evaluates current market conditions against
                historical regimes to assess execution risk.
              </p>
            </article>

            <article className="bg-white rounded-lg p-6 shadow-sm border border-gray-100">
              <div className="w-10 h-10 rounded-md bg-brand-100 flex items-center justify-center mb-4" aria-hidden="true">
                <svg className="w-5 h-5 text-brand-700" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-brand-900">Historical Similarity Engine</h3>
              <p className="mt-2 text-gray-600 text-sm">
                Pattern matching across decades of FX data to identify analogous
                market conditions and their outcomes.
              </p>
            </article>
          </div>
        </div>
      </section>

      {/* Technical features — below the fold */}
      <section className="py-12 sm:py-16 px-4 bg-white" aria-labelledby="tech-heading">
        <div className="max-w-4xl mx-auto text-center">
          <h2 id="tech-heading" className="text-2xl font-bold text-brand-900">
            Built for Production
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="p-4 rounded-lg bg-gray-50">
              <p className="font-mono text-sm font-medium text-brand-700">REST API</p>
              <p className="mt-1 text-xs text-gray-600">JSON responses</p>
            </div>
            <div className="p-4 rounded-lg bg-gray-50">
              <p className="font-mono text-sm font-medium text-brand-700">RapidAPI</p>
              <p className="mt-1 text-xs text-gray-600">Marketplace available</p>
            </div>
            <div className="p-4 rounded-lg bg-gray-50">
              <p className="font-mono text-sm font-medium text-brand-700">99.9%</p>
              <p className="mt-1 text-xs text-gray-600">Uptime SLA</p>
            </div>
            <div className="p-4 rounded-lg bg-gray-50">
              <p className="font-mono text-sm font-medium text-brand-700">OpenAPI</p>
              <p className="mt-1 text-xs text-gray-600">Full spec docs</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
