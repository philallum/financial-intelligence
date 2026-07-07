const roadmapItems = [
  {
    quarter: "Q3 2025",
    status: "in-progress" as const,
    items: [
      "Multi-pair support (GBP/USD, USD/JPY)",
      "Webhook notifications for regime changes",
      "Enhanced similarity engine with outcome tracking",
    ],
  },
  {
    quarter: "Q4 2025",
    status: "planned" as const,
    items: [
      "Portfolio-level risk aggregation",
      "Custom model training for Enterprise tier",
      "Python & TypeScript SDK packages",
    ],
  },
  {
    quarter: "Q1 2026",
    status: "planned" as const,
    items: [
      "Real-time streaming via WebSocket",
      "Advanced backtesting API",
      "Multi-factor regime classification",
    ],
  },
  {
    quarter: "Q2 2026",
    status: "exploring" as const,
    items: [
      "Options-implied probability integration",
      "Cross-asset correlation engine",
      "Natural language market summaries",
    ],
  },
];

const statusStyles = {
  "in-progress": { label: "In Progress", classes: "bg-green-100 text-green-800" },
  planned: { label: "Planned", classes: "bg-blue-100 text-blue-800" },
  exploring: { label: "Exploring", classes: "bg-amber-100 text-amber-800" },
};

export default function Roadmap() {
  return (
    <div className="py-12 sm:py-16 px-4">
      <div className="max-w-4xl mx-auto">
        <header className="text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-brand-900">
            Roadmap
          </h1>
          <p className="mt-4 text-gray-600 max-w-2xl mx-auto">
            See what we're building next. Our roadmap is driven by user feedback
            and market needs.
          </p>
        </header>

        {/* Timeline */}
        <section className="mt-12 space-y-8" aria-label="Product roadmap timeline">
          {roadmapItems.map((quarter) => (
            <article
              key={quarter.quarter}
              className="relative pl-6 border-l-2 border-gray-200"
            >
              <div className="absolute left-[-9px] top-0 w-4 h-4 rounded-full bg-white border-2 border-brand-700" aria-hidden="true" />
              <div className="flex flex-wrap items-center gap-3 mb-3">
                <h2 className="text-lg font-bold text-brand-900">{quarter.quarter}</h2>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusStyles[quarter.status].classes}`}
                >
                  {statusStyles[quarter.status].label}
                </span>
              </div>
              <ul className="space-y-2" role="list">
                {quarter.items.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-gray-700">
                    <svg
                      className="w-4 h-4 mt-0.5 text-brand-500 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={2}
                      stroke="currentColor"
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                    {item}
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
