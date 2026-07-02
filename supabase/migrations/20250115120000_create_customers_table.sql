-- Create customers table
-- Requirements: 2.1, 2.2 - API Key Management (customer association)

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  tier VARCHAR(20) NOT NULL DEFAULT 'RETAIL',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
