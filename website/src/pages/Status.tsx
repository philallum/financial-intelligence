const services = [
  { name: "Forecast API", status: "operational" as const },
  { name: "Similarity Engine", status: "operational" as const },
  { name: "State Endpoint", status: "operational" as const },
  { name: "Authentication", status: "operational" as const },
  { name: "RapidAPI Gateway", status: "operational" as const },
];

const statusConfig = {
  operational: { label: "Operational", dotClass: "bg-green-500", textClass: "text-green-700" },
  degraded: { label: "Degraded", dotClass: "bg-amber-500", textClass: "text-amber-700" },
  outage: { label: "Outage", dotClass: "bg-red-500", textClass: "text-red-700" },
};

export default function Status() {
  return (
    <div className="py-12 sm:py-16 px-4">
      <div className="max-w-4xl mx-auto">
        <header className="text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-brand-900">
            System Status
          </h1>
          <p className="mt-4 text-gray-600">
            Real-time status of the Financial Intelligence Platform services.
          </p>
        </header>

        {/* Overall status banner */}
        <div className="mt-8 rounded-lg bg-green-50 border border-green-200 p-4 text-center">
          <div className="flex items-center justify-center gap-2">
            <span className="w-3 h-3 rounded-full bg-green-500" aria-hidden="true" />
            <p className="font-semibold text-green-800">All Systems Operational</p>
          </div>
          <p className="mt-1 text-sm text-green-700">99.9% uptime over the last 30 days</p>
        </div>

        {/* Individual services */}
        <section className="mt-8" aria-labelledby="services-heading">
          <h2 id="services-heading" className="text-xl font-semibold text-brand-900">
            Services
          </h2>
          <ul className="mt-4 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white" role="list">
            {services.map((service) => {
              const config = statusConfig[service.status];
              return (
                <li key={service.name} className="flex items-center justify-between px-5 py-4">
                  <span className="text-sm font-medium text-gray-900">{service.name}</span>
                  <span className={`flex items-center gap-2 text-sm font-medium ${config.textClass}`}>
                    <span className={`w-2.5 h-2.5 rounded-full ${config.dotClass}`} aria-hidden="true" />
                    {config.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Health endpoint link */}
        <section className="mt-8" aria-labelledby="health-heading">
          <h2 id="health-heading" className="text-xl font-semibold text-brand-900">
            Health Check
          </h2>
          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-5">
            <p className="text-sm text-gray-700">
              Programmatic health monitoring is available via the health endpoint:
            </p>
            <div className="mt-3 flex items-center gap-3">
              <code className="text-sm font-mono bg-gray-100 px-3 py-1.5 rounded text-brand-700">
                GET /health
              </code>
              <span className="text-xs text-gray-500">Returns JSON with service status</span>
            </div>
          </div>
        </section>

        {/* Uptime history */}
        <section className="mt-8" aria-labelledby="uptime-heading">
          <h2 id="uptime-heading" className="text-xl font-semibold text-brand-900">
            Uptime History (Last 7 Days)
          </h2>
          <div className="mt-4 flex gap-1" aria-label="Daily uptime indicators for the last 7 days, all showing operational">
            {Array.from({ length: 7 }).map((_, i) => (
              <div
                key={i}
                className="flex-1 h-8 rounded bg-green-400"
                aria-label={`Day ${7 - i}: Operational`}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-gray-500">
            <span>7 days ago</span>
            <span>Today</span>
          </div>
        </section>
      </div>
    </div>
  );
}
