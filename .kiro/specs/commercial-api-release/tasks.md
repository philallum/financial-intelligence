# Implementation Plan: Commercial API Release

## Overview

Transform the Financial Intelligence Platform from an internal-use API into a production-ready commercial API. Implementation follows the design's priority order: authentication → rate limiting → response filtering → OpenAPI/Swagger → marketing website → RapidAPI publication → observability → customer management → analytics → CI/CD. All code is TypeScript, tested with Vitest and fast-check. The API supports dual authentication: direct API keys (Argon2id) and RapidAPI marketplace requests (proxy-secret validation with subscription-to-tier mapping).

## Tasks

- [x] 1. Database schema and data model foundation
  - [x] 1.1 Create Supabase migration for `customers` table
    - Create `supabase/migrations/` directory structure
    - Write migration SQL for `customers` table with id, email, name, tier, created_at, updated_at
    - Add UNIQUE constraint on email
    - _Requirements: 2.1, 2.2_

  - [x] 1.2 Create Supabase migration for `projects` table
    - Write migration SQL for `projects` table with id, customer_id FK, name, environment, is_active, created_at
    - Add partial unique index on (customer_id, name) WHERE is_active = true
    - Add index on customer_id WHERE is_active = true
    - _Requirements: 2.4, 2.5_

  - [x] 1.3 Create Supabase migration for updated `api_keys` table
    - Write migration SQL for `api_keys` table with project_id FK, key_hash (Argon2id), name, description, subscription_plan, is_active, rate_limit_override, daily_usage, monthly_usage, last_reset, created_at, last_used_at
    - Add partial unique index on (project_id, name) WHERE is_active = true
    - Add index on key_hash for lookup performance
    - Add index on project_id WHERE is_active = true
    - _Requirements: 1.3, 2.1, 2.2, 2.4, 5.1, 5.2, 5.3, 5.4_

  - [x] 1.4 Create Supabase migration for `subscriptions` table
    - Write migration SQL for `subscriptions` table with id, customer_id FK (UNIQUE), plan, status, current_period_start, current_period_end, created_at
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 1.5 Create TypeScript types and enums for the data model
    - Add `SubscriptionPlan` enum (FREE, STARTER, PROFESSIONAL, ENTERPRISE) to `src/types/enums.ts`
    - Update `CustomerTier` enum to match new hierarchy: RETAIL, DEVELOPER, RESEARCH, INTERNAL (remove INTEGRATOR)
    - Add TypeScript interfaces for Customer, Project, ApiKey, Subscription entities
    - Add `RapidApiSubscription` type for mapping values (BASIC, PRO, ULTRA, MEGA, CUSTOM)
    - _Requirements: 1.5, 3.1, 5.1_

  - [x] 1.6 Create seed data for local development
    - Write `supabase/seed.sql` with test customers, projects, and API keys
    - Include keys for each tier and subscription plan combination
    - _Requirements: 2.1, 2.2_

