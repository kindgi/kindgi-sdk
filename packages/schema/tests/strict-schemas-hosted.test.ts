// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The strict-schemas test vectors (`packages/specs/test-vectors/strict-schemas`)
 * on either bounds. `answers.json` holds what the compile says on V8
 * (`scripts/strict-schemas-oracle.mjs`), and on RE2 (hosted) it says the
 * same, word for word, but for a refused pattern, which RE2's compile refuses
 * in its own words: the one V8 refuses with the `u` flag, or one V8 compiles
 * that RE2 refuses first (`RE2_REFUSES_FIRST`). On RE2, `uniqueItems` keeps
 * the place Ajv's own has among the keywords.
 */

import { readFileSync } from 'node:fs';

import { HOSTED_BOUNDS, SELF_HOSTED_BOUNDS, compileTenantPattern } from '@kindgi/bounds';
import type { TenantInputBounds } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, test } from 'vitest';

import { boundedAjv } from '../src/bounded.js';
import { compileInlineSchema } from '../src/index.js';
import { linearUniqueItems, useLinearUniqueItems } from '../src/unique-items.js';

type Answer = string | null;
type ByGroup<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

const vectors = new URL('../../specs/test-vectors/strict-schemas/', import.meta.url);
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, vectors), 'utf8'));
const corpus = read('corpus.json') as ByGroup<unknown>;
const answers = read('answers.json') as ByGroup<Answer>;

/**
 * The cases where RE2 refuses a pattern V8 compiles, before the one V8
 * refuses. `additionalProperties` compiles each `patternProperties` name with
 * the `u` flag before `patternProperties`' own check compiles them without
 * it: V8 takes the range of surrogate pairs and refuses `(`, and RE2, which
 * has no `\u` escapes, refuses the range.
 */
const RE2_REFUSES_FIRST: ByGroup<string> = {
  parity: {
    "additionalProperties syntax: before the patterns' own compile without the u flag":
      '[\\uD83D\\uDE00-\\uD83D\\uDE01]',
  },
};

let restore: (() => void) | undefined;

function under(bounds: TenantInputBounds): void {
  restore?.();
  restore = overrideTenantInputBounds(bounds);
}

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('the strict-schemas test vectors', () => {
  test('on V8, every case gets its answer', () => {
    under(SELF_HOSTED_BOUNDS);
    expect(each(corpus, answerTo)).toEqual(answers);
  });

  test('on RE2, every case gets its answer, a refused pattern in RE2’s words', () => {
    under(HOSTED_BOUNDS);
    expect(each(corpus, answerTo)).toEqual(each(answers, onRe2));
  });
});

describe('`uniqueItems` on RE2, in the place Ajv’s own has', () => {
  // Ajv puts `prefixItems`, `items` and `contains` before its own
  // `uniqueItems`: `unevaluatedItems` is the keyword whose errors come after.
  test('an array’s errors come in the order they do on V8', () => {
    const schema = { type: 'array', uniqueItems: true, unevaluatedItems: { type: 'object' } };
    const onV8 = errorsOf(SELF_HOSTED_BOUNDS, schema, [{}, {}, 1]);
    expect(onV8).toEqual([
      ['uniqueItems', ''],
      ['type', '/2'],
    ]);
    expect(errorsOf(HOSTED_BOUNDS, schema, [{}, {}, 1])).toEqual(onV8);
  });

  test('the rule an array’s code is written from is the linear one', () => {
    under(HOSTED_BOUNDS);
    const arrays = boundedAjv('2020-12', { strict: true }).RULES.types.array;
    const rules = typeof arrays === 'object' ? arrays.rules : [];
    expect(rules.find((rule) => rule.keyword === 'uniqueItems')?.definition).toMatchObject({
      code: linearUniqueItems().code,
    });
  });

  test('an Ajv whose `uniqueItems` rule isn’t the one its array rules hold is refused', () => {
    const ajv = new Ajv2020();
    const arrays = ajv.RULES.types.array;
    if (typeof arrays !== 'object') throw new Error('Ajv has no array rules.');
    arrays.rules = arrays.rules.map((rule) => ({ ...rule }));
    expect(() => useLinearUniqueItems(ajv)).toThrow(
      "Ajv's uniqueItems rule isn't the shape @kindgi/schema expects.",
    );
  });
});

/** `f` of every case, by group and name. */
function each<T, U>(
  cases: ByGroup<T>,
  f: (value: T, group: string, name: string) => U,
): ByGroup<U> {
  return Object.fromEntries(
    Object.entries(cases).map(([group, named]) => [
      group,
      Object.fromEntries(
        Object.entries(named).map(([name, value]) => [name, f(value, group, name)]),
      ),
    ]),
  );
}

/** What the compile says to `schema`, as the oracle writes it. */
function answerTo(schema: unknown): Answer {
  const compiled = compileInlineSchema(schema);
  if (compiled.kind === 'ok') return null;
  return compiled.error.message.replace(/^Inline schema failed to compile: /, '');
}

/**
 * The answer on RE2 to a case whose answer on V8 is `answer`: the same, but
 * for the pattern `RE2_REFUSES_FIRST` names, or one V8 refuses with the `u`
 * flag, which Ajv compiles every pattern with.
 */
function onRe2(answer: Answer, group: string, name: string): Answer {
  const first = RE2_REFUSES_FIRST[group]?.[name];
  if (first !== undefined) return refusalOf(first);
  const v8 = answer === null ? null : /^Invalid regular expression: \/(.*)\/u: /.exec(answer);
  return v8 === null ? answer : refusalOf(v8[1] ?? '');
}

/** `compileTenantPattern`'s refusal of `source`, through Ajv's `code.regExp`. */
function refusalOf(source: string): string {
  const compiled = compileTenantPattern(source, 'u');
  if (compiled.kind !== 'refused') return `RE2 compiles the pattern ${JSON.stringify(source)}`;
  return `The schema's pattern ${JSON.stringify(source)} isn't a regular expression that compiles: ${compiled.reason}.`;
}

/** Each error's keyword and instance path, for `data` against `schema` on `bounds`. */
function errorsOf(bounds: TenantInputBounds, schema: unknown, data: unknown): string[][] {
  under(bounds);
  const compiled = compileInlineSchema(schema);
  if (compiled.kind !== 'ok') throw new Error(compiled.error.message);
  const checked = compiled.value.validate(data);
  if (checked.kind === 'ok') return [];
  return checked.error.errors.map((error) => {
    const { keyword, instancePath } = error as { keyword: string; instancePath: string };
    return [keyword, instancePath];
  });
}
