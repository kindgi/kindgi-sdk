// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Public run tokens (`kgi_pt_…`): minting and verification, and what such
 * a token can do through the app — read the runs it names (and their
 * descendants) in the public view, follow their stream, nothing else.
 * Plus `POST /v1/tokens/public`, the token on `POST /v1/runs`, and CORS.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { createInMemorySigningKeyBinding, generateEd25519KeyPair } from '@kindgi/crypto';
import type { SigningKeyBinding } from '@kindgi/crypto';
import type { JournalEntry, KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { ProjectId, RunId, SigningKeyId, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp, mintPublicRunToken, verifyPublicRunToken } from '../src/index.js';
import type { PublicRunTokenConfig, RunHandlerBinding, TokenResolver } from '../src/index.js';
import { resolvePublicRunTokenConfig } from '../src/public-run-token.js';

const KEY_ID = 'public-run-tokens-2026-10' as SigningKeyId;
const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const API_TOKEN = 'public-run-tokens-api-token';
const ORIGIN = 'https://app.example.com';

function ed25519Binding(keyId: SigningKeyId = KEY_ID): SigningKeyBinding {
  const pair = generateEd25519KeyPair();
  return createInMemorySigningKeyBinding([
    { keyId, algorithm: 'ed25519', publicKey: pair.publicKey, privateKey: pair.privateKey },
  ]);
}

const signingKey = ed25519Binding();
const runIdA = randomUUID() as RunId;

function mint(
  runIds: readonly RunId[],
  options: {
    tenantId?: TenantId;
    ttlSeconds?: number;
    now?: () => number;
    key?: SigningKeyBinding;
  } = {},
): string {
  const minted = mintPublicRunToken({
    signingKey: options.key ?? signingKey,
    keyId: KEY_ID,
    tenantId: options.tenantId ?? tenantA,
    runIds,
    ttlSeconds: options.ttlSeconds ?? 900,
    ...(options.now !== undefined && { now: options.now }),
  });
  if (minted.kind !== 'ok') throw new Error(minted.message);
  return minted.token;
}

describe('mintPublicRunToken / verifyPublicRunToken', () => {
  test('a minted token verifies, with its claims', () => {
    const token = mint([runIdA]);
    expect(token.startsWith('kgi_pt_')).toBe(true);
    const verified = verifyPublicRunToken(token, { signingKey });
    expect(verified.kind).toBe('ok');
    if (verified.kind !== 'ok') return;
    expect(verified.claims).toMatchObject({ keyId: KEY_ID, tenantId: tenantA, runIds: [runIdA] });
    const lifetime = verified.claims.expiresAt.getTime() - verified.claims.issuedAt.getTime();
    expect(lifetime).toBe(900_000);
  });

  test('a changed payload or signature fails', () => {
    const token = mint([runIdA]);
    const [signed, signature] = [
      token.slice(0, token.lastIndexOf('.')),
      token.slice(token.lastIndexOf('.') + 1),
    ];
    const payload = JSON.parse(Buffer.from(signed.slice(7), 'base64url').toString('utf-8'));
    const forged = Buffer.from(JSON.stringify({ ...payload, runIds: [randomUUID()] })).toString(
      'base64url',
    );
    expect(verifyPublicRunToken(`kgi_pt_${forged}.${signature}`, { signingKey })).toEqual({
      kind: 'err',
      reason: 'bad-signature',
    });
    const otherSignature = randomBytes(64).toString('base64url');
    expect(verifyPublicRunToken(`${signed}.${otherSignature}`, { signingKey })).toEqual({
      kind: 'err',
      reason: 'bad-signature',
    });
  });

  test('a token signed by another key with the same id fails', () => {
    const token = mint([runIdA], { key: ed25519Binding() });
    expect(verifyPublicRunToken(token, { signingKey })).toEqual({
      kind: 'err',
      reason: 'bad-signature',
    });
  });

  test('an unknown key id, or a key that is not Ed25519, is unknown-key', () => {
    const token = mint([runIdA]);
    expect(
      verifyPublicRunToken(token, { signingKey: ed25519Binding('other' as SigningKeyId) }),
    ).toEqual({
      kind: 'err',
      reason: 'unknown-key',
    });
    const secret = randomBytes(32);
    const hmac = createInMemorySigningKeyBinding([
      { keyId: KEY_ID, algorithm: 'hmac-sha256', publicKey: secret, privateKey: secret },
    ]);
    expect(verifyPublicRunToken(token, { signingKey: hmac })).toEqual({
      kind: 'err',
      reason: 'unknown-key',
    });
  });

  test('expired, or issued too far in the future, is expired', () => {
    const issued = Date.UTC(2026, 9, 1, 12, 0, 0);
    const token = mint([runIdA], { ttlSeconds: 60, now: () => issued });
    expect(verifyPublicRunToken(token, { signingKey, now: () => issued + 59_000 }).kind).toBe('ok');
    expect(verifyPublicRunToken(token, { signingKey, now: () => issued + 60_000 })).toEqual({
      kind: 'err',
      reason: 'expired',
    });
    expect(verifyPublicRunToken(token, { signingKey, now: () => issued - 120_000 })).toEqual({
      kind: 'err',
      reason: 'expired',
    });
  });

  test.each([
    ['no prefix', 'abc.def'],
    ['nothing after the prefix', 'kgi_pt_'],
    ['no signature', 'kgi_pt_eyJ2IjoxfQ'],
    ['not base64url', 'kgi_pt_e+J2IjoxfQ.abc'],
    ['a payload that is not JSON', `kgi_pt_${Buffer.from('nope').toString('base64url')}.abc`],
    [
      'a payload of the wrong shape',
      `kgi_pt_${Buffer.from(JSON.stringify({ v: 2 })).toString('base64url')}.abc`,
    ],
  ])('%s is malformed', (_label, token) => {
    expect(verifyPublicRunToken(token, { signingKey })).toEqual({
      kind: 'err',
      reason: 'malformed',
    });
  });

  test('minting refuses no runs, too many runs, and lifetimes out of range', () => {
    const many = Array.from({ length: 51 }, () => randomUUID() as RunId);
    for (const [runIds, ttlSeconds] of [
      [[], 900],
      [many, 900],
      [[runIdA], 0],
      [[runIdA], 86_401],
    ] as const) {
      const minted = mintPublicRunToken({
        signingKey,
        keyId: KEY_ID,
        tenantId: tenantA,
        runIds,
        ttlSeconds,
      });
      expect(minted.kind).toBe('err');
    }
  });

  test('startup configuration checks fail loudly', () => {
    expect(() =>
      resolvePublicRunTokenConfig({ signingKey, keyId: 'missing' as SigningKeyId }),
    ).toThrow();
    expect(() =>
      resolvePublicRunTokenConfig({ signingKey, keyId: KEY_ID, maxTtlSeconds: 90_000 }),
    ).toThrow();
    expect(() =>
      resolvePublicRunTokenConfig({
        signingKey,
        keyId: KEY_ID,
        defaultTtlSeconds: 600,
        maxTtlSeconds: 300,
      }),
    ).toThrow();
    expect(resolvePublicRunTokenConfig({ signingKey, keyId: KEY_ID })).toEqual({
      defaultTtlSeconds: 900,
      maxTtlSeconds: 86_400,
    });
  });
});

// ---------------- through the app ----------------

const at = '2026-10-01T00:00:00.000Z' as Timestamp;

function runRow(tenantId: TenantId, overrides: Partial<KernelRunRecord> = {}): KernelRunRecord {
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId: randomUUID() as ProjectId,
    flowId: 'acme.order-review',
    flowVersion: '1.0.0',
    status: 'completed',
    input: { orderId: 'o-1' },
    output: { decision: 'approve' },
    failureMessage: undefined,
    dryRun: false,
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    ...overrides,
  } as KernelRunRecord;
}