- [x] 2. Authentication middleware (dual-auth: Argon2id + RapidAPI proxy-secret)
  - [x] 2.1 Implement Argon2id key hashing and verification utilities
    - Install `argon2` npm package
    - Create `src/api/utils/key-hash.ts` with `hashApiKey(plaintext) → hash` and `verifyApiKey(plaintext, hash) → boolean` functions using Argon2id with OWASP-recommended parameters
    - Replace SHA-256 hashing in auth flow
    - _Requirements: 1.3, 2.1_

  - [x] 2.2 Write property test for API key verification round-trip
    - **Property 1: API Key Verification Round-Trip**
    - **Validates: Requirements 1.3, 2.1**
    - File: `tests/property/auth-key-roundtrip.property.test.ts`
    - Generator: random strings (1–256 chars, all byte values)

  - [x] 2.3 Implement RapidAPI subscription-to-tier mapping utility
    - Create `src/api/utils/rapidapi-tier-map.ts`
    - Implement `RAPIDAPI_TIER_MAP` constant: BASIC→RETAIL, PRO→DEVELOPER, ULTRA→RESEARCH, MEGA→RESEARCH, CUSTOM→RESEARCH
    - Implement `resolveRapidApiTier(subscription: string): CustomerTier` returning mapped tier or RETAIL for unknown values
    - Implement `isRapidApiRequest(req: Request): boolean` checking X-RapidAPI-Proxy-Secret against configured RAPIDAPI_PROXY_SECRET env var
    - _Requirements: 5.8_

  - [x] 2.4 Rewrite auth middleware with dual-auth: Argon2id + RapidAPI proxy-secret
    - Refactor `src/api/middleware/auth.ts` to:
      - **RapidAPI path**: Check X-RapidAPI-Proxy-Secret header first — if it matches configured secret (from Secret Manager), resolve tier via `resolveRapidApiTier`, set `req.isMarketplaceRequest = true`, set `req.rapidApiUser` and `req.rapidApiSubscription`, skip API key validation
      - **Direct path**: Extract key from X-API-Key (priority) or Authorization Bearer (Req 1.8), verify against Argon2id hash via project → customer chain, resolve CustomerTier from customer record and SubscriptionPlan from key record
      - Attach tier, subscriptionPlan, apiKeyId, projectId, customerId, requestId, anonymous, rapidApiUser, rapidApiSubscription, isMarketplaceRequest to request
      - Fire-and-forget async update of usage counter and last_used_at (Req 1.6)
      - Return 503 with retry_after_seconds if Supabase is unreachable (Req 1.7)
      - Log `new_ip_detected` events for audit (Req 15.4)
      - Support anonymous access for GET /v1/forecast/EURUSD without auth
      - X-API-Key takes priority over Authorization Bearer when both present (Req 1.8)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 5.8, 15.4_

  - [x] 2.5 Write unit tests for auth middleware (both paths)
    - Test missing key → 401 (Req 1.1)
    - Test invalid key → 401 (Req 1.2)
    - Test revoked key → 401 (Req 1.4)
    - Test X-API-Key priority over Bearer (Req 1.8)
    - Test DB unreachable → 503 (Req 1.7)
    - Test valid key resolves correct tier and plan (Property 2)
    - Test valid RapidAPI proxy-secret sets isMarketplaceRequest=true and resolves tier from subscription header
    - Test invalid/missing proxy-secret falls through to direct path
    - Test req.rapidApiUser and req.rapidApiSubscription populated for marketplace requests
    - File: `tests/unit/auth-middleware.test.ts`
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.7, 1.8, 5.8_

  - [x] 2.6 Write unit test for RapidAPI subscription tier mapping
    - **Property 21: RapidAPI Subscription Tier Mapping**
    - **Validates: Requirements 5.8, 4.1, 4.2, 4.3**
    - Test BASIC→RETAIL, PRO→DEVELOPER, ULTRA→RESEARCH, MEGA→RESEARCH
    - Test unknown subscription value → defaults to RETAIL
    - Test response filtering uses the mapped tier correctly
    - File: `tests/unit/rapidapi-tier-mapping.test.ts`

- [x] 3. Authorisation middleware
  - [x] 3.1 Implement authorisation middleware with tier hierarchy and deny-by-default
    - Create `src/api/middleware/authorisation.ts`
    - Define ENDPOINT_METADATA with path, minimumTier, version, status, allowAnonymous fields
    - Implement tier hierarchy comparison: RETAIL < DEVELOPER < RESEARCH < INTERNAL
    - Return 403 with error code "forbidden" without revealing required tier (Req 3.3)
    - Deny-by-default for endpoints not in ENDPOINT_METADATA (Req 3.5)
    - Allow anonymous access to /v1/forecast when allowAnonymous is true
    - Works for both direct and RapidAPI requests (uses req.tier regardless of source)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 3.2 Write unit tests for authorisation middleware
    - Test all tier × endpoint combinations (Property 3)
    - Test 403 response does not leak tier requirements (Property 4)
    - Test deny-by-default for unknown endpoints (Req 3.5)
    - Test anonymous access bypass for allowed endpoints
    - File: `tests/unit/authorisation-middleware.test.ts`
    - _Requirements: 3.1, 3.2, 3.3, 3.5_

