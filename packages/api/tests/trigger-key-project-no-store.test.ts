// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { EnvName, ProjectId, TenantId, UserId } from '@kindgi/types';

import { createApp, generateOpenApiDocument } from '../src/index.js';
import type {
  AgentRegistryBinding,
  ProviderRegistryBinding,
  RunHandlerBinding,
  SecretBinding,
  TokenResolver,
  TriggerRegistryBinding,
} from '../src/index.js';
import { LIMITED_TRIGGER_PROJECT } from '../src/openapi/operations.js';
import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

/**
 * A key or session limited to a project, and the triggers it registers
 * and changes (schedules, webhook triggers, mail triggers). A trigger it
 * registers without naming a project goes in its own project, with an
 * authorization store or without one. Without a store, it is refused,
 * `403 key-project-mismatch`, any change to another project's trigger
 * by the trigger's id, before anything is written, as a store refuses it
 * (`permission-denied`). It still reads them, and a key limited to no
 * project is not refused.
 */

const tenantId = randomUUID() as TenantId;
const USER = randomUUID() as UserId;
/** Where a trigger that names no project goes for a key limited to none. */
const DEFAULT = randomUUID() as ProjectId;
/** The project the key and the session are limited to. */
const P1 = randomUUID();
/** Another project of the workspace. */
const P2 = randomUUID();
const LIMITED = 'kgi_ak_test_limited_to_p1';
const SESSION = 'kgi_ak_test_session_limited_to_p1';
const UNLIMITED = 'kgi_ak_test_not_limited';

const resolveToken: TokenResolver = async (token) => {
  if (token === LIMITED) return { tenantId, userId: USER, tokenProjectId: P1 };
  if (token === SESSION) {
    return { tenantId, userId: USER, tokenProjectId: P1, sessionId: 'ses-acme' as never };
  }
  return token === UNLIMITED ? { tenantId, userId: USER } : null;
};

const SUPPORT = { tools: [{ id: 'acme.reply' }] };
const agentRegistry = {
  get: async ({ agentId }: { agentId: string }) =>
    agentId === 'acme.support' ? { id: agentId, ...SUPPORT } : null,
  getVersion: async ({ agentId, version }: { agentId: string; version: string }) =>
    agentId === 'acme.support' ? { id: agentId, version, ...SUPPORT } : null,
} as unknown as AgentRegistryBinding;

/** A store that grants everything: what it refuses, the key's limit refuses. */
const granted = (action: Action, r: ResourceRef): Decision => ({
  allowed: true,
  reason: 'test: granted',
  evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
});

/**
 * What the store places in P1: the flows and the agent the triggers start.
 * A key limited to P1 reaches nothing else that isn't a project.
 */
const IN_P1 = new Set(['flow:acme.nightly', 'flow:acme.refund-review', 'agent:acme.support']);

const WRITE_CALL = /^(fire|pause|register|resume|set|unregister|update)/;

/** Every write-named call a request makes on the trigger registry. */
const writes: string[] = [];

function recorded(registry: TriggerRegistryBinding): TriggerRegistryBinding {
  return new Proxy(registry, {
    get(t, key) {
      const value: unknown = Reflect.get(t, key, t);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (typeof key === 'string' && WRITE_CALL.test(key)) writes.push(key);
        return value.apply(t, args);
      };
    },
  });
}

function appWith(store: boolean) {
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    triggerRegistry: recorded(createInMemoryTriggerRegistry({ defaultProjectId: DEFAULT })),
    agentRegistry,
    // No secret is set, and the provider's key is the one a webhook may not take.
    secretsBinding: { get: async () => null } as unknown as SecretBinding,
    providerRegistry: {
      resolveForRuntime: async () => [
        { metadata: { id: 'acme-llm' }, secretRef: { name: 'acme-provider-key' } },
      ],
    } as unknown as ProviderRegistryBinding,
    webhookReceiver: { envName: 'test' as EnvName },
    ...(store && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          inProject: async (_p, r, projectId) => projectId === P1 && IN_P1.has(`${r.type}:${r.id}`),
          check: async (_p, action, r) => granted(action, r),
          checkBatch: async (_p, action, rs) => rs.map((r) => granted(action, r)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
}

const noStore = appWith(false);
const withStore = appWith(true);
type App = typeof noStore;

type Body = {
  triggerId?: string;
  scheduleId?: string;
  projectId?: string;
  error?: { code: string; message?: string; details?: Record<string, unknown> };
};

async function send(app: App, token: string, method: string, path: string, body?: unknown) {
  writes.length = 0;
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Body = {};
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as Body) : {};
  } catch {
    // Not JSON: no error code to read.
  }
  return { status: res.status, body: parsed, writes: [...writes] };
}

type Kind = 'schedule' | 'webhook' | 'mail';

const KINDS: Record<Kind, { readonly base: string; readonly register: Record<string, unknown> }> = {
  schedule: {
    base: '/v1/schedules',
    register: {
      flowId: 'acme.nightly',
      flowVersion: '1.0.0',
      config: { cronExpression: '0 2 * * *', timezone: 'UTC' },
    },
  },
  webhook: {
    base: '/v1/webhooks',
    register: { flowId: 'acme.refund-review', flowVersion: '1.0.0', hmacSecretName: 'acme-hmac' },
  },
  mail: {
    base: '/v1/mail-triggers',
    register: { agentId: 'acme.support', config: { mailbox: { app: 'google', as: 'person' } } },
  },
};

