// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The one rule for patterns: a pattern from tenant input is compiled by
 * `compileTenantPattern`, so it can't skip the bounds. Every other
 * `RegExp(` in the packages' source is listed here, with why it isn't one.
 * A new site fails this test until it moves onto the helper or is listed.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const PACKAGES = join(import.meta.dirname, '..', '..');

/** `RegExp(` sites by file (from `packages/`): how many, and why none compiles a tenant's pattern. */
const ALLOWED: Readonly<Record<string, { readonly sites: number; readonly why: string }>> = {
  'bounds/src/pattern.ts': { sites: 2, why: 'the helper itself: on V8, and parsing before RE2' },
  'agents/src/remember.ts': { sites: 1, why: 'a tool id, escaped, as a whole token' },
  'api/src/image-ref.ts': {
    sites: 1,
    why: 'the image reference grammar, on a name of at most 255 characters',
  },
  'api/src/middleware/public-run-routes.ts': { sites: 1, why: "Kindgi's own route paths" },
  'capabilities/src/tool-names.ts': { sites: 1, why: 'tool ids, escaped, as whole tokens' },
  'connections/src/mail-text.ts': {
    sites: 1,
    why: "a link's address from the message, escaped, as a whole word",
  },
  'handler-runtime/src/discovery.ts': {
    sites: 1,
    why: "a pack's discovery globs, in the pack's own process",
  },
  'schema/src/bounded.ts': {
    sites: 1,
    why: "ajv-formats' url format, written without backtracking",
  },
  'sdk/src/webhook-events.ts': { sites: 1, why: "Kindgi's generated event shapes, in a client" },
};

/** Packages that never run in a server. */
const NOT_SERVER = new Set(['cli']);

/** Every `RegExp(` in the files given, by file: the files that have any. */
function regExpSites(files: ReadonlyMap<string, string>): Map<string, number> {
  const sites = new Map<string, number>();
  for (const [file, text] of files) {
    const count = (text.match(/\bRegExp\(/g) ?? []).length;
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

/**
 * The packages, as paths from `packages/`: each folder with a package.json,
 * however deep. The model adapters are a level down, under `adapters/`.
 */
function packageDirs(dir = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(PACKAGES, dir), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (existsSync(join(PACKAGES, rel, 'package.json'))) found.push(rel);
    else found.push(...packageDirs(rel));
  }
  return found;
}

function sourceFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const pkg of packageDirs()) {
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

describe('no tenant pattern skips compileTenantPattern', () => {
  test("every RegExp( in the packages' source is the helper's or listed with why", () => {
    const files = sourceFiles();
    expect(files.size).toBeGreaterThan(100);
    // The model adapters' too, a level down.
    expect([...files.keys()].some((f) => f.startsWith('adapters/'))).toBe(true);
    expect(unlisted(regExpSites(files))).toEqual([]);
  });

  test('a known positive: a new site, or one more in a listed file, fails it', () => {
    const files = new Map([
      ['guardrails/src/checks.ts', "const re = new RegExp(config.pattern, 'g');"],
      ['agents/src/remember.ts', 'new RegExp(a); new RegExp(b);'],
    ]);
    expect(unlisted(regExpSites(files))).toEqual([
      'guardrails/src/checks.ts: 1 new',
      'agents/src/remember.ts: 2, listed 1',
      'bounds/src/pattern.ts: listed, but has none',
      'api/src/image-ref.ts: listed, but has none',
      'api/src/middleware/public-run-routes.ts: listed, but has none',
      'capabilities/src/tool-names.ts: listed, but has none',
      'connections/src/mail-text.ts: listed, but has none',
      'handler-runtime/src/discovery.ts: listed, but has none',
      'schema/src/bounded.ts: listed, but has none',
      'sdk/src/webhook-events.ts: listed, but has none',
    ]);
  });
});
