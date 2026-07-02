-- Create subscriptions table
-- Requirements: 5.1, 5.2, 5.3, 5.4 - Rate Limiting (subscription plan tracking)

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) UNIQUE,
  plan VARCHAR(20) NOT NULL DEFAULT 'FREE',
  status VARCHAR(20) NOT NULL DEFAULT 'active', -- active, cancelled, past_due
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 month'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
