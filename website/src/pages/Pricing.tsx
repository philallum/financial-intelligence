const tiers = [
  {
    name: "Free",
    price: "$0",
    period: "/month",
    description: "Get started with basic forecasts",
    features: [
      "10 requests/day",
      "EUR/USD forecast (restricted fields)",
      "1-hour horizon only",
      "Community support",
    ],
    cta: "Get Started",
    highlighted: false,
  },
  {
    name: "Starter",
    price: "$49",
    period: "/month",
    description: "For individual traders and researchers",
    features: [
      "1,000 requests/day",
      "Full forecast data",
      "All horizons (1h, 4h, 1d)",
      "Historical similarity access",
      "Email support",
    ],
    cta: "Start Free Trial",
    highlighted: false,
  },
  {
    name: "Professional",
    price: "$199",
    period: "/month",
    description: "For teams and systematic strategies",
    features: [
      "10,000 requests/day",
      "Full forecast + tradeability",
      "All horizons + regime data",
      "Historical similarity + outcomes",
      "Priority support",
      "Webhook notifications",
    ],
    cta: "Start Free Trial",
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "For institutions with custom needs",
    features: [
      "Unlimited requests",
      "Full API access",
      "Custom SLA (99.99%)",
      "Dedicated account manager",
      "On-premise deployment option",
      "Custom integrations",
    ],
    cta: "Contact Sales",
    highlighted: false,
  },
];

export default function Pricing() {
  return (
    <div className="py-12 sm:py-16 px-4">
      <div className="max-w-7xl mx-auto">
        <header className="text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-brand-900">
            Simple, Transparent Pricing
          </h1>
          <p className="mt-4 text-gray-600 max-w-2xl mx-auto">
            Choose the plan that matches your trading volume. All plans include
            access to our probabilistic forecasting engine.
          </p>
        </header>

        {/* Pricing grid */}
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {tiers.map((tier) => (
            <article
              key={tier.name}
              className={`rounded-lg border p-6 flex flex-col ${
                tier.highlighted
                  ? "border-brand-700 ring-2 ring-brand-700 bg-white"
                  : "border-gray-200 bg-white"
              }`}
            >
              {tier.highlighted && (
                <span className="self-start mb-3 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-100 text-brand-700">
                  Most Popular
                </span>
              )}
              <h2 className="text-xl font-bold text-brand-900">{tier.name}</h2>
              <p className="mt-1 text-sm text-gray-600">{tier.description}</p>
              <p className="mt-4">
                <span className="text-3xl font-bold text-brand-900">{tier.price}</span>
                <span className="text-sm text-gray-500">{tier.period}</span>
              </p>
              <ul className="mt-6 space-y-2 flex-1" role="list">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-gray-700">
                    <svg
                      className="w-4 h-4 mt-0.5 text-green-600 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={2.5}
                      stroke="currentColor"
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={`mt-6 w-full py-2.5 px-4 rounded-md text-sm font-semibold transition-colors ${
                  tier.highlighted
                    ? "bg-brand-700 text-white hover:bg-brand-800"
                    : "border border-brand-700 text-brand-700 hover:bg-brand-50"
                }`}
              >
                {tier.cta}
              </button>
            </article>
          ))}
        </div>

        {/* RapidAPI alternative purchase channel */}
        <section className="mt-12 text-center" aria-labelledby="rapidapi-heading">
          <h2 id="rapidapi-heading" className="text-lg font-semibold text-brand-900">
            Also Available on RapidAPI
          </h2>
          <p className="mt-2 text-sm text-gray-600 max-w-xl mx-auto">
            Prefer to manage your subscriptions through RapidAPI? Our full API is
            available on the RapidAPI Marketplace with the same tier options.
          </p>
          <a
            href="https://rapidapi.com/hub"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors"
            aria-label="Subscribe on RapidAPI Marketplace (opens in new tab)"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
            </svg>
            Subscribe on RapidAPI
          </a>
        </section>
      </div>
    </div>
  );
}
