// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, test } from 'vitest';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import { OPERATIONS, generateOpenApiDocument, honoToOpenapiPath } from '../src/index.js';
import { frozenTenantMay } from '../src/middleware/tenant-state-rules.js';
import {
  READS_WITHOUT_STORAGE,
  answersAuthzUnavailable,
  answersDatabaseBusy,
  takesIdempotencyKey,
} from '../src/openapi/operations.js';
import { RunEventSchema } from '../src/openapi/schemas.js';

import { fullAppInput, noopResolveToken, noopRunHandler } from './support/full-app.js';

interface HonoRouteRecord {
  readonly method: string;
  readonly path: string;
  readonly basePath?: string;
}

function collectMountedRoutes(): HonoRouteRecord[] {
  const app = createApp(fullAppInput());
  return (app.routes as unknown as HonoRouteRecord[]).filter((r) => r.method !== 'ALL');
}

describe('OpenAPI — operations registry ↔ mounted routes drift', () => {
  test('every mounted route has an OPERATIONS entry', () => {
    const mounted = collectMountedRoutes();
    const registered = new Set(OPERATIONS.map((o) => `${o.method.toUpperCase()} ${o.honoPath}`));
    const missing: string[] = [];
    for (const r of mounted) {
      const key = `${r.method.toUpperCase()} ${r.path}`;
      if (!registered.has(key)) missing.push(key);
    }
    expect(
      missing,
      `Routes mounted on the Hono app but missing from OPERATIONS: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  test('every OPERATIONS entry maps to a mounted route', () => {
    const mounted = new Set(
      collectMountedRoutes().map((r) => `${r.method.toUpperCase()} ${r.path}`),
    );
    const dangling: string[] = [];
    for (const op of OPERATIONS) {
      // Hono answers a HEAD with the GET route at its path: that route serves a `head` operation.
      const method = op.method === 'head' ? 'GET' : op.method.toUpperCase();
      const key = `${method} ${op.honoPath}`;
      if (!mounted.has(key)) dangling.push(key);
    }
    expect(dangling, `OPERATIONS entries with no mounted route: ${dangling.join(', ')}`).toEqual(
      [],
    );
  });

  test('openapiPath is a correct rewrite of honoPath', () => {
    for (const op of OPERATIONS) {
      expect(op.openapiPath).toBe(honoToOpenapiPath(op.honoPath));
    }
  });

  test('operationIds are unique', () => {
    const ids = OPERATIONS.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('OpenAPI — generated document', () => {
  test('is a valid OpenAPI 3.1 top-level shape', () => {
    const doc = generateOpenApiDocument() as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
      tags: Array<{ name: string }>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    expect(Object.keys(doc.components.schemas).length).toBeGreaterThan(0);
    expect(doc.components.securitySchemes.bearerAuth).toBeTruthy();
    expect(doc.tags.length).toBeGreaterThan(0);
  });

  test('each operation declares the security its variant names', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<string, Record<string, { operationId: string; security: unknown[] }>>;
    };
    for (const op of OPERATIONS.filter((o) => o.unserved === undefined)) {
      const path = doc.paths[op.openapiPath];
      expect(path, `path ${op.openapiPath} missing`).toBeTruthy();
      const method = path?.[op.method];
      expect(method, `${op.method} ${op.openapiPath} missing`).toBeTruthy();
      if (op.security === 'public') {
        expect(method?.security).toEqual([]);
      } else if (op.security === 'bearer-or-public-run') {
        expect(method?.security).toEqual([{ bearerAuth: [] }, { publicRunToken: [] }]);
      } else {
        expect(method?.security).toEqual([{ bearerAuth: [] }]);
      }
    }
  });

  test('every served read declares the 503 the database answers when busy', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { description?: string }> }>
      >;
    };
    const reads = OPERATIONS.filter((o) => o.unserved === undefined && answersDatabaseBusy(o));
    // Guard against a filter that selects nothing (which would pass vacuously):
    // there are well over a hundred served reads.
    expect(reads.length).toBeGreaterThan(100);
    for (const op of reads) {
      const method = doc.paths[op.openapiPath]?.[op.method];
      expect(method, `${op.method} ${op.openapiPath} missing`).toBeTruthy();
      const response = method?.responses['503'];
      expect(
        response,
        `${op.operationId} (${op.method} ${op.openapiPath}) must declare a 503 (database-busy)`,
      ).toBeDefined();
      // The 503 must name the busy answer, so a read that keeps its own 503
      // can't quietly drop it (`identity.me.permissions` names both causes).
      expect(response?.description, `${op.operationId} 503 must name database-busy`).toContain(
        'database-busy',
      );
    }
  });

  test('a read that never reaches storage is left out of the 503', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(READS_WITHOUT_STORAGE.size).toBeGreaterThan(0);
    for (const id of READS_WITHOUT_STORAGE) {
      const op = OPERATIONS.find((o) => o.operationId === id);
      expect(op, `no operation ${id}`).toBeTruthy();
      const method = op === undefined ? undefined : doc.paths[op.openapiPath]?.[op.method];
      expect(method, `${id} missing`).toBeTruthy();
      expect(
        (method as { responses: Record<string, unknown> }).responses['503'],
        `${id} never reaches storage, so it declares no 503`,
      ).toBeUndefined();
    }
  });

  test('a read with its own 503 keeps it, not the shared database-busy one', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
    };
    // `identity.me.permissions` declares its own 503 (`authz-backend-unavailable`,
    // widened to name `database-busy` too); the generator keeps it rather than
    // replacing it with the shared response.
    const method = doc.paths['/v1/identity/me/permissions']?.get;
    expect(method, 'identity.me.permissions missing').toBeTruthy();
    expect(method?.responses['503']?.description).toContain('authz-backend-unavailable');
  });

  test('every served write that takes an Idempotency-Key declares the 503 its key store answers', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { description?: string }> }>
      >;
    };
    const writes = OPERATIONS.filter((o) => o.unserved === undefined && takesIdempotencyKey(o));
    // Guard against a filter that selects nothing (which would pass vacuously):
    // well over a hundred writes take the key.
    expect(writes.length).toBeGreaterThan(100);
    for (const op of writes) {
      const response = doc.paths[op.openapiPath]?.[op.method]?.responses['503'];
      expect(
        response,
        `${op.operationId} (${op.method} ${op.openapiPath}) must declare a 503 (idempotency-store-unavailable)`,
      ).toBeDefined();
      // A write that keeps its own 503 must name this one too.
      expect(
        response?.description,
        `${op.operationId} 503 must name idempotency-store-unavailable`,
      ).toContain('idempotency-store-unavailable');
    }
  });

  test('an operation without the key never declares it: reads, and writes that take no key', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { description?: string }> }>
      >;
    };
    const others = OPERATIONS.filter((o) => o.unserved === undefined && !takesIdempotencyKey(o));
    // Both kinds are there, so neither half passes vacuously.
    expect(others.some((o) => o.method === 'get')).toBe(true);
    expect(others.some((o) => o.method === 'post')).toBe(true);
    for (const op of others) {
      const response = doc.paths[op.openapiPath]?.[op.method]?.responses['503'];
      expect(
        response?.description ?? '',
        `${op.operationId} takes no Idempotency-Key`,
      ).not.toContain('idempotency-store-unavailable');
    }
  });

  test('every served operation that declares a 401 declares a 503 naming authz-backend-unavailable and database-busy', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { description?: string }> }>
      >;
    };
    const authenticated = OPERATIONS.filter(
      (o) => o.unserved === undefined && answersAuthzUnavailable(o),
    );
    // Guard against a filter that selects nothing (which would pass vacuously):
    // all but a handful of operations declare a 401.
    expect(authenticated.length).toBeGreaterThan(400);
    for (const op of authenticated) {
      const response = doc.paths[op.openapiPath]?.[op.method]?.responses['503'];
      expect(
        response,
        `${op.operationId} (${op.method} ${op.openapiPath}) must declare a 503 (authz-backend-unavailable)`,
      ).toBeDefined();
      // Whichever 503 it has, its own or a shared one, names the code.
      expect(
        response?.description,
        `${op.operationId} 503 must name authz-backend-unavailable`,
      ).toContain('authz-backend-unavailable');
      // The authorization check reads the database too, before the handler
      // runs, so a busy one answers the same 503 on any method.
      expect(response?.description, `${op.operationId} 503 must name database-busy`).toContain(
        'database-busy',
      );
    }
  });

  test('an operation that declares no 401 never names authz-backend-unavailable', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { description?: string }> }>
      >;
    };
    const unauthenticated = OPERATIONS.filter(
      (o) => o.unserved === undefined && !answersAuthzUnavailable(o),
    );
    expect(unauthenticated.length).toBeGreaterThan(0);
    for (const op of unauthenticated) {
      const response = doc.paths[op.openapiPath]?.[op.method]?.responses['503'];
      expect(response?.description ?? '', `${op.operationId} declares no 401`).not.toContain(
        'authz-backend-unavailable',
      );
    }
    // `GET /v1/auth/sign-in-options` keeps the shared busy 503 alone.
    const signInOptions = doc.paths['/v1/auth/sign-in-options']?.get?.responses['503'];
    expect(signInOptions?.description).toContain('database-busy');
  });

  test("what the runtime doesn't serve is left out, with the schemas only it uses", () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
      tags: { name: string }[];
    };
    const unserved = OPERATIONS.filter((o) => o.unserved !== undefined);
    expect(unserved.map((o) => o.operationId).sort()).toEqual(
      [
        'register',
        'list',
        'get',
        'update',
        'pause',
        'resume',
        'unregister',
        'listVersions',
        'getVersion',
      ]
        .map((verb) => `eventTriggers.${verb}`)
        .sort(),
    );
    for (const op of unserved) {
      expect(doc.paths[op.openapiPath]?.[op.method], op.operationId).toBeUndefined();
    }
    const schemas = Object.keys(doc.components.schemas);
    expect(schemas.filter((n) => /EventTrigger/.test(n))).toEqual([]);
    // Webhook triggers are served (inbound events, with their receiver).
    expect(schemas).toContain('WebhookTriggerRecord');
    expect(doc.paths['/v1/hooks/{tenantId}/{webhookId}']?.post).toBeDefined();
    // A schema a served operation uses too stays.
    expect(schemas).toContain('TriggerStatus');
    expect(doc.tags.map((t) => t.name)).not.toContain('event-triggers');
  });

  test('SSE stream endpoint advertises text/event-stream', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>
      >;
    };
    const stream = doc.paths['/v1/runs/{runId}/stream']?.get;
    expect(stream).toBeTruthy();
    expect(stream?.responses['200']?.content).toHaveProperty('text/event-stream');
  });

  test('every $ref target exists under components.schemas or components.headers', () => {
    const doc = generateOpenApiDocument() as {
      components: { schemas: Record<string, unknown>; headers: Record<string, unknown> };
      paths: Record<string, unknown>;
    };
    const known = new Set([
      ...Object.keys(doc.components.schemas).map((name) => `#/components/schemas/${name}`),
      ...Object.keys(doc.components.headers).map((name) => `#/components/headers/${name}`),
    ]);
    const refs: string[] = [];
    collectRefs(doc.paths, refs);
    for (const ref of refs) expect(known.has(ref), `dangling $ref: ${ref}`).toBe(true);
  });

  // Without a `mapping`, a generator may take each member's schema name as
  // its tag (openapi-typescript types `kind` as "ImproveRunOutcomeSuggested").
  // A mapping that leaves a member out is no better: openapi-typescript keeps
  // that member's schema name, and typed-openapi's zod output drops it.
  test("every discriminated union maps each member's tag to that member", () => {
    const doc = generateOpenApiDocument() as {
      components: { schemas: Record<string, SchemaNode> };
    };
    const unions: DiscriminatedUnion[] = [];
    collectDiscriminatedUnions(doc, '#', unions);
    // The walk finds named unions, and ones inlined in a property.
    expect(unions.map((u) => u.where)).toEqual(
      expect.arrayContaining([
        '#/components/schemas/ImproveRunOutcome',
        '#/components/schemas/CreateServiceAccountBody/properties/grants/items',
      ]),
    );
    for (const { where, union } of unions) {
      expect(
        union.discriminator.mapping,
        `${where}: no mapping, or not each member's tag to that member`,
      ).toEqual(mappingFromTags(where, union, doc.components.schemas));
    }
  });
});

