import { useState, useCallback } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

const navLinks = [
  { to: "/playground", label: "Playground" },
  { to: "/pricing", label: "Pricing" },
  { to: "/docs", label: "Docs" },
  { to: "/roadmap", label: "Roadmap" },
  { to: "/status", label: "Status" },
];

export default function Layout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const toggleMenu = useCallback(() => {
    setMobileMenuOpen((prev) => !prev);
  }, []);

  const closeMenu = useCallback(() => {
    setMobileMenuOpen(false);
  }, []);

  return (
    <div className="flex flex-col min-h-screen font-sans">
      {/* Skip to content link for keyboard users */}
      <a
        href="#main-content"
        className="skip-link"
      >
        Skip to main content
      </a>

      <header className="sticky top-0 z-50 bg-white border-b border-gray-200">
        <nav
          className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between"
          aria-label="Primary navigation"
        >
          <Link
            to="/"
            className="text-xl font-bold text-brand-900 hover:text-brand-700 transition-colors"
            aria-label="Financial Intelligence Platform home"
          >
            FIP
          </Link>

          {/* Desktop navigation — visible on viewports ≥768px */}
          <ul className="hidden md:flex items-center gap-6 text-sm font-medium">
            {navLinks.map((link) => (
              <li key={link.to}>
                <NavLink
                  to={link.to}
                  className={({ isActive }) =>
                    `transition-colors px-1 py-1 ${
                      isActive
                        ? "text-brand-700 font-semibold"
                        : "text-gray-700 hover:text-brand-600"
                    }`
                  }
                >
                  {link.label}
                </NavLink>
              </li>
            ))}
          </ul>

          {/* Mobile hamburger button — visible below 768px */}
          <button
            type="button"
            className="md:hidden p-2 rounded-md text-gray-700 hover:bg-gray-100 transition-colors"
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-menu"
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            onClick={toggleMenu}
          >
            {mobileMenuOpen ? (
              <svg
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </nav>

        {/* Mobile menu dropdown */}
        {mobileMenuOpen && (
          <div
            id="mobile-menu"
            className="md:hidden border-t border-gray-200 bg-white"
            role="navigation"
            aria-label="Mobile navigation"
          >
            <ul className="px-4 py-3 space-y-1">
              {navLinks.map((link) => (
                <li key={link.to}>
                  <NavLink
                    to={link.to}
                    onClick={closeMenu}
                    className={({ isActive }) =>
                      `block px-3 py-2 rounded-md text-base font-medium transition-colors ${
                        isActive
                          ? "text-brand-700 bg-brand-50"
                          : "text-gray-700 hover:text-brand-600 hover:bg-gray-50"
                      }`
                    }
                  >
                    {link.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>

      <main id="main-content" className="flex-1" tabIndex={-1}>
        <Outlet />
      </main>

      <footer className="border-t border-gray-200 bg-gray-50 py-8" role="contentinfo">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-gray-600">
            <Link to="/about" className="hover:text-brand-700 transition-colors">
              About
            </Link>
            <Link to="/changelog" className="hover:text-brand-700 transition-colors">
              Changelog
            </Link>
            <Link to="/privacy" className="hover:text-brand-700 transition-colors">
              Privacy Policy
            </Link>
            <Link to="/terms" className="hover:text-brand-700 transition-colors">
              Terms of Service
            </Link>
          </div>
          <p className="mt-4 text-center text-xs text-gray-500">
            &copy; {new Date().getFullYear()} Financial Intelligence Platform. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
