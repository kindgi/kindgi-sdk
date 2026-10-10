// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/sdk/define` is what an app's own code imports (an agent file's
 * exported output schema, read by a route handler), so an app's bundler
 * (Next.js with Turbopack, webpack) bundles it. To those bundlers
 * `new URL('<relative>', import.meta.url)` is a reference to a file to
 * bundle, and a folder (`'../migrations/'`) fails the build. So no module
 * the entry reaches may have one: what locates files on disk lives in a
 * runtime-only subpath (`@kindgi/agents/migrations`). Runs on the built
 * package (`dist/`), as an app gets it.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { build } from 'esbuild';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);

/** A file reference relative to the module's own URL, as bundlers read it. */
const RELATIVE_FILE_URL = /new\s+URL\(\s*(['"`])\.{1,2}\/[^'"`]*\1\s*,\s*import\.meta\.url\s*\)/;

test("no module @kindgi/sdk/define reaches resolves a file from its own URL (an app's bundler would)", async () => {
  const entry = require.resolve('@kindgi/sdk/define');
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs);
  // The control: the entry reaches @kindgi/agents, where the last one was.
  expect(inputs.some((p) => /[\\/]agents[\\/]dist[\\/]/.test(p))).toBe(true);

  const offenders: string[] = [];
  for (const input of inputs) {
    if (input.includes(':')) continue; // a plugin namespace, not a file
    const text = await readFile(resolve(input), 'utf8');
    const match = RELATIVE_FILE_URL.exec(text);
    if (match !== null) offenders.push(`${input}: ${match[0]}`);
  }
  expect(offenders).toEqual([]);
});