- [x] 4. Rate limiting
  - [x] 4.1 Implement rate limiter middleware with database-backed counters
    - Create `src/api/middleware/rate-limiter.ts`
    - Read daily_usage / monthly_usage from api_keys table
    - Reset counter if last_reset is before current period start (midnight UTC for daily, 1st of month for monthly)
    - Enforce plan limits: FREE=100/day, STARTER=5000/month, PROFESSIONAL=25000/month, ENTERPRISE=rate_limit_override or 25000/month
    - Return 429 with limit, reset time (ISO 8601 UTC), retry_after_seconds (Req 5.5)
    - Bypass rate limiting when `req.isMarketplaceRequest === true` (RapidAPI handles quotas at proxy layer)
    - Add rate limit response headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset (Req 13.4)
    - Single UPDATE per request to api_keys row
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 13.4_

  - [x] 4.2 Write property test for rate limiter logic
    - **Property 6: Rate Limiter Enforces Plan Quotas**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
    - File: `tests/property/rate-limiter.property.test.ts`
    - Generator: random plan × usage count; verify allow/reject decision

  - [x] 4.3 Write property test for rate limit scope isolation
    - **Property 7: Rate Limit Scope Isolation**
    - **Validates: Requirements 5.7**
    - File: `tests/property/rate-limiter.property.test.ts` (additional test case)
    - Generator: pairs of random key IDs with independent counters

  - [x] 4.4 Write unit test for RapidAPI marketplace bypass
    - **Property 8: RapidAPI Proxy Bypass**
    - **Validates: Requirements 5.8**
    - File: `tests/unit/rate-limiter.test.ts`
    - Test req.isMarketplaceRequest=true bypasses rate limiting regardless of usage count
    - Test direct requests (isMarketplaceRequest=false) still subject to rate limiting
    - _Requirements: 5.8_

- [~] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Response filtering by tier
  - [x] 6.1 Rewrite response filter for tier-based field stripping
    - Refactor `src/api/middleware/response-filter.ts` to implement new tier-based filtering:
      - RETAIL: direction_probabilities, expected_move_pips, confidence_final, tradeability_score, tradeability_label, forecast_valid_until
      - DEVELOPER: RETAIL fields + state_layers, layer_breakdown, similarity_matches, match_explanation, contributing_factors, execution_metrics
      - RESEARCH: DEVELOPER fields + historical_distributions, time_series_data, research_metadata minus trace_id_internal, pipeline_debug, raw_engine_logs
      - INTERNAL: complete unfiltered payload
      - Anonymous: confidence_final, direction_probabilities, tradeability_label only
      - Default to RETAIL filtering when tier is missing (Req 4.6)
    - Works identically for direct and RapidAPI requests (uses req.tier set by auth middleware)
    - Remove old mode-based filtering; replace with tier-only approach
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 6.2 Write property test for tier-based response filtering
    - **Property 5: Tier-Based Response Filtering**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**
    - File: `tests/property/response-filter.property.test.ts`
    - Generator: random objects with arbitrary field sets × all tiers + anonymous

- [x] 7. Security hardening middleware
  - [x] 7.1 Implement security headers middleware
    - Create `src/api/middleware/security.ts`
    - Set X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Strict-Transport-Security: max-age=31536000; includeSubDomains, X-XSS-Protection: 0
    - Enforce HTTPS in production via X-Forwarded-Proto check (Req 15.3)
    - _Requirements: 15.1, 15.3_

  - [x] 7.2 Implement request ID middleware
    - Create `src/api/middleware/request-id.ts`
    - Assign UUID v4 to every request, attach to req.requestId and X-Request-ID response header
    - _Requirements: 10.1_

  - [x] 7.3 Implement size guard middleware
    - Create `src/api/middleware/size-guard.ts`
    - Reject request bodies > 1MB with HTTP 413, error code "payload_too_large" (Req 15.2)
    - Reject URLs > 2048 characters and query param values > 512 characters with HTTP 414, error code "uri_too_long" (Req 15.5)
    - _Requirements: 15.2, 15.5_

  - [x] 7.4 Write property test for security headers
    - **Property 13: Security Headers Present on All Responses**
    - **Validates: Requirements 15.1**
    - File: `tests/property/security-headers.property.test.ts`
    - Generator: random request methods and paths

  - [x] 7.5 Write property test for size guard
    - **Property 14: Request Size Rejection**
    - **Validates: Requirements 15.2, 15.5**
    - File: `tests/property/size-guard.property.test.ts`
    - Generator: random bodies near and above 1MB boundary

