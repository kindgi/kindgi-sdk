// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The one place `@kindgi/schema` makes an Ajv, under the process's bounds
 * (`@kindgi/bounds`): `compileJsonSchema`, `compileInlineSchema` and
 * `createSpecRegistry` all compile here.
 *
 * With `SELF_HOSTED_BOUNDS`, Ajv is as it always was: patterns on V8,
 * ajv-formats' full formats, Ajv's own `uniqueItems`. On RE2
 * (`HOSTED_BOUNDS`), every check a tenant's schema makes runs in time
 * linear in the data (`uniqueItems`: in its size times its depth):
 * - `pattern`, `patternProperties` and `propertyNames`' patterns run on
 *   RE2, through `compileTenantPattern` (Ajv's `code.regExp`); Kindgi's own
 *   schemas' patterns stay on V8 (`schemasFrom`);
 * - formats are ajv-formats' `fast` ones, with its format bounds
 *   (`formatMinimum` and the rest) as on V8; `regex` is a pattern whose
 *   syntax `compileTenantPattern` accepts (`tenantPatternSyntaxProblem`,
 *   which builds no RE2 program), and `url` is matched without the
 *   backtracking its regular expression has (see `linearUrl`);
 * - `uniqueItems` finds a repeat by each item's key, not pair by pair
 *   (`./unique-items.ts`).
 *
 * A tenant's schema (`compileTenantSchema`) is also measured before it's
 * compiled, its depth and its size as JSON, and compiled once: the
 * validators are kept by the schema's JSON, the least recently used
 * dropped first (`schemaCacheEntries`, `schemaCacheMaxBytes`). The time
 * its compiles take is charged to the tenant whose work it is
 * (`./compile-budget.ts`).
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import {
  compileTenantPattern,
  currentTenant,
  tenantInputBounds,
  tenantPatternSyntaxProblem,
} from '@kindgi/bounds';
import type { TenantInputBounds } from '@kindgi/bounds';
import { Ajv } from 'ajv';
import type { Options, ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { RegExpEngine, RegExpLike } from 'ajv/dist/types/index.js';

import { CompileBudget, SchemaCompileBudgetError } from './compile-budget.js';
import type { JsonSchemaDialect } from './dialect.js';
import { linearUniqueItems } from './unique-items.js';

type AnyAjv = Ajv | Ajv2019 | Ajv2020;

// ajv-formats is CommonJS (`export = fn`): the namespace holds the
// function directly or under `.default`, depending on the resolver.
type AddFormatsFn = (
  ajv: AnyAjv,
  opts?: { readonly mode?: 'fast' | 'full'; readonly keywords?: boolean },
) => unknown;
const addFormatsRaw = addFormatsModule as unknown;
const addFormats: AddFormatsFn =
  typeof addFormatsRaw === 'function'
    ? (addFormatsRaw as AddFormatsFn)
    : (addFormatsRaw as { default: AddFormatsFn }).default;

const require = createRequire(import.meta.url);

/** Whose schemas an Ajv compiles, and the keywords they may carry. */
export interface BoundedAjvOptions {
  /**
   * `tenant` (the default): anyone's, its patterns run as a tenant's do.
   * `kindgi`: Kindgi's own (`@kindgi/specs`), whose patterns are Kindgi's
   * code and run on V8 as the rest of it does; the checks they make of the
   * data (formats, `uniqueItems`) are bounded all the same.
   */
  readonly schemasFrom?: 'tenant' | 'kindgi';
  /** Keywords Kindgi reads off a schema, which validate nothing. */
  readonly annotations?: readonly string[];
}

/**
 * An Ajv for `dialect` under the process's bounds, with ajv-formats'
 * formats and format bounds, and the keywords in `annotations`.
 */
export function boundedAjv(
  dialect: JsonSchemaDialect,
  options: Options,
  how: BoundedAjvOptions = {},
): AnyAjv {
  const onRe2 = tenantInputBounds().regex === 're2';
  const tenants = how.schemasFrom !== 'kindgi';
  const ajvOptions: Options = tenants
    ? {
        ...options,
        // Ajv's default inlines a `$ref` target at every site that uses
        // it, so the code it writes grows as the target's size times its
        // uses while the JSON stays small: 27 KiB of one `$defs` used 400
        // times took 18 s and 2.8 GiB to compile.
        inlineRefs: false,
        ...(onRe2 && { code: { ...options.code, regExp: tenantRegExp } }),
      }
    : options;
  let ajv: AnyAjv;
  if (dialect === '2020-12') ajv = new Ajv2020(ajvOptions);
  else if (dialect === '2019-09') ajv = new Ajv2019(ajvOptions);
  else {
    ajv = new Ajv(ajvOptions);
    if (dialect === 'draft-06') {
      ajv.addMetaSchema(require('ajv/dist/refs/json-schema-draft-06.json'));
    }
  }
  if (onRe2) {
    // ajv-formats' default adds `formatMinimum`, `formatMaximum` and the
    // exclusive two; options replace that default, so these say `keywords`
    // too. The fast formats compare as the full ones do, in time linear in
    // the data.
    addFormats(ajv, { mode: 'fast', keywords: true });
    // A pattern `compileTenantPattern` would accept for its syntax, checked
    // without building RE2's program: data can carry thousands of values.
    ajv.addFormat('regex', (input: string) => tenantPatternSyntaxProblem(input) === undefined);
    ajv.addFormat('url', linearUrl());
    ajv.removeKeyword('uniqueItems');
    ajv.addKeyword(linearUniqueItems());
  } else {
    addFormats(ajv);
  }
  for (const keyword of how.annotations ?? []) ajv.addKeyword(keyword);
  return ajv;
}

/**
 * Ajv's `code.regExp` on RE2: a schema's pattern compiled by
 * `compileTenantPattern`, and refused, so the schema doesn't compile, when
 * it can't run there. Ajv keeps one compiled pattern per `toString()`.
 */
const tenantRegExp: RegExpEngine = Object.assign(
  (source: string, flags: string): RegExpLike => {
    const compiled = compileTenantPattern(source, flags);
    if (compiled.kind === 'refused') {
      throw new Error(
        `The schema's pattern ${JSON.stringify(source)} isn't a regular expression that compiles: ${compiled.reason}.`,
      );
    }
    const { pattern } = compiled;
    const key = JSON.stringify([source, flags]);
    const like = { test: (input: string) => pattern.test(input), toString: () => key };
    return like;
  },
  // Only Ajv's standalone code reads `code`, and Kindgi never generates it.
  { code: 'tenantRegExp' },
);

/**
 * ajv-formats' `url`, with its user-info part `\S+(?::\S*)?@` written
 * `\S+@`: the same strings (`\S` takes the `:` already), without the
 * backtracking that makes it quadratic in a long string with no `@`.
 * Built on first use, so only a process on RE2 depends on its source.
 */
function linearUrl(): RegExp {
  if (rewrittenUrl !== undefined) return rewrittenUrl;
  const full = (require('ajv-formats/dist/formats.js') as { fullFormats: { url: RegExp } })
    .fullFormats.url;
  const userInfo = '(?:\\S+(?::\\S*)?@)?';
  if (full.source.split(userInfo).length !== 2) {
    throw new Error("ajv-formats' url format isn't the one @kindgi/schema rewrites.");
  }
  rewrittenUrl = new RegExp(full.source.replace(userInfo, '(?:\\S+@)?'), full.flags);
  return rewrittenUrl;
}

let rewrittenUrl: RegExp | undefined;

/** What `compileTenantSchema` compiles: the dialect, Ajv's options, and the annotations. */
export interface TenantSchemaCompile {
  readonly dialect: JsonSchemaDialect;
  readonly options: Options;
  readonly annotations?: readonly string[];
}

/**
 * A validator for a tenant's `schema`, compiled once: measured against the
 * bounds first (its depth, then its size as JSON), then taken from the
 * cache or compiled and kept. Throws, as `ajv.compile` does, when it's over
 * a bound or doesn't compile; a schema that didn't compile is kept too, and
 * throws the same error again. Throws `SchemaCompileBudgetError`, and
 * keeps nothing, when the compile counts against a tenant that has spent
 * its budget.
 *
 * The cache key is the schema's JSON as written, keys in their order: the
 * order of `properties` is the order Ajv fills in defaults and reports
 * errors in. A schema holding a value JSON can't carry (a function,
 * `undefined`) is compiled each time.
 */
export function compileTenantSchema(schema: unknown, how: TenantSchemaCompile): ValidateFunction {
  return compileKeyed(schema, how).validate;
}

/**
 * A tenant's `schema` compiled now, as `compileTenantSchema` does, for a
 * caller that keeps it: what this keeps is the cache key, not the
 * validator. Each call returns the validator the cache has under the key
 * or, once the cache has dropped it (or the bounds changed), compiles it
 * again as `compileTenantSchema` does, a recompile the tenant's budget
 * counts, and which can throw as it does. So however long a caller keeps
 * it, the cache is all that holds the compiled schema. A schema holding a
 * value JSON can't carry, never cached, is held as compiled.
 */
export function holdTenantSchema(
  schema: unknown,
  how: TenantSchemaCompile,
): () => ValidateFunction {
  const first = compileKeyed(schema, how);
  if (first.key === undefined) return () => first.validate;
  let key = first.key;
  return () => {
    const kept = stateFor(tenantInputBounds()).cache.get(key);
    if (kept?.kind === 'compiled') return kept.validate;
    const again = compileKeyed(schema, how);
    if (again.key !== undefined) key = again.key;
    return again.validate;
  };
}

/** `compileTenantSchema`'s validator, and the key the cache keeps it under (none when it isn't JSON). */
function compileKeyed(
  schema: unknown,
  how: TenantSchemaCompile,
): { readonly validate: ValidateFunction; readonly key?: string } {
  const bounds = tenantInputBounds();
  const measured = measure(schema, bounds);
  if (measured.kind === 'over') throw new Error(measured.reason);
  const text = jsonText(schema);
  const bytes = Buffer.byteLength(text);
  if (bytes > bounds.schemaMaxBytes) {
    throw new Error(
      `The schema is ${bytes} bytes as JSON, over the limit of ${bounds.schemaMaxBytes}.`,
    );
  }
  const compile = () =>
    boundedAjv(how.dialect, how.options, { annotations: how.annotations ?? [] }).compile(
      schema as object,
    );
  const { cache, budget } = stateFor(bounds);
  const scope = currentTenant();
  if (!measured.json) return { validate: budget.run(scope, undefined, compile) };
  const key = createHash('sha256')
    .update(JSON.stringify([how.dialect, how.options, how.annotations ?? []]))
    .update(text)
    .digest('base64');
  const kept = cache.get(key);
  if (kept !== undefined) {
    if (kept.kind === 'refused') throw kept.error;
    return { validate: kept.validate, key };
  }
  let validate: ValidateFunction;
  try {
    validate = budget.run(scope, key, compile);
  } catch (error) {
    // A schema that doesn't compile keeps its error, which is small.
    if (!(error instanceof SchemaCompileBudgetError)) cache.set(key, { kind: 'refused', error }, 0);
    throw error;
  }
  cache.set(key, { kind: 'compiled', validate }, bytes);
  return { validate, key };
}

/** `JSON.stringify(schema)`, or '' when it can't write it (a `BigInt`). */
function jsonText(schema: unknown): string {
  try {
    return JSON.stringify(schema) ?? '';
  } catch {
    return '';
  }
}

type Measured =
  | { readonly kind: 'over'; readonly reason: string }
  | { readonly kind: 'within'; readonly json: boolean };

/**
 * Whether `schema` nests deeper than the bounds allow, and whether it's
 * JSON: only plain objects, arrays, strings, finite numbers, booleans and
 * `null`. Walked without recursion, and stopped once it has seen more
 * values than fit in `schemaMaxBytes` of JSON, so an object graph that
 * shares its parts (or loops) can't make the walk long.
 */
function measure(schema: unknown, bounds: TenantInputBounds): Measured {
  const max = bounds.schemaMaxDepth;
  const stack: [unknown, number][] = [[schema, 0]];
  let json = true;
  let seen = 0;
  while (stack.length > 0) {
    const [value, depth] = stack.pop() as [unknown, number];
    if (typeof value === 'number') json &&= Number.isFinite(value);
    else if (typeof value !== 'object')
      json &&= typeof value === 'string' || typeof value === 'boolean';
    if (typeof value !== 'object' || value === null) continue;
    if (depth === max) {
      return {
        kind: 'over',
        reason: `The schema nests objects and arrays more than ${max} deep, the limit.`,
      };
    }
    const proto = Object.getPrototypeOf(value);
    json &&= proto === Object.prototype || proto === Array.prototype;
    for (const inner of Object.values(value)) {
      seen += 1;
      // Each value takes at least two bytes of JSON, with its comma.
      if (seen * 2 > bounds.schemaMaxBytes) {
        return {
          kind: 'over',
          reason: `The schema is more than ${bounds.schemaMaxBytes} bytes as JSON, the limit.`,
        };
      }
      stack.push([inner, depth + 1]);
    }
  }
  return { kind: 'within', json };
}

type Kept =
  | { readonly kind: 'compiled'; readonly validate: ValidateFunction }
  | { readonly kind: 'refused'; readonly error: unknown };

/**
 * A cache that drops the least recently used entries while it holds more
 * than `maxEntries`, or more than `maxBytes` by the weights it was given.
 */
class LeastRecentlyUsed<V> {
  private readonly entries = new Map<string, { readonly value: V; readonly bytes: number }>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, bytes: number): void {
    this.delete(key);
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.delete(oldest.value);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }
}

interface State {
  readonly bounds: TenantInputBounds;
  readonly cache: LeastRecentlyUsed<Kept>;
  readonly budget: CompileBudget;
}

let state: State | undefined;

/** The cache and the budget for `bounds`: new ones when the bounds change (a test's override). */
function stateFor(bounds: TenantInputBounds): State {
  if (state?.bounds !== bounds) {
    state = {
      bounds,
      cache: new LeastRecentlyUsed(bounds.schemaCacheEntries, bounds.schemaCacheMaxBytes),
      budget: new CompileBudget(bounds.schemaCompileBudgetMs),
    };
  }
  return state;
}
