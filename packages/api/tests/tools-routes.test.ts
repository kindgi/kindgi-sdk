// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ToolManifest } from '@kindgi/tools';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver, ToolRegistryBinding } from '../src/index.js';
import { ToolSchema } from '../src/openapi/schemas.js';

/**
 * Tools route tests.
 *
 * The `ToolRegistryBinding` is caller-plugged, so these tests use a
 * small in-memory adapter. No DB access — the routes only talk to the
 * binding.
 */

const tenantId = randomUUID() as TenantId;
const TOKEN = 'tools-token-abc';

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId };
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  invokeFlow: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

/**
 * Simple in-memory tenant-scoped tool registry with id-cursor
 * pagination. Captures the last `projectId` seen by register so tests
 * can assert threading from the POST route → binding.
 */
let lastRegisteredProjectId: ProjectId | undefined;

/**
 * In-memory binding mirroring the postgres store's shape: a head row
 * per toolId with a nullable `latestVersion`, and a versions map
 * carrying manifest bytes + tombstone state. Enough to exercise the
 * versioned CRUD routes without a live DB.
 */
interface VersionRow {
  readonly manifest: ToolManifest;
  unregisteredAt: string | null;
}
interface HeadRow {
  latestVersion: string | null;
  readonly versions: Map<string, VersionRow>;
}

