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
import { fileURLToPath } from 'node:url';

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

// Prepend an SPDX header to the emitted file.
const { readFile } = await import('node:fs/promises');
const body = await readFile(OUT_TS, 'utf8');
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
