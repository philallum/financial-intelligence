-- Create projects table
-- Requirements: 2.4, 2.5 - API Key Management (project association, key limits per project)

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  name VARCHAR(64) NOT NULL,
  environment VARCHAR(20) NOT NULL DEFAULT 'development', -- development, staging, production
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index: enforce unique project names per customer among active projects
CREATE UNIQUE INDEX idx_projects_customer_name_active
  ON projects (customer_id, name)
  WHERE is_active = true;

-- Index for looking up active projects by customer
CREATE INDEX idx_projects_customer
  ON projects (customer_id)
  WHERE is_active = true;
