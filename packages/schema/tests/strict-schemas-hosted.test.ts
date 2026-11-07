// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The strict-schemas test vectors (`packages/specs/test-vectors/strict-schemas`)
 * on either bounds. `answers.json` holds what the compile says on V8
 * (`scripts/strict-schemas-oracle.mjs`), and on RE2 (hosted) it says the
 * same, word for word, but for a pattern V8 refuses with the `u` flag, which
 * RE2's compile refuses in its own words. On RE2, `uniqueItems` keeps the
 * place Ajv's own has among the keywords.
 */

import { readFileSync } from 'node:fs';

import { HOSTED_BOUNDS, SELF_HOSTED_BOUNDS, compileTenantPattern } from '@kindgi/bounds';
import type { TenantInputBounds } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, test } from 'vitest';

import { compileInlineSchema } from '../src/index.js';
import { useLinearUniqueItems } from '../src/unique-items.js';

type Answer = string | null;
type ByGroup<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

const vectors = new URL('../../specs/test-vectors/strict-schemas/', import.meta.url);
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, vectors), 'utf8'));
const corpus = read('corpus.json') as ByGroup<unknown>;
const answers = read('answers.json') as ByGroup<Answer>;

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

  test('on RE2, every case gets its answer, a pattern V8 refuses in RE2’s words', () => {
    under(HOSTED_BOUNDS);
    expect(each(corpus, answerTo)).toEqual(each(answers, onRe2));
  });
});

describe('`uniqueItems` on RE2, in the place Ajv’s own has', () => {
  test('an array’s errors come in the order they do on V8', () => {
    const schema = { type: 'array', uniqueItems: true, items: { type: 'object' } };
    const onV8 = errorsOf(SELF_HOSTED_BOUNDS, schema, [{}, {}, 1]);
    expect(onV8).toEqual([
      ['uniqueItems', ''],
      ['type', '/2'],
    ]);
    expect(errorsOf(HOSTED_BOUNDS, schema, [{}, {}, 1])).toEqual(onV8);
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
function each<T, U>(cases: ByGroup<T>, f: (value: T) => U): ByGroup<U> {
  return Object.fromEntries(
    Object.entries(cases).map(([group, named]) => [
      group,
      Object.fromEntries(Object.entries(named).map(([name, value]) => [name, f(value)])),
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
 * where V8 refuses a pattern with the `u` flag, which Ajv compiles every
 * pattern with. On RE2 that's `compileTenantPattern`'s refusal of the same
 * source, through Ajv's `code.regExp`.
 */
function onRe2(answer: Answer): Answer {
  const v8 = answer === null ? null : /^Invalid regular expression: \/(.*)\/u: /.exec(answer);
  if (v8 === null) return answer;
  const source = v8[1] ?? '';
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
