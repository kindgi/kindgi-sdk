#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
//
// Bundle @kindgi/client's types into a single self-contained
// `dist/index.d.ts` (+ `.d.cts` copy). Uses `dts-bundle-generator`
// because rollup-plugin-dts (tsup's built-in) can't handle
// `@kindgi/types`'s `export *` from submodules cleanly.
//
// After `tsup` produces the runtime (index.js + index.cjs), this pass
// walks src/index.ts's type flow, inlines every referenced type from
// @kindgi/{handler,runtime,types,agents,platform,flow}, and writes one
// self-contained .d.ts. External TypeScript consumers get types
// without needing any workspace @kindgi/* deps installed.

import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { namesExportedTwice, unexportNamesakes } from './dts-namesakes.mjs';
import { unexportPhantomValues } from './dts-values.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const ENTRY = join(PKG_ROOT, 'src', 'index.ts');
const OUT_TS = join(PKG_ROOT, 'dist', 'index.d.ts');
// package.json's `exports.require.types` points at the SAME `.d.ts` file —
// no separate `.d.cts` needed. TypeScript's `moduleResolution: node16/
// nodenext` follows the explicit hint from exports rather than requiring a
// `.d.cts` sibling. Saves ~360KB unpacked from the published tarball.

// zod is left external — consumers install it alongside @kindgi/client.
// Every other referenced type (from @kindgi/*) gets walked + inlined.
// yargs's array parsing needs `--` before positional args when the array
// option immediately precedes them; passing `ENTRY` first avoids the
// ambiguity.
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'dts-bundle-generator',
    ENTRY,
    '--out-file',
    OUT_TS,
    '--project',
    join(PKG_ROOT, 'tsconfig.json'),
    '--no-check',
    '--no-banner',
    '--external-imports=zod',
  ],
  { stdio: 'inherit', cwd: PKG_ROOT },
);

if (result.status !== 0) {
  console.error(`dts-bundle-generator exited with status ${result.status ?? 'unknown'}`);
  process.exit(result.status ?? 1);
}

// Each name exported once, meaning the client's own type (dts-namesakes.mjs),
// and a value exported only when the runtime module exports it (dts-values.mjs).
const { readFile } = await import('node:fs/promises');
const runtime = Object.keys(await import(pathToFileURL(join(PKG_ROOT, 'dist', 'index.js')).href));
const body = unexportPhantomValues(unexportNamesakes(await readFile(OUT_TS, 'utf8')), runtime);
const twice = namesExportedTwice(body);
if (twice.length > 0) {
  console.error(`dist/index.d.ts exports these names twice: ${twice.join(', ')}`);
  process.exit(1);
}
await writeFile(OUT_TS, body, 'utf8');

// Prepend an SPDX header to the emitted file.
if (!body.startsWith('// SPDX-License-Identifier')) {
  const header = [
    '// SPDX-License-Identifier: Apache-2.0',
    '// Copyright (C) 2026 Kindgi Inc.',
    '//',
    '// Bundled types for @kindgi/client — self-contained; no',
    '// @kindgi/* workspace deps required at install time.',
    '',
    '',
  ].join('\n');
  await writeFile(OUT_TS, header + body, 'utf8');
}

// CommonJS consumers resolve `exports["."].require.types`; the declarations
// are identical, but a `.d.cts` file is what tells TypeScript they describe
// the CommonJS build (a `.d.ts` next to `"type": "module"` reads as ESM).
const OUT_CTS = join(PKG_ROOT, 'dist', 'index.d.cts');
await writeFile(OUT_CTS, await readFile(OUT_TS, 'utf8'), 'utf8');

console.log(`wrote ${OUT_TS} + ${OUT_CTS}`);

// `@kindgi/client/sso-handoff`: its own entry, with no imports, so its
// declarations are just that file's.
const HANDOFF_TS = join(PKG_ROOT, 'dist', 'sso-handoff.d.ts');
const handoff = spawnSync(
  'pnpm',
  [
    'exec',
    'dts-bundle-generator',
    join(PKG_ROOT, 'src', 'sso-handoff.ts'),
    '--out-file',
    HANDOFF_TS,
    '--project',
    join(PKG_ROOT, 'tsconfig.json'),
    '--no-check',
    '--no-banner',
  ],
  { stdio: 'inherit', cwd: PKG_ROOT },
);
if (handoff.status !== 0) {
  console.error(
    `dts-bundle-generator (sso-handoff) exited with status ${handoff.status ?? 'unknown'}`,
  );
  process.exit(handoff.status ?? 1);
}
const handoffBody = [
  '// SPDX-License-Identifier: Apache-2.0',
  '// Copyright (C) 2026 Kindgi Inc.',
  '',
  await readFile(HANDOFF_TS, 'utf8'),
].join('\n');
await writeFile(HANDOFF_TS, handoffBody, 'utf8');
await writeFile(join(PKG_ROOT, 'dist', 'sso-handoff.d.cts'), handoffBody, 'utf8');
console.log(`wrote ${HANDOFF_TS} + .d.cts`);
