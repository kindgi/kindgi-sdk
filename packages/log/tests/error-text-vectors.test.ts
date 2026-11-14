// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The shared error-text vectors (`vectors/error-text.json`): `scrubText`'s
 * full mask, and what `describeCauses` adds to an error's message. The
 * Python and Java pack services replay the same file, so a tool's error
 * says its causes, and masks them, the same way in every language.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { describeCauses, scrubText } from '../src/index.js';

/** An error as the vectors write it: its name, message and code, and what caused it. */
interface ErrorSpec {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly cause?: ErrorSpec;
}

const spec = JSON.parse(
  readFileSync(new URL('./vectors/error-text.json', import.meta.url), 'utf8'),
) as {
  readonly scrub: readonly {
    readonly name: string;
    readonly text: string;
    readonly expected: string;
  }[];
  readonly causes: readonly {
    readonly name: string;
    readonly error: ErrorSpec;
    readonly expected: string;
  }[];
};

function errorOf(s: ErrorSpec): Error {
  const error =
    s.cause === undefined
      ? new Error(s.message)
      : new Error(s.message, { cause: errorOf(s.cause) });
  error.name = s.name;
  if (s.code !== undefined) Object.assign(error, { code: s.code });
  return error;
}

describe('the shared error-text vectors', () => {
  test.each(spec.scrub.map((c) => [c.name, c] as const))('full mask: %s', (_name, c) => {
    expect(scrubText(c.text, { fullMask: true })).toBe(c.expected);
  });

  test.each(spec.causes.map((c) => [c.name, c] as const))('causes: %s', (_name, c) => {
    expect(describeCauses(errorOf(c.error))).toBe(c.expected);
  });
});