- [x] 8. API response envelope and error handling
  - [x] 8.1 Implement consistent response envelope wrapper
    - Create `src/api/utils/response-envelope.ts` with helpers:
      - `successResponse(data, requestId)` → `{ data, meta: { request_id, timestamp } }`
      - `errorResponse(error, message, requestId)` → `{ error, message, request_id }`
    - _Requirements: 6.2, 6.3, 6.4_

  - [x] 8.2 Implement global error handler
    - Create `src/api/middleware/error-handler.ts`
    - Catch unhandled exceptions, emit structured log to stdout, return sanitised 500 response
    - Strip stack traces, file paths, DB queries, internal addresses from response body (Req 14.2)
    - Include request_id in all error responses
    - _Requirements: 14.2, 14.3_

  - [x] 8.3 Implement HTTP 405 method not allowed handler
    - Add method-not-allowed middleware for unsupported HTTP methods on each route
    - Return error code "method_not_allowed" with Allow header listing supported methods (Req 14.5)
    - _Requirements: 14.5_

  - [x] 8.4 Write property test for error sanitisation
    - **Property 17: Internal Error Sanitisation**
    - **Validates: Requirements 14.2**
    - File: `tests/property/error-sanitisation.property.test.ts`
    - Generator: errors containing paths, stack traces, queries, internal addresses

  - [x] 8.5 Write property test for unsupported asset error
    - **Property 16: Unsupported Asset Error**
    - **Validates: Requirements 14.1**
    - File: `tests/property/asset-validation.property.test.ts`
    - Generator: random non-supported asset strings

- [x] 9. Refactor route handlers and wire middleware chain
  - [x] 9.1 Refactor forecast route for anonymous access and response envelope
    - Update `src/api/routes/forecast.ts` to:
      - Allow anonymous access to GET /v1/forecast/EURUSD (no auth required)
      - Apply IP-based rate limit of 60 req/min for anonymous requests (Req 13.5)
      - Return anonymous subset: { confidence_final, direction_probabilities, tradeability_label } with meta.note
      - Wrap authenticated responses in standard envelope format
      - Handle unsupported assets with consistent error response
    - _Requirements: 13.1, 13.2, 13.5, 14.1, 6.2, 6.3_

  - [x] 9.2 Refactor similarity route with pagination support
    - Update `src/api/routes/similarity.ts` to:
      - Support limit (1–100, default 20) and offset (≥0, default 0) query parameters
      - Return paginated response with { data, pagination: { total, limit, offset, has_more }, meta }
      - Validate pagination params; return 400 with "invalid_parameter" for invalid values (Req 6.6)
      - Wrap response in standard envelope format
    - _Requirements: 6.5, 6.6_

  - [x] 9.3 Refactor state route with response envelope
    - Update `src/api/routes/state.ts` to use consistent response envelope format
    - _Requirements: 6.2, 6.3_

  - [x] 9.4 Wire complete middleware chain in server.ts
    - Update `src/api/server.ts` to wire middleware in the correct order:
      1. Security headers
      2. Request ID
      3. Size guard
      4. CORS
      5. Auth middleware (skipped for public routes: /health, /v1/forecast/EURUSD anonymous, /v1/openapi.json, /docs)
      6. Authorisation middleware
      7. Rate limiter (skipped for RapidAPI requests via req.isMarketplaceRequest)
      8. Response filter (wraps response, uses req.tier from either auth path)
      9. Edge cache
      10. Route handlers
    - Register /health endpoint, global error handler, 405 handler
    - _Requirements: 3.4, 6.1, 10.3, 15.1_

  - [x] 9.5 Write property tests for pagination correctness
    - **Property 10: Pagination Correctness**
    - **Validates: Requirements 6.5**
    - File: `tests/property/pagination.property.test.ts`
    - Generator: random dataset sizes (0–500), limit (1–100), offset (0–500)

  - [x] 9.6 Write property test for invalid pagination rejection
    - **Property 11: Invalid Pagination Rejection**
    - **Validates: Requirements 6.6**
    - File: `tests/property/pagination.property.test.ts` (additional test case)
    - Generator: invalid limit/offset values (negative, float, string, >100)

  - [x] 9.7 Write unit test for anonymous forecast restricted fields
    - **Property 20: Anonymous Forecast Returns Restricted Fields**
    - **Validates: Requirements 13.1, 13.2**
    - File: `tests/unit/anonymous-forecast.test.ts`
    - _Requirements: 13.1, 13.2_

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Structured logging and health endpoint
  - [~] 11.1 Implement structured logging middleware
    - Create `src/api/middleware/request-logger.ts`
    - Emit structured JSON to stdout for every request: request_id, method, path, status_code, response_time_ms, customer_tier, subscription_plan, timestamp (ISO 8601 UTC)
    - Include `is_marketplace_request` field in log entries for RapidAPI traffic distinction
    - Log warning-level entry when response_time_ms > 1000ms (Req 10.5)
    - _Requirements: 10.2, 10.5_

  - [~] 11.2 Enhance health endpoint with dependency checks
    - Update /health endpoint to:
      - Perform lightweight `SELECT 1` against Supabase with 5000ms timeout
      - Return { status: "healthy"|"degraded", database: "connected"|"disconnected", timestamp }
      - Always return HTTP 200 regardless of dependency state (Req 10.3)
      - Return "degraded" if check times out (Req 10.6)
    - _Requirements: 10.3, 10.6_