function makeInMemoryBinding(): ToolRegistryBinding {
  const store = new Map<string, Map<string, HeadRow>>();
  function tenant(id: TenantId): Map<string, HeadRow> {
    const key = id as unknown as string;
    let m = store.get(key);
    if (m === undefined) {
      m = new Map();
      store.set(key, m);
    }
    return m;
  }
  function head(t: TenantId, toolId: string): HeadRow | undefined {
    return tenant(t).get(toolId);
  }
  function recomputeLatest(row: HeadRow): void {
    const active = [...row.versions.entries()]
      .filter(([, v]) => v.unregisteredAt === null)
      .map(([v]) => v);
    if (active.length === 0) {
      row.latestVersion = null;
      return;
    }
    // Simple lexical sort — good enough for '1.0.0' vs '1.1.0' vs '2.0.0'.
    active.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    row.latestVersion = active[0] ?? null;
  }
  function paginate(
    rows: readonly ToolManifest[],
    limit: number,
    cursor: Cursor | undefined,
  ): { data: readonly ToolManifest[]; nextCursor?: Cursor } {
    let startAt = 0;
    if (cursor !== undefined) {
      const cur = cursor as unknown as string;
      startAt = rows.findIndex((r) => (r.id as unknown as string) > cur);
      if (startAt < 0) startAt = rows.length;
    }
    const slice = rows.slice(startAt, startAt + limit);
    const last = slice[slice.length - 1];
    const hasMore = startAt + slice.length < rows.length;
    return {
      data: slice,
      ...(hasMore &&
        last !== undefined && { nextCursor: last.id as unknown as string as unknown as Cursor }),
    };
  }
  return {
    async list({ tenantId: t, limit, cursor, nameFilter }) {
      const all: ToolManifest[] = [];
      for (const [, row] of tenant(t)) {
        if (row.latestVersion === null) continue;
        const v = row.versions.get(row.latestVersion);
        if (v !== undefined) all.push(v.manifest);
      }
      all.sort((a, b) => (a.id as unknown as string).localeCompare(b.id as unknown as string));
      const filtered =
        nameFilter === undefined
          ? all
          : all.filter((t2) => (t2.id as unknown as string).startsWith(nameFilter));
      return paginate(filtered, limit, cursor);
    },
    async get({ tenantId: t, toolId }) {
      const row = head(t, toolId as unknown as string);
      if (row === undefined || row.latestVersion === null) return null;
      return row.versions.get(row.latestVersion)?.manifest ?? null;
    },
    async getVersion({ tenantId: t, toolId, version }) {
      const row = head(t, toolId as unknown as string);
      if (row === undefined) return null;
      const v = row.versions.get(version as unknown as string);
      if (v === undefined || v.unregisteredAt !== null) return null;
      return v.manifest;
    },
    async headExists({ tenantId: t, toolId }) {
      return head(t, toolId as unknown as string) !== undefined;
    },
    async listVersions({ tenantId: t, toolId, includeTombstoned }) {
      const row = head(t, toolId as unknown as string);
      if (row === undefined) return { data: [] };
      const entries = [...row.versions.values()].filter(
        (v) => includeTombstoned === true || v.unregisteredAt === null,
      );
      const data = entries.map((v) =>
        v.unregisteredAt !== null
          ? { ...v.manifest, unregisteredAt: v.unregisteredAt }
          : v.manifest,
      );
      // Version-desc for a stable page order.
      data.sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0));
      return { data };
    },
    async resolve({ tenantId: t, toolId }) {
      const row = head(t, toolId as unknown as string);
      if (row === undefined) return { kind: 'not-found', toolId };
      if (row.latestVersion === null) return { kind: 'not-found', toolId };
      const v = row.versions.get(row.latestVersion);
      if (v === undefined) return { kind: 'not-found', toolId };
      return {
        kind: 'ok',
        toolId,
        resolvedVersion: row.latestVersion as never,
        manifest: v.manifest,
      };
    },
    async publish({ tenantId: t, projectId, tool }) {
      lastRegisteredProjectId = projectId;
      const key = tool.id as unknown as string;
      const m = tenant(t);
      let row = m.get(key);
      if (row === undefined) {
        row = { latestVersion: null, versions: new Map() };
        m.set(key, row);
      }
      const versionKey = tool.version;
      const existing = row.versions.get(versionKey);
      if (existing !== undefined && existing.unregisteredAt === null) {
        return { kind: 'already-registered', toolId: tool.id, version: tool.version as never };
      }
      row.versions.set(versionKey, { manifest: tool, unregisteredAt: null });
      recomputeLatest(row);
      return { kind: 'ok', toolId: tool.id, version: tool.version as never };
    },
    async unregister({ tenantId: t, toolId, version }) {
      const row = head(t, toolId as unknown as string);
      if (row === undefined) return { unregistered: false };
      const v = row.versions.get(version as unknown as string);
      if (v === undefined || v.unregisteredAt !== null) return { unregistered: false };
      v.unregisteredAt = new Date().toISOString();
      recomputeLatest(row);
      return { unregistered: true };
    },
    async reinstateVersion({ tenantId: t, toolId, version }) {
      const row = head(t, toolId as unknown as string);
      if (row === undefined) return { kind: 'not-found', toolId, version };
      const v = row.versions.get(version as unknown as string);
      if (v === undefined) return { kind: 'not-found', toolId, version };
      const wasTombstoned = v.unregisteredAt !== null;
      v.unregisteredAt = null;
      recomputeLatest(row);
      return { kind: 'ok', toolId, version, wasTombstoned };
    },
  };
}

function toolBody(
  overrides: {
    id?: string;
    description?: string;
    version?: string;
    input?: object;
    output?: object;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 'acme.verify-citation',
    description: overrides.description ?? 'Look up an order in the acme order system.',
    version: overrides.version ?? '1.0.0',
    input: overrides.input ?? { type: 'object', properties: { citation: { type: 'string' } } },
    output: overrides.output ?? { type: 'object', properties: { verified: { type: 'boolean' } } },
  };
}

/**
 * Build a POST /v1/tools body. `projectId` is REQUIRED (content-scope
 * anchor) — the fixture supplies a stable uuid by default
 * so happy-path tests read cleanly.
 */
function toolPostBody(
  overrides: {
    id?: string;
    description?: string;
    input?: object;
    output?: object;
    projectId?: string;
  } = {},
): Record<string, unknown> {
  return {
    ...toolBody({
      ...(overrides.id !== undefined && { id: overrides.id }),
      ...(overrides.description !== undefined && { description: overrides.description }),
      ...(overrides.input !== undefined && { input: overrides.input }),
      ...(overrides.output !== undefined && { output: overrides.output }),
    }),
    projectId: overrides.projectId ?? randomUUID(),
  };
}

