// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi exports create`'s plan against `openapi.json`: every read route
 * is in the plan or excluded with a reason, exactly once, so a new route
 * fails here until someone classifies it. Each kind's reads match its
 * route: the path parameters its parent fills, the query it sends, how it
 * pages, and, where a list stands in for each item's own route, that the
 * list carries every field that route answers.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { EXCLUDED, EXPORT_PLAN } from '../src/exports/plan.js';
import type { ExportKind } from '../src/exports/plan.js';
import { PAGE_SIZE } from '../src/exports/reader.js';

type Schema = {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly items?: Schema;
  readonly allOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly enum?: readonly unknown[];
  readonly maximum?: number;
};
type Parameter = {
  readonly $ref?: string;
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly schema?: Schema;
};
type Operation = {
  readonly parameters?: readonly Parameter[];
  readonly responses: Readonly<
    Record<string, { readonly content?: Readonly<Record<string, { readonly schema?: Schema }>> }>
  >;
};
type Spec = {
  readonly paths: Readonly<
    Record<string, { readonly get?: Operation; readonly parameters?: readonly Parameter[] }>
  >;
};

const spec = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../api/openapi.json', import.meta.url)), 'utf8'),
) as Spec;

function deref<T extends { readonly $ref?: string }>(value: T): T {
  let at: T = value;
  while (at.$ref !== undefined) {
    at = at.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce((o: Record<string, unknown>, k) => o[k] as Record<string, unknown>, spec) as T;
  }
  return at;
}

/** Every field a schema can answer: the union over `allOf`, `oneOf` and `anyOf`. */
function fields(schema: Schema | undefined): Map<string, Schema> {
  const out = new Map<string, Schema>();
  if (schema === undefined) return out;
  const s = deref(schema);
  for (const part of [...(s.allOf ?? []), ...(s.oneOf ?? []), ...(s.anyOf ?? [])]) {
    for (const [k, v] of fields(part)) out.set(k, v);
  }
  for (const [k, v] of Object.entries(s.properties ?? {})) out.set(k, v);
  return out;
}

const GETS = Object.entries(spec.paths).flatMap(([path, item]) =>
  item.get === undefined ? [] : [path],
);

function operation(route: string): Operation {
  const op = spec.paths[route]?.get;
  if (op === undefined) throw new Error(`${route} isn't a GET in openapi.json`);
  return op;
}

function params(route: string, where: 'path' | 'query'): Map<string, Parameter> {
  const all = [...(spec.paths[route]?.parameters ?? []), ...(operation(route).parameters ?? [])];
  return new Map(all.map(deref).flatMap((p) => (p.in === where ? [[p.name, p]] : [])));
}

function answer(route: string): Schema | undefined {
  return operation(route).responses['200']?.content?.['application/json']?.schema;
}

/** The records a list answers: its `data` array's items. */
function listItem(route: string): Schema | undefined {
  const data = fields(answer(route)).get('data');
  return data === undefined ? undefined : deref(data).items;
}

/** The records a kind's file holds: each item's own record, the one answer, or the list's items. */
function recordSchema(kind: ExportKind): Schema | undefined {
  if (kind.item !== undefined) return answer(kind.item.route);
  if (kind.paging === 'one') return answer(kind.route);
  return listItem(kind.route);
}

/** The field at `path` in a record's schema, when the record carries it. */
function fieldAt(schema: Schema | undefined, path: readonly string[]): Schema | undefined {
  let at = schema;
  for (const name of path) {
    const field = fields(at).get(name);
    if (field === undefined) return undefined;
    at = deref(field);
  }
  return at;
}

/** The types a field can take, over `oneOf` and `anyOf`. */
function typesOf(field: Schema | undefined): string[] {
  if (field === undefined) return [];
  const s = deref(field);
  const own = s.type === undefined ? [] : typeof s.type === 'string' ? [s.type] : [...s.type];
  return [...own, ...[...(s.oneOf ?? []), ...(s.anyOf ?? [])].flatMap(typesOf)];
}

