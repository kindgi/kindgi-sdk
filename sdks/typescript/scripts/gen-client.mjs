#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
//
// Generates SDK wire-shape types + zod runtime schemas from the OpenAPI
// document shipped by `@kindgi/api` (`@kindgi/api/openapi.json`, resolved
// by package name — no repo-layout assumption) using `typed-openapi`. The
// output lands under
// `sdks/typescript/src/generated/api.ts` — imported by hand-written
// resource clients in `src/resources/*.ts` for wire types and
// (optionally) runtime response validation.
//
// Regen manually via `pnpm --filter @kindgi/client gen`.
// `pnpm --filter @kindgi/client build` chains gen → tsc.

import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');
// `@kindgi/api` is a devDependency; its `openapi.json` export is a committed
// file, so resolution needs no build of @kindgi/api.
const OPENAPI_PATH = createRequire(import.meta.url).resolve('@kindgi/api/openapi.json');
const OUT_DIR = join(PACKAGE_ROOT, 'src', 'generated');
const OUT_FILE = join(OUT_DIR, 'api.ts');

await mkdir(OUT_DIR, { recursive: true });

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'typed-openapi',
    OPENAPI_PATH,
    '--runtime',
    'zod',
    '--output',
    OUT_FILE,
    '--jsdoc',
    '--include-descriptions',
    '--format',
    // Unreferenced by any operation (`EvalRun.result` is kind-specific, so
    // open), but the clients read a comparison's result as these.
    '--schema',
    '^(JudgedComparison|ComparisonCandidate|ComparisonMetric|ComparisonCaseResult|FlowVersionOverrides)',
  ],
  { stdio: 'inherit', cwd: PACKAGE_ROOT },
);

if (result.status !== 0) {
  console.error(`typed-openapi exited with status ${result.status ?? 'unknown'}`);
  process.exit(result.status ?? 1);
}

const { readFile } = await import('node:fs/promises');
let body = await readFile(OUT_FILE, 'utf8');

// typed-openapi leaves the type of `EndpointByMethod` (every endpoint's
// runtime schemas, by method and path) to inference, and once the API has
// enough operations that type outgrows what tsc writes into a declaration
// (TS7056). Annotate it with the shape its `satisfies` already checks, as
// typed-openapi annotates its other maps: the client reads it only through a
// cast, and every type reads `__TypedOpenapi.EndpointByMethod` instead.
const ENDPOINTS_CONST = 'export const EndpointByMethod = {';
if (body.split(ENDPOINTS_CONST).length !== 2) {
  console.error(`expected one \`${ENDPOINTS_CONST}\` in ${OUT_FILE}`);
  process.exit(1);
}
body = body.replace(
  ENDPOINTS_CONST,
  'export const EndpointByMethod: {\n' +
    '  [M in keyof __TypedOpenapi.EndpointByMethod]: { [P in keyof __TypedOpenapi.EndpointByMethod[M]]: unknown };\n' +
    '} = {',
);
await writeFile(OUT_FILE, body, 'utf8');

// Prepend SPDX header — typed-openapi output otherwise has no license line.
if (!body.startsWith('// SPDX-License-Identifier')) {
  const header = [
    '// SPDX-License-Identifier: Apache-2.0',
    '// Copyright (C) 2026 Kindgi Inc.',
    '//',
    '// GENERATED FILE — do not edit by hand.',
    '// Regenerate via `pnpm --filter @kindgi/client gen` after openapi.json',
    '// changes. Source: @kindgi/api/openapi.json (itself generated from',
    '// packages/api/src/openapi/{operations,schemas}.ts).',
    '',
    '',
  ].join('\n');
  await writeFile(OUT_FILE, header + body, 'utf8');
}

console.log(`wrote ${OUT_FILE}`);
