export default function Terms() {
  return (
    <div className="py-12 sm:py-16 px-4">
      <div className="max-w-3xl mx-auto">
        <header>
          <h1 className="text-3xl sm:text-4xl font-bold text-brand-900">
            Terms of Service
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Last updated: June 15, 2025
          </p>
        </header>

        <div className="mt-8 space-y-8 text-gray-700 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-brand-900">1. Acceptance of Terms</h2>
            <p className="mt-3">
              By accessing or using the Financial Intelligence Platform API ("Service"),
              you agree to be bound by these Terms of Service. If you do not agree to
              these terms, do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">2. Service Description</h2>
            <p className="mt-3">
              The Financial Intelligence Platform provides probabilistic EUR/USD
              forecasting, historical pattern analysis, and market regime classification
              via a REST API. The Service is provided "as is" and is intended for
              informational purposes only.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">3. Not Financial Advice</h2>
            <p className="mt-3">
              The information provided through the Service does not constitute financial,
              investment, trading, or other advice. You should not treat any of the
              Service's content as such. We do not recommend that any financial instrument
              should be bought, sold, or held by you.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">4. API Usage</h2>
            <ul className="mt-3 list-disc pl-6 space-y-1 text-sm">
              <li>You must use a valid API key for authenticated requests</li>
              <li>You must not exceed your plan's rate limits</li>
              <li>You must not redistribute raw API data without permission</li>
              <li>You must not use the Service for any illegal purpose</li>
              <li>You must not attempt to reverse-engineer the underlying models</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">5. Service Level Agreement</h2>
            <p className="mt-3">
              We target 99.9% uptime for paid tiers. The Free tier is provided
              on a best-effort basis with no uptime guarantee. Scheduled maintenance
              windows are communicated at least 48 hours in advance via the Status page.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">6. Intellectual Property</h2>
            <p className="mt-3">
              The Service, including its algorithms, models, and documentation,
              is protected by intellectual property laws. Your subscription grants
              you a limited, non-exclusive license to use the API output in your
              own applications.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">7. Limitation of Liability</h2>
            <p className="mt-3">
              To the maximum extent permitted by law, we shall not be liable for any
              indirect, incidental, special, consequential, or punitive damages,
              including loss of profits, data, or trading losses, whether based on
              warranty, contract, tort, or any other legal theory.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">8. Termination</h2>
            <p className="mt-3">
              We may terminate or suspend your access immediately, without prior notice,
              for conduct that we believe violates these Terms or is harmful to other
              users or the Service. You may cancel your subscription at any time.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">9. Changes to Terms</h2>
            <p className="mt-3">
              We reserve the right to modify these terms at any time. Material changes
              will be communicated with at least 30 days notice. Continued use of the
              Service after changes constitutes acceptance of the modified terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-brand-900">10. Contact</h2>
            <p className="mt-3">
              For questions about these Terms, contact us at{" "}
              <a href="mailto:legal@fip.dev" className="text-brand-700 hover:text-brand-800 underline">
                legal@fip.dev
              </a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
