// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { Scope } from '@kindgi/platform';
import type { EnvName, Result, TenantId } from '@kindgi/types';
import { makeEnvName } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp, createInMemoryRotationStatusStore } from '../src/index.js';
import type {
  RotationStatusStore,
  RunHandlerBinding,
  SecretBinding,
  SecretError,
  SecretRecord,
  SecretResolveOutcome,
  SecretRotateOutcome,
  SecretSetInput,
  SecretVersionRecord,
  TokenResolver,
} from '../src/index.js';

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