- [ ] 12. OpenAPI specification and Swagger UI
  - [~] 12.1 Create OpenAPI 3.1 specification document
    - Create `src/api/openapi/openapi.yaml` (or .json) defining all non-Internal endpoints
    - Include request parameters, response schemas with field types and constraints
    - Include authentication requirements (X-API-Key header) — do NOT include X-RapidAPI-* headers (RapidAPI adds those automatically)
    - Add example request/response pairs for each endpoint
    - Add x-codeSamples annotations for cURL, JavaScript (fetch), Python (requests)
    - Set info.version to 1.0.0 with semantic versioning
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [~] 12.2 Implement build-time OpenAPI generation and static serving
    - Add build script to generate `/v1/openapi.json` from the spec source
    - Serve OpenAPI spec statically at GET /v1/openapi.json (no auth required, Content-Type: application/json)
    - Return 503 if spec file is missing or unreadable (Req 7.6)
    - _Requirements: 7.1, 7.6_

  - [~] 12.3 Integrate Swagger UI at /docs
    - Install `swagger-ui-express` or serve Swagger UI static assets
    - Mount at /docs route powered by the OpenAPI spec (no auth required)
    - _Requirements: 13.3_

- [ ] 13. Rate limit headers and developer onboarding response
  - [~] 13.1 Add rate limit headers to all authenticated responses
    - Modify rate limiter middleware to set X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers on every authenticated response
    - For RapidAPI requests: omit internal rate limit headers (RapidAPI provides its own)
    - _Requirements: 13.4_

  - [ ] 13.2 Write unit test for rate limit headers
    - **Property 15: Rate Limit Headers on Authenticated Responses**
    - **Validates: Requirements 13.4**
    - File: `tests/unit/rate-limit-headers.test.ts`
    - Verify headers are present and valid on all direct authenticated responses
    - Verify headers are omitted for RapidAPI marketplace requests
    - _Requirements: 13.4_

- [ ] 14. API lifecycle and deprecation support
  - [~] 14.1 Implement deprecation header middleware
    - Create `src/api/middleware/deprecation.ts`
    - For endpoints with status "deprecated" in ENDPOINT_METADATA, add Sunset and Deprecation headers in RFC 9110 format
    - Add Link header pointing to migration guide URL
    - _Requirements: 12.2, 12.3_

  - [ ] 14.2 Write unit test for deprecation headers
    - **Property 19: Deprecated Endpoint Headers**
    - **Validates: Requirements 12.2**
    - File: `tests/unit/deprecation-headers.test.ts`
    - Test deprecated endpoints include correct Sunset and Deprecation headers
    - _Requirements: 12.2_

