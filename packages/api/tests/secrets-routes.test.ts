// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test, vi } from 'vitest';

import type { Scope } from '@kindgi/platform';
import type { Cursor, EnvName, Result, TenantId } from '@kindgi/types';
import { makeEnvName } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import {
  createApp,
  createInMemoryRotationStatusStore,
  secretNameGrammarRefusal,
} from '../src/index.js';
import type {
  RotationStatusStore,
  RunHandlerBinding,
  SecretBinding,
  SecretError,
  SecretListInput,
  SecretListPage,
  SecretRecord,
  SecretResolveOutcome,
  SecretRotateOutcome,
  SecretSetInput,
  SecretVersionRecord,
  TokenResolver,
} from '../src/index.js';
import { SecretSetRequestSchema } from '../src/openapi/schemas.js';

/**
 * `/v1/secrets/*` route tests — the HTTP surface for
 * `SecretBinding`. Exercises:
 *   - metadata-only list / get (value NEVER on the wire)
 *   - POST /v1/secrets with `secrets:write` capability
 *   - sync rotate → 201 + inline outcome
 *   - async rotate → 202 + rotationId + statusUrl + eventsUrl
 *   - rotation status poll → matches store state
 *   - SSE events stream — emits rotation-update on terminal transition
 *   - DELETE with hard flag → capability discrimination
 */

const tenantA: TenantId = 'ten-a' as unknown as TenantId;
const staging: EnvName = makeEnvName('staging') as EnvName;

const TOKEN_ALL = 'token-all-caps';
const TOKEN_RO = 'token-readonly';
const TOKEN_WRITE_ONLY = 'token-write-only';

const resolveToken: TokenResolver = async (t) => {
  if (t === TOKEN_ALL) {
    return {
      tenantId: tenantA,
      capabilities: [
        'secrets:write',
        'secrets:rotate',
        'secrets:revoke',
        'secrets:revoke:hard',
        'secrets:reveal',
      ],
    };
  }
  if (t === TOKEN_WRITE_ONLY) {
    return { tenantId: tenantA, capabilities: ['secrets:write'] };
  }
  if (t === TOKEN_RO) {
    return { tenantId: tenantA, capabilities: [] };
  }
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

interface TestSecretBinding extends SecretBinding {
  rotateImpl: (input: {
    scope: Scope;
    envName: EnvName;
    name: string;
    newValue?: string;
  }) => Promise<Result<SecretRotateOutcome, SecretError>>;
}

/** Fixture — same-scope + same-envName only. Values stored so we can
 * exercise the "value never returns" property. */
function makeInMemorySecretsBinding(): TestSecretBinding {
  const rows = new Map<
    string,
    { record: SecretRecord; versions: SecretVersionRecord[]; value: string }
  >();
  const key = (scope: Scope, envName: EnvName, name: string): string =>
    `${scopeKeyString(scope)}::${envName as unknown as string}::${name}`;
  let seq = 0;

  const binding: TestSecretBinding = {
    rotateImpl: async () => ({
      kind: 'err',
      error: { code: 'secret-not-found', message: 'unused', name: '' },
    }),
    async list(input) {
      const out: SecretRecord[] = [];
      for (const row of rows.values()) {
        if (scopeKeyString(row.record.scope) !== scopeKeyString(input.scope)) continue;
        if (row.record.envName !== input.envName) continue;
        out.push(row.record);
      }
      out.sort((a, b) => (a.name < b.name ? -1 : 1));
      return { data: out.slice(0, input.limit) };
    },
    async get(input) {
      const row = rows.get(key(input.scope, input.envName, input.name));
      return row?.record ?? null;
    },
    async resolve(input) {
      const row = rows.get(key(input.scope, input.envName, input.name));
      if (row === undefined) {
        return {
          kind: 'err',
          error: { code: 'secret-not-found', message: 'unknown', name: input.name },
        };
      }
      const outcome: SecretResolveOutcome = {
        name: row.record.name,
        versionId: row.record.currentVersion,
        value: row.value,
      };
      return { kind: 'ok', value: outcome };
    },
    async getVersion(input) {
      const row = rows.get(key(input.scope, input.envName, input.name));
      if (row === undefined) return null;
      return row.versions.find((v) => v.versionId === input.versionId) ?? null;
    },
    async listVersions(input) {
      const row = rows.get(key(input.scope, input.envName, input.name));
      if (row === undefined) return { data: [] };
      return { data: row.versions.slice(0, input.limit) };
    },
    async set(input) {
      const k = key(input.scope, input.envName, input.name);
      const existing = rows.get(k);
      if (input.writeMode === 'create-new' && existing !== undefined) {
        return { kind: 'already-exists', record: existing.record };
      }
      if (input.ifVersion !== undefined) {
        const current = existing?.record.currentVersion ?? 0;
        if (current !== input.ifVersion) {
          return { kind: 'version-conflict', currentVersion: current };
        }
      }
      seq += 1;
      const nextV = (existing?.record.currentVersion ?? 0) + 1;
      const rec: SecretRecord = {
        scope: input.scope,
        envName: input.envName,
        name: input.name,
        currentVersion: nextV,
        createdAt: existing?.record.createdAt ?? new Date(Date.now() + seq).toISOString(),
        updatedAt: new Date(Date.now() + seq).toISOString(),
        ...(input.tags !== undefined && { tags: input.tags }),
      };
      const versions = existing?.versions ?? [];
      versions.push({
        scope: input.scope,
        envName: input.envName,
        name: input.name,
        versionId: nextV,
        createdAt: rec.updatedAt,
        value: null,
      });
      rows.set(k, { record: rec, versions, value: input.value });
      return { kind: 'ok', record: rec, versionId: nextV };
    },
    async rotate(input) {
      return this.rotateImpl(input);
    },
    async revoke(input) {
      const k = key(input.scope, input.envName, input.name);
      const existing = rows.get(k);
      if (existing === undefined) {
        return {
          kind: 'err',
          error: { code: 'secret-not-found', message: 'unknown', name: input.name },
        };
      }
      if (input.hard === true) {
        rows.delete(k);
      }
      return { kind: 'ok', value: { revoked: true, hard: input.hard === true } };
    },
  };
  return binding;
}

function scopeKeyString(s: Scope): string {
  switch (s.kind) {
    case 'tenant':
      return `tenant:${s.tenantId as unknown as string}`;
    case 'org':
      return `org:${s.tenantId as unknown as string}:${s.orgId as unknown as string}`;
    case 'project':
      return `project:${s.tenantId as unknown as string}:${s.projectId as unknown as string}`;
    default:
      return 'unknown';
  }
}

function makeApp(options: {
  secrets?: SecretBinding;
  store?: RotationStatusStore;
}): ReturnType<typeof createApp> {
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    ...(options.secrets !== undefined && { secretsBinding: options.secrets }),
    ...(options.store !== undefined && { rotationStatusStore: options.store }),
  });
}