describe('OpenAPI — RunEvent schema mirrors @kindgi/specs/run-event.schema.json', () => {
  test('kind enum + required fields match the file spec', async () => {
    const specPath = createRequire(import.meta.url).resolve('@kindgi/specs/run-event.schema.json');
    const specRaw = await readFile(specPath, 'utf8');
    const spec = JSON.parse(specRaw) as {
      required: string[];
      properties: { kind: { enum: string[] } };
    };
    const inlined = RunEventSchema as {
      required: string[];
      properties: { kind: { enum: string[] } };
    };
    expect(inlined.required.sort()).toEqual(spec.required.slice().sort());
    expect(inlined.properties.kind.enum.slice().sort()).toEqual(
      spec.properties.kind.enum.slice().sort(),
    );
  });
});

describe('OpenAPI — public route is reachable without auth', () => {
  test('GET /v1/openapi.json is public and returns 200', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: noopResolveToken,
      runHandler: noopRunHandler,
    });
    const res = await app.request('/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/runs');
  });
});

interface SpecResponse {
  readonly description?: string;
  readonly headers?: Readonly<Record<string, { readonly $ref?: string }>>;
}

interface SpecOperation {
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly parameters?: readonly { readonly name?: string; readonly in?: string }[];
  readonly responses: Readonly<Record<string, SpecResponse>>;
}