- [~] 15. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Marketing website
  - [~] 16.1 Scaffold React + Vite + Tailwind website project
    - Create `website/` directory with Vite React TypeScript template
    - Install Tailwind CSS and configure
    - Set up project structure: pages/, components/, hooks/, assets/
    - Configure Firebase Hosting deployment in `firebase.json`
    - _Requirements: 9.1, 9.2_

  - [~] 16.2 Implement website pages and navigation
    - Build pages: Home (hero with live demo preview, value proposition), API Playground, Pricing, Documentation, Status, About, Privacy Policy, Terms of Service
    - Implement responsive navigation visible without scrolling on viewports ≥768px
    - Use ≤2 typeface families, consistent spacing scale
    - Ensure WCAG 2.1 Level AA compliance: 4.5:1 colour contrast, keyboard navigation
    - Include RapidAPI Marketplace link/badge as alternative purchase channel on Pricing page
    - _Requirements: 9.3, 9.4, 9.7_

  - [~] 16.3 Implement live data fetching from anonymous forecast endpoint
    - Create hook to fetch GET /v1/forecast/EURUSD from the API
    - Display confidence, direction probabilities, tradeability label on Home page
    - Implement 3-second timeout and graceful fallback to static placeholders (Req 9.6)
    - _Requirements: 9.5, 9.6_

  - [~] 16.4 Optimise for performance targets
    - Ensure LCP ≤ 2500ms and CLS ≤ 0.1 on 4G connection
    - Lazy-load non-critical assets, optimise images, minimise JS bundle
    - Test with Lighthouse
    - _Requirements: 9.8_

- [ ] 17. RapidAPI Marketplace publication
  - [~] 17.1 Store RAPIDAPI_PROXY_SECRET in Secret Manager
    - Create secret `RAPIDAPI_PROXY_SECRET` in Google Cloud Secret Manager
    - Update Cloud Run service configuration to mount secret as environment variable
    - Add `RAPIDAPI_PROXY_SECRET` to `src/config/env.ts` for typed access
    - Update `.env.example` with placeholder for local development
    - _Requirements: 5.8, 16.1_

  - [~] 17.2 Prepare RapidAPI Studio listing configuration
    - Create `docs/rapidapi/` directory with listing preparation files
    - Write `docs/rapidapi/listing-config.md` documenting:
      - General Tab: API name ("FX Intelligence API"), description, category (Finance), logo asset
      - Definitions Tab: instructions to upload the OpenAPI 3.1 spec from /v1/openapi.json
      - Gateway Tab: base URL configuration (Cloud Run service URL + /v1 prefix)
      - Security Tab: note that no additional auth scheme needed (proxy-secret validates origin)
      - Monetize Tab: BASIC (Free, 100 req/day), PRO ($29/mo, 5000 req/mo), ULTRA ($79/mo, 25000 req/mo), MEGA ($149/mo, 100000 req/mo)
      - Docs Tab: Getting Started guide content
    - Create `docs/rapidapi/getting-started.md` for the marketplace documentation
    - _Requirements: 5.8_

  - [~] 17.3 Validate OpenAPI spec for RapidAPI compatibility
    - Ensure spec does NOT include X-RapidAPI-* headers in security schemes (RapidAPI adds those)
    - Ensure all endpoints have descriptions, parameter tables, and response examples
    - Ensure spec conforms to RapidAPI marketplace documentation format requirements (Req 8.2)
    - Test spec upload against RapidAPI's validation (or use their CLI/preview tool)
    - _Requirements: 7.1, 7.2, 8.2_

- [ ] 18. Customer and API key management utilities
  - [~] 18.1 Implement key creation utility with Argon2id hashing
    - Create `src/api/services/key-management.ts` with functions:
      - `createApiKey(projectId, name, description, subscriptionPlan)` → returns plaintext key once, stores Argon2id hash
      - `revokeApiKey(keyId)` → marks key as inactive without deleting
      - Enforce max 20 active keys per project (Req 2.5)
      - Enforce unique name among active keys per project (Req 2.6)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ] 18.2 Write unit test for key creation constraints
    - **Property 12: Key Creation Constraints**
    - **Validates: Requirements 2.5, 2.6**
    - File: `tests/unit/key-management.test.ts`
    - Test 20-key limit and name uniqueness enforcement
    - _Requirements: 2.5, 2.6_