function makeApp() {
  const binding = makeInMemoryBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    toolRegistry: binding,
  });
  return { app, binding };
}

describe('API — tools list', () => {
  test('empty registry → empty list', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/tools', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('prefix name filter', async () => {
    const { app, binding } = makeApp();
    for (const id of ['acme.a', 'acme.b', 'globex.c']) {
      await binding.publish({
        tenantId,
        projectId: randomUUID() as ProjectId,
        tool: toolBody({ id }) as unknown as ToolManifest,
        enqueueTuples: () => [],
      });
    }
    const res = await app.request('/v1/tools?name=acme', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((a) => a.id).sort();
    expect(ids).toEqual(['acme.a', 'acme.b']);
  });

  test('cursor pagination — hasMore + nextCursor', async () => {
    const { app, binding } = makeApp();
    for (const id of ['a.1', 'a.2', 'a.3', 'a.4', 'a.5']) {
      await binding.publish({
        tenantId,
        projectId: randomUUID() as ProjectId,
        tool: toolBody({ id }) as unknown as ToolManifest,
        enqueueTuples: () => [],
      });
    }
    const first = await app.request('/v1/tools?limit=2', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(firstBody.data.map((a) => a.id)).toEqual(['a.1', 'a.2']);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.request(
      `/v1/tools?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const secondBody = (await second.json()) as {
      data: Array<{ id: string }>;
      hasMore: boolean;
    };
    expect(secondBody.data.map((a) => a.id)).toEqual(['a.3', 'a.4']);
    expect(secondBody.hasMore).toBe(true);
  });
});

describe('API — tools get', () => {
  test('register + get roundtrip', async () => {
    const { app } = makeApp();
    const publish = await app.request('/v1/tools', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(toolPostBody()),
    });
    expect(publish.status).toBe(201);
    const registered = (await publish.json()) as { toolId: string };
    expect(registered.toolId).toBe('acme.verify-citation');

    const get = await app.request('/v1/tools/acme.verify-citation', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as { id: string; description: string };
    expect(body.id).toBe('acme.verify-citation');
    expect(body.description).toBeTruthy();
  });

  test('a tool reads back whole: where its code runs, its sandbox, its typed needs', async () => {
    const { app } = makeApp();
    const manifest = {
      ...toolBody({ id: 'acme.pack-tool' }),
      mutating: false,
      sandbox: 'strict',
      limits: { memMB: 256, cpuMs: 2000 },
      network: { kind: 'allowlist', hosts: ['api.example.com'] },
      needsSpec: { secrets: { ACME_API_KEY: { type: 'string' } }, capabilities: ['tool-use'] },
      codeArtifactRef: {
        kind: 'oci',
        imageRef: `registry.example/acme/pack@sha256:${'a'.repeat(64)}`,
        modulePath: 'tools/pack-tool.mjs',
        artifactVersion: '20261002.1',
      },
    };
    const publish = await app.request('/v1/tools', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...manifest, projectId: randomUUID() }),
    });
    expect(publish.status).toBe(201);

    for (const path of ['/v1/tools/acme.pack-tool', '/v1/tools/acme.pack-tool/versions']) {
      const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown> & { data?: unknown[] };
      const body = (json.data?.[0] ?? json) as Record<string, unknown>;
      expect(body).toEqual(manifest);
      // Only what the wire schema declares (`additionalProperties: false`).
      for (const key of Object.keys(body)) {
        expect(Object.keys(ToolSchema.properties as object)).toContain(key);
      }
    }
  });

  test('a declarative HTTP tool reads back its spec, the secret as a reference', async () => {
    const { app } = makeApp();
    const spec = {
      kind: 'http',
      method: 'POST',
      urlTemplate: 'https://api.example.com/v1/items/{id}',
      headers: [{ name: 'accept', value: 'application/json' }],
      authorization: { kind: 'bearer', secretRef: { envName: 'prod', name: 'ACME_API_KEY' } },
      requestBody: { kind: 'json-input' },
      timeoutMs: 5000,
    };
    const publish = await app.request('/v1/tools', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...toolPostBody({ id: 'acme.http-tool' }), spec }),
    });
    expect(publish.status).toBe(201);
    const res = await app.request('/v1/tools/acme.http-tool', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await res.json()) as { spec?: unknown }).spec).toEqual(spec);
  });

  test('unknown id → 404 tool-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/tools/nope.missing', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('tool-not-found');
  });
});

describe('API — tools register', () => {
  test('validation failure → 400 validation-failed', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/tools', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: randomUUID(),
        id: '',
        description: '',
        input: {},
        output: {},
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { issues?: unknown[] } };
    };
    expect(body.error.code).toBe('validation-failed');
    expect(body.error.details?.issues).toBeTruthy();
  });

  test('non-JSON body → 400 bad-input', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/tools', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad-input');
  });

  test('register twice same id with no idempotency key → 409', async () => {
    const { app } = makeApp();
    // No idempotency-key header — both bodies use fresh projectIds and
    // still collide because the tool id is what makes them dupes.
    const first = await app.request('/v1/tools', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(toolPostBody()),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/tools', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(toolPostBody()),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('tool-already-registered');
  });

  // ------------------ projectId on POST ------------------

  test('POST /v1/tools threads projectId to the binding', async () => {
    const { app } = makeApp();
    lastRegisteredProjectId = undefined;
    const projectId = randomUUID();
    const res = await app.request('/v1/tools', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(toolPostBody({ projectId })),
    });
    expect(res.status).toBe(201);
    expect(lastRegisteredProjectId as unknown as string).toBe(projectId);
  });

  test('POST /v1/tools without projectId → 400 bad-input', async () => {
    const { app } = makeApp();
    // Build a body without projectId (the toolPostBody fixture always adds one).
    const { projectId: _pid, ...bodyWithoutProjectId } = toolPostBody();
    const res = await app.request('/v1/tools', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(bodyWithoutProjectId),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toContain('projectId');
  });

  test('idempotency-key retry replays original 201 response', async () => {
    const { app } = makeApp();
    const key = randomUUID();
    // Stable projectId across both POSTs — the idempotency middleware
    // hashes the body and rejects a replay with a different body as
    // `idempotency-key-body-mismatch`.
    const stableBody = toolPostBody({ projectId: randomUUID() });
    const first = await app.request('/v1/tools', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(stableBody),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/tools', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(stableBody),
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
    const body = (await second.json()) as { toolId: string };
    expect(body.toolId).toBe('acme.verify-citation');
  });
});

describe('API — tools unregister', () => {
  test('unregister known id → 200 unregistered: true', async () => {
    const { app, binding } = makeApp();
    await binding.publish({
      tenantId,
      projectId: randomUUID() as ProjectId,
      tool: toolBody() as unknown as ToolManifest,
      enqueueTuples: () => [],
    });
    const res = await app.request('/v1/tools/acme.verify-citation/versions/1.0.0/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { toolId: string; unregistered: boolean };
    expect(body.toolId).toBe('acme.verify-citation');
    expect(body.unregistered).toBe(true);

    // Fully-retired tool (all versions tombstoned) → 410 gone with the
    // id still resolvable via `headExists`. Distinct signal from 404
    // never-registered.
    const get = await app.request('/v1/tools/acme.verify-citation', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status).toBe(410);
    const goneBody = (await get.json()) as { error: { code: string } };
    expect(goneBody.error.code).toBe('tool-gone');
  });

  test('unregister unknown (id, version) → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/tools/nope.missing/versions/1.0.0/unregister', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — tools versions', () => {
  test('GET /:toolId/versions → 200 lists active versions only by default', async () => {
    const { app, binding } = makeApp();
    const projectId = randomUUID() as ProjectId;
    await binding.publish({
      tenantId,
      projectId,
      tool: toolBody({ version: '1.0.0' }) as unknown as ToolManifest,
      enqueueTuples: () => [],
    });
    await binding.publish({
      tenantId,
      projectId,
      tool: toolBody({ version: '1.1.0' }) as unknown as ToolManifest,
      enqueueTuples: () => [],
    });
    await binding.publish({
      tenantId,
      projectId,
      tool: toolBody({ version: '2.0.0' }) as unknown as ToolManifest,
      enqueueTuples: () => [],
    });
    // Tombstone the middle version — absent flag → hidden from listVersions.
    await binding.unregister({
      tenantId,
      toolId: 'acme.verify-citation' as never,
      version: '1.1.0' as never,
    });

    const res = await app.request('/v1/tools/acme.verify-citation/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ version: string; unregisteredAt?: string }>;
      hasMore: boolean;
    };
    expect(body.data.map((t) => t.version).sort()).toEqual(['1.0.0', '2.0.0']);
    expect(body.data.every((r) => r.unregisteredAt === undefined)).toBe(true);
    expect(body.hasMore).toBe(false);
  });

  test('GET /:toolId/versions?includeTombstoned=true → 200 lists active + tombstoned with unregisteredAt', async () => {
    const { app, binding } = makeApp();
    const projectId = randomUUID() as ProjectId;
    await binding.publish({
      tenantId,
      projectId,
      tool: toolBody({ version: '1.0.0' }) as unknown as ToolManifest,
      enqueueTuples: () => [],
    });
    await binding.publish({
      tenantId,
      projectId,
      tool: toolBody({ version: '1.1.0' }) as unknown as ToolManifest,
      enqueueTuples: () => [],
    });
    await binding.unregister({
      tenantId,
      toolId: 'acme.verify-citation' as never,
      version: '1.0.0' as never,
    });

    const res = await app.request(
      '/v1/tools/acme.verify-citation/versions?includeTombstoned=true',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ version: string; unregisteredAt?: string }>;
    };
    expect(body.data.map((t) => t.version).sort()).toEqual(['1.0.0', '1.1.0']);
    const tomb = body.data.find((r) => r.version === '1.0.0');
    const active = body.data.find((r) => r.version === '1.1.0');
    expect(typeof tomb?.unregisteredAt).toBe('string');
    // Should parse as a real ISO timestamp, not a random string.
    expect(Number.isFinite(Date.parse(tomb?.unregisteredAt ?? ''))).toBe(true);
    expect(active?.unregisteredAt).toBeUndefined();
  });

  test('GET /:toolId/versions → 404 when id was never registered', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/tools/nope.missing/versions', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  const enc = (v: string) => Buffer.from(v, 'utf8').toString('base64url');
  test.each([
    [
      'a position',
      200,
      enc(
        JSON.stringify({
          p: '2026-10-09 12:00:00.123456+00',
          i: '6f1c2a4e-3b5d-4c7e-8f90-1a2b3c4d5e6f',
        }),
      ),
    ],
    ['a bare time, from before', 200, enc('2026-10-09T12:00:00.123Z')],
    ['not base64 of anything', 400, 'not-a-cursor'],
    ['a position whose time and id are not', 400, enc(JSON.stringify({ p: 'x', i: 'y' }))],
    ['broken JSON', 400, enc('{"p":')],
  ])('GET /:toolId/versions with %s as the cursor → %i', async (_name, status, cursor) => {
    const { app, binding } = makeApp();
    await binding.publish({
      tenantId,
      projectId: randomUUID() as ProjectId,
      tool: toolBody({ version: '1.0.0' }) as unknown as ToolManifest,
      enqueueTuples: () => [],
    });
    const res = await app.request(`/v1/tools/acme.verify-citation/versions?cursor=${cursor}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(status);
    if (status === 400) {
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad-input');
    }
  });

  test('GET /:toolId/versions/:version → 200 exact version', async () => {
    const { app, binding } = makeApp();
    const projectId = randomUUID() as ProjectId;
    await binding.publish({
      tenantId,
      projectId,
      tool: toolBody({ version: '1.0.0' }) as unknown as ToolManifest,
      enqueueTuples: () => [],
    });
    await binding.publish({
      tenantId,
      projectId,
      tool: toolBody({ version: '2.0.0' }) as unknown as ToolManifest,
      enqueueTuples: () => [],
    });

    const res = await app.request('/v1/tools/acme.verify-citation/versions/1.0.0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe('1.0.0');
  });

  test('GET /:toolId/versions/:version → 404 when version is unknown', async () => {
    const { app, binding } = makeApp();
    await binding.publish({
      tenantId,
      projectId: randomUUID() as ProjectId,
      tool: toolBody({ version: '1.0.0' }) as unknown as ToolManifest,
      enqueueTuples: () => [],
    });
    const res = await app.request('/v1/tools/acme.verify-citation/versions/9.9.9', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test('POST /:toolId/versions/:version/reinstate → 200 reactivates a tombstoned version', async () => {
    const { app, binding } = makeApp();
    const projectId = randomUUID() as ProjectId;
    await binding.publish({
      tenantId,
      projectId,
      tool: toolBody({ version: '1.0.0' }) as unknown as ToolManifest,
      enqueueTuples: () => [],
    });
    await binding.unregister({
      tenantId,
      toolId: 'acme.verify-citation' as never,
      version: '1.0.0' as never,
    });
    // GET should now be 410 gone.
    const gone = await app.request('/v1/tools/acme.verify-citation', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(gone.status).toBe(410);

    const res = await app.request('/v1/tools/acme.verify-citation/versions/1.0.0/reinstate', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      toolId: string;
      version: string;
      wasTombstoned: boolean;
    };
    expect(body.toolId).toBe('acme.verify-citation');
    expect(body.version).toBe('1.0.0');
    expect(body.wasTombstoned).toBe(true);

    // Identity reactivated: GET returns 200.
    const restored = await app.request('/v1/tools/acme.verify-citation', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(restored.status).toBe(200);
  });

  test('POST /:toolId/versions/:version/reinstate → 200 wasTombstoned: false when already active', async () => {
    const { app, binding } = makeApp();
    await binding.publish({
      tenantId,
      projectId: randomUUID() as ProjectId,
      tool: toolBody({ version: '1.0.0' }) as unknown as ToolManifest,
      enqueueTuples: () => [],
    });
    const res = await app.request('/v1/tools/acme.verify-citation/versions/1.0.0/reinstate', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wasTombstoned: boolean };
    expect(body.wasTombstoned).toBe(false);
  });

  test('POST /:toolId/versions/:version/reinstate → 404 when never published', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/tools/nope.missing/versions/1.0.0/reinstate', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — tools surface unmounted when no binding supplied', () => {
  test('no `toolRegistry` binding → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/tools', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

// -------------------- scope filter --------------------

describe('API — tools scope filter', () => {
  function makeSpy() {
    const inner = makeInMemoryBinding();
    let lastListInput: Parameters<ToolRegistryBinding['list']>[0] | null = null;
    const spy: ToolRegistryBinding = {
      ...inner,
      async list(input) {
        lastListInput = input;
        return inner.list(input);
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      toolRegistry: spy,
    });
    return { app, getLastInput: (): typeof lastListInput => lastListInput };
  }

  test('?scopeKind=project&scopeId=<uuid> → binding receives project scope', async () => {
    const { app, getLastInput } = makeSpy();
    const projectId = randomUUID();
    const res = await app.request(`/v1/tools?scopeKind=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'project', tenantId, projectId });
  });

  test('?scopeKind=org&scopeId=<uuid> → binding receives org scope', async () => {
    const { app, getLastInput } = makeSpy();
    const orgId = randomUUID();
    const res = await app.request(`/v1/tools?scopeKind=org&scopeId=${orgId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toEqual({ kind: 'org', tenantId, orgId });
  });

  test('no scope params → binding receives scope=undefined', async () => {
    const { app, getLastInput } = makeSpy();
    const res = await app.request('/v1/tools', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(getLastInput()?.scope).toBeUndefined();
  });

  test('?scopeKind=tenant&scopeId=<uuid> → 400 scope-invalid', async () => {
    const { app } = makeSpy();
    const res = await app.request(`/v1/tools?scopeKind=tenant&scopeId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-invalid');
  });
});
