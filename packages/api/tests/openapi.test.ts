// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, test } from 'vitest';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import { OPERATIONS, generateOpenApiDocument, honoToOpenapiPath } from '../src/index.js';
import {
  READS_WITHOUT_STORAGE,
  answersDatabaseBusy,
  answersIdempotencyStoreUnavailable,
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
    const writes = OPERATIONS.filter(
      (o) => o.unserved === undefined && answersIdempotencyStoreUnavailable(o),
    );
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
    const others = OPERATIONS.filter(
      (o) => o.unserved === undefined && !answersIdempotencyStoreUnavailable(o),
    );
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

  test("what the runtime doesn't serve is left out, with the schemas only it uses", () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
      tags: { name: string }[];
    };
    const unserved = OPERATIONS.filter((o) => o.unserved !== undefined);
    expect(unserved.map((o) => o.operationId).sort()).toEqual(
      ['register', 'list', 'get', 'update', 'pause', 'resume', 'unregister']
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

  test('every $ref target exists under components.schemas', () => {
    const doc = generateOpenApiDocument() as {
      components: { schemas: Record<string, unknown> };
      paths: Record<string, unknown>;
    };
    const known = new Set(Object.keys(doc.components.schemas));
    const refs: string[] = [];
    collectRefs(doc.paths, refs);
    for (const ref of refs) {
      const name = ref.replace('#/components/schemas/', '');
      expect(known.has(name), `dangling $ref: ${ref}`).toBe(true);
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
