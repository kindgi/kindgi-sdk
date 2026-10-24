// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `must-cite` and `output-matches` compile their patterns with
 * `@kindgi/bounds`: once per config, on the engine the process's bounds
 * name (RE2 under the hosted profile), and refused by name at
 * registration when they can't run there.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

import { HOSTED_BOUNDS } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import type { RunId, TenantId } from '@kindgi/types';

import { type RunTrace, createCheckRegistry } from '../src/index.js';

const compiles = vi.hoisted(() => ({ count: 0 }));
vi.mock('@kindgi/bounds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kindgi/bounds')>();
  return {
    ...actual,
    compileTenantPattern: (...args: Parameters<typeof actual.compileTenantPattern>) => {
      compiles.count += 1;
      return actual.compileTenantPattern(...args);
    },
  };
});

const registry = createCheckRegistry();
const check = (id: string) => {
  const found = registry.get(id);
  if (found === undefined) throw new Error(`${id} missing`);
  return found;
};
const trace = (output: string) =>
  ({
    runId: 'run-1' as RunId,
    tenantId: 'acme' as TenantId,
    output,
    toolCalls: [],
    toolResults: [],
    modelCalls: [],
    mode: 'runtime',
  }) as RunTrace;

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});
const hosted = () => {
  restore = overrideTenantInputBounds(HOSTED_BOUNDS);
};

describe('hosted: a pattern RE2 lacks is refused at registration, by name', () => {
  test('output-matches with a lookahead; must-cite with a backreference', () => {
    hosted();
    expect(check('output-matches').configProblems?.({ pattern: 'refund(?! denied)' })).toEqual([
      {
        path: '/config/pattern',
        message:
          "config.pattern isn't a regular expression that compiles: RE2, the engine patterns run on here, has no lookahead or lookbehind (`(?!` at index 6).",
      },
    ]);
    expect(check('must-cite').validateConfig?.({ sourcePattern: '(\\[)[^\\]]+\\1' })).toBe(
      "config.sourcePattern isn't a regular expression that compiles: RE2, the engine patterns run on here, has no backreferences (`\\1` at index 10).",
    );
  });

  test('a pattern over the hosted length is refused with both numbers', () => {
    hosted();
    expect(
      check('output-matches').validateConfig?.({ pattern: 'a'.repeat(1_024), flags: 'i' }),
    ).toBe(
      "config.pattern isn't a regular expression that compiles: 1025 characters with its flags, over the limit of 1024.",
    );
  });

  test('self-hosted, the same lookahead runs on V8', async () => {
    const outputMatches = check('output-matches');
    expect(outputMatches.configProblems?.({ pattern: 'refund(?! denied)' })).toEqual([]);
    const result = await outputMatches.evaluate(
      { pattern: 'refund(?! denied)', negate: true },
      trace('refund denied'),
      {},
    );
    expect(result.passed).toBe(true);
  });
});

describe('hosted: evaluation runs on RE2', () => {
  test("output-matches answers with the config's flags", async () => {
    hosted();
    const result = await check('output-matches').evaluate(
      { pattern: '^order \\p{Lu}-\\d+$', flags: 'mu' },
      trace('Shipped:\norder A-1\nThanks.'),
      {},
    );
    expect(result).toEqual({ passed: true });
  });

  test('a pattern evaluated directly that RE2 refuses throws: never a pass', async () => {
    hosted();
    await expect(
      check('output-matches').evaluate({ pattern: '(?=x)' }, trace('x'), {}),
    ).rejects.toThrow(
      "config.pattern isn't a regular expression that compiles: RE2, the engine patterns run on here, has no lookahead or lookbehind (`(?=` at index 0).",
    );
  });
});

describe('must-cite counts no further than it needs', () => {
  test.each([
    ['self-hosted', () => undefined],
    ['hosted', hosted],
  ])('%s: a pass reports minCitations; a fail, every one found', async (_, setBounds) => {
    setBounds();
    const mustCite = check('must-cite');
    const pass = await mustCite.evaluate({ minCitations: 2 }, trace('[a] [b] [c] [d]'), {});
    expect(pass).toEqual({ passed: true, attributes: { citationCount: 2 } });
    const fail = await mustCite.evaluate({ minCitations: 5 }, trace('[a] [b] [c]'), {});
    expect(fail).toMatchObject({ passed: false, attributes: { citationCount: 3 } });
  });
});

describe('must-cite asks for at most mustCiteMaxCitations', () => {
  const overTheCap = {
    path: '/config/minCitations',
    message: 'config.minCitations is 101, over the limit of 100.',
  };

  test('hosted: 100 registers; 101 is refused by name, alongside a pattern RE2 lacks', () => {
    hosted();
    const mustCite = check('must-cite');
    expect(mustCite.configProblems?.({ minCitations: 100 })).toEqual([]);
    expect(mustCite.configProblems?.({ minCitations: 101 })).toEqual([overTheCap]);
    expect(mustCite.configProblems?.({ minCitations: 101, sourcePattern: '(?=x)' })).toEqual([
      overTheCap,
      {
        path: '/config/sourcePattern',
        message:
          "config.sourcePattern isn't a regular expression that compiles: RE2, the engine patterns run on here, has no lookahead or lookbehind (`(?=` at index 0).",
      },
    ]);
  });

  test('hosted: evaluated directly over the cap, it throws, however many it would find', async () => {
    hosted();
    await expect(
      check('must-cite').evaluate({ minCitations: 101 }, trace('[a] '.repeat(101)), {}),
    ).rejects.toThrow(overTheCap.message);
  });

  test('self-hosted: no cap', async () => {
    const mustCite = check('must-cite');
    expect(mustCite.configProblems?.({ minCitations: 1_000_000 })).toEqual([]);
    const result = await mustCite.evaluate({ minCitations: 101 }, trace('[a] '.repeat(101)), {});
    expect(result).toEqual({ passed: true, attributes: { citationCount: 101 } });
  });
});

describe('compiled once per config', () => {
  test('registration and every evaluation share one compile; a new config or new bounds compile again', async () => {
    const outputMatches = check('output-matches');
    const config = { pattern: '^APPROVED', flags: 'i' };
    compiles.count = 0;
    expect(outputMatches.configProblems?.(config)).toEqual([]);
    for (const output of ['approved', 'APPROVED', 'denied']) {
      await outputMatches.evaluate(config, trace(output), {});
    }
    expect(compiles.count).toBe(1);

    await outputMatches.evaluate({ ...config }, trace('approved'), {});
    expect(compiles.count).toBe(2);

    hosted();
    await outputMatches.evaluate(config, trace('approved'), {});
    expect(compiles.count).toBe(3);
  });

  test('a changed setting on the same object compiles again', async () => {
    const outputMatches = check('output-matches');
    const config: Record<string, unknown> = { pattern: '^a' };
    expect((await outputMatches.evaluate(config, trace('ab'), {})).passed).toBe(true);
    config.pattern = '^b';
    expect((await outputMatches.evaluate(config, trace('ab'), {})).passed).toBe(false);
  });
});