interface SpecEntry {
  readonly method: string;
  readonly path: string;
  readonly op: SpecOperation;
}

const SPEC_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head']);

function specEntries(): {
  readonly doc: { readonly components: { readonly headers?: Record<string, unknown> } };
  readonly entries: readonly SpecEntry[];
} {
  const doc = generateOpenApiDocument() as {
    components: { headers?: Record<string, unknown> };
    paths: Record<string, Record<string, SpecOperation>>;
  };
  const entries: SpecEntry[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (SPEC_METHODS.has(method)) entries.push({ method, path, op });
    }
  }
  return { doc, entries };
}

/**
 * Called with a workspace's key or session: the limiter and the gate act
 * when the request has a `tenantId` and no system principal. Only the
 * bearer middleware (auth.ts) and SigV4 (sigv4.ts) set `tenantId`, so the
 * spec's `bearerAuth` outside `/v1/system` stands in for that. A middleware
 * that took `tenantId` from a path (the hooks' and connection notices'
 * paths carry one) would show here as a spec gap.
 */
function workspaceCall({ path, op }: SpecEntry): boolean {
  const bearer = (op.security ?? []).some((req) => Object.hasOwn(req, 'bearerAuth'));
  return bearer && !/^\/v1\/system(?:\/|$)/.test(path);
}

