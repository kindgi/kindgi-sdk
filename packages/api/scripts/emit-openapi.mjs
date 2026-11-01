#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Emits `openapi.json` (this package's root) from `@kindgi/api`'s route +
// schema registry. The file ships with the package and is exported as
// `@kindgi/api/openapi.json` — SDK codegen and other consumers resolve it by
// package name, never by repo path.
//
// It loads the registry from source, as the tests do: `src/index.ts`, and the
// workspace packages it imports, through vite's server with the same aliases
// as `vitest.config.ts` (`scripts/workspace-source-aliases.mjs`). So it needs
// no build first, and writes what `tests/openapi-artifact.test.ts` checks the
// committed file against. The server comes from `vitest/node`, which this
// package already has; it opens no port and watches no files.
//
// Usage: `pnpm --filter @kindgi/api gen:openapi`.

import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViteServer } from 'vitest/node';
import { workspaceSourceAliases } from '../../../scripts/workspace-source-aliases.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = join(PACKAGE_ROOT, 'openapi.json');

const server = await createViteServer({
  configFile: false,
  root: PACKAGE_ROOT,
  appType: 'custom',
  // Errors only: vite warns about each dynamic import it can't analyze
  // (`handler-runtime` loads packs by path), which it runs as written. A load
  // that fails still throws, and the run exits non-zero.
  logLevel: 'error',
  clearScreen: false,
  resolve: { alias: workspaceSourceAliases(PACKAGE_ROOT) },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});

let doc;
try {
  const { generateOpenApiDocument } = await server.ssrLoadModule('/src/index.ts');
  doc = generateOpenApiDocument();
} finally {
  await server.close();
}

await writeFile(OUTPUT_PATH, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

const pathCount = Object.keys(doc.paths).length;
const opCount = Object.values(doc.paths).reduce(
  (sum, methods) => sum + Object.keys(methods).length,
  0,
);
console.log(
  `wrote ${OUTPUT_PATH} — ${pathCount} paths, ${opCount} operations, ${Object.keys(doc.components.schemas).length} schemas`,
);
