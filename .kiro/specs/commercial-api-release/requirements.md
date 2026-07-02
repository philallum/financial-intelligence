# Requirements Document

## Introduction

Transform the Financial Intelligence Platform from an internal-use API into a production-ready commercial API suitable for publication on the RapidAPI Marketplace, direct developer customers, research customers, and a future SaaS website. The platform must remain fully compatible with the existing batch-driven architecture, stay within a £50/month infrastructure budget, and be maintainable by a solo developer. This initiative covers API security, customer tiering, endpoint authorisation, rate limiting, RapidAPI readiness, documentation, a marketing website, operational observability, commercial analytics, API lifecycle management, and developer onboarding.

## Glossary

- **Platform**: The Financial Intelligence Platform — the complete system including batch pipeline, REST API, and database
- **API_Gateway**: The Express-based API server that serves forecast, similarity, and state endpoints via Cloud Run
- **Auth_Middleware**: The middleware component responsible for extracting, validating, and resolving API keys from incoming requests
- **Authorisation_Middleware**: The middleware component that verifies a caller's Customer_Tier has permission to access the requested endpoint
- **Response_Filter**: The middleware component that strips response fields based on the caller's Customer_Tier and requested response mode
- **Rate_Limiter**: The component responsible for enforcing request quotas per API key based on Subscription_Plan
- **Key_Store**: The Supabase database table (api_keys) that stores Argon2id-hashed API keys, tier assignments, rate limit configuration, and usage metadata
- **Customer_Tier**: A classification (Internal, Retail, Developer, Research) that determines which endpoints and response fields a caller may access
- **Subscription_Plan**: A rate-limit tier (Free, Starter, Professional, Enterprise) that determines how many requests a caller may make per billing period
- **OpenAPI_Spec**: The machine-readable API specification document in OpenAPI 3.1 format used for documentation generation and SDK compatibility
- **Marketing_Website**: A lightweight React/TypeScript/Vite/Tailwind static website deployed to Firebase Hosting that presents the platform to potential customers, hosts documentation, and provides an API playground
- **Request_ID**: A unique identifier (UUID v4) assigned to every API request for tracing and debugging purposes
- **Health_Endpoint**: A monitoring endpoint that reports the operational status of the API and its dependencies
- **Endpoint_Metadata**: Structured annotations on each API endpoint defining its purpose, minimum tier, version, status, and documentation URL
- **Deprecation_Window**: The minimum period (12 months) between announcing an endpoint deprecation and removing it

## Requirements

### Requirement 1: API Key Authentication

**User Story:** As an API consumer, I want to authenticate using an API key, so that my requests are securely associated with my account and tier.

#### Acceptance Criteria

1. WHEN a request is received without an API key in the X-API-Key header or Authorization Bearer header, THE Auth_Middleware SHALL return HTTP 401 with error code "unauthorized" and a message indicating the key is missing
2. WHEN a request contains an API key that does not match any active record in the Key_Store, THE Auth_Middleware SHALL return HTTP 401 with error code "unauthorized" and a message indicating the key is invalid
3. WHEN validating an API key against stored hashes, THE Auth_Middleware SHALL use Argon2id hashing following current OWASP recommendations for key verification
4. WHEN a request contains a valid API key that has been revoked or disabled, THE Auth_Middleware SHALL return HTTP 401 with error code "unauthorized" and a message indicating the key has been deactivated
5. WHEN a request contains a valid and active API key, THE Auth_Middleware SHALL resolve the associated Customer_Tier and Subscription_Plan, then attach both to the request context before passing control to the next middleware
6. WHEN a valid request is processed, THE Auth_Middleware SHALL asynchronously update the usage counter and last_used_at timestamp for the API key in the Key_Store without blocking the response to the caller, and SHALL allow the request to proceed even if the usage update fails
7. IF the Key_Store is unreachable during API key validation, THEN THE Auth_Middleware SHALL return HTTP 503 with error code "service_unavailable" and a retry_after_seconds value
8. WHEN a request provides an API key in both the X-API-Key header and the Authorization Bearer header, THE Auth_Middleware SHALL use the X-API-Key header value and ignore the Authorization Bearer value
9. THE Auth_Middleware SHALL complete API key validation and tier resolution within 500ms under normal operating conditions

