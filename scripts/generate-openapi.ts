/**
 * Build-time script to convert the OpenAPI YAML spec to JSON.
 *
 * Reads `src/api/openapi/openapi.yaml` and writes `dist/openapi.json`.
 * This is run as part of the build process (after tsc) so that the
 * API server can serve the spec statically without runtime YAML parsing.
 *
 * Injects the dynamic asset enum from the research asset registry into
 * the OpenAPI spec at build time — ensuring the API docs are always
 * in sync with the registry's ACTIVE assets.
 *
 * Requirements: 7.1, 8.1, 8.2, 8.3, 8.4, 8.5, 9.3, 10.3
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { getOpenApiAssetEnum } from '../src/config/research-assets.js';

/**
 * Core logic for generating the OpenAPI spec JSON from YAML content and active assets.
 * Exported for testability.
 *
 * @param yamlContent - Raw YAML content of the OpenAPI spec
 * @param activeAssets - Array of ACTIVE asset symbols to inject as the enum
 * @returns Object with `json` (the generated JSON string) or `error` (if no assets)
 */
export function generateOpenApiSpec(
  yamlContent: string,
  activeAssets: string[],
): { json: string; error?: string } | { json: ''; error: string } {
  if (activeAssets.length === 0) {
    return { json: '', error: '✗ No ACTIVE assets in registry — cannot generate OpenAPI spec' };
  }

  const spec = yaml.load(yamlContent) as Record<string, unknown>;

  // Navigate to components.parameters.Asset.schema.enum and replace
  const components = spec.components as Record<string, unknown>;
  const parameters = components.parameters as Record<string, unknown>;
  const assetParam = parameters.Asset as Record<string, unknown>;
  const schema = assetParam.schema as Record<string, unknown>;

  schema.enum = activeAssets;
  assetParam.description = `The asset to query. Supported: ${activeAssets.join(', ')}`;

  return { json: JSON.stringify(spec, null, 2) };
}

// ─── Script execution (only runs when invoked directly) ─────────────────────

const ROOT = path.resolve(import.meta.dirname, '..');
const INPUT = path.join(ROOT, 'src', 'api', 'openapi', 'openapi.yaml');
const OUTPUT_DIR = path.join(ROOT, 'dist');
const OUTPUT = path.join(OUTPUT_DIR, 'openapi.json');

// Ensure dist/ directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Read YAML, parse to object
const yamlContent = fs.readFileSync(INPUT, 'utf-8');

// Get active assets from registry
const activeAssets = getOpenApiAssetEnum();

// Generate spec
const result = generateOpenApiSpec(yamlContent, activeAssets);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

// Write JSON
fs.writeFileSync(OUTPUT, result.json, 'utf-8');

console.log(`✓ OpenAPI spec generated with assets: ${activeAssets.join(', ')}`);