- [ ] 19. Integration tests
  - [ ] 19.1 Write integration tests for complete request lifecycle
    - Test full middleware chain execution order (security → request-id → size-guard → cors → auth → authorisation → rate-limiter → response-filter → route)
    - Test authenticated direct request end-to-end
    - Test anonymous forecast end-to-end
    - Test rate limit counter persistence and reset
    - Test key creation and revocation workflow
    - File: `tests/integration/full-middleware-chain.test.ts`
    - _Requirements: 3.4, 6.2, 6.3_

  - [ ] 19.2 Write integration test for RapidAPI marketplace request end-to-end
    - Test complete flow: valid X-RapidAPI-Proxy-Secret → tier mapping from X-RapidAPI-Subscription → response filtering using mapped tier → no internal rate limit hit
    - Test with each subscription level: BASIC (RETAIL fields), PRO (DEVELOPER fields), ULTRA/MEGA (RESEARCH fields)
    - Verify req.isMarketplaceRequest=true, req.rapidApiUser, req.rapidApiSubscription populated
    - Verify rate limiter is bypassed (no X-RateLimit-* headers)
    - File: `tests/integration/rapidapi-integration.test.ts`
    - _Requirements: 5.8, 4.1, 4.2, 4.3_

  - [ ] 19.3 Write integration tests for customer and project management
    - Test Customer → Project → Key hierarchy
    - Test tier inheritance from customer to key
    - File: `tests/integration/customer-projects.test.ts`
    - _Requirements: 2.1, 2.4_

- [ ] 20. CI/CD and deployment configuration
  - [~] 20.1 Update Cloud Build configuration for API deployment
    - Update `cloudbuild.yaml` to include:
      - OpenAPI spec generation step
      - Run tests (vitest --run)
      - Build TypeScript
      - Build and push Docker image
      - Deploy to Cloud Run with max 2 instances
    - Configure RAPIDAPI_PROXY_SECRET secret mounting in Cloud Run service YAML
    - _Requirements: 16.2, 16.4_

  - [~] 20.2 Add Firebase Hosting deployment configuration for marketing website
    - Create `website/firebase.json` with hosting configuration
    - Add deployment script or CI step for `firebase deploy --only hosting`
    - _Requirements: 9.2, 16.4_

- [~] 21. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using `fast-check`
- Unit tests validate specific examples and edge cases using `vitest`
- The existing batch pipeline remains completely untouched (Req 16.5)
- No request_log table — all observability via stdout → Cloud Logging (design decision)
- No /v1/metrics or /v1/changelog endpoints (design decision — use Cloud Monitoring dashboards)
- Anonymous access to GET /v1/forecast/EURUSD replaces a separate /v1/demo endpoint
- RapidAPI dual-auth model: proxy-secret for marketplace, own API keys for direct customers
- RapidAPI handles consumer auth + rate limiting; we validate proxy-secret and map subscription tiers
- Property 21 (RapidAPI tier mapping) is validated with unit tests, not PBT
- RAPIDAPI_PROXY_SECRET stored in Secret Manager, mounted as env var in Cloud Run
- RapidAPI publication (task 17) is prioritised BEFORE operational tooling per design principle: "Early customer feedback > perfect dashboards"

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.5"] },
    { "id": 1, "tasks": ["1.3", "1.4", "1.6"] },
    { "id": 2, "tasks": ["2.1", "2.3", "7.1", "7.2", "7.3"] },
    { "id": 3, "tasks": ["2.2", "2.4", "7.4", "7.5"] },
    { "id": 4, "tasks": ["2.5", "2.6", "3.1", "8.1", "8.2", "8.3"] },
    { "id": 5, "tasks": ["3.2", "4.1", "8.4", "8.5"] },
    { "id": 6, "tasks": ["4.2", "4.3", "4.4", "6.1"] },
    { "id": 7, "tasks": ["6.2", "9.1", "9.2", "9.3"] },
    { "id": 8, "tasks": ["9.4", "9.5", "9.6", "9.7"] },
    { "id": 9, "tasks": ["11.1", "11.2", "12.1", "13.1"] },
    { "id": 10, "tasks": ["12.2", "12.3", "13.2", "14.1"] },
    { "id": 11, "tasks": ["14.2", "16.1", "17.1", "18.1"] },
    { "id": 12, "tasks": ["16.2", "16.3", "17.2", "18.2"] },
    { "id": 13, "tasks": ["16.4", "17.3", "19.1", "19.2", "19.3"] },
    { "id": 14, "tasks": ["20.1", "20.2"] }
  ]
}
```
