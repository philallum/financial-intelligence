export default function About() {
  return (
    <div className="py-12 sm:py-16 px-4">
      <div className="max-w-4xl mx-auto">
        <header className="text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-brand-900">
            About
          </h1>
          <p className="mt-4 text-gray-600 max-w-2xl mx-auto">
            Building institutional-grade financial intelligence, accessible to everyone.
          </p>
        </header>

        <section className="mt-12 space-y-8">
          <article>
            <h2 className="text-xl font-semibold text-brand-900">Our Mission</h2>
            <p className="mt-3 text-gray-700 leading-relaxed">
              The Financial Intelligence Platform exists to democratise access to
              sophisticated FX analysis. We believe that probabilistic forecasting,
              regime detection, and historical pattern recognition should not be
              exclusive to institutional trading desks with million-dollar budgets.
            </p>
          </article>

          <article>
            <h2 className="text-xl font-semibold text-brand-900">What We Do</h2>
            <p className="mt-3 text-gray-700 leading-relaxed">
              We combine advanced statistical methods — including topological data
              analysis, regime classification, and calibrated probability distributions —
              to deliver actionable EUR/USD intelligence. Our engine analyses decades of
              market data in real time to identify patterns, quantify uncertainty, and
              score current conditions for tradeability.
            </p>
          </article>

          <article>
            <h2 className="text-xl font-semibold text-brand-900">Our Approach</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="p-4 rounded-lg bg-gray-50 border border-gray-100">
                <h3 className="font-semibold text-brand-900">Research-Driven</h3>
                <p className="mt-2 text-sm text-gray-600">
                  Every model is backtested, calibrated, and continuously evaluated against
                  live market outcomes.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-gray-50 border border-gray-100">
                <h3 className="font-semibold text-brand-900">Transparent</h3>
                <p className="mt-2 text-sm text-gray-600">
                  We provide confidence intervals and regime context — never black-box
                  predictions.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-gray-50 border border-gray-100">
                <h3 className="font-semibold text-brand-900">Production-Grade</h3>
                <p className="mt-2 text-sm text-gray-600">
                  99.9% uptime SLA, structured logging, and comprehensive monitoring
                  for enterprise reliability.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-gray-50 border border-gray-100">
                <h3 className="font-semibold text-brand-900">Developer-First</h3>
                <p className="mt-2 text-sm text-gray-600">
                  OpenAPI spec, interactive Swagger UI, and clear error messages
                  for fast integration.
                </p>
              </div>
            </div>
          </article>

          <article>
            <h2 className="text-xl font-semibold text-brand-900">Contact</h2>
            <p className="mt-3 text-gray-700">
              Have questions or want to discuss an Enterprise integration?
              Reach out at{" "}
              <a
                href="mailto:hello@fip.dev"
                className="text-brand-700 hover:text-brand-800 underline"
              >
                hello@fip.dev
              </a>
            </p>
          </article>
        </section>
      </div>
    </div>
  );
}
