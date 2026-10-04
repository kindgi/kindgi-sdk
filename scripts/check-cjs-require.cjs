// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * CommonJS apps can `require()` Kindgi: every entry of every package given
 * loads with `require()` (Node's require(esm), from Node 22.12) wherever it
 * loads with `import()`. This file is CommonJS itself, so it calls
 * `require()` as an app does. Each entry is required by the package's own
 * name (self-reference), so the package's `exports` conditions decide, as
 * they do for an app.
 *
 * Skipped:
 *   - a program entry (an export path ending in `-main`): it runs with
 *     `node <file>` and is never loaded;
 *   - an entry `import()` can't load either (it needs its runner, as
 *     `@kindgi/pack-conformance` needs Vitest): not a CommonJS problem.
 *
 * Usage: `node scripts/check-cjs-require.cjs <package dir>...`
 * (`check:publish` runs it over the publishable packages, after a build).
 */

'use strict';

const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

/** An export path that names a program, not a module to load. */
const isProgram = (subpath) => subpath.endsWith('-main');

async function main(dirs) {
  const failures = [];
  let required = 0;
  for (const dir of dirs.map((d) => resolve(d))) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const load = createRequire(join(dir, 'package.json'));
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target !== 'object' || target === null || isProgram(subpath)) continue;
      const specifier = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
      try {
        load(specifier);
        required += 1;
      } catch (requireError) {
        if (await importFails(load, specifier)) continue;
        failures.push(`${specifier}: ${firstLine(requireError)}`);
      }
    }
  }
  if (failures.length > 0) {
    console.error(
      `require() fails where import() works:\n${failures.map((f) => `  ${f}`).join('\n')}`,
    );
    process.exit(1);
  }
  console.log(`CommonJS check OK — ${required} entries load with require().`);
}

/**
 * Whether `import()` fails too. An entry `require()` can't even resolve
 * (no condition answers it) is the package's own problem: `false`, so it's
 * reported.
 */
async function importFails(load, specifier) {
  let file;
  try {
    file = load.resolve(specifier);
  } catch {
    return false;
  }
  return import(pathToFileURL(file).href).then(
    () => false,
    () => true,
  );
}

function firstLine(error) {
  const code = error && typeof error === 'object' && 'code' in error ? `${error.code}: ` : '';
  return `${code}${String(error instanceof Error ? error.message : error).split('\n')[0]}`;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error);
  process.exit(1);
});
