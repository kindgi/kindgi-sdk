// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The one rule for schemas: an Ajv in a server is made by `boundedAjv`
 * (`src/bounded.ts`), so a schema can't skip the bounds. Every other
 * `new Ajv(` in the packages' source is listed here, with why it isn't
 * in a server. A new site fails this test until it moves onto the factory
 * or is listed. (`@kindgi/bounds`' guard test does the same for `RegExp(`.)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const PACKAGES = join(import.meta.dirname, '..', '..');

/** `new Ajv(` sites by file (from `packages/`): how many, and why each is fine. */
const ALLOWED: Readonly<Record<string, { readonly sites: number; readonly why: string }>> = {
  'schema/src/bounded.ts': { sites: 3, why: 'the factory itself, one per dialect' },
  'guardrails/src/define-check.ts': {
    sites: 1,
    why: "a check's config schema, in the pack's own process",
  },
  'handler-runtime/src/handler-runner.ts': {
    sites: 1,
    why: "a handler's schemas, in the pack's own process",
  },
  'pack-conformance/src/index.ts': { sites: 2, why: "an author's test of their own pack" },
};

/** Packages that never run in a server. */
const NOT_SERVER = new Set(['cli']);

/** Every `new Ajv(` (any dialect's class) in the files given, by file: the files that have any. */
function ajvSites(files: ReadonlyMap<string, string>): Map<string, number> {
  const sites = new Map<string, number>();
  for (const [file, text] of files) {
    const count = (text.match(/\bnew Ajv(?:2019|2020)?\(/g) ?? []).length;
    if (count > 0) sites.set(file, count);
  }
  return sites;
}

/** The sites that aren't listed, or a listed file with a site more or fewer than listed. */
function unlisted(sites: ReadonlyMap<string, number>): string[] {
  const problems: string[] = [];
  for (const [file, count] of sites) {
    const allowed = ALLOWED[file];
    if (allowed === undefined) problems.push(`${file}: ${count} new`);
    else if (allowed.sites !== count) problems.push(`${file}: ${count}, listed ${allowed.sites}`);
  }
  for (const file of Object.keys(ALLOWED)) {
    if (!sites.has(file)) problems.push(`${file}: listed, but has none`);
  }
  return problems;
}

function sourceFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const pkg of readdirSync(PACKAGES)) {
    if (NOT_SERVER.has(pkg)) continue;
    const src = join(PACKAGES, pkg, 'src');
    let entries: string[];
    try {
      entries = readdirSync(src, { recursive: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/\.(m?ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      files.set(`${pkg}/src/${entry}`, readFileSync(join(src, entry), 'utf8'));
    }
  }
  return files;
}

describe('no schema skips boundedAjv', () => {
  test("every new Ajv( in the packages' source is the factory's or listed with why", () => {
    const files = sourceFiles();
    expect(files.size).toBeGreaterThan(100);
    expect(unlisted(ajvSites(files))).toEqual([]);
  });

  test('a known positive: a new site, or one more in a listed file, fails it', () => {
    const files = new Map([
      ['tools/src/invoke.ts', 'const ajv = new Ajv2019({ strict: false });'],
      ['pack-conformance/src/index.ts', 'new Ajv2020(a); new Ajv2020(b); new Ajv(c);'],
    ]);
    expect(unlisted(ajvSites(files))).toEqual([
      'tools/src/invoke.ts: 1 new',
      'pack-conformance/src/index.ts: 3, listed 2',
      'schema/src/bounded.ts: listed, but has none',
      'guardrails/src/define-check.ts: listed, but has none',
      'handler-runtime/src/handler-runner.ts: listed, but has none',
    ]);
  });
});
