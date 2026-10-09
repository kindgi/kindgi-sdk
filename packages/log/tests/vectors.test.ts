// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The shared record vectors (`vectors/records.json`): the logger writes
 * each case's record exactly, keys in order, or nothing when the case
 * expects `null`. Python's `kindgi.log` replays the same file, so the
 * two languages write the same records and redact the same way.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { type LogLevel, type Logger, createLogger } from '../src/index.js';

interface VectorCase {
  readonly name: string;
  readonly logger: { readonly level: LogLevel; readonly levels?: Record<string, LogLevel> };
  readonly bindings: readonly Record<string, unknown>[];
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: Record<string, unknown>;
  readonly error?: { readonly name: string; readonly message: string; readonly code?: string };
  /** `LogOptions.inMessage`, when the case writes with it. */
  readonly inMessage?: readonly string[];
  readonly expected: Record<string, unknown> | null;
}

const spec = JSON.parse(
  readFileSync(new URL('./vectors/records.json', import.meta.url), 'utf8'),
) as { readonly now: string; readonly cases: readonly VectorCase[] };

describe('the shared record vectors', () => {
  test.each(spec.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const lines: string[] = [];
    let log: Logger = createLogger({
      ...c.logger,
      format: 'json',
      write: (line) => lines.push(line),
      now: () => new Date(spec.now),
    });
    for (const b of c.bindings) log = log.child(b);
    const fields: Record<string, unknown> = { ...c.fields };
    if (c.error !== undefined) {
      const err = new Error(c.error.message) as Error & { code?: string };
      err.name = c.error.name;
      if (c.error.code !== undefined) err.code = c.error.code;
      fields.err = err;
    }
    log[c.level](
      c.message,
      fields,
      c.inMessage !== undefined ? { inMessage: c.inMessage } : undefined,
    );
    if (c.expected === null) {
      expect(lines).toEqual([]);
      return;
    }
    expect(lines).toHaveLength(1);
    const got = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(got).toEqual(c.expected);
    expect(Object.keys(got)).toEqual(Object.keys(c.expected));
  });
});