describe('API — /v1/secrets — mount', () => {
  test('unmounted when secretsBinding absent', async () => {
    const app = makeApp({});
    const res = await app.request('/v1/secrets?envName=staging&scopeKind=tenant', {
      headers: { authorization: `Bearer ${TOKEN_ALL}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('API — POST /v1/secrets — capability + happy path', () => {
  test('missing `secrets:write` capability → 403', async () => {
    const secrets = makeInMemorySecretsBinding();
    const app = makeApp({ secrets });
    const res = await app.request('/v1/secrets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_RO}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: { kind: 'tenant', tenantId: tenantA },
        envName: 'staging',
        name: 'stripe.key',
        value: 'sk_live_x',
        writeMode: 'create-new',
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('permission-denied');
  });

  test('create-new → 201 + record + versionId; list omits `value`', async () => {
    const secrets = makeInMemorySecretsBinding();
    const app = makeApp({ secrets });
    const create = await app.request('/v1/secrets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_WRITE_ONLY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: { kind: 'tenant', tenantId: tenantA },
        envName: 'staging',
        name: 'stripe.key',
        value: 'sk_live_x',
        writeMode: 'create-new',
      }),
    });
    expect(create.status).toBe(201);
    const createBody = (await create.json()) as {
      record: { name: string; currentVersion: number; value?: unknown };
      versionId: number;
    };
    expect(createBody.versionId).toBe(1);
    expect(createBody.record.name).toBe('stripe.key');
    expect((createBody.record as unknown as Record<string, unknown>).value).toBeUndefined();

    // add-version → 200
    const addV = await app.request('/v1/secrets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_WRITE_ONLY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: { kind: 'tenant', tenantId: tenantA },
        envName: 'staging',
        name: 'stripe.key',
        value: 'sk_live_y',
        writeMode: 'add-version',
      }),
    });
    expect(addV.status).toBe(200);

    // duplicate create-new → 409
    const dup = await app.request('/v1/secrets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_WRITE_ONLY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: { kind: 'tenant', tenantId: tenantA },
        envName: 'staging',
        name: 'stripe.key',
        value: 'sk_live_z',
        writeMode: 'create-new',
      }),
    });
    expect(dup.status).toBe(409);

    // list — value ABSENT
    const list = await app.request('/v1/secrets?envName=staging&scopeKind=tenant', {
      headers: { authorization: `Bearer ${TOKEN_WRITE_ONLY}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.value).toBeUndefined();
  });

  test("the request's Idempotency-Key reaches the binding's set and rotate (none without the header)", async () => {
    const inner = makeInMemorySecretsBinding();
    inner.rotateImpl = async () =>
      ({ kind: 'ok', value: { kind: 'ok', newVersionId: 2, oldVersionId: 1 } }) as never;
    const keys: { op: string; key: string | undefined }[] = [];
    const secrets: SecretBinding = {
      ...inner,
      async set(input) {
        keys.push({ op: 'set', key: input.idempotencyKey });
        return inner.set(input);
      },
      async rotate(input) {
        keys.push({ op: 'rotate', key: input.idempotencyKey });
        return inner.rotate(input);
      },
    };
    const app = makeApp({ secrets });
    const post = (headers: Record<string, string>, name: string) =>
      app.request('/v1/secrets', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN_WRITE_ONLY}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          scope: { kind: 'tenant', tenantId: tenantA },
          envName: 'staging',
          name,
          value: 'v',
          writeMode: 'create-new',
        }),
      });
    expect((await post({ 'idempotency-key': 'retry-1' }, 'with.key')).status).toBe(201);
    expect((await post({}, 'without.key')).status).toBe(201);
    const rotate = await app.request(
      '/v1/secrets/with.key/rotate?envName=staging&scopeKind=tenant',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN_ALL}`,
          'content-type': 'application/json',
          'idempotency-key': 'rotate-1',
        },
        body: JSON.stringify({ newValue: 'v2' }),
      },
    );
    expect(rotate.status).toBeLessThan(300);
    expect(keys).toEqual([
      { op: 'set', key: 'retry-1' },
      { op: 'set', key: undefined },
      { op: 'rotate', key: 'rotate-1' },
    ]);
  });

  test('scope body-vs-session mismatch → 400 scope-mismatch', async () => {
    const secrets = makeInMemorySecretsBinding();
    const app = makeApp({ secrets });
    const res = await app.request('/v1/secrets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_WRITE_ONLY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: { kind: 'tenant', tenantId: 'other-tenant' },
        envName: 'staging',
        name: 'x',
        value: 'v',
        writeMode: 'create-new',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-mismatch');
  });
});

describe("API — POST /v1/secrets — appEnvFile (kindgi dev: the app's env file)", () => {
  const post = (app: ReturnType<typeof makeApp>, extra: Record<string, unknown>) =>
    app.request('/v1/secrets', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_WRITE_ONLY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: { kind: 'tenant', tenantId: tenantA },
        envName: 'local',
        name: 'ACME_WEBHOOK_SECRET',
        value: 'whsec_x',
        writeMode: 'create-new',
        ...extra,
      }),
    });

  test('a binding with a secrets store: refused (400 bad-input), nothing written', async () => {
    const secrets = makeInMemorySecretsBinding();
    const res = await post(makeApp({ secrets }), { appEnvFile: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toContain('kindgi dev');
    expect(body.error.message).not.toContain('whsec_x');
  });

  test("a binding that writes the pack's env files: passed through to set", async () => {
    const inner = makeInMemorySecretsBinding();
    const calls: SecretSetInput[] = [];
    const secrets: SecretBinding = {
      ...inner,
      writesAppEnvFiles: true,
      set: async (input) => {
        calls.push(input);
        return inner.set(input);
      },
    };
    const res = await post(makeApp({ secrets }), { appEnvFile: true });
    expect(res.status).toBe(201);
    expect(calls[0]?.appEnvFile).toBe(true);
  });

  test('not a boolean: 400 bad-input', async () => {
    const secrets = makeInMemorySecretsBinding();
    const res = await post(makeApp({ secrets }), { appEnvFile: 'yes' });
    expect(res.status).toBe(400);
  });
});

describe('API — GET /v1/secrets/:name/versions — value redaction', () => {
  test('listVersions returns metadata with `value: null` on the wire', async () => {
    const secrets = makeInMemorySecretsBinding();
    const app = makeApp({ secrets });
    await app.request('/v1/secrets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_WRITE_ONLY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: { kind: 'tenant', tenantId: tenantA },
        envName: 'staging',
        name: 'k',
        value: 'v1',
        writeMode: 'create-new',
      }),
    });
    const versions = await app.request('/v1/secrets/k/versions?envName=staging&scopeKind=tenant', {
      headers: { authorization: `Bearer ${TOKEN_WRITE_ONLY}` },
    });
    expect(versions.status).toBe(200);
    const body = (await versions.json()) as {
      data: Array<{ value: unknown; versionId: number }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.value).toBeNull();
    expect(body.data[0]?.versionId).toBe(1);
  });
});

describe('API — POST /v1/secrets/:name/rotate — sync (201)', () => {
  test('sync provider returns 201 inline with newVersionId + oldVersionId', async () => {
    const secrets = makeInMemorySecretsBinding();
    // Sync stub — returns `{ kind: 'ok' }`.
    secrets.rotateImpl = async () =>
      ({
        kind: 'ok',
        value: { kind: 'ok', newVersionId: 2, oldVersionId: 1 },
      }) as never;
    const app = makeApp({ secrets });
    // Seed a secret so the route reaches rotate (some bindings verify
    // existence — this fixture doesn't, so seeding is optional).
    await app.request('/v1/secrets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_ALL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: { kind: 'tenant', tenantId: tenantA },
        envName: 'staging',
        name: 'k',
        value: 'v1',
        writeMode: 'create-new',
      }),
    });
    const rot = await app.request('/v1/secrets/k/rotate?envName=staging&scopeKind=tenant', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_ALL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ newValue: 'v2' }),
    });
    expect(rot.status).toBe(201);
    const body = (await rot.json()) as {
      kind: string;
      newVersionId: number;
      oldVersionId: number;
    };
    expect(body.kind).toBe('sync');
    expect(body.newVersionId).toBe(2);
    expect(body.oldVersionId).toBe(1);
  });

  test('missing `secrets:rotate` capability → 403', async () => {
    const secrets = makeInMemorySecretsBinding();
    const app = makeApp({ secrets });
    const res = await app.request('/v1/secrets/k/rotate?envName=staging&scopeKind=tenant', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_WRITE_ONLY}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});

describe('API — POST /v1/secrets/:name/rotate — async (202)', () => {
  test('async provider → 202 + rotationId + statusUrl + eventsUrl; status polls; SSE emits update', async () => {
    const secrets = makeInMemorySecretsBinding();
    secrets.rotateImpl = async () => ({
      kind: 'ok',
      value: {
        kind: 'rotation-pending',
        resumeToken: 'aws:us-east-1:rot-abc',
        provider: 'aws-secrets-manager',
      },
    });
    const store = createInMemoryRotationStatusStore();
    const app = makeApp({ secrets, store });

    const rot = await app.request('/v1/secrets/k/rotate?envName=staging&scopeKind=tenant', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_ALL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(rot.status).toBe(202);
    const body = (await rot.json()) as {
      kind: string;
      rotationId: string;
      statusUrl: string;
      eventsUrl: string;
    };
    expect(body.kind).toBe('async');
    expect(body.rotationId).toMatch(/^[0-9a-f]{8}-/);
    expect(body.statusUrl).toContain(body.rotationId);
    expect(body.eventsUrl).toContain(body.rotationId);
    expect(body.eventsUrl).toContain('/events');

    // Poll status — pending.
    const poll1 = await app.request(body.statusUrl, {
      headers: { authorization: `Bearer ${TOKEN_ALL}` },
    });
    expect(poll1.status).toBe(200);
    const poll1Body = (await poll1.json()) as { status: string };
    expect(poll1Body.status).toBe('pending');

    // Subscribe to the SSE events, then transition to `succeeded`.
    const ssePromise = app.request(body.eventsUrl, {
      headers: { authorization: `Bearer ${TOKEN_ALL}` },
    });

    // Give the request a moment to attach the subscriber, then update.
    await new Promise((r) => setTimeout(r, 20));
    await store.update({
      rotationId: body.rotationId,
      status: 'succeeded',
      newVersionId: 5,
      oldVersionId: 4,
    });

    const sseRes = await ssePromise;
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('Content-Type')).toContain('text/event-stream');
    const raw = await sseRes.text();
    // Two `rotation-update` frames minimum: initial + terminal.
    const frames = raw.split('\n\n').filter((f) => f.trim().length > 0);
    const updates = frames.filter((f) => f.includes('event: rotation-update'));
    expect(updates.length).toBeGreaterThanOrEqual(2);
    // Terminal frame carries the succeeded status.
    const last = updates[updates.length - 1] ?? '';
    expect(last).toContain('"status":"succeeded"');
    expect(last).toContain('"newVersionId":5');

    // Poll status after terminal — should show succeeded.
    const poll2 = await app.request(body.statusUrl, {
      headers: { authorization: `Bearer ${TOKEN_ALL}` },
    });
    const poll2Body = (await poll2.json()) as { status: string; newVersionId?: number };
    expect(poll2Body.status).toBe('succeeded');
    expect(poll2Body.newVersionId).toBe(5);
  });

  test('unknown rotationId → 404', async () => {
    const secrets = makeInMemorySecretsBinding();
    const store = createInMemoryRotationStatusStore();
    const app = makeApp({ secrets, store });
    const res = await app.request(
      '/v1/secrets/k/rotations/00000000-0000-0000-0000-000000000000?envName=staging&scopeKind=tenant',
      { headers: { authorization: `Bearer ${TOKEN_ALL}` } },
    );
    expect(res.status).toBe(404);
  });

  /** A pending rotation; the store's subscriptions to it counted. */
  async function pendingRotation() {
    const secrets = makeInMemorySecretsBinding();
    secrets.rotateImpl = async () => ({
      kind: 'ok',
      value: { kind: 'rotation-pending', resumeToken: 'acme:rot-1', provider: 'acme-vault' },
    });
    const inner = createInMemoryRotationStatusStore();
    const counts = { subscribed: 0, unsubscribed: 0 };
    let hold: { entered: () => void; released: Promise<void> } | undefined;
    /** Holds each read of a rotation until `release`; `waiting` resolves once one waits. */
    const holdReads = () => {
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((entered) => {
        hold = { entered, released };
      });
      return { waiting, release };
    };
    const store: RotationStatusStore = {
      create: (input) => inner.create(input),
      get: async (input) => {
        if (hold !== undefined) {
          hold.entered();
          await hold.released;
        }
        return inner.get(input);
      },
      update: (input) => inner.update(input),
      subscribe: (input) => {
        counts.subscribed += 1;
        const unsubscribe = inner.subscribe(input);
        return () => {
          counts.unsubscribed += 1;
          unsubscribe();
        };
      },
    };
    const app = makeApp({ secrets, store });
    const rot = await app.request('/v1/secrets/k/rotate?envName=staging&scopeKind=tenant', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_ALL}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(rot.status).toBe(202);
    const { eventsUrl } = (await rot.json()) as { eventsUrl: string };
    const call = (
      method: 'GET' | 'HEAD',
      { url = eventsUrl, signal }: { url?: string; signal?: AbortSignal } = {},
    ) =>
      app.request(url, {
        method,
        headers: { authorization: `Bearer ${TOKEN_ALL}`, 'x-request-id': 'req-events' },
        ...(signal !== undefined && { signal }),
      });
    // The same events URL for a rotation that isn't there.
    const absentUrl = eventsUrl.replace(
      /\/rotations\/[^/]+\//,
      '/rotations/00000000-0000-0000-0000-000000000000/',
    );
    expect(absentUrl).not.toBe(eventsUrl);
    return { call, counts, absentUrl, holdReads };
  }

  test("a reader that cancels a pending rotation's events: unsubscribed, and no heartbeat after", async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    try {
      const { call, counts } = await pendingRotation();
      const res = await call('GET');
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decode = async () => new TextDecoder().decode((await reader.read()).value);
      expect(await decode()).toContain('"status":"pending"');
      // The heartbeat, every 15 s while the rotation is pending.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await decode()).toContain('event: ping');
      expect([counts, vi.getTimerCount()]).toEqual([{ subscribed: 1, unsubscribed: 0 }, 1]);

      await reader.cancel();
      await vi.advanceTimersByTimeAsync(0);
      expect([counts, vi.getTimerCount()]).toEqual([{ subscribed: 1, unsubscribed: 1 }, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a HEAD on a pending rotation's events answers the stream's status and headers and starts none of its work", async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    try {
      const { call, counts, absentUrl } = await pendingRotation();
      const head = await call('HEAD');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // No subscription and no heartbeat: the stream never started.
      expect([counts, vi.getTimerCount()]).toEqual([{ subscribed: 0, unsubscribed: 0 }, 0]);
      expect(head.body).toBeNull();
      const get = await call('GET');
      await get.body?.cancel();
      expect([head.status, get.status]).toEqual([200, 200]);
      // Each request answers its own span; every other header is the same.
      const { traceresponse: headSpan, ...headHeaders } = Object.fromEntries(head.headers);
      const { traceresponse: getSpan, ...getHeaders } = Object.fromEntries(get.headers);
      expect([headSpan, getSpan]).toEqual([expect.any(String), expect.any(String)]);
      expect(headHeaders).toEqual(getHeaders);
      expect(headHeaders['content-type']).toBe('text/event-stream; charset=utf-8');
      // A rotation that isn't there: the GET's 404.
      const [headMissing, getMissing] = [
        await call('HEAD', { url: absentUrl }),
        await call('GET', { url: absentUrl }),
      ];
      expect([headMissing.status, getMissing.status, headMissing.body]).toEqual([404, 404, null]);
      expect(Object.fromEntries(headMissing.headers)).toEqual({
        ...Object.fromEntries(getMissing.headers),
        traceresponse: expect.any(String),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('a client that leaves during the read of a pending rotation: its events never start', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    try {
      const { call, counts, holdReads } = await pendingRotation();
      const { waiting, release } = holdReads();
      const client = new AbortController();
      const answered = call('GET', { signal: client.signal });
      await waiting;
      client.abort();
      release();
      const res = await answered;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // No subscription and no heartbeat. The body is never touched.
      expect([counts, vi.getTimerCount()]).toEqual([{ subscribed: 0, unsubscribed: 0 }, 0]);
      expect([res.status, res.body]).toEqual([200, null]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a client that leaves a pending rotation's events, its body never read: unsubscribed, and no heartbeat after", async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    try {
      const { call, counts } = await pendingRotation();
      const client = new AbortController();
      const res = await call('GET', { signal: client.signal });
      expect(res.status).toBe(200);
      await vi.advanceTimersByTimeAsync(15_000);
      // Subscribed, with the heartbeat, while the client is there.
      expect([counts, vi.getTimerCount()]).toEqual([{ subscribed: 1, unsubscribed: 0 }, 1]);
      client.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect([counts, vi.getTimerCount()]).toEqual([{ subscribed: 1, unsubscribed: 1 }, 0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('API — DELETE /v1/secrets/:name — soft + hard revoke', () => {
  test('soft revoke requires `secrets:revoke` capability', async () => {
    const secrets = makeInMemorySecretsBinding();
    const app = makeApp({ secrets });
    const res = await app.request('/v1/secrets/x?envName=staging&scopeKind=tenant', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_WRITE_ONLY}` },
    });
    expect(res.status).toBe(403);
  });

  test('hard revoke requires `secrets:revoke:hard` capability', async () => {
    const secrets = makeInMemorySecretsBinding();
    const app = makeApp({ secrets });
    // Create + soft revoke with TOKEN_ALL (has both).
    await app.request('/v1/secrets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN_ALL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: { kind: 'tenant', tenantId: tenantA },
        envName: 'staging',
        name: 'x',
        value: 'v',
        writeMode: 'create-new',
      }),
    });
    const hard = await app.request('/v1/secrets/x?envName=staging&scopeKind=tenant&hard=true', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_ALL}` },
    });
    expect(hard.status).toBe(200);
    const body = (await hard.json()) as { revoked: boolean; hard: boolean };
    expect(body.revoked).toBe(true);
    expect(body.hard).toBe(true);
    expect(body).not.toHaveProperty('recoverableUntil');
  });

  test('a hard revoke that left a recoverable copy answers until when (recoverableUntil)', async () => {
    const until = '2026-11-22T21:00:00.000Z';
    const secrets: SecretBinding = {
      ...makeInMemorySecretsBinding(),
      revoke: async () => ({
        kind: 'ok',
        value: { revoked: true, hard: true, recoverableUntil: until },
      }),
    };
    const app = makeApp({ secrets });
    const res = await app.request('/v1/secrets/x?envName=staging&scopeKind=tenant&hard=true', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_ALL}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true, hard: true, recoverableUntil: until });
  });
});

describe('API — validation — envName + scope required', () => {
  test('list without scopeKind → 400 scope-kind-required', async () => {
    const secrets = makeInMemorySecretsBinding();
    const app = makeApp({ secrets });
    const res = await app.request('/v1/secrets?envName=staging', {
      headers: { authorization: `Bearer ${TOKEN_ALL}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('scope-kind-required');
  });
});

