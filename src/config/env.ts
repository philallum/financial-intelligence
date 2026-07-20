import 'dotenv/config';

/**
 * Environment variable configuration with typed loading and validation.
 * Throws on missing required variables in production; allows optional ones in dev/test.
 */

export interface EnvConfig {
  // Data Provider API Keys
  readonly TWELVE_DATA_API_KEY: string;
  readonly MASSIVE_API_KEY: string;
  readonly ALPHA_VANTAGE_API_KEY: string;
  readonly FINNHUB_API_KEY: string;
  readonly NEWS_API_KEY: string;

  // Google Cloud / Vertex AI (Gemini)
  readonly GCP_PROJECT_ID: string;
  readonly GCP_LOCATION: string;
  readonly GEMINI_MODEL: string;

  // Supabase
  readonly SUPABASE_URL: string;
  readonly SUPABASE_ANON_KEY: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;

  // RapidAPI
  readonly RAPIDAPI_PROXY_SECRET: string;

  // Cloud Run
  readonly PORT: number;
  readonly NODE_ENV: 'development' | 'production' | 'test';

  // ML Service
  readonly ML_SERVICE_URL: string;
}

const REQUIRED_IN_PRODUCTION: readonly string[] = [
  'TWELVE_DATA_API_KEY',
  'MASSIVE_API_KEY',
  'ALPHA_VANTAGE_API_KEY',
  'FINNHUB_API_KEY',
  'NEWS_API_KEY',
  'GCP_PROJECT_ID',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

function getNodeEnv(): 'development' | 'production' | 'test' {
  const value = process.env['NODE_ENV'] ?? 'development';
  if (value === 'production' || value === 'development' || value === 'test') {
    return value;
  }
  throw new Error(
    `Invalid NODE_ENV value: "${value}". Must be one of: development, production, test`
  );
}

function getRequiredString(key: string, nodeEnv: string): string {
  const value = process.env[key];
  if (!value) {
    if (nodeEnv === 'production') {
      throw new Error(
        `Missing required environment variable: ${key}. All provider keys and Supabase credentials are required in production.`
      );
    }
    return '';
  }
  return value;
}

function getPort(): number {
  const raw = process.env['PORT'] ?? '8080';
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(
      `Invalid PORT value: "${raw}". Must be a number between 0 and 65535.`
    );
  }
  return parsed;
}

function loadEnvConfig(): EnvConfig {
  const nodeEnv = getNodeEnv();

  if (nodeEnv === 'production') {
    const missing = REQUIRED_IN_PRODUCTION.filter(
      (key) => !process.env[key]
    );
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables in production: ${missing.join(', ')}`
      );
    }
  }

  return Object.freeze({
    TWELVE_DATA_API_KEY: getRequiredString('TWELVE_DATA_API_KEY', nodeEnv),
    MASSIVE_API_KEY: getRequiredString('MASSIVE_API_KEY', nodeEnv),
    ALPHA_VANTAGE_API_KEY: getRequiredString('ALPHA_VANTAGE_API_KEY', nodeEnv),
    FINNHUB_API_KEY: getRequiredString('FINNHUB_API_KEY', nodeEnv),
    NEWS_API_KEY: getRequiredString('NEWS_API_KEY', nodeEnv),
    GCP_PROJECT_ID: getRequiredString('GCP_PROJECT_ID', nodeEnv),
    GCP_LOCATION: process.env['GCP_LOCATION'] ?? 'us-central1',
    GEMINI_MODEL: process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash',
    SUPABASE_URL: getRequiredString('SUPABASE_URL', nodeEnv),
    SUPABASE_ANON_KEY: getRequiredString('SUPABASE_ANON_KEY', nodeEnv),
    SUPABASE_SERVICE_ROLE_KEY: getRequiredString('SUPABASE_SERVICE_ROLE_KEY', nodeEnv),
    RAPIDAPI_PROXY_SECRET: process.env['RAPIDAPI_PROXY_SECRET'] ?? '',
    PORT: getPort(),
    NODE_ENV: nodeEnv,
    ML_SERVICE_URL: process.env['ML_SERVICE_URL'] ?? 'http://localhost:5000',
  });
}

/** Validated, typed environment configuration. Frozen at load time. */
export const env: EnvConfig = loadEnvConfig();
