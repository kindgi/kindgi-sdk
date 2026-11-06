// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
// reads-source: packages/api/openapi.json sdks/typescript/src/resources/*.ts

/**
 * A method whose route answers only `204 No Content` resolves to nothing.
 * The transport hands back `undefined` for a 204, so a method typed as
 * returning a record would give its caller `undefined` under that record's
 * type, and a read of a field off it would fail at run time, not compile
 * time. Each resource method's `@wire METHOD /path` tag names its route; for
 * every route whose only success answer in the spec is 204, the method's
 * declared return must be `Promise<void>`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOURCES_DIR = join(__dirname, '..', 'src', 'resources');
// The spec `@kindgi/api` ships, which the generated wire types come from.
const OPENAPI = createRequire(import.meta.url).resolve('@kindgi/api/openapi.json');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Spec {
  readonly paths: Record<string, Partial<Record<string, { readonly responses?: object }>>>;
}

interface Tagged {
  readonly where: string;
  readonly route: string;
  /** The declared return, or undefined when no method declaration follows the tag. */
  readonly returns: string | undefined;
}

// A route's key: its method and its path with each parameter as `*`, so the
// spec's `/v1/projects/{projectId}` and a tag's `/v1/projects/:projectId` meet.
const routeKey = (method: string, path: string): string =>
  `${method.toUpperCase()} ${path.replace(/\{[^}]+\}|:[A-Za-z_]\w*/gu, '*')}`;

/** The routes whose only success (2xx) answer is 204. */
function noContentRoutes(spec: Spec): Set<string> {
  const routes = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const responses = item[method]?.responses;
      if (responses === undefined) continue;
      const success = Object.keys(responses).filter((code) => code.startsWith('2'));
      if (success.length === 1 && success[0] === '204') routes.add(routeKey(method, path));
    }
  }
  return routes;
}

/**
 * The return type of the method declaration `rest` starts with,
 * `name(…): Promise<…>;`, its parameters on one line or several.
 */
function declaredReturn(rest: string): string | undefined {
  const head = /^\s*\w+\s*\(/u.exec(rest);
  if (head === null) return undefined;
  let depth = 0;
  for (let i = head[0].length - 1; i < rest.length; i += 1) {
    if (rest[i] === '(') depth += 1;
    if (rest[i] === ')') depth -= 1;
    if (depth === 0) {
      return /^\):\s*([^;{]+);/u.exec(rest.slice(i))?.[1]?.replace(/\s+/gu, ' ').trim();
    }
  }
  return undefined;
}

/** Each `@wire` tag in `source`'s doc comments, with the declaration's return after it. */
function wireTags(source: string, file: string): Tagged[] {
  const tagged: Tagged[] = [];
  for (const comment of source.matchAll(/\/\*\*([\s\S]*?)\*\//gu)) {
    const line = source.slice(0, comment.index).split('\n').length;
    const returns = declaredReturn(source.slice((comment.index ?? 0) + comment[0].length));
    for (const tag of (comment[1] ?? '').matchAll(
      /@wire\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/gu,
    )) {
      tagged.push({ where: `${file}:${line}`, route: routeKey(tag[1]!, tag[2]!), returns });
    }
  }
  return tagged;
}

const offenders = (tags: readonly Tagged[], noContent: ReadonlySet<string>): string[] =>
  tags
    .filter((t) => noContent.has(t.route) && t.returns !== 'Promise<void>')
    .map(
      (t) =>
        `${t.where}: ${t.route} answers only 204, but returns ${t.returns ?? 'no method declaration'}`,
    );

describe('a method on a 204-only route resolves to nothing', () => {
  const noContent = noContentRoutes(JSON.parse(readFileSync(OPENAPI, 'utf8')) as Spec);
  const tags = readdirSync(RESOURCES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => wireTags(readFileSync(join(RESOURCES_DIR, f), 'utf8'), f));

  it('every such method returns Promise<void>', () => {
    expect(
      offenders(tags, noContent),
      'A resource method whose route answers only 204 must be typed Promise<void> and call\n' +
        'transport.request<void>: the transport resolves a 204 to undefined. To return the\n' +
        'record, read it back with the resource’s get.',
    ).toEqual([]);
  });

  it('reads the routes and tags it checks, the updates among them', () => {
    const checked = tags.filter((t) => noContent.has(t.route)).map((t) => t.route);
    expect(checked).toEqual(
      expect.arrayContaining([
        'PATCH /v1/projects/*',
        'PATCH /v1/orgs/*',
        'PATCH /v1/teams/*',
        'PATCH /v1/tenant',
        'DELETE /v1/projects/*',
      ]),
    );
  });

  it('flags a 204 route typed as a record, its parameters across lines', () => {
    const source = [
      'export interface ThingsClient {',
      '  /** @wire PATCH /v1/things/:thingId */',
      '  update(',
      '    thingId: string,',
      '    options?: { readonly idempotencyKey?: string },',
      '  ): Promise<Thing>;',
      '  /** @wire DELETE /v1/things/:thingId */',
      '  delete(thingId: string): Promise<void>;',
      '  /** @wire GET /v1/things/:thingId/parts */',
      '  readonly parts: PartsClient;',
      '}',
    ].join('\n');
    const routes = new Set(['PATCH /v1/things/*', 'DELETE /v1/things/*', 'GET /v1/things/*/parts']);
    expect(offenders(wireTags(source, 'things.ts'), routes)).toEqual([
      'things.ts:2: PATCH /v1/things/* answers only 204, but returns Promise<Thing>',
      'things.ts:9: GET /v1/things/*/parts answers only 204, but returns no method declaration',
    ]);
  });

  it('counts a route as 204-only only when 204 is its one success answer', () => {
    const spec: Spec = {
      paths: {
        '/v1/things/{thingId}': {
          patch: { responses: { '204': {}, '400': {} } },
          delete: { responses: { '200': {}, '204': {} } },
          get: { responses: { '200': {} } },
        },
      },
    };
    expect([...noContentRoutes(spec)]).toEqual(['PATCH /v1/things/*']);
  });
});