/** Whether a record's field can fill a path: it's a string or an integer, never anything else. */
function fillsAPath(field: Schema | undefined): boolean {
  const types = typesOf(field).filter((t) => t !== 'null');
  return types.length > 0 && types.every((t) => t === 'string' || t === 'integer');
}

const kindNamed = (name: string): ExportKind => {
  const kind = EXPORT_PLAN.find((k) => k.name === name);
  if (kind === undefined) throw new Error(`no kind ${name} in the plan`);
  return kind;
};

/**
 * What the export reads from records besides what fills a path
 * (`create.ts`): the env names, a secret's env and scope to read its
 * versions at, the orgs' and projects' ids to read each env at, an
 * approval's id and status, and a run's id for its signed provenance.
 */
const READS: readonly (readonly [string, readonly string[]])[] = [
  ['environments', ['envName']],
  ['secrets', ['envName']],
  ['secrets', ['scope', 'kind']],
  ['secrets', ['scope', 'orgId']],
  ['secrets', ['scope', 'projectId']],
  ['orgs', ['id']],
  ['projects', ['id']],
  ['approvals', ['id']],
  ['approvals', ['status']],
  ['provenance', ['runId']],
];

const pathParams = (route: string): string[] =>
  [...route.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);

function classified(): Map<string, string[]> {
  const where = new Map<string, string[]>();
  const add = (route: string, as: string) => where.set(route, [...(where.get(route) ?? []), as]);
  for (const kind of EXPORT_PLAN) {
    add(kind.route, kind.name);
    if (kind.item !== undefined) add(kind.item.route, `${kind.name} (each item)`);
    if (kind.bytes !== undefined) add(kind.bytes.route, `${kind.name} (bytes)`);
    for (const route of kind.covers ?? []) add(route, `${kind.name} (covers)`);
  }
  for (const route of Object.keys(EXCLUDED)) add(route, 'EXCLUDED');
  return where;
}

describe('every read route is exported or excluded, once', () => {
  const where = classified();

  test('no read route is left out', () => {
    expect(GETS.filter((route) => !where.has(route))).toEqual([]);
  });

  test('none is in two places', () => {
    expect([...where].filter(([, as]) => as.length > 1)).toEqual([]);
  });

  test('every route the plan names is a read route', () => {
    expect([...where.keys()].filter((route) => !GETS.includes(route))).toEqual([]);
  });

  test('every exclusion says why', () => {
    expect(Object.entries(EXCLUDED).filter(([, why]) => why.trim() === '')).toEqual([]);
  });
});

