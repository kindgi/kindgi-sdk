// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Scope } from '@kindgi/platform';
import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const TENANT_SCOPE: Scope = {
  kind: 'tenant',
  tenantId: 'tenant-1' as never,
};
const PROJECT_SCOPE: Scope = {
  kind: 'project',
  tenantId: 'tenant-1' as never,
  projectId: 'proj-42' as never,
};

const WIRE_SECRET = {
  scope: TENANT_SCOPE,
  envName: 'staging',
  name: 'stripe.key',
  currentVersion: 5,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-22T00:00:00Z',
  rotationDueAt: '2026-12-01T00:00:00Z',
};

// ---------------------------------------------------------------
// list / get / getVersion / listVersions
// ---------------------------------------------------------------

describe('secrets.list', () => {
  it('GETs /v1/secrets with scope + envName + optional filters', async () => {
    const stub = jsonFetch({ data: [WIRE_SECRET] });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const page = await client.secrets.list({
      scope: PROJECT_SCOPE,
      envName: 'staging' as never,
      includeRevoked: true,
      namePrefix: 'stripe.',
    });
    expect(page.data.length).toBe(1);
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/secrets');
    expect(url.searchParams.get('scopeKind')).toBe('project');
    expect(url.searchParams.get('scopeId')).toBe('proj-42');
    expect(url.searchParams.get('envName')).toBe('staging');
    expect(url.searchParams.get('includeRevoked')).toBe('true');
    expect(url.searchParams.get('namePrefix')).toBe('stripe.');
  });
});

