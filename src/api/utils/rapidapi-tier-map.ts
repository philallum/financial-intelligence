import type { Request } from 'express';
import { CustomerTier } from '../../types/enums.js';

export const RAPIDAPI_TIER_MAP: Record<string, CustomerTier> = {
  'BASIC': CustomerTier.RETAIL,
  'PRO': CustomerTier.DEVELOPER,
  'ULTRA': CustomerTier.RESEARCH,
  'MEGA': CustomerTier.RESEARCH,
  'CUSTOM': CustomerTier.RESEARCH,
};

export function resolveRapidApiTier(subscription: string): CustomerTier {
  return RAPIDAPI_TIER_MAP[subscription] ?? CustomerTier.RETAIL;
}

export function isRapidApiRequest(req: Request): boolean {
  const proxySecret = req.headers['x-rapidapi-proxy-secret'];
  const configuredSecret = process.env.RAPIDAPI_PROXY_SECRET;
  if (!configuredSecret) return false;
  return proxySecret === configuredSecret;
}
