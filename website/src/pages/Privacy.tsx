export default function Privacy() {
  return (
    <div className="py-12 sm:py-16 px-4">
      <div className="max-w-3xl mx-auto">
        <header>
          <h1 className="text-3xl sm:text-4xl font-bold text-brand-900">
            Privacy Policy
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Last updated: June 15, 2025
          </p>
        </header>

        <div className="mt-8 space-y-8 text-gray-700 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-brand-900">1. Information We Collect</h2>
            <p className="mt-3">
              When you use the Financial Intelligence Platform API, we collect:
            </p>
            <ul className="mt-3 list-disc pl-6 space-y-1 text-sm">
              <li>Account information (email address, API key identifier)</li>
              <li>Usage data (API requests, timestamps, endpoints accessed)</li>
              <li>Technical data (IP address, user agent, request headers)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">2. How We Use Your Information</h2>
            <p className="mt-3">We use collected information to:</p>
            <ul className="mt-3 list-disc pl-6 space-y-1 text-sm">
              <li>Provide and maintain the API service</li>
              <li>Enforce rate limits and usage quotas</li>
              <li>Monitor for abuse and security threats</li>
              <li>Improve service performance and reliability</li>
              <li>Communicate service updates and changes</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">3. Data Retention</h2>
            <p className="mt-3">
              Request logs are retained for 30 days for operational purposes.
              Account information is retained for the duration of your subscription
              and for 90 days after account deletion to handle any outstanding
              billing matters.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">4. Data Sharing</h2>
            <p className="mt-3">
              We do not sell your personal information. We may share data with:
            </p>
            <ul className="mt-3 list-disc pl-6 space-y-1 text-sm">
              <li>Infrastructure providers (Google Cloud Platform) for service delivery</li>
              <li>RapidAPI for marketplace subscription management</li>
              <li>Law enforcement when legally required</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">5. Security</h2>
            <p className="mt-3">
              We implement industry-standard security measures including encryption
              in transit (TLS 1.3), hashed API key storage, and access controls.
              No system is 100% secure, and we cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">6. Your Rights</h2>
            <p className="mt-3">
              You have the right to access, correct, or delete your personal data.
              Contact us at{" "}
              <a href="mailto:privacy@fip.dev" className="text-brand-700 hover:text-brand-800 underline">
                privacy@fip.dev
              </a>{" "}
              to exercise these rights.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">7. Changes to This Policy</h2>
            <p className="mt-3">
              We may update this policy from time to time. We will notify you of
              material changes via email or a notice on our website at least 30 days
              before the changes take effect.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