### Requirement 2: API Key Management

**User Story:** As a platform operator, I want to create, revoke, and manage multiple named API keys, so that I can control access and customers can organise keys by purpose.

#### Acceptance Criteria

1. WHEN a new API key is created, THE Key_Store SHALL store only the Argon2id hash of the key using current OWASP-recommended parameters, never the plaintext value, and SHALL return the plaintext key exactly once in the creation response
2. WHEN a new API key is created, THE Key_Store SHALL associate the key with a Customer_Tier, a Subscription_Plan, a human-readable name (1 to 64 characters, allowing letters, digits, spaces, hyphens, and underscores), and an optional description (maximum 256 characters)
3. WHEN an API key is revoked, THE Key_Store SHALL mark the key as inactive without deleting the record
4. THE Key_Store SHALL maintain the following metadata for each API key: key_hash, name, description, tier, subscription_plan, is_active, created_at, last_used_at, request_count, and rate_limit_override
5. THE Key_Store SHALL support a maximum of 20 active API keys per customer, each with a name that is unique among that customer's active keys
6. IF a key creation request specifies a name that already exists among the customer's active keys, THEN THE Key_Store SHALL reject the request with an error indicating the key name is already in use

### Requirement 3: Endpoint Authorisation

**User Story:** As a platform operator, I want endpoints protected by minimum tier requirements, so that customers cannot access data above their authorisation level.

#### Acceptance Criteria

1. THE Authorisation_Middleware SHALL enforce the following Customer_Tier hierarchy from lowest to highest privilege: Retail < Developer < Research < Internal, where each tier inherits access to all endpoints available to tiers below it
2. THE Authorisation_Middleware SHALL enforce the following minimum tier requirements: /v1/forecast requires Retail or above, /v1/state requires Developer or above, /v1/similarity requires Developer or above, /v1/metrics requires Internal only
3. WHEN a request's Customer_Tier is below the minimum tier for the requested endpoint, THE Authorisation_Middleware SHALL return HTTP 403 with error code "forbidden" and a message indicating the endpoint is not available for the caller's tier, without revealing which tier is required
4. THE Authorisation_Middleware SHALL execute after Auth_Middleware and before Rate_Limiter in the middleware chain
5. IF a request targets an endpoint that has no minimum tier defined in Endpoint_Metadata, THEN THE Authorisation_Middleware SHALL deny access by returning HTTP 403 with error code "forbidden" (deny-by-default)
6. WHEN a new endpoint is added, THE Endpoint_Metadata SHALL define the minimum required Customer_Tier before the endpoint is deployed

### Requirement 4: Customer Tier Response Filtering

**User Story:** As a platform operator, I want API responses filtered by customer tier, so that each tier receives only the data fields they are authorised to access.

#### Acceptance Criteria

1. WHILE a request is associated with the Retail tier, THE Response_Filter SHALL return only the following fields: direction_probabilities, expected_move_pips, confidence_final, tradeability_score, tradeability_label, and forecast_valid_until, excluding all other fields present in the full response payload
2. WHILE a request is associated with the Developer tier, THE Response_Filter SHALL return the Retail tier fields plus the following additional fields: state_layers, layer_breakdown, similarity_matches, match_explanation, contributing_factors, and execution_metrics
3. WHILE a request is associated with the Research tier, THE Response_Filter SHALL return all Developer tier fields plus historical_distributions, time_series_data, and research_metadata, excluding only fields designated as internal debugging data (trace_id_internal, pipeline_debug, raw_engine_logs)
4. WHILE a request is associated with the Internal tier, THE Response_Filter SHALL return the complete unfiltered response payload with no field restrictions
5. THE Response_Filter SHALL strip restricted fields from the response before serialisation, ensuring no tier receives fields outside its authorised set regardless of response mode requested
6. IF the request has no recognised Customer_Tier or the tier value is missing, THEN THE Response_Filter SHALL apply Retail-level filtering as the default, returning only the Retail-authorised field set

### Requirement 5: Rate Limiting

**User Story:** As a platform operator, I want to enforce request quotas per subscription plan, so that the platform remains within budget and fair use is maintained.

#### Acceptance Criteria

