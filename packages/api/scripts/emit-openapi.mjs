#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Emits `openapi.json` (this package's root) from the built `@kindgi/api`
// route + schema registry. The file ships with the package and is exported
// as `@kindgi/api/openapi.json` — SDK codegen and other consumers resolve
// it by package name, never by repo path. Kept as a pure `.mjs` script (no
// tsx dep) — mirrors `@kindgi/specs`' `scripts/validate.mjs`.
//
// Usage: `pnpm --filter @kindgi/api gen:openapi`.
// The npm script builds first so the imported dist is always fresh.
// `tests/openapi-artifact.test.ts` fails when the committed file is stale.

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');
const DIST_ENTRY = join(PACKAGE_ROOT, 'dist', 'index.js');
const OUTPUT_PATH = join(PACKAGE_ROOT, 'openapi.json');

if (!existsSync(DIST_ENTRY)) {
  console.error(
    `error: expected built entry at ${DIST_ENTRY}. Run \`pnpm --filter @kindgi/api build\` first, or use \`pnpm --filter @kindgi/api gen:openapi\` which chains both.`,
  );
  process.exit(1);
}

const { generateOpenApiDocument } = await import(DIST_ENTRY);
const doc = generateOpenApiDocument();

await writeFile(OUTPUT_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

const pathCount = Object.keys(doc.paths).length;
const opCount = Object.values(doc.paths).reduce(
  (sum, methods) => sum + Object.keys(methods).length,
  0,
);
console.log(
  `wrote ${OUTPUT_PATH} — ${pathCount} paths, ${opCount} operations, ${Object.keys(doc.components.schemas).length} schemas`,
);