describe('secrets.get', () => {
  it('returns metadata (never a value field on the wire type)', async () => {
    const stub = jsonFetch(WIRE_SECRET);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const rec = await client.secrets.get({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'stripe.key',
    });
    expect(rec?.name).toBe('stripe.key');
    // TS-level structural check: the returned SecretRecord type has
    // no `value` field. This is enforced by tsc, not asserted here.
  });

  it('returns null on 404 secret-not-found', async () => {
    const stub = errorFetch(404, { code: 'secret-not-found', message: 'nope' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const rec = await client.secrets.get({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'missing',
    });
    expect(rec).toBeNull();
  });
});

describe('secrets.getVersion', () => {
  it('GETs /v1/secrets/{name}/versions/{versionId}', async () => {
    const stub = jsonFetch({
      scope: TENANT_SCOPE,
      envName: 'staging',
      name: 'stripe.key',
      versionId: 4,
      createdAt: '2026-09-01T00:00:00Z',
      value: null,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const rec = await client.secrets.getVersion({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'stripe.key',
      versionId: 4,
    });
    expect(rec?.versionId).toBe(4);
    expect(rec?.value).toBeNull();
    expect(new URL(stub.calls[0]?.url).pathname).toBe('/v1/secrets/stripe.key/versions/4');
  });

  it('returns null on 404 secret-version-not-found', async () => {
    const stub = errorFetch(404, { code: 'secret-version-not-found', message: 'nope' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const rec = await client.secrets.getVersion({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'stripe.key',
      versionId: 99,
    });
    expect(rec).toBeNull();
  });
});

describe('secrets.listVersions', () => {
  it('GETs /v1/secrets/{name}/versions with pagination + null values', async () => {
    const stub = jsonFetch({ data: [], nextCursor: 'cur-9' });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const page = await client.secrets.listVersions({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'stripe.key',
      cursor: 'cur-8' as never,
    });
    expect(page.nextCursor).toBe('cur-9');
    const url = new URL(stub.calls[0]?.url);
    expect(url.pathname).toBe('/v1/secrets/stripe.key/versions');
    expect(url.searchParams.get('cursor')).toBe('cur-8');
  });
});

// ---------------------------------------------------------------
// set
// ---------------------------------------------------------------

describe('secrets.set', () => {
  it('POSTs /v1/secrets with body containing scope + writeMode + value', async () => {
    const stub = jsonFetch({ record: WIRE_SECRET, versionId: 5 }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const outcome = await client.secrets.set({
      scope: PROJECT_SCOPE,
      envName: 'staging' as never,
      name: 'stripe.key',
      value: 'sk_live_x',
      writeMode: 'create-new',
      tags: { owner: 'billing' },
      idempotencyKey: 'idem-1',
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.versionId).toBe(5);
    }
    const body = JSON.parse(stub.calls[0]?.body!);
    expect(body.writeMode).toBe('create-new');
    expect(body.value).toBe('sk_live_x');
    expect(body.scope.kind).toBe('project');
    expect(body.tags.owner).toBe('billing');
    expect(stub.calls[0]?.headers['idempotency-key']).toBe('idem-1');
    expect(body).not.toHaveProperty('appEnvFile');
  });

  it("sends appEnvFile only when true (kindgi dev: the app's env file)", async () => {
    const stub = jsonFetch({ record: WIRE_SECRET, versionId: 1 }, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await client.secrets.set({
      scope: PROJECT_SCOPE,
      envName: 'local' as never,
      name: 'ACME_WEBHOOK_SECRET',
      value: 'whsec_x',
      writeMode: 'create-new',
      appEnvFile: true,
    });
    expect(JSON.parse(stub.calls[0]?.body!).appEnvFile).toBe(true);
  });

  it('returns version-conflict outcome on 409 secret-write-conflict', async () => {
    const stub = errorFetch(409, {
      code: 'secret-write-conflict',
      message: 'nope',
      details: { currentVersion: 7 },
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const outcome = await client.secrets.set({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'stripe.key',
      value: 'x',
      writeMode: 'add-version',
      ifVersion: 3,
    });
    expect(outcome.kind).toBe('version-conflict');
    if (outcome.kind === 'version-conflict') {
      expect(outcome.currentVersion).toBe(7);
    }
  });
});

// ---------------------------------------------------------------
// rotate — sync path
// ---------------------------------------------------------------

describe('secrets.rotate (sync provider)', () => {
  it('resolves inline when wire returns kind:sync', async () => {
    const stub = jsonFetch({
      kind: 'sync',
      newVersionId: 6,
      oldVersionId: 5,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const outcome = await client.secrets.rotate({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'stripe.key',
      newValue: 'sk_live_new',
      revokeOldAfterMs: 24 * 60 * 60 * 1000,
    });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.newVersionId).toBe(6);
      expect(outcome.oldVersionId).toBe(5);
    }
    // ONE HTTP call — no polling for sync path.
    expect(stub.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------
// rotate — async polling
// ---------------------------------------------------------------

describe('secrets.rotate (async provider, wait-for-complete)', () => {
  it('polls with exp backoff until succeeded', async () => {
    const stub = recordingFetch([
      // POST /rotate → 202 async
      {
        status: 202,
        body: JSON.stringify({
          kind: 'async',
          rotationId: 'rot-1',
          statusUrl: '/v1/secrets/stripe.key/rotations/rot-1?envName=staging&scopeKind=tenant',
          eventsUrl:
            '/v1/secrets/stripe.key/rotations/rot-1/events?envName=staging&scopeKind=tenant',
        }),
      },
      // 1st poll → pending
      {
        status: 200,
        body: JSON.stringify({
          rotationId: 'rot-1',
          status: 'pending',
          startedAt: '2026-09-22T00:00:00Z',
          updatedAt: '2026-09-22T00:00:01Z',
        }),
      },
      // 2nd poll → succeeded
      {
        status: 200,
        body: JSON.stringify({
          rotationId: 'rot-1',
          status: 'succeeded',
          startedAt: '2026-09-22T00:00:00Z',
          updatedAt: '2026-09-22T00:00:02Z',
          newVersionId: 6,
          oldVersionId: 5,
        }),
      },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const sleeps: number[] = [];
    const outcome = await client.secrets.rotate({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'stripe.key',
      pollingOverrides: {
        initialDelayMs: 10,
        maxDelayMs: 40,
        ceilingMs: 60_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.newVersionId).toBe(6);
    }
    // POST + 2 GETs = 3 calls total.
    expect(stub.calls.length).toBe(3);
    // Backoff cadence: 10 (initial), then doubled to 20 (below max 40).
    expect(sleeps).toEqual([10, 20]);
    // Poll GET path is the status URL.
    expect(new URL(stub.calls[1]?.url).pathname).toBe('/v1/secrets/stripe.key/rotations/rot-1');
  });

  it('caps backoff at maxDelayMs', async () => {
    // Build a scenario that pends enough times to hit the cap.
    const pendingResponse = {
      status: 200,
      body: JSON.stringify({
        rotationId: 'rot-1',
        status: 'pending',
        startedAt: '2026-09-22T00:00:00Z',
        updatedAt: '2026-09-22T00:00:00Z',
      }),
    };
    const stub = recordingFetch([
      {
        status: 202,
        body: JSON.stringify({
          kind: 'async',
          rotationId: 'rot-1',
          statusUrl: '/v1/secrets/x/rotations/rot-1',
          eventsUrl: '/v1/secrets/x/rotations/rot-1/events',
        }),
      },
      pendingResponse,
      pendingResponse,
      pendingResponse,
      pendingResponse,
      pendingResponse,
      {
        status: 200,
        body: JSON.stringify({
          rotationId: 'rot-1',
          status: 'succeeded',
          startedAt: '2026-09-22T00:00:00Z',
          updatedAt: '2026-09-22T00:00:05Z',
          newVersionId: 2,
          oldVersionId: 1,
        }),
      },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const sleeps: number[] = [];
    await client.secrets.rotate({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'x',
      pollingOverrides: {
        initialDelayMs: 1,
        maxDelayMs: 4,
        ceilingMs: 60_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
    // Exp backoff: 1, 2, 4, 4, 4, 4 (capped after third doubling).
    expect(sleeps).toEqual([1, 2, 4, 4, 4, 4]);
  });

  it('returns timeout kind when ceiling exceeded', async () => {
    const pending = {
      status: 200,
      body: JSON.stringify({
        rotationId: 'rot-1',
        status: 'pending',
        startedAt: '2026-09-22T00:00:00Z',
        updatedAt: '2026-09-22T00:00:00Z',
      }),
    };
    const stub = recordingFetch([
      {
        status: 202,
        body: JSON.stringify({
          kind: 'async',
          rotationId: 'rot-1',
          statusUrl: '/v1/secrets/x/rotations/rot-1',
          eventsUrl: '/v1/secrets/x/rotations/rot-1/events',
        }),
      },
      pending,
      pending,
      pending,
      pending,
      pending,
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    // Sleep advances a clock so ceiling is exceeded after a few polls.
    let now = Date.now();
    const advance = (ms: number): Promise<void> => {
      now += ms;
      return Promise.resolve();
    };
    const originalNow = Date.now;
    Date.now = (): number => now;
    try {
      const outcome = await client.secrets.rotate({
        scope: TENANT_SCOPE,
        envName: 'staging' as never,
        name: 'x',
        pollingOverrides: {
          initialDelayMs: 100,
          maxDelayMs: 100,
          ceilingMs: 250,
          sleep: advance,
        },
      });
      expect(outcome.kind).toBe('timeout');
      if (outcome.kind === 'timeout') {
        expect(outcome.rotationId).toBe('rot-1');
      }
    } finally {
      Date.now = originalNow;
    }
  });

  it('returns failed kind on terminal failed status', async () => {
    const stub = recordingFetch([
      {
        status: 202,
        body: JSON.stringify({
          kind: 'async',
          rotationId: 'r',
          statusUrl: '/v1/secrets/x/rotations/r',
          eventsUrl: '/v1/secrets/x/rotations/r/events',
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          rotationId: 'r',
          status: 'failed',
          startedAt: '2026-09-22T00:00:00Z',
          updatedAt: '2026-09-22T00:00:01Z',
          error: 'Lambda timed out',
        }),
      },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const outcome = await client.secrets.rotate({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'x',
      pollingOverrides: {
        initialDelayMs: 1,
        maxDelayMs: 1,
        ceilingMs: 60_000,
        sleep: async () => {
          /* skip */
        },
      },
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toBe('Lambda timed out');
    }
  });

  it('mode:raw skips polling and returns the wire response', async () => {
    const stub = jsonFetch(
      {
        kind: 'async',
        rotationId: 'r',
        statusUrl: '/v1/secrets/x/rotations/r',
        eventsUrl: '/v1/secrets/x/rotations/r/events',
      },
      { status: 202 },
    );
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const outcome = await client.secrets.rotate({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'x',
      mode: 'raw',
    });
    expect(outcome.kind).toBe('raw');
    if (outcome.kind === 'raw' && outcome.response.kind === 'async') {
      expect(outcome.response.rotationId).toBe('r');
    }
    // Exactly one HTTP call — no polling.
    expect(stub.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------
// revoke
// ---------------------------------------------------------------

describe('secrets.revoke', () => {
  it('DELETEs /v1/secrets/{name} with optional hard + reason', async () => {
    const stub = jsonFetch({ revoked: true, hard: true });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const out = await client.secrets.revoke({
      scope: TENANT_SCOPE,
      envName: 'staging' as never,
      name: 'stripe.key',
      hard: true,
      reason: 'compromised',
    });
    expect(out.hard).toBe(true);
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('hard')).toBe('true');
    expect(url.searchParams.get('reason')).toBe('compromised');
  });
});