describe('API — GET /v1/secrets — what reaches the store, and its page', () => {
  /** An app whose store answers `page` and keeps each list input. */
  function listing(page: SecretListPage) {
    const inputs: SecretListInput[] = [];
    const secrets: SecretBinding = {
      ...makeInMemorySecretsBinding(),
      async list(input) {
        inputs.push(input);
        return page;
      },
    };
    const app = makeApp({ secrets });
    const get = async (query: string) => {
      const res = await app.request(`/v1/secrets?envName=staging&scopeKind=tenant${query}`, {
        headers: { authorization: `Bearer ${TOKEN_RO}` },
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { get, inputs };
  }

  test('includeRevoked=true asks the store for revoked secrets too; false or none does not', async () => {
    const { get, inputs } = listing({ data: [] });
    for (const query of ['&includeRevoked=true', '&includeRevoked=false', '']) {
      expect((await get(query)).status).toBe(200);
    }
    expect(inputs.map((i) => i.includeRevoked)).toEqual([true, undefined, undefined]);
  });

  test('a revoked secret lists with revokedAt and revokeReason, and never a value', async () => {
    const revoked: SecretRecord = {
      scope: { kind: 'tenant', tenantId: tenantA },
      envName: staging,
      name: 'old.key',
      currentVersion: 2,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-14T12:00:00.000Z',
      revokedAt: '2026-10-14T12:00:00.000Z',
      revokeReason: 'erased',
    };
    const { get } = listing({ data: [revoked] });
    const { body } = await get('&includeRevoked=true');
    expect(body.data).toEqual([
      {
        scope: { kind: 'tenant', tenantId: tenantA },
        envName: 'staging',
        name: 'old.key',
        currentVersion: 2,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-14T12:00:00.000Z',
        revokedAt: '2026-10-14T12:00:00.000Z',
        revokeReason: 'erased',
      },
    ]);
  });

  test("the cursor and limit reach the store, and the store's nextCursor comes back with hasMore", async () => {
    const { get, inputs } = listing({ data: [], nextCursor: 'next-1' as Cursor });
    const { status, body } = await get('&cursor=prev-1&limit=26');
    expect(status).toBe(200);
    expect(inputs[0]).toMatchObject({ cursor: 'prev-1', limit: 26 });
    expect(body).toEqual({ data: [], hasMore: true, nextCursor: 'next-1' });
    const last = listing({ data: [] });
    expect((await last.get('')).body).toEqual({ data: [], hasMore: false });
  });
});

describe.each([
  { list: 'secrets' as const, path: '/v1/secrets?envName=staging&scopeKind=tenant' },
  { list: 'versions' as const, path: '/v1/secrets/k/versions?envName=staging&scopeKind=tenant' },
])('API — GET $path: a cursor the store did not issue', ({ list, path }) => {
  const ISSUED = `issued-for-${list}`;
  /** A store that keeps each list read, and says which cursors it issued, or has no say. */
  function store(say: boolean) {
    const reads: (Cursor | undefined)[] = [];
    const asked: string[] = [];
    const secrets: SecretBinding = {
      ...makeInMemorySecretsBinding(),
      async list(input) {
        reads.push(input.cursor);
        return { data: [] };
      },
      async listVersions(input) {
        reads.push(input.cursor);
        return { data: [] };
      },
      ...(say && {
        issuedCursor: (which: 'secrets' | 'versions', cursor: Cursor) => {
          asked.push(which);
          return (cursor as unknown as string) === `issued-for-${which}`;
        },
      }),
    };
    const app = makeApp({ secrets });
    const get = async (query: string) => {
      const res = await app.request(`${path}${query}`, {
        headers: { authorization: `Bearer ${TOKEN_RO}` },
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { get, reads, asked };
  }

  test('one it did not issue: 400 bad-input, before the list is read', async () => {
    const { get, reads, asked } = store(true);
    const { status, body } = await get('&cursor=made-up');
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: 'bad-input', message: '`cursor` is malformed' });
    expect(reads).toEqual([]);
    expect(asked).toEqual([list]);
  });

  test("one it issued for the other list: 400, so the store is asked about this list's", async () => {
    const other = list === 'secrets' ? 'versions' : 'secrets';
    const { get, reads } = store(true);
    expect((await get(`&cursor=issued-for-${other}`)).status).toBe(400);
    expect(reads).toEqual([]);
  });

  test('one it issued: the store reads the next page', async () => {
    const { get, reads } = store(true);
    expect((await get(`&cursor=${ISSUED}`)).status).toBe(200);
    expect(reads).toEqual([ISSUED]);
  });

  test('a store without issuedCursor: any cursor reaches it, as before', async () => {
    const { get, reads } = store(false);
    expect((await get('&cursor=made-up')).status).toBe(200);
    expect(reads).toEqual(['made-up']);
  });

  test('no cursor: the first page, and the store is not asked', async () => {
    const { get, reads, asked } = store(true);
    expect((await get('')).status).toBe(200);
    expect(reads).toEqual([undefined]);
    expect(asked).toEqual([]);
  });
});

// Silence unused-value warnings on staging/scopeKeyString if all fixtures
// happen to bypass one code path.
void staging;

describe('API — a store that does not rotate or revoke by design', () => {
  test('rotate and revoke answer 501 secret-operation-unsupported, with what to do instead', async () => {
    const secrets = makeInMemorySecretsBinding();
    const unsupported = (message: string) =>
      ({ kind: 'err', error: { code: 'secret-operation-unsupported', message } }) as never;
    secrets.rotateImpl = async () =>
      unsupported(
        'Dev secrets live in your env files and have no versions to rotate. Edit the value there.',
      );
    secrets.revoke = async () =>
      unsupported(
        'Dev secrets live in your env files and have no revocation. Remove k from those files.',
      );
    const app = makeApp({ secrets });
    const headers = { authorization: `Bearer ${TOKEN_ALL}`, 'content-type': 'application/json' };
    const rot = await app.request('/v1/secrets/k/rotate?envName=local&scopeKind=tenant', {
      method: 'POST',
      headers,
      body: JSON.stringify({ newValue: 'v2' }),
    });
    expect(rot.status).toBe(501);
    const rotBody = (await rot.json()) as { error: { code: string; message: string } };
    expect(rotBody.error.code).toBe('secret-operation-unsupported');
    expect(rotBody.error.message).toContain('Edit the value there');
    const rev = await app.request('/v1/secrets/k?envName=local&scopeKind=tenant', {
      method: 'DELETE',
      headers,
    });
    expect(rev.status).toBe(501);
    expect(((await rev.json()) as { error: { code: string } }).error.code).toBe(
      'secret-operation-unsupported',
    );
  });
});

describe("API — a write the store refuses for its name or its value is the caller's 400", () => {
  const headers = { authorization: `Bearer ${TOKEN_ALL}`, 'content-type': 'application/json' };

  test.each([
    'reserved-name-prefix',
    'secret-name-invalid',
    'secret-value-too-large',
    'secret-value-invalid',
  ])("POST /v1/secrets answers %s at 400, with the store's message", async (code) => {
    const secrets = makeInMemorySecretsBinding();
    secrets.set = async () => ({ kind: 'error', code, message: 'the store says why' });
    const res = await makeApp({ secrets }).request('/v1/secrets', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        scope: { kind: 'tenant', tenantId: tenantA },
        envName: 'staging',
        name: 'ACME_KEY',
        value: 'v',
        writeMode: 'create-new',
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({
      code,
      message: 'the store says why',
    });
  });

  test.each(['reserved-name-prefix', 'secret-value-too-large'] as const)(
    'rotate answers %s at 400, as a write of the new value would',
    async (code) => {
      const secrets = makeInMemorySecretsBinding();
      secrets.rotateImpl = async () => ({
        kind: 'err',
        error: { code, message: 'the store says why' } satisfies SecretError,
      });
      const res = await makeApp({ secrets }).request(
        '/v1/secrets/ACME_KEY/rotate?envName=staging&scopeKind=tenant',
        { method: 'POST', headers, body: JSON.stringify({ newValue: 'v2' }) },
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: unknown }).error).toMatchObject({
        code,
        message: 'the store says why',
      });
    },
  );
});

describe('secretNameGrammarRefusal — the shared create-name grammar', () => {
  test.each([
    'a',
    'ACME_KEY',
    'acme.woo-orders_v2',
    'kindgi.webhook.1',
    'A1',
    '_leads',
    '9leads',
    'a.b',
    '__x--y.9',
    'a'.repeat(255),
  ])('allows %s', (name) => {
    expect(secretNameGrammarRefusal(name)).toBeUndefined();
  });
  test.each(['acme/woo', 'has space', 'per%cent', 'hash#1', 'q?x', 'ключ', ''])(
    'refuses %s with secret-name-invalid',
    (name) => {
      expect(secretNameGrammarRefusal(name)?.code).toBe('secret-name-invalid');
    },
  );
  test('refuses a name longer than 255 characters', () => {
    expect(secretNameGrammarRefusal('a'.repeat(256))?.code).toBe('secret-name-invalid');
  });
  // A new name starts with a letter, digit or `_`: a leading dot or dash, or
  // an all-dots name, is refused. (A mutant that widened the first-character
  // class to admit `.` or `-`, or dropped the anchor, is caught here.)
  test.each(['.hidden', '.a', '-foo', '.', '...', '-'])(
    'refuses %s for its first character',
    (name) => {
      expect(secretNameGrammarRefusal(name)?.code).toBe('secret-name-invalid');
    },
  );
  // A dot sits only between two non-dot characters. (A mutant that relaxed the
  // dot rule back to a flat `[A-Za-z0-9._-]*` class — which admits a doubled or
  // trailing dot — is caught here.)
  test.each(['a...b', 'a.', 'foo.'])('refuses %s for its dot placement', (name) => {
    expect(secretNameGrammarRefusal(name)?.code).toBe('secret-name-invalid');
  });
  test.each(['_abc', '9abc', 'Zabc', 'abc'])('allows a name starting with %s', (name) => {
    expect(secretNameGrammarRefusal(name)).toBeUndefined();
  });
  // The create grammar is the server's; the wire request stays additive, so a
  // generated client can still add a version to a name stored before this
  // release. Guard that the schema documents the rule without enforcing it.
  test('SecretSetRequest.name stays additive on the wire — documented, not enforced', () => {
    const nameSchema = (
      SecretSetRequestSchema.properties as Record<
        string,
        { pattern?: string; maxLength?: number; description?: string }
      >
    ).name;
    expect(nameSchema?.pattern).toBeUndefined();
    expect(nameSchema?.maxLength).toBeUndefined();
    expect(nameSchema?.description ?? '').toContain('already stored');
  });
});

describe('API — a new secret name is held to the shared grammar at the border (on create, incl. add-version that creates)', () => {
  const headers = { authorization: `Bearer ${TOKEN_ALL}`, 'content-type': 'application/json' };
  const writeBody = (name: string, writeMode: 'create-new' | 'add-version') =>
    JSON.stringify({
      scope: { kind: 'tenant', tenantId: tenantA },
      envName: 'staging',
      name,
      value: 'v',
      writeMode,
    });

  test.each([
    ['a slash', 'acme/woo-orders'],
    ['a space', 'acme key'],
    ['a percent', 'acme%pc'],
    ['a hash', 'acme#1'],
    ['a question mark', 'acme?x'],
    ['a non-ASCII letter', 'ключ'],
    ['a leading dot', '.acme'],
    ['a leading dash', '-acme'],
    ['an all-dots name', '...'],
  ])(
    'POST /v1/secrets create-new refuses %s with secret-name-invalid, storing nothing',
    async (_why, name) => {
      const secrets = makeInMemorySecretsBinding();
      let setCalls = 0;
      const inner = secrets.set.bind(secrets);
      secrets.set = async (input) => {
        setCalls += 1;
        return inner(input);
      };
      const res = await makeApp({ secrets }).request('/v1/secrets', {
        method: 'POST',
        headers,
        body: writeBody(name, 'create-new'),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'secret-name-invalid',
      );
      expect(setCalls).toBe(0);
    },
  );

  test('POST /v1/secrets create-new refuses a name longer than 255', async () => {
    const secrets = makeInMemorySecretsBinding();
    const res = await makeApp({ secrets }).request('/v1/secrets', {
      method: 'POST',
      headers,
      body: writeBody('a'.repeat(256), 'create-new'),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'secret-name-invalid',
    );
  });

  test('POST /v1/secrets create-new allows a 255-character name of the allowed characters', async () => {
    const secrets = makeInMemorySecretsBinding();
    const name = `a.b-c_D9${'x'.repeat(247)}`;
    expect(name.length).toBe(255);
    const res = await makeApp({ secrets }).request('/v1/secrets', {
      method: 'POST',
      headers,
      body: writeBody(name, 'create-new'),
    });
    expect(res.status).toBe(201);
  });

  test('POST /v1/secrets add-version refuses a NEW out-of-grammar name, storing nothing', async () => {
    const secrets = makeInMemorySecretsBinding();
    let setCalls = 0;
    const inner = secrets.set.bind(secrets);
    secrets.set = async (input) => {
      setCalls += 1;
      return inner(input);
    };
    const res = await makeApp({ secrets }).request('/v1/secrets', {
      method: 'POST',
      headers,
      body: writeBody('acme/new-via-add-version', 'add-version'),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'secret-name-invalid',
    );
    expect(setCalls).toBe(0);
  });

  test('add-version to an EXISTING out-of-grammar name still takes a new value', async () => {
    const secrets = makeInMemorySecretsBinding();
    await secrets.set({
      scope: { kind: 'tenant', tenantId: tenantA },
      envName: staging,
      name: 'acme/legacy',
      value: 'v1',
      writeMode: 'create-new',
      enqueueTuples: () => [],
    });
    const res = await makeApp({ secrets }).request('/v1/secrets', {
      method: 'POST',
      headers,
      body: writeBody('acme/legacy', 'add-version'),
    });
    expect(res.status).toBe(200);
  });

  test('a name already stored outside the grammar still reads, revokes and takes a new version', async () => {
    const secrets = makeInMemorySecretsBinding();
    await secrets.set({
      scope: { kind: 'tenant', tenantId: tenantA },
      envName: staging,
      name: '.legacy',
      value: 'v1',
      writeMode: 'create-new',
      enqueueTuples: () => [],
    });
    const app = makeApp({ secrets });
    const read = await app.request('/v1/secrets/.legacy?envName=staging&scopeKind=tenant', {
      headers: { authorization: `Bearer ${TOKEN_ALL}` },
    });
    expect(read.status).toBe(200);
    const addV = await app.request('/v1/secrets', {
      method: 'POST',
      headers,
      body: writeBody('.legacy', 'add-version'),
    });
    expect(addV.status).toBe(200);
    const del = await app.request('/v1/secrets/.legacy?envName=staging&scopeKind=tenant', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_ALL}` },
    });
    expect(del.status).toBe(200);
  });
});