describe('each kind reads its route as the route takes it', () => {
  test('kind names are unique, and a parent comes before its children', () => {
    const seen = new Set<string>();
    for (const kind of EXPORT_PLAN) {
      expect(seen.has(kind.name), kind.name).toBe(false);
      if (kind.parent !== undefined) expect(seen.has(kind.parent.kind), kind.name).toBe(true);
      seen.add(kind.name);
    }
  });

  const kinds = EXPORT_PLAN.map((k) => [k.name, k] as const);

  test.each(kinds)('%s: its parent fills its path', (_name, kind: ExportKind) => {
    expect(pathParams(kind.route).sort()).toEqual(Object.keys(kind.parent?.params ?? {}).sort());
  });

  test.each(kinds)('%s: the route takes each query value it sends', (_name, kind: ExportKind) => {
    const query = params(kind.route, 'query');
    const sent = [...Object.keys(kind.query ?? {}), ...Object.keys(kind.parent?.query ?? {})];
    const unknown = sent.filter((name) => !query.has(name));
    expect(unknown, kind.route).toEqual([]);
    const outside = Object.entries(kind.query ?? {}).filter(([name, value]) => {
      const schema = query.get(name)?.schema;
      const allowed = schema === undefined ? undefined : deref(schema).enum;
      return allowed !== undefined && !allowed.includes(value);
    });
    expect(outside, kind.route).toEqual([]);
  });

  test.each(kinds)('%s: it sends every query value the route needs', (_name, kind: ExportKind) => {
    const query = params(kind.route, 'query');
    const scoped = kind.envScoped === true ? ['envName', 'scopeKind', 'scopeId'] : [];
    const paged = kind.paging === 'cursor' ? ['limit', 'cursor'] : [];
    const filled = Object.keys(kind.parent?.query ?? {});
    const given = new Set([...Object.keys(kind.query ?? {}), ...filled, ...scoped, ...paged]);
    const missing = [...query.values()].filter((p) => p.required === true && !given.has(p.name));
    expect(missing.map((p) => p.name)).toEqual([]);
    expect(scoped.filter((name) => name !== 'scopeId' && !query.has(name))).toEqual([]);
  });

  test.each(kinds)('%s: it pages as the route does', (_name, kind: ExportKind) => {
    const query = params(kind.route, 'query');
    const pages = query.has('cursor');
    expect(kind.paging === 'cursor', `${kind.route} takes ?cursor`).toBe(pages);
    if (kind.paging === 'cursor') {
      const limit = query.get('limit')?.schema;
      expect(limit === undefined ? undefined : deref(limit).maximum).toBeGreaterThanOrEqual(
        PAGE_SIZE,
      );
    }
    const shape = fields(answer(kind.route));
    expect(shape.has('data'), `${kind.route} answers a list`).toBe(kind.paging !== 'one');
  });

  test.each(kinds.filter(([, k]) => k.parent !== undefined))(
    '%s: its parent’s records carry what fills its path and query',
    (_name, kind: ExportKind) => {
      const parent = recordSchema(kindNamed(kind.parent?.kind as string));
      const fields = [
        ...Object.values(kind.parent?.params ?? {}),
        ...Object.values(kind.parent?.query ?? {}),
      ];
      expect(fields.filter((field) => !fillsAPath(fieldAt(parent, [field])))).toEqual([]);
    },
  );

  test.each(
    EXPORT_PLAN.flatMap((k) =>
      [k.item, k.bytes].flatMap((read) => (read === undefined ? [] : [[k.name, read, k] as const])),
    ),
  )(
    '%s: each item’s route takes the fields it names, and the list carries them',
    (_name, read, kind) => {
      expect(pathParams(read.route).sort()).toEqual(Object.keys(read.params).sort());
      const listed = listItem(kind.route);
      const fields = Object.values(read.params);
      expect(fields.filter((field) => !fillsAPath(fieldAt(listed, [field])))).toEqual([]);
    },
  );

  test.each(READS)('%s: its records carry %j, which the export reads', (name, path) => {
    expect(fillsAPath(fieldAt(recordSchema(kindNamed(name)), path))).toBe(true);
  });

  test('whoami answers the tenant, whether the caller is its admin, and its key’s scopes, role and project', () => {
    const me = answer('/v1/identity/whoami');
    expect(typesOf(fieldAt(me, ['tenantId']))).toEqual(['string']);
    expect(typesOf(fieldAt(me, ['tenantAdmin']))).toEqual(['boolean']);
    expect(typesOf(fieldAt(me, ['scopes']))).toEqual(['array']);
    expect(typesOf(fieldAt(me, ['role']))).toEqual(['string']);
    expect(fieldAt(me, ['role'])?.enum).toContain('member');
    expect(typesOf(fieldAt(me, ['projectId']))).toEqual(['string']);
  });

  test.each(
    EXPORT_PLAN.flatMap((k) => (k.covers ?? []).map((route) => [k.name, route, k] as const)),
  )('%s: the list carries every field %s answers', (_name, route, kind: ExportKind) => {
    const item = fields(listItem(kind.route));
    // A route under an item (`/users/{userId}/grants`) answers one of its fields.
    const last = route.split('/').pop() as string;
    const part = item.get(last);
    const carried = part === undefined ? item : fields(part);
    const answered = fields(answer(route));
    expect([...answered.keys()].filter((k) => !carried.has(k))).toEqual([]);
  });
});
