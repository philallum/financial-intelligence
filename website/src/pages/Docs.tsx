const docSections = [
  {
    title: "Getting Started",
    description: "Authentication, API keys, and your first request.",
    icon: (
      <svg className="w-5 h-5 text-brand-700" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.841m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
      </svg>
    ),
  },
  {
    title: "Forecast Endpoint",
    description: "Retrieve probabilistic EUR/USD forecasts across multiple horizons.",
    icon: (
      <svg className="w-5 h-5 text-brand-700" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
      </svg>
    ),
  },
  {
    title: "Similarity Endpoint",
    description: "Find historical periods matching current market conditions.",
    icon: (
      <svg className="w-5 h-5 text-brand-700" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
      </svg>
    ),
  },
  {
    title: "State Endpoint",
    description: "Current market regime classification and tradeability score.",
    icon: (
      <svg className="w-5 h-5 text-brand-700" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    title: "Authentication & Rate Limits",
    description: "API key management, tier-based rate limiting, and RapidAPI integration.",
    icon: (
      <svg className="w-5 h-5 text-brand-700" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
  },
  {
    title: "Error Handling",
    description: "Standard error codes, response envelope format, and retry strategies.",
    icon: (
      <svg className="w-5 h-5 text-brand-700" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
    ),
  },
];

export default function Docs() {
  return (
    <div className="py-12 sm:py-16 px-4">
      <div className="max-w-5xl mx-auto">
        <header className="text-center">
          <h1 className="text-3xl sm:text-4xl font-bold text-brand-900">
            Documentation
          </h1>
          <p className="mt-4 text-gray-600 max-w-2xl mx-auto">
            Everything you need to integrate the Financial Intelligence API.
            Full interactive docs are available via Swagger UI.
          </p>
          <a
            href="/playground"
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand-700 text-white text-sm font-medium hover:bg-brand-800 transition-colors"
          >
            Open API Playground
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </a>
        </header>

        {/* Documentation sections grid */}
        <section className="mt-12" aria-labelledby="sections-heading">
          <h2 id="sections-heading" className="sr-only">Documentation Sections</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {docSections.map((section) => (
              <article
                key={section.title}
                className="p-5 rounded-lg border border-gray-200 bg-white hover:border-brand-300 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-md bg-brand-50 flex items-center justify-center shrink-0">
                    {section.icon}
                  </div>
                  <div>
                    <h3 className="font-semibold text-brand-900">{section.title}</h3>
                    <p className="mt-1 text-sm text-gray-600">{section.description}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* Quick reference */}
        <section className="mt-12" aria-labelledby="quickref-heading">
          <h2 id="quickref-heading" className="text-xl font-semibold text-brand-900">
            Quick Reference
          </h2>
          <div className="mt-4 rounded-lg border border-gray-200 bg-white p-5">
            <dl className="space-y-3 text-sm">
              <div className="flex flex-col sm:flex-row sm:gap-4">
                <dt className="font-semibold text-gray-900 sm:w-40 shrink-0">Base URL</dt>
                <dd className="font-mono text-brand-700">https://api.fip.dev/v1</dd>
              </div>
              <div className="flex flex-col sm:flex-row sm:gap-4">
                <dt className="font-semibold text-gray-900 sm:w-40 shrink-0">Authentication</dt>
                <dd className="text-gray-700">API key via <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">X-API-Key</code> header</dd>
              </div>
              <div className="flex flex-col sm:flex-row sm:gap-4">
                <dt className="font-semibold text-gray-900 sm:w-40 shrink-0">Response Format</dt>
                <dd className="text-gray-700">JSON with standard envelope</dd>
              </div>
              <div className="flex flex-col sm:flex-row sm:gap-4">
                <dt className="font-semibold text-gray-900 sm:w-40 shrink-0">OpenAPI Spec</dt>
                <dd className="font-mono text-brand-700">/v1/openapi.json</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>
    </div>
  );
}