const where = ({ method, path }: SpecEntry, status: string): string =>
  `${method.toUpperCase()} ${path} ${status}`;

describe('OpenAPI — Retry-After and the answers every call can get', () => {
  test('the Retry-After header is one shared component: whole seconds, at least 1', () => {
    const { doc } = specEntries();
    expect(doc.components.headers?.RetryAfter).toMatchObject({
      schema: { type: 'integer', minimum: 1 },
    });
  });

  // A response's text says which of its codes send `Retry-After`; the header
  // object is what a typed client reads. Each holds the other.
  test('a response declares Retry-After exactly when its text names it', () => {
    const { entries } = specEntries();
    let declared = 0;
    for (const entry of entries) {
      for (const [status, response] of Object.entries(entry.op.responses)) {
        const names = (response.description ?? '').includes('Retry-After');
        const header = response.headers?.['Retry-After'];
        expect(header !== undefined, `${where(entry, status)}: text and header disagree`).toBe(
          names,
        );
        if (header === undefined) continue;
        declared += 1;
        expect(header, where(entry, status)).toEqual({ $ref: '#/components/headers/RetryAfter' });
      }
    }
    expect(declared).toBeGreaterThan(400);
  });

  // A new 429 or 503 picks one: send `Retry-After` and say so, or join this
  // list with why it sends none.
  const SENDS_NO_RETRY_AFTER: Readonly<Record<string, string>> = {
    // The app may send the notice again at once; there's no wait to give it.
    'POST /v1/connection-notices/{tenantId}/{appId} 503': 'connection-notice-unavailable',
  };

  test('every 429 and 503 declares Retry-After, but the ones listed with why', () => {
    const { entries } = specEntries();
    const unmarked: string[] = [];
    for (const entry of entries) {
      for (const status of ['429', '503']) {
        const response = entry.op.responses[status];
        if (response !== undefined && response.headers?.['Retry-After'] === undefined) {
          unmarked.push(where(entry, status));
        }
      }
    }
    expect(unmarked.sort()).toEqual(Object.keys(SENDS_NO_RETRY_AFTER).sort());
  });

  test('every write that takes an Idempotency-Key declares the 409 a same-key request in flight gets', () => {
    const { entries } = specEntries();
    const keyed = entries.filter(({ op }) =>
      (op.parameters ?? []).some((p) => p.name === 'Idempotency-Key' && p.in === 'header'),
    );
    expect(keyed.length).toBeGreaterThan(100);
    for (const entry of keyed) {
      const response = entry.op.responses['409'];
      expect(response?.description, where(entry, '409')).toContain('idempotency-key-in-flight');
      expect(response?.headers?.['Retry-After'], where(entry, '409')).toBeDefined();
    }
    for (const entry of entries.filter((e) => !keyed.includes(e))) {
      expect(
        entry.op.responses['409']?.description ?? '',
        `${where(entry, '409')} takes no Idempotency-Key`,
      ).not.toContain('idempotency-key-in-flight');
    }
  });

  test("every call a workspace's key or session makes declares the workspace's request limit, and no other does", () => {
    const { entries } = specEntries();
    const calls = entries.filter(workspaceCall);
    // Both sides are there, and so is a call a public run token also takes.
    expect(calls.length).toBeGreaterThan(300);
    expect(calls.some(({ op }) => (op.security ?? []).length > 1)).toBe(true);
    expect(entries.length).toBeGreaterThan(calls.length);
    for (const entry of entries) {
      const description = entry.op.responses['429']?.description ?? '';
      expect(description.includes('"api-requests"'), where(entry, '429')).toBe(
        workspaceCall(entry),
      );
    }
  });

  // These take a workspace from their path, not from a key, and answer the
  // gate's refusal themselves.
  const REFUSE_FOR_A_FROZEN_WORKSPACE_THEMSELVES = new Set([
    'POST /v1/hooks/{tenantId}/{webhookId}',
    'POST /v1/tool-files',
    'POST /v1/wait-tokens/{token}/complete',
  ]);

  test('every write the frozen-workspace gate checks declares tenant-state-unavailable, and the ones it lets through do not', () => {
    const { entries } = specEntries();
    // The gate sees a real path, so each `{param}` is filled before matching.
    const gated = (entry: SpecEntry): boolean =>
      workspaceCall(entry) &&
      !frozenTenantMay(entry.method.toUpperCase(), entry.path.replace(/\{[^}]+\}/g, 'p1'));
    const checked = entries.filter(gated);
    expect(checked.length).toBeGreaterThan(100);
    // Some writes a workspace's key makes are let through: posts the gate allows.
    expect(entries.some((e) => workspaceCall(e) && e.method === 'post' && !gated(e))).toBe(true);
    for (const entry of entries) {
      const names = (entry.op.responses['503']?.description ?? '').includes(
        'tenant-state-unavailable',
      );
      const own = REFUSE_FOR_A_FROZEN_WORKSPACE_THEMSELVES.has(
        `${entry.method.toUpperCase()} ${entry.path}`,
      );
      expect(names, where(entry, '503')).toBe(gated(entry) || own);
    }
  });
});