/** Registers a trigger of `kind` (in `projectId`, when named), answering it as stored. */
async function register(app: App, token: string, kind: Kind, projectId?: string) {
  const res = await send(app, token, 'POST', KINDS[kind].base, {
    ...KINDS[kind].register,
    ...(projectId !== undefined && { projectId }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    id: (res.body.triggerId ?? res.body.scheduleId) as string,
    projectId: res.body.projectId,
  };
}

type Row = {
  readonly label: string;
  readonly kind: Kind;
  /** The operation, as `METHOD /openapi/path`. */
  readonly op: string;
  readonly method: string;
  /** After `/<base>/<triggerId>`. */
  readonly tail: string;
  readonly body?: unknown;
};

const ROUTES: Record<Kind, readonly (readonly [string, string, unknown?])[]> = {
  schedule: [
    ['PATCH', '', {}],
    ['POST', '/pause'],
    ['POST', '/resume'],
    ['POST', '/unregister'],
    ['POST', '/run-now'],
    ['POST', '/owner'],
  ],
  webhook: [
    ['PATCH', '', {}],
    ['POST', '/pause'],
    ['POST', '/resume'],
    ['POST', '/unregister'],
    ['POST', '/owner'],
  ],
  mail: [
    ['PATCH', '', {}],
    ['POST', '/pause'],
    ['POST', '/resume'],
    ['POST', '/unregister'],
    ['POST', '/owner'],
  ],
};

/** One row per change to a trigger by its id. */
const HELD: readonly Row[] = (Object.keys(ROUTES) as Kind[]).flatMap((kind) =>
  ROUTES[kind].map(([method, tail, body]) => ({
    label: `${kind} ${method} ${tail === '' ? '(update)' : tail.slice(1)}`,
    kind,
    op: `${method} ${KINDS[kind].base}/{triggerId}${tail}`,
    method,
    tail,
    body,
  })),
);

/** `row` on a trigger of its kind just registered in `projectId`. */
async function sendOn(app: App, token: string, r: Row, projectId: string) {
  const { id } = await register(app, UNLIMITED, r.kind, projectId);
  return send(app, token, r.method, `${KINDS[r.kind].base}/${id}${r.tail}`, r.body);
}

const KIND_LIST: readonly Kind[] = ['schedule', 'webhook', 'mail'];

describe('a trigger that names no project', () => {
  test.each(KIND_LIST)(
    '%s, by a key limited to a project, with no store: in its project',
    async (kind) => {
      const made = await register(noStore, LIMITED, kind);
      expect(made.projectId).toBe(P1);
    },
  );

  test.each(KIND_LIST)(
    '%s, by a key limited to a project, with a store: in its project',
    async (kind) => {
      const made = await register(withStore, LIMITED, kind);
      expect(made.projectId).toBe(P1);
    },
  );

  test.each(KIND_LIST)('%s, by a session limited to a project: in its project', async (kind) => {
    const made = await register(noStore, SESSION, kind);
    expect(made.projectId).toBe(P1);
  });

  test.each(KIND_LIST)(
    '%s, by a key limited to no project: the default project, as before',
    async (kind) => {
      const made = await register(noStore, UNLIMITED, kind);
      expect(made.projectId).toBe(DEFAULT);
    },
  );
});

describe("another project's trigger, by a key limited to a project, with no store", () => {
  test('every operation whose 403 names this refusal has a row, and no other', () => {
    const doc = generateOpenApiDocument() as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    const documented = new Set<string>();
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (JSON.stringify(op.responses?.['403'] ?? '').includes(LIMITED_TRIGGER_PROJECT)) {
          documented.add(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(HELD.map((r) => r.op).sort()).toEqual([...documented].sort());
  });

  test.each(HELD)('$label: 403 key-project-mismatch, nothing written', async (r) => {
    const res = await sendOn(noStore, LIMITED, r, P2);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'key-project-mismatch',
      message: `This API key is limited to project ${P1}; the trigger is in project ${P2}`,
      details: { keyProjectId: P1, projectId: P2 },
    });
    expect(res.writes).toEqual([]);
  });

  test.each(HELD)('$label, in its own project: not refused', async (r) => {
    const res = await sendOn(noStore, LIMITED, r, P1);
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
  });

  test.each(HELD)('$label, by a key limited to no project: not refused', async (r) => {
    const res = await sendOn(noStore, UNLIMITED, r, P2);
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
  });

  test('a change that is not refused reaches the registry, so the rows above see one', async () => {
    const pause = HELD.find((r) => r.kind === 'schedule' && r.tail === '/pause') as Row;
    const res = await sendOn(noStore, UNLIMITED, pause, P2);
    expect(res.status).toBe(200);
    expect(res.writes).toEqual(['pause']);
  });

  test.each(KIND_LIST)('%s: a session limited to a project is held the same way', async (kind) => {
    const pause = HELD.find((r) => r.kind === kind && r.tail === '/pause') as Row;
    const res = await sendOn(noStore, SESSION, pause, P2);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'key-project-mismatch',
      message: `This session is limited to project ${P1}; the trigger is in project ${P2}`,
    });
    expect(res.writes).toEqual([]);
  });

  test.each(KIND_LIST)('%s: reading it by its id is not refused', async (kind) => {
    const { id } = await register(noStore, UNLIMITED, kind, P2);
    for (const tail of ['', '/fires', '/versions']) {
      const res = await send(noStore, LIMITED, 'GET', `${KINDS[kind].base}/${id}${tail}`);
      expect(res.status, `${kind} GET ${tail}`).toBe(200);
    }
  });
});

describe("another project's trigger, by a key limited to a project, with a store", () => {
  test.each(HELD)('$label: 403 permission-denied, as before', async (r) => {
    const res = await sendOn(withStore, LIMITED, r, P2);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('permission-denied');
    expect(res.writes).toEqual([]);
  });
});
