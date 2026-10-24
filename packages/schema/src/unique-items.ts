// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `uniqueItems` in time linear in the data's size times its depth (each
 * level's key is built from its children's), for schemas compiled on RE2
 * (the hosted bounds).
 *
 * Ajv's own keyword compares every pair of items (n² deep-equals) unless
 * the schema declares only scalar types for them: items typed `object` or
 * `array`, or with no `type` at all, as most schemas leave them. 300,000
 * small objects fit in 2 MiB. This one gives each item a key, its JSON with
 * the keys of every object sorted, and looks for a repeat in a `Map`.
 *
 * The verdict is Ajv's, and so is the error: the same pair of items (`i`,
 * `j`), the same `params` and message. Two items are the same as
 * `fast-deep-equal` (what Ajv uses) finds them for JSON values: key order
 * doesn't matter, array order does, and `-0` is `0`. Items declared
 * scalar go through Ajv's own code, which is linear already. Two cases
 * differ, neither of them from JSON:
 * - an item JSON can't carry (a `Date`, a class instance, a `Map`) makes
 *   the whole array compared as Ajv does, pair by pair, with its
 *   `fast-deep-equal`. Only code in the server's own process passes those;
 * - an object with its own `valueOf` or `toString` key is compared by its
 *   keys, where `fast-deep-equal` throws a `TypeError` calling it.
 */

import { _ } from 'ajv';
import type { CodeKeywordDefinition, KeywordCxt } from 'ajv';
import { getSchemaTypes } from 'ajv/dist/compile/validate/dataType.js';
import * as equalModule from 'ajv/dist/runtime/equal.js';
import * as uniqueItemsModule from 'ajv/dist/vocabularies/validation/uniqueItems.js';

// Ajv's dist modules are CommonJS with `exports.default`. An ESM import
// wraps that once or twice, depending on the resolver (Node's, Vite's),
// and a wrapper can answer for the export's own keys without holding them,
// so take the innermost `default`. Read on first use, so a process that
// never compiles on RE2 never depends on their shape.
let ajvUniqueItems: CodeKeywordDefinition | undefined;
let ajvEqual: ((a: unknown, b: unknown) => boolean) | undefined;

function ajvKeyword(): CodeKeywordDefinition {
  ajvUniqueItems ??= unwrapDefault(
    uniqueItemsModule,
    (value): value is CodeKeywordDefinition =>
      typeof value === 'object' &&
      value !== null &&
      Object.hasOwn(value, 'keyword') &&
      typeof (value as { code?: unknown }).code === 'function',
  );
  return ajvUniqueItems;
}

function equal(a: unknown, b: unknown): boolean {
  ajvEqual ??= unwrapDefault(
    equalModule,
    (value): value is (a: unknown, b: unknown) => boolean => typeof value === 'function',
  );
  return ajvEqual(a, b);
}

function unwrapDefault<T>(module: unknown, is: (value: unknown) => value is T): T {
  let value = module;
  for (let step = 0; step < 3; step += 1) {
    const inner = (value as { default?: unknown } | null)?.default;
    if (inner === undefined || inner === null) break;
    value = inner;
  }
  if (!is(value)) throw new Error("Ajv's module isn't the shape @kindgi/schema expects.");
  return value;
}

/** The keyword: `ajv.removeKeyword('uniqueItems')`, then `ajv.addKeyword(linearUniqueItems())`. */
export function linearUniqueItems(): CodeKeywordDefinition {
  return { ...ajvKeyword(), code: linearCode };
}

function linearCode(cxt: KeywordCxt): void {
  const { gen, data, $data, schema, parentSchema, schemaCode } = cxt;
  const itemTypes = parentSchema.items ? getSchemaTypes(parentSchema.items) : [];
  // Ajv's own test: items declared scalar are compared by a key already.
  if (itemTypes.length > 0 && !itemTypes.some((t) => t === 'object' || t === 'array')) {
    ajvKeyword().code(cxt);
    return;
  }
  if (!$data && !schema) return;
  const valid = gen.let('valid');
  cxt.block$data(valid, validateUniqueItems, _`${schemaCode} === false`);
  cxt.ok(valid);

  function validateUniqueItems(): void {
    const i = gen.let('i', _`${data}.length`);
    const j = gen.let('j');
    cxt.setParams({ i, j });
    gen.assign(valid, true);
    gen.if(_`${i} > 1`, () => {
      const find = gen.scopeValue('func', { ref: lastRepeat });
      const pair = gen.const('pair', _`${find}(${data})`);
      gen.if(pair, () => {
        gen.assign(i, _`${pair}[0]`);
        gen.assign(j, _`${pair}[1]`);
        cxt.error();
        gen.assign(valid, false);
      });
    });
  }
}

/**
 * The pair Ajv's own keyword reports for items it compares pair by pair:
 * `i`, the last item equal to an earlier one, and `j`, the last earlier
 * item it equals. Undefined when every item is unique.
 */
export function lastRepeat(items: readonly unknown[]): readonly [number, number] | undefined {
  const seen = new Map<string, number>();
  let found: readonly [number, number] | undefined;
  for (let k = 0; k < items.length; k += 1) {
    const key = itemKey(items[k]);
    if (key === undefined) return pairwise(items);
    const before = seen.get(key);
    if (before !== undefined) found = [k, before];
    seen.set(key, k);
  }
  return found;
}

/** Ajv's own loop: from the last item back, each against every item before it. */
function pairwise(items: readonly unknown[]): readonly [number, number] | undefined {
  for (let i = items.length - 1; i > 0; i -= 1) {
    for (let j = i - 1; j >= 0; j -= 1) {
      if (equal(items[i], items[j])) return [i, j];
    }
  }
  return undefined;
}

/**
 * A key two items share exactly when `fast-deep-equal` finds them equal:
 * JSON with each object's keys sorted, numbers as `String` writes them
 * (`-0` is `0`, every `NaN` the same), and `undefined` kept. Undefined for
 * a value JSON can't carry.
 */
function itemKey(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
      return 'undefined';
    case 'object': {
      if (value === null) return 'null';
      const proto = Object.getPrototypeOf(value);
      if (proto === Array.prototype) {
        const parts: string[] = [];
        for (const item of value as readonly unknown[]) {
          const key = itemKey(item);
          if (key === undefined) return undefined;
          parts.push(key);
        }
        return `[${parts.join(',')}]`;
      }
      if (proto !== Object.prototype) return undefined;
      const record = value as Readonly<Record<string, unknown>>;
      const parts: string[] = [];
      for (const name of Object.keys(record).sort()) {
        const key = itemKey(record[name]);
        if (key === undefined) return undefined;
        parts.push(`${JSON.stringify(name)}:${key}`);
      }
      // `fast-deep-equal` first compares `a.constructor` with `===`: an
      // own `constructor` key holding an object or array matches only the
      // same object, never an equal one.
      const ctor = Object.hasOwn(record, 'constructor') ? record.constructor : undefined;
      const same = typeof ctor === 'object' && ctor !== null ? `@${identity(ctor)}` : '';
      return `{${parts.join(',')}}${same}`;
    }
    default:
      return undefined;
  }
}

const identities = new WeakMap<object, number>();
let lastIdentity = 0;

/** A number for `value` itself: the same object, the same number. */
function identity(value: object): number {
  let id = identities.get(value);
  if (id === undefined) {
    lastIdentity += 1;
    id = lastIdentity;
    identities.set(value, id);
  }
  return id;
}