function journalEntry(sequence: number, kind: string): JournalEntry {
  return {
    sequence,
    kind,
    nodeId: 'review',
    payload: { secretInput: 'order details' },
    timestamp: new Date(Date.UTC(2026, 9, 1, 12, 0, sequence)).toISOString() as Timestamp,
  } as unknown as JournalEntry;
}

interface Harness {
  readonly app: ReturnType<typeof createApp>;
  readonly parent: KernelRunRecord;
  readonly child: KernelRunRecord;
  readonly grandchild: KernelRunRecord;
  readonly other: KernelRunRecord;
  readonly otherTenantRun: KernelRunRecord;
}

function harness(
  options: { publicRunTokens?: PublicRunTokenConfig | false; denyAll?: boolean } = {},
): Harness {
  const parent = runRow(tenantA);
  const child = runRow(tenantA, { parentRunId: parent.runId });
  const grandchild = runRow(tenantA, { parentRunId: child.runId });
  const other = runRow(tenantA);
  const otherTenantRun = runRow(tenantB);
  const rows = [parent, child, grandchild, other, otherTenantRun];
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (tenantId: TenantId, id: RunId) =>
      rows.find((r) => r.runId === id && r.tenantId === tenantId) ?? null,
    listRuns: async () => ({ data: [] }),
    readJournal: async () => ({
      kind: 'ok' as const,
      value: [
        journalEntry(0, 'run.started'),
        journalEntry(1, 'step.completed'),
        journalEntry(2, 'run.completed'),
      ],
    }),
  } as unknown as RunBinding;
  const runHandler: RunHandlerBinding = {
    invokeAgent: async () => ({ kind: 'ok', runId: parent.runId }),
    invokeFlow: async () => ({ kind: 'ok', runId: parent.runId }),
    resumeRun: async ({ runId }) => ({ kind: 'ok', runId }),
  };
  const resolveToken: TokenResolver = async (token) =>
    token === API_TOKEN ? { tenantId: tenantA, userId: 'user-1' as never } : null;
  const config =
    options.publicRunTokens === false
      ? undefined
      : (options.publicRunTokens ?? { signingKey, keyId: KEY_ID, allowedOrigins: [ORIGIN] });
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler,
    ...(config !== undefined && { publicRunTokens: config }),
    ...(options.denyAll === true && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async () => ({
            allowed: false,
            failing: 'relation',
            reason: 'deny everything',
            evidence: { action: 'read', relation: '', resource: '', actorSubject: '' },
          }),
        } as never,
      },
    }),
  });
  return { app, parent, child, grandchild, other, otherTenantRun };
}

