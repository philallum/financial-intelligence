/**
 * Build-time script to convert the OpenAPI YAML spec to JSON.
 *
 * Reads `src/api/openapi/openapi.yaml` and writes `dist/openapi.json`.
 * This is run as part of the build process (after tsc) so that the
 * API server can serve the spec statically without runtime YAML parsing.
 *
 * Requirements: 7.1
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const INPUT = path.join(ROOT, 'src', 'api', 'openapi', 'openapi.yaml');
const OUTPUT_DIR = path.join(ROOT, 'dist');
const OUTPUT = path.join(OUTPUT_DIR, 'openapi.json');

// Ensure dist/ directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Read YAML, convert to JSON, and write
const yamlContent = fs.readFileSync(INPUT, 'utf-8');
const spec = yaml.load(yamlContent);
const jsonContent = JSON.stringify(spec, null, 2);

fs.writeFileSync(OUTPUT, jsonContent, 'utf-8');

console.log(`✓ OpenAPI spec generated: ${OUTPUT}`);