1. WHILE a request is associated with the Free subscription plan, THE Rate_Limiter SHALL enforce a maximum of 100 requests per UTC calendar day (00:00:00 UTC to 23:59:59 UTC), resetting the counter at the start of each new UTC day
2. WHILE a request is associated with the Starter subscription plan, THE Rate_Limiter SHALL enforce a maximum of 5,000 requests per UTC calendar month, resetting the counter at 00:00:00 UTC on the first day of each month
3. WHILE a request is associated with the Professional subscription plan, THE Rate_Limiter SHALL enforce a maximum of 25,000 requests per UTC calendar month, resetting the counter at 00:00:00 UTC on the first day of each month
4. WHILE a request is associated with the Enterprise subscription plan, THE Rate_Limiter SHALL enforce the numeric requests-per-period limit defined in the Key_Store rate_limit_override field; IF the rate_limit_override field is null or empty, THEN THE Rate_Limiter SHALL apply the Professional plan limit of 25,000 requests per UTC calendar month as the default
5. WHEN a request exceeds the rate limit for its subscription plan, THE Rate_Limiter SHALL return HTTP 429 with error code "rate_limit_exceeded", the limit value, the counter reset time as an ISO 8601 UTC timestamp, and a retry_after_seconds field indicating the number of seconds until the counter resets
6. THE Rate_Limiter SHALL read all rate limit thresholds from the Key_Store database, requiring no code changes to adjust limits
7. WHEN rate limit counters are evaluated, THE Rate_Limiter SHALL use the request's API key identifier as the rate limit scope
8. IF a request is identified as originating from a marketplace proxy by the presence of a provider-specific authentication header (e.g. RapidAPI's X-RapidAPI-Proxy-Secret matching the configured secret), THEN THE Rate_Limiter SHALL bypass internal rate limit enforcement for that request and defer quota management to the marketplace provider

### Requirement 6: Consistent REST API Design

**User Story:** As a developer, I want the API to follow REST conventions with versioned URLs and consistent response formats, so that integration is predictable and straightforward.

#### Acceptance Criteria

1. THE API_Gateway SHALL serve all endpoints under the /v1/ path prefix
2. THE API_Gateway SHALL return JSON success responses with a consistent envelope containing: a "data" field holding the requested resource, a "meta" field containing the request_id (UUID v4) and timestamp, and the HTTP status code 200
3. WHEN a request fails, THE API_Gateway SHALL return a JSON error response with fields: error (machine-readable code), message (human-readable description), and request_id (the Request_ID for the call)
4. THE API_Gateway SHALL return appropriate HTTP status codes: 200 for success, 400 for bad requests, 401 for authentication failures, 403 for authorisation failures, 404 for missing resources, 429 for rate limit exceeded, and 500 for internal errors
5. WHEN a similarity endpoint returns results, THE API_Gateway SHALL support pagination via limit (integer, minimum 1, maximum 100, default 20) and offset (integer, minimum 0, default 0) query parameters and SHALL include in the response a "pagination" object containing: total (total number of available results), limit (applied limit), offset (applied offset), and has_more (boolean indicating whether additional results exist beyond the current page)
6. IF a pagination query parameter is not a valid non-negative integer or exceeds the allowed maximum, THEN THE API_Gateway SHALL return HTTP 400 with error code "invalid_parameter" specifying the parameter name and the accepted range

### Requirement 7: OpenAPI Specification

**User Story:** As a developer, I want a machine-readable API specification, so that I can generate clients, explore endpoints, and integrate with API tooling.

#### Acceptance Criteria

1. THE Platform SHALL provide an OpenAPI 3.1 specification document accessible at /v1/openapi.json without requiring authentication, served with Content-Type application/json
2. THE OpenAPI_Spec SHALL describe all non-Internal endpoints with request parameters, response schemas (including field types and constraints), authentication requirements, and example values, and SHALL validate against the OpenAPI 3.1 JSON Schema without errors
3. WHEN the API schema changes, THE OpenAPI_Spec SHALL be updated to reflect the current contract before deployment, such that every request parameter, response field, and authentication requirement in the live API has a corresponding entry in the spec
4. THE OpenAPI_Spec SHALL include example request/response pairs for each endpoint using OpenAPI example objects, supplemented with x-codeSamples annotations providing usage in cURL, JavaScript (fetch), and Python (requests) formats
5. THE OpenAPI_Spec SHALL use semantic versioning (MAJOR.MINOR.PATCH) for the API version in the info.version field, starting at 1.0.0
6. IF the OpenAPI_Spec document cannot be generated or served, THEN THE Platform SHALL return HTTP 503 with error code "service_unavailable" and a message indicating the specification is temporarily unavailable

### Requirement 8: API Documentation

**User Story:** As a developer, I want comprehensive API documentation, so that I can integrate the platform without requiring direct support.

#### Acceptance Criteria

1. THE Platform SHALL provide documentation covering the following sections: introduction, authentication, endpoints, parameters, response schemas, error handling, rate limits, versioning, code examples in cURL, JavaScript (fetch), and Python (requests), at least 3 best-practice guides (e.g., error retry strategies, pagination handling, key rotation), at least 3 common workflow tutorials (e.g., polling for forecasts, comparing similarity results, checking market state), and a FAQ with at least 10 entries
2. THE Platform documentation SHALL conform to RapidAPI marketplace documentation format requirements, including markdown-compatible formatting, per-endpoint descriptions with parameter tables, and response schema examples, such that it can be published on RapidAPI without structural modification
3. THE Platform documentation SHALL include a "Getting Started in 5 Minutes" guide that walks a new developer from API key acquisition to first successful response in no more than 5 sequential steps, including at least one copy-pasteable code example with authentication headers
4. WHEN a new endpoint or parameter is added, THE Platform documentation SHALL be updated before the change is published
5. THE Platform documentation SHALL be generated from or validated against the OpenAPI_Spec defined in Requirement 7, ensuring all documented endpoints, parameters, and response schemas match the live API contract

### Requirement 9: Marketing Website

**User Story:** As a potential customer, I want a professional marketing website, so that I can understand the platform's value proposition, pricing, and documentation before subscribing.

#### Acceptance Criteria

1. THE Marketing_Website SHALL be built with React, TypeScript, Vite, and Tailwind CSS as a static site requiring no backend
2. THE Marketing_Website SHALL be deployable to Firebase Hosting with a single deployment command
3. THE Marketing_Website SHALL include the following pages: Home (hero, live demo preview, value proposition), API Playground, Pricing, Documentation, Roadmap, Changelog, Status, About, Privacy Policy, and Terms of Service
4. THE Marketing_Website SHALL use no more than 2 typeface families, maintain a consistent spacing scale across all pages, and keep primary navigation visible without scrolling on viewports 768px and wider
5. THE Marketing_Website SHALL consume the existing API for live data display (forecast preview, status indicators) and display the data within 3 seconds of page load under normal network conditions
6. IF the API is unreachable or returns an error when the Marketing_Website requests live data, THEN THE Marketing_Website SHALL display a static placeholder with a message indicating that live data is temporarily unavailable, without breaking page layout or navigation
7. THE Marketing_Website SHALL be fully responsive across viewports of 320px, 768px, and 1280px minimum widths, and comply with WCAG 2.1 Level AA for colour contrast (minimum 4.5:1 for normal text) and keyboard navigation (all interactive elements reachable via Tab and activatable via Enter or Space)
8. WHEN any page of the Marketing_Website is loaded on a 4G mobile connection, THE Marketing_Website SHALL achieve a Largest Contentful Paint of 2500ms or less and a Cumulative Layout Shift of 0.1 or less as measured by Lighthouse

### Requirement 10: Operational Observability

**User Story:** As a platform operator, I want structured logging and monitoring, so that I can diagnose issues, track usage, and maintain service quality.

#### Acceptance Criteria

1. THE API_Gateway SHALL assign a unique Request_ID (UUID v4) to every incoming request and include it in the response headers as X-Request-ID
2. THE API_Gateway SHALL emit structured JSON logs for every request containing: request_id, method, path, status_code, response_time_ms, customer_tier, and timestamp in ISO 8601 UTC format
3. THE API_Gateway SHALL expose a /health endpoint that returns a JSON body with a "status" field set to "healthy" when all dependencies are reachable or "degraded" when one or more dependencies are unreachable, a "database" field set to "connected" or "disconnected", and respond within 5000ms; the endpoint SHALL return HTTP 200 regardless of dependency state
4. THE API_Gateway SHALL expose a /v1/metrics endpoint (Internal tier only) that returns request count, average response time in milliseconds, error rate as a percentage of total requests, and active key count aggregated over the current calendar day (midnight-to-midnight UTC)
5. WHEN a request takes longer than 1000ms to process, THE API_Gateway SHALL log a warning-level entry with the request_id and response_time_ms
6. IF the /health endpoint cannot complete its dependency checks within 5000ms, THEN THE API_Gateway SHALL return HTTP 200 with status "degraded" and mark the timed-out dependency as "disconnected"

### Requirement 11: Commercial Analytics

**User Story:** As a platform operator, I want commercial usage analytics, so that I can understand customer behaviour, popular endpoints, and revenue potential.

#### Acceptance Criteria

1. THE Platform SHALL track per-request analytics including: endpoint path, customer tier, subscription plan, API key identifier, response status code, response time in milliseconds, and timestamp in ISO 8601 UTC format
2. THE Platform SHALL provide aggregated analytics via a dedicated Internal-tier-only endpoint showing: requests per endpoint, requests per customer, requests per tier, average latency per endpoint, error rate per endpoint, and top 10 customers by request volume, with aggregation periods of current day, current month, and last 30 days
3. THE Platform SHALL store analytics data in the existing Supabase database using an append-only request_log table and SHALL retain records for a maximum of 90 days, automatically purging older entries
4. WHILE analytics are being recorded, THE Platform SHALL add no more than 10ms of latency to request processing by performing analytics writes asynchronously and non-blocking to the main request thread
5. IF an analytics write to the request_log table fails, THEN THE Platform SHALL log the failure with the associated request_id and continue processing the API request without returning an error to the caller

### Requirement 12: API Lifecycle Management

**User Story:** As a platform operator, I want a versioning and deprecation policy, so that customers have confidence in the API's stability and migration path.

#### Acceptance Criteria

1. THE Platform SHALL use semantic versioning (MAJOR.MINOR.PATCH) for all API changes, with the major version reflected in the URL path prefix (/v1/, /v2/), where a breaking change is defined as any removal of an endpoint, removal or renaming of a response field, change in the data type of a response field, addition of a required request parameter, or change in authentication/authorisation requirements
2. WHEN an endpoint is deprecated, THE API_Gateway SHALL return a Sunset HTTP header with the removal date in RFC 9110 date format and a Deprecation header with the deprecation date in RFC 9110 date format on every response from that endpoint for the duration of the Deprecation_Window
3. THE Platform SHALL enforce a minimum 12-month Deprecation_Window between announcing a deprecation and removing the endpoint, during which the deprecated endpoint SHALL continue to function with identical behavior apart from the added deprecation headers
4. THE Platform SHALL maintain a machine-readable changelog at /v1/changelog in JSON format where each entry contains: version (MAJOR.MINOR.PATCH), date (ISO 8601), category (one of: breaking, deprecation, feature, fix), and description (max 500 characters), covering all breaking changes, deprecations, new endpoint additions, and endpoint bug fixes
5. WHEN a breaking change is introduced, THE Platform SHALL increment the major version and maintain the previous major version fully operational for the duration of the Deprecation_Window, supporting a maximum of 2 concurrent major versions
6. WHEN an endpoint is deprecated, THE Platform SHALL document the deprecation in the changelog and include a migration guide in the API documentation identifying the replacement endpoint or alternative approach within 5 business days of the deprecation announcement

### Requirement 13: Developer Onboarding

**User Story:** As a new developer, I want a frictionless first experience, so that I can verify the API works before committing to integration.

#### Acceptance Criteria

1. THE API_Gateway SHALL expose a GET /v1/demo endpoint that returns a static sample response with HTTP 200 without requiring authentication, bypassing Auth_Middleware entirely, allowing developers to verify connectivity
2. THE API_Gateway SHALL return a JSON response from /v1/demo containing: a welcome message, the current API version (as defined in OpenAPI_Spec), a list of all publicly documented endpoint paths (those visible in OpenAPI_Spec), and a URL linking to the API documentation
3. THE Platform SHALL serve an API playground at /docs using Swagger UI or Redoc, powered by the OpenAPI_Spec, that allows developers to send requests to endpoints and view responses directly from the browser
4. WHILE a request is authenticated, THE API_Gateway SHALL include rate limit headers in the response: X-RateLimit-Limit (maximum requests allowed in the current period), X-RateLimit-Remaining (requests remaining in the current period), and X-RateLimit-Reset (Unix epoch seconds when the rate limit window resets)
5. IF the /v1/demo endpoint receives more than 60 requests per minute from a single IP address, THEN THE API_Gateway SHALL return HTTP 429 with error code "rate_limit_exceeded" and a retry_after_seconds value

### Requirement 14: Error Handling

**User Story:** As a developer, I want clear and actionable error responses, so that I can diagnose and resolve integration issues without guessing.

#### Acceptance Criteria

1. WHEN an unsupported asset is requested, THE API_Gateway SHALL return HTTP 400 with error code "asset_not_supported" and list the supported assets in the response
2. WHEN an internal error occurs, THE API_Gateway SHALL return HTTP 500 with error code "internal_error", include the request_id, and log the full error details while ensuring the response body contains no stack traces, file paths, database queries, or internal service addresses
3. IF the database is unreachable, THEN THE API_Gateway SHALL return HTTP 503 with error code "service_unavailable" and a retry_after_seconds value between 1 and 60
4. WHEN one or more invalid query parameters are provided, THE API_Gateway SHALL return HTTP 400 with error code "invalid_parameter" listing each invalid parameter name and its accepted values or format
5. WHEN a request uses an HTTP method not supported by the target endpoint, THE API_Gateway SHALL return HTTP 405 with error code "method_not_allowed" and include an Allow header listing the supported methods for that endpoint

### Requirement 15: Security Hardening

**User Story:** As a platform operator, I want the API hardened against common attack vectors, so that customer data and platform integrity are protected.

#### Acceptance Criteria

1. THE API_Gateway SHALL set the following security headers on all HTTP responses including error responses: X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Strict-Transport-Security with max-age of at least 31536000, and X-XSS-Protection: 0
2. IF a request body exceeds 1MB, THEN THE API_Gateway SHALL reject the request with HTTP 413, error code "payload_too_large", and a message indicating the maximum allowed body size
3. WHILE operating in the production environment, THE API_Gateway SHALL reject any non-HTTPS request by returning HTTP 403 with error code "https_required" and a message indicating that HTTPS is mandatory (Cloud Run handles TLS termination and forwards the X-Forwarded-Proto header)
4. WHEN an API key is used from a new IP address for the first time, THE Auth_Middleware SHALL log a structured JSON entry containing the key identifier, IP address, timestamp, and the event type "new_ip_detected" for audit purposes
5. THE API_Gateway SHALL reject request URLs longer than 2048 characters and query parameter values longer than 512 characters with HTTP 414 and error code "uri_too_long"

### Requirement 16: Infrastructure Constraints

**User Story:** As a solo developer, I want the platform to remain simple and cost-effective, so that I can operate it without a team or excessive budget.

#### Acceptance Criteria

1. THE Platform SHALL operate within a total infrastructure budget of £50 per month, measured as the sum of Cloud Run (API and batch services), Firebase Hosting, Supabase database, Cloud Scheduler, and Secret Manager costs
2. THE Platform SHALL use serverless components (Cloud Run, Firebase Hosting) that scale to zero instances when no requests are being processed, with maximum instance counts of 2 for the API service and 1 for the batch service
3. THE Platform SHALL require no JWT or OAuth infrastructure — API key authentication is sufficient for MVP
4. THE Platform SHALL be fully deployable by a single developer using no more than 10 documented CLI commands, completing a fresh deployment within 30 minutes excluding build time
5. THE Platform SHALL maintain full compatibility with the existing batch pipeline architecture, meaning the batch service continues to run on its existing schedule, reads from and writes to the same database tables, and requires no source code or configuration changes to accommodate API-layer additions
6. THE Platform SHALL require no always-on infrastructure components — all compute services SHALL use pay-per-request or pay-per-invocation pricing models
