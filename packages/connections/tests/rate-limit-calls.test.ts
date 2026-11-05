// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: packages/connections/src/**

/**
 * Each of an entry's rate limits that lists costs names every call the
 * entry's tools and mail functions make, at 0 or at its cost, and nothing
 * else. A call a limit doesn't name costs 1 there (`AppRateLimit.costs`),
 * so a new call would quietly draw on another product's units: a Drive
 * list on Gmail's, a calendar read on Exchange's 30 sends a minute.
 *
 * The calls are found in the source: every string of the entry's call
 * shape (`gmail.*`, `calendar.*` and `drive.*` for Google, `outlook.*` for
 * Microsoft), but for its permissions' keys and host names. A call named
 * as a permission's key is listed by hand. Known calls of each kind keep
 * the scan honest.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { google } from '../src/google.js';
import { microsoft } from '../src/microsoft.js';
import type { AppEntry } from '../src/types.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const ENTRIES = [
  {
    entry: google,
    shape: /'((?:gmail|calendar|drive)\.[A-Za-z.]+)'/g,
    // Gmail's send is a permission's key and a call's name.
    alsoCalls: ['gmail.send'],
    known: ['gmail.attachments.get', 'calendar.freebusy.query', 'drive.files.create.upload'],
  },
  {
    entry: microsoft,
    shape: /'(outlook\.[A-Za-z.]+)'/g,
    alsoCalls: [],
    known: ['outlook.send', 'outlook.events.update', 'outlook.messages.delta'],
  },
] as const;

/** The calls the source makes with `entry`: its call shape's strings, outside the entry's own file. */
function callsOf(entry: AppEntry, shape: RegExp, alsoCalls: readonly string[]): string[] {
  const keys = new Set(Object.keys(entry.permissions));
  const calls = new Set(alsoCalls);
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith('.ts') || file === `${entry.id}.ts`) continue;
    for (const [, name] of readFileSync(`${SRC}${file}`, 'utf8').matchAll(shape)) {
      if (name !== undefined && !keys.has(name) && !name.endsWith('.com')) calls.add(name);
    }
  }
  return [...calls].sort();
}

describe('every call in every rate limit that lists costs', () => {
  it.each(ENTRIES.map((e) => [e.entry.id, e] as const))('%s', (_id, e) => {
    const calls = callsOf(e.entry, e.shape, e.alsoCalls);
    expect(calls).toEqual(expect.arrayContaining([...e.known]));
    for (const [i, limit] of (e.entry.rateLimits ?? []).entries()) {
      if (limit.costs === undefined) continue;
      const named = Object.keys(limit.costs);
      expect(
        calls.filter((c) => !named.includes(c)),
        `rate limit ${i} of ${e.entry.id} doesn't name these calls: they'd cost 1 there`,
      ).toEqual([]);
      expect(
        named.filter((n) => !calls.includes(n)),
        `rate limit ${i} of ${e.entry.id} names calls nothing makes`,
      ).toEqual([]);
    }
  });
});
