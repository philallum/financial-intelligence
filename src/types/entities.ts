/**
 * Entity interfaces for the Commercial API data model.
 *
 * These represent the core business entities stored in Supabase:
 * Customer → Projects → API Keys, with Subscriptions tracking billing state.
 */

import type { CustomerTier, SubscriptionPlan } from "./enums.js";

/** A platform customer with a tier classification. */
export interface Customer {
  id: string;
  email: string;
  name: string;
  tier: CustomerTier;
  created_at: string;
  updated_at: string;
}

/** A logical project grouping under a customer. */
export interface Project {
  id: string;
  customer_id: string;
  name: string;
  environment: "development" | "staging" | "production";
  is_active: boolean;
  created_at: string;
}

/** An API key associated with a project. */
export interface ApiKey {
  id: string;
  project_id: string;
  key_hash: string;
  name: string;
  description: string | null;
  subscription_plan: SubscriptionPlan;
  is_active: boolean;
  rate_limit_override: number | null;
  daily_usage: number;
  monthly_usage: number;
  last_reset: string;
  created_at: string;
  last_used_at: string | null;
}

/** A customer's subscription tracking billing state. */
export interface Subscription {
  id: string;
  customer_id: string;
  plan: SubscriptionPlan;
  status: "active" | "cancelled" | "past_due";
  current_period_start: string;
  current_period_end: string;
  created_at: string;
}
