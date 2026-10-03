// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { SPECS_EXAMPLES_DIR, SPECS_SCHEMAS_DIR } from '../src/index.js';

// Resolves through this package's own `exports` map (package self-reference),
// exactly as a consumer resolves `@kindgi/specs/...`.
const require = createRequire(import.meta.url);

const schemaFiles = readdirSync(SPECS_SCHEMAS_DIR).filter((f) => f.endsWith('.schema.json'));
const exampleFiles = readdirSync(SPECS_EXAMPLES_DIR).filter((f) => f.endsWith('.json'));

describe('@kindgi/specs exports', () => {
  test('ships schemas and examples', () => {
    expect(schemaFiles.length).toBeGreaterThan(0);
    expect(exampleFiles.length).toBeGreaterThan(0);
  });

  test.each(schemaFiles)('%s resolves by name', (file) => {
    expect(require.resolve(`@kindgi/specs/${file}`)).toBe(join(SPECS_SCHEMAS_DIR, file));
  });

  test.each(exampleFiles)('examples/%s resolves by name', (file) => {
    expect(require.resolve(`@kindgi/specs/examples/${file}`)).toBe(join(SPECS_EXAMPLES_DIR, file));
  });

  test('package.json is importable', () => {
    expect(require('@kindgi/specs/package.json')).toMatchObject({ name: '@kindgi/specs' });
  });
});