function collectRefs(node: unknown, out: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') out.push(value);
    else collectRefs(value, out);
  }
}

interface SchemaNode {
  readonly $ref?: string;
  readonly oneOf?: readonly SchemaNode[];
  readonly discriminator?: {
    readonly propertyName: string;
    readonly mapping?: Record<string, string>;
  };
  readonly properties?: Record<string, { readonly const?: unknown; readonly enum?: unknown[] }>;
  readonly required?: readonly string[];
}

interface DiscriminatedSchema extends SchemaNode {
  readonly discriminator: NonNullable<SchemaNode['discriminator']>;
}

interface DiscriminatedUnion {
  readonly where: string;
  readonly union: DiscriminatedSchema;
}

function collectDiscriminatedUnions(node: unknown, where: string, out: DiscriminatedUnion[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) collectDiscriminatedUnions(item, `${where}/${i}`, out);
    return;
  }
  const schema = node as SchemaNode;
  if (typeof schema.discriminator?.propertyName === 'string') {
    out.push({ where, union: schema as DiscriminatedSchema });
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    collectDiscriminatedUnions(value, `${where}/${key}`, out);
  }
}

// The mapping a union should declare: each `oneOf` member, named once by
// `$ref`, under the one value its required tag property takes.
function mappingFromTags(
  where: string,
  union: DiscriminatedSchema,
  schemas: Record<string, SchemaNode>,
): Record<string, string> {
  const { propertyName } = union.discriminator;
  const refs = (union.oneOf ?? []).map((member) => member.$ref ?? '');
  expect(refs.length, `${where}: no oneOf members`).toBeGreaterThan(0);
  expect(new Set(refs).size, `${where}: a member named twice`).toBe(refs.length);
  const mapping: Record<string, string> = {};
  for (const ref of refs) {
    expect(ref, `${where}: a member that isn't a $ref`).toMatch(/^#\/components\/schemas\//);
    const member = schemas[ref.replace('#/components/schemas/', '')];
    expect(member?.required ?? [], `${where}: ${ref} doesn't require ${propertyName}`).toContain(
      propertyName,
    );
    const tag = member?.properties?.[propertyName];
    const raw = tag?.const ?? (tag?.enum?.length === 1 ? tag.enum[0] : undefined);
    expect(typeof raw, `${where}: ${ref} has no single ${propertyName} string`).toBe('string');
    const value = String(raw);
    expect(Object.keys(mapping), `${where}: two members share the tag ${value}`).not.toContain(
      value,
    );
    mapping[value] = ref;
  }
  return mapping;
}
