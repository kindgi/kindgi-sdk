// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/sdk` is what an app's own code imports (an agent file's
 * exported output schema, read by a route handler; a client), so an app's
 * bundler (Next.js with Turbopack, webpack) bundles it. To those bundlers
 * `new URL('<relative>', import.meta.url)` is a reference to a file to
 * bundle, and a folder (`'../migrations/'`) or a missing file fails the
 * build. So no module a public entry reaches may have one: what locates
 * files on disk lives in a runtime-only subpath (`@kindgi/agents/migrations`).
 * Runs on the built package (`dist/`), as an app gets it.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { build } from 'esbuild';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);

/**
 * A file reference relative to the module's own URL, as bundlers read it:
 * any string that isn't absolute (`/…`) or a URL with a scheme (`data:`,
 * `https:`), with or without `./`.
 */
const RELATIVE_FILE_URL =
  /new\s+URL\(\s*(['"`])(?![a-zA-Z][a-zA-Z0-9+.-]*:|\/)[^'"`]*\1\s*,\s*import\.meta\.url\s*\)/;

/** Every public entry of `@kindgi/sdk`, from its `exports`. */
const ENTRIES = Object.keys(
  (require('@kindgi/sdk/package.json') as { exports: Record<string, unknown> }).exports,
)
  .filter((key) => key !== './package.json')
  .map((key) => (key === '.' ? '@kindgi/sdk' : `@kindgi/sdk/${key.slice(2)}`));

/** The source files an entry's bundle takes in. */
async function inputsOf(entry: string): Promise<readonly string[]> {
  const result = await build({
    entryPoints: [require.resolve(entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  // A plugin namespace isn't a file.
  return Object.keys(result.metafile.inputs).filter((input) => !input.includes(':'));
}

test('the pattern takes every relative form, and only those', () => {
  for (const ref of [
    "'../migrations/'",
    '"./prompt.md"',
    "'planted/'",
    '`./${name}.json`',
    "'.'",
  ]) {
    expect(RELATIVE_FILE_URL.test(`new URL(${ref}, import.meta.url)`), ref).toBe(true);
  }
  for (const ref of [
    "'/etc/hosts'",
    "'data:text/plain,x'",
    "'https://kindgi.com/'",
    "'file:///x'",
  ]) {
    expect(RELATIVE_FILE_URL.test(`new URL(${ref}, import.meta.url)`), ref).toBe(false);
  }
});

test.each(['@kindgi/sdk/define', '@kindgi/sdk'])(
  "%s reaches @kindgi/agents, where the last one was (the guard below isn't vacuous)",
  async (entry) => {
    expect((await inputsOf(entry)).some((p) => /[\\/]agents[\\/]dist[\\/]/.test(p))).toBe(true);
  },
);

test.each(ENTRIES)(
  "no module %s reaches resolves a file from its own URL (an app's bundler would)",
  async (entry) => {
    const offenders: string[] = [];
    for (const input of await inputsOf(entry)) {
      const text = await readFile(resolve(input), 'utf8');
      const match = RELATIVE_FILE_URL.exec(text);
      if (match !== null) offenders.push(`${input}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  },
);