async function get(
  app: Harness['app'],
  path: string,
  token: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...init.headers,
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json:
      text.length > 0 && text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: res.headers,
  };
}

const code = (json: Record<string, unknown>) => (json.error as { code?: string } | undefined)?.code;

describe('POST /v1/runs hands back a public token for the run', () => {
  test('the token reads the started run', async () => {
    const h = harness();
    const started = await get(h.app, '/v1/runs', API_TOKEN, {
      method: 'POST',
      body: { flow: 'acme.order-review', input: {}, options: { wait: false } },
    });
    expect(started.status).toBe(202);
    const token = started.json.publicAccessToken as string;
    expect(token.startsWith('kgi_pt_')).toBe(true);
    const expiresIn = Date.parse(started.json.publicAccessTokenExpiresAt as string) - Date.now();
    expect(expiresIn).toBeGreaterThan(14 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(15 * 60_000);
    const read = await get(h.app, `/v1/runs/${h.parent.runId}/progress`, token);
    expect(read.status).toBe(200);
  });

  test('no token without the configuration', async () => {
    const h = harness({ publicRunTokens: false });
    const started = await get(h.app, '/v1/runs', API_TOKEN, {
      method: 'POST',
      body: { flow: 'acme.order-review', input: {} },
    });
    expect(started.json.publicAccessToken).toBeUndefined();
  });
});

describe('what a public token can read', () => {
  test('the public view of a named run: status and timing, nothing else', async () => {
    const h = harness();
    const res = await get(h.app, `/v1/runs/${h.parent.runId}/progress`, mint([h.parent.runId]));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      id: h.parent.runId,
      flowId: 'acme.order-review',
      flowVersion: '1.0.0',
      status: 'completed',
      createdAt: at,
      updatedAt: at,
      completedAt: at,
    });
  });

  test('descendants of a named run are readable; other runs are 404', async () => {
    const h = harness();
    const token = mint([h.parent.runId]);
    const child = await get(h.app, `/v1/runs/${h.child.runId}/progress`, token);
    expect(child.status).toBe(200);
    expect(child.json.parentRunId).toBe(h.parent.runId);
    expect((await get(h.app, `/v1/runs/${h.grandchild.runId}/progress`, token)).status).toBe(200);
    const other = await get(h.app, `/v1/runs/${h.other.runId}/progress`, token);
    expect(other.status).toBe(404);
    expect(code(other.json)).toBe('run-not-found');
    // A token naming the child doesn't reach up to the parent.
    expect(
      (await get(h.app, `/v1/runs/${h.parent.runId}/progress`, mint([h.child.runId]))).status,
    ).toBe(404);
  });

  test("another tenant's run is 404, even when the token names it", async () => {
    const h = harness();
    const res = await get(
      h.app,
      `/v1/runs/${h.otherTenantRun.runId}/progress`,
      mint([h.otherTenantRun.runId]),
    );
    expect(res.status).toBe(404);
  });

  test('every other route is 403 for a public token', async () => {
    const h = harness();
    const token = mint([h.parent.runId]);
    for (const [method, path] of [
      ['GET', `/v1/runs/${h.parent.runId}`],
      ['GET', `/v1/runs/${h.parent.runId}/stream`],
      ['GET', '/v1/runs'],
      ['GET', `/v1/runs/${h.parent.runId}/journal`],
      ['POST', `/v1/runs/${h.parent.runId}/cancel`],
      ['POST', `/v1/runs/${h.parent.runId}/resume`],
      ['POST', '/v1/runs'],
      ['POST', '/v1/tokens/public'],
      ['GET', '/v1/agents'],
    ] as const) {
      const res = await get(h.app, path, token, { method, ...(method === 'POST' && { body: {} }) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(code(res.json)).toBe('permission-denied');
    }
  });

  test('an expired token is 401 auth-expired; a forged one 401 auth-missing', async () => {
    const h = harness();
    const expired = mint([h.parent.runId], { ttlSeconds: 60, now: () => Date.now() - 120_000 });
    const res = await get(h.app, `/v1/runs/${h.parent.runId}/progress`, expired);
    expect(res.status).toBe(401);
    expect(code(res.json)).toBe('auth-expired');
    const forged = mint([h.parent.runId], { key: ed25519Binding() });
    const bad = await get(h.app, `/v1/runs/${h.parent.runId}/progress`, forged);
    expect(bad.status).toBe(401);
    expect(code(bad.json)).toBe('auth-missing');
  });

  test('without the configuration, a public token is not recognized', async () => {
    const h = harness({ publicRunTokens: false });
    const res = await get(h.app, `/v1/runs/${h.parent.runId}/progress`, mint([h.parent.runId]));
    expect(res.status).toBe(401);
  });

  test('an API token can read progress too', async () => {
    const h = harness();
    const res = await get(h.app, `/v1/runs/${h.other.runId}/progress`, API_TOKEN);
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(h.other.runId);
    expect(res.json.output).toBeUndefined();
  });

  test('the authorizer governs API tokens; a public token is checked by its grant instead', async () => {
    const h = harness({ denyAll: true });
    expect((await get(h.app, `/v1/runs/${h.parent.runId}`, API_TOKEN)).status).toBe(403);
    const token = mint([h.parent.runId]);
    expect((await get(h.app, `/v1/runs/${h.parent.runId}/progress`, token)).status).toBe(200);
    expect((await get(h.app, `/v1/runs/${h.other.runId}/progress`, token)).status).toBe(404);
  });
});

describe('GET /v1/runs/:runId/progress/stream', () => {
  test('events carry kind, node and sequence, never the payload or tenant', async () => {
    const h = harness();
    const res = await h.app.request(`/v1/runs/${h.parent.runId}/progress/stream`, {
      headers: { authorization: `Bearer ${mint([h.parent.runId])}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    const events = body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
    expect(events.map((e) => e.kind)).toEqual([
      'run.started',
      'run.step-completed',
      'run.completed',
    ]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual([
        'eventId',
        'kind',
        'nodeId',
        'runId',
        'sequence',
        'timestamp',
      ]);
    }
    expect(body).not.toContain('order details');
  });

  test('the full stream still sends everything to an API token', async () => {
    const h = harness();
    const res = await h.app.request(`/v1/runs/${h.parent.runId}/stream`, {
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(await res.text()).toContain('order details');
  });

  test('a run outside the grant is 404', async () => {
    const h = harness();
    const res = await h.app.request(`/v1/runs/${h.other.runId}/progress/stream`, {
      headers: { authorization: `Bearer ${mint([h.parent.runId])}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/tokens/public', () => {
  test('mints a token for runs the caller can read', async () => {
    const h = harness();
    const res = await get(h.app, '/v1/tokens/public', API_TOKEN, {
      method: 'POST',
      body: { runIds: [h.parent.runId, h.other.runId, h.parent.runId], expiresInSeconds: 120 },
    });
    expect(res.status).toBe(201);
    expect(res.json.runIds).toEqual([h.parent.runId, h.other.runId]);
    const expiresIn = Date.parse(res.json.expiresAt as string) - Date.now();
    expect(expiresIn).toBeLessThanOrEqual(120_000);
    const token = res.json.token as string;
    expect((await get(h.app, `/v1/runs/${h.other.runId}/progress`, token)).status).toBe(200);
  });

  test('refuses unknown runs, bad bodies and lifetimes above the maximum', async () => {
    const h = harness({ publicRunTokens: { signingKey, keyId: KEY_ID, maxTtlSeconds: 3600 } });
    const post = (body: unknown) =>
      get(h.app, '/v1/tokens/public', API_TOKEN, { method: 'POST', body });
    const missing = await post({ runIds: [randomUUID()] });
    expect(missing.status).toBe(404);
    expect(code(missing.json)).toBe('run-not-found');
    expect((await post({ runIds: [h.otherTenantRun.runId] })).status).toBe(404);
    expect((await post({ runIds: [] })).status).toBe(400);
    expect((await post({ runIds: [h.parent.runId], expiresInSeconds: 3601 })).status).toBe(400);
    const unknown = await post({ runIds: [h.parent.runId], scopes: ['write'] });
    expect(unknown.status).toBe(400);
    expect(code(unknown.json)).toBe('unknown-field');
  });

  test('the caller must be allowed to read each run', async () => {
    const h = harness({ denyAll: true });
    const res = await get(h.app, '/v1/tokens/public', API_TOKEN, {
      method: 'POST',
      body: { runIds: [h.parent.runId] },
    });
    expect(res.status).toBe(403);
  });

  test('not mounted without the configuration', async () => {
    const h = harness({ publicRunTokens: false });
    const res = await get(h.app, '/v1/tokens/public', API_TOKEN, {
      method: 'POST',
      body: { runIds: [h.parent.runId] },
    });
    expect(res.status).toBe(404);
  });
});

describe('CORS on the public-token routes only', () => {
  const preflight = (app: Harness['app'], path: string, origin: string, method = 'GET') =>
    app.request(path, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization, last-event-id',
      },
    });

  test('a preflight from an allowed origin passes without a token', async () => {
    const h = harness();
    const res = await preflight(h.app, `/v1/runs/${h.parent.runId}/progress/stream`, ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
  });

  test('no CORS for other origins, other methods or other routes', async () => {
    const h = harness();
    const otherOrigin = await preflight(
      h.app,
      `/v1/runs/${h.parent.runId}/progress`,
      'https://evil.example',
    );
    expect(otherOrigin.headers.get('access-control-allow-origin')).toBeNull();
    const fullRun = await preflight(h.app, `/v1/runs/${h.parent.runId}`, ORIGIN);
    expect(fullRun.headers.get('access-control-allow-origin')).toBeNull();
    const post = await preflight(h.app, '/v1/runs', ORIGIN, 'POST');
    expect(post.headers.get('access-control-allow-origin')).toBeNull();
    const list = await get(h.app, '/v1/runs', API_TOKEN, { headers: { origin: ORIGIN } });
    expect(list.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('responses on the public routes carry the CORS headers, errors included', async () => {
    const h = harness();
    const ok = await get(h.app, `/v1/runs/${h.parent.runId}/progress`, mint([h.parent.runId]), {
      headers: { origin: ORIGIN },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-expose-headers')?.toLowerCase()).toContain(
      'x-request-id',
    );
    const notFound = await get(
      h.app,
      `/v1/runs/${h.other.runId}/progress`,
      mint([h.parent.runId]),
      {
        headers: { origin: ORIGIN },
      },
    );
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});
