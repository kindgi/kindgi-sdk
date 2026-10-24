// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a webhook trigger's signing secret is read (`secret-scope.ts`):
 * recorded when it's registered, as its registrant may read the secret,
 * then the only scope the receiver reads. With a store that reads as the
 * in-tree ones do (most-specific-wins up to the tenant, unless the read is
 * `exact`), and three people: the tenant's admin, project P's admin, and a
 * writer in P who administers nothing.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import { createLogger } from '@kindgi/log';
import type { Scope } from '@kindgi/platform';
import type { EnvName, TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, SecretBinding, TokenResolver } from '../src/index.js';
import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';
import { validateAgainst } from './support/openapi-schema.js';

const TENANT = '00000000-0000-4000-8000-00000000000a' as TenantId;
const P = '00000000-0000-4000-8000-0000000000a1';
const ORG = '00000000-0000-4000-8000-0000000000b1';
const ENV = 'test' as EnvName;
const NAME = 'acmeWooSecret';

const TOKENS: Record<string, string> = {
  'tenant-admin': 'user-admin',
  'p-admin': 'user-p-admin',
  'p-writer': 'user-p-writer',
};

const resolveToken: TokenResolver = async (token) =>
  TOKENS[token] !== undefined
    ? { tenantId: TENANT, userId: TOKENS[token] as unknown as UserId }
    : null;

/** Who may do what: the tenant's admin all; P's admin all on P; P's writer read and write on P. */
function decide(subject: string, action: Action, resource: ResourceRef): Decision {
  const user = subject;
  const allowed =
    user === 'user-admin' ||
    resource.type === 'flow' ||
    (resource.type === 'project' &&
      resource.id === P &&
      (user === 'user-p-admin' ||
        (user === 'user-p-writer' && (action === 'read' || action === 'write'))));
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

/** The check, as `decide` answers it for the caller's user. */
function checkBinding(): AuthzCheckBinding {
  const subject = (principal: Principal) => principal.actor.id;
  return {
    check: async (principal: Principal, action: Action, resource: ResourceRef) =>
      decide(subject(principal), action, resource),
    checkBatch: async (principal: Principal, action: Action, resources: readonly ResourceRef[]) =>
      resources.map((r) => decide(subject(principal), action, r)),
  } as unknown as AuthzCheckBinding;
}

const keyOf = (scope: Scope, env: string, name: string) =>
  `${scope.kind === 'project' ? `project:${scope.projectId}` : scope.kind === 'org' ? `org:${scope.orgId}` : 'tenant'}|${env}|${name}`;

/** The scopes a read at `scope` walks, most specific first: P's org is ORG. */
const walkFrom = (scope: Scope): Scope[] => {
  const top: Scope = { kind: 'tenant', tenantId: TENANT };
  if (scope.kind === 'tenant') return [top];
  if (scope.kind === 'org') return [scope, top];
  return [scope, { kind: 'org', tenantId: TENANT, orgId: ORG as never }, top];
};

function setup(
  options: {
    readonly receiver?: boolean;
    /** A store that walks even for an `exact` read (one that doesn't honour it). */
    readonly ignoresExact?: boolean;
    /** A store that doesn't report the scope it read. */
    readonly omitsScope?: boolean;
    /** Triggers registered as before scopes were recorded: none kept. */
    readonly legacy?: boolean;
    /** A store that writes only names like these (the dev store's env-file keys): `nameRefusal`, and `set` refusing the rest. */
    readonly writes?: RegExp;
    /** An audit store that refuses `secret-resolved` records. */
    readonly refusesResolved?: boolean;
  } = {},
) {
  // The store, each scope apart.
  const stored = new Map<string, string>();
  const reads: { readonly scope: string; readonly exact: boolean }[] = [];
  const audited: AuditEvent[] = [];
  const auditEvents = {
    append: async (events: readonly AuditEvent[]) => {
      if (options.refusesResolved === true && events.some((e) => e.kind === 'secret-resolved')) {
        return {
          kind: 'err',
          error: { code: 'persistence-error', message: 'the audit store is down' },
        };
      }
      audited.push(...events);
      return { kind: 'ok', value: undefined };
    },
  } as unknown as AuditEventBinding;
  const logLines: string[] = [];
  const put = (scope: Scope, value: string, env: string = ENV) =>
    stored.set(keyOf(scope, env, NAME), value);
  // The names `nameRefusal` was asked about.
  const asked: string[] = [];
  const refusal = (name: string) =>
    options.writes === undefined || options.writes.test(name)
      ? undefined
      : {
          code: 'secret-name-invalid' as const,
          message: `"${name}" isn't a name this store writes.`,
        };
  const secrets = {
    ...(options.writes !== undefined && {
      nameRefusal(name: string) {
        asked.push(name);
        return refusal(name);
      },
    }),
    async get(input: { scope: Scope; envName: string; name: string }) {
      return stored.has(keyOf(input.scope, input.envName, input.name))
        ? { name: input.name, currentVersion: 1, scope: input.scope }
        : null;
    },
    async set(input: { scope: Scope; envName: string; name: string; value: string }) {
      const refused = refusal(input.name);
      if (refused !== undefined) return { kind: 'error', ...refused };
      const key = keyOf(input.scope, input.envName, input.name);
      if (stored.has(key)) return { kind: 'already-exists', record: { name: input.name } };
      stored.set(key, input.value);
      const at = new Date().toISOString();
      return {
        kind: 'ok',
        versionId: 1,
        record: {
          scope: input.scope,
          envName: input.envName,
          name: input.name,
          currentVersion: 1,
          createdAt: at,
          updatedAt: at,
        },
      };
    },
    async resolve(input: { scope: Scope; envName: string; name: string; exact?: true }) {
      reads.push({ scope: keyOf(input.scope, '', '').split('|')[0] ?? '', exact: !!input.exact });
      const exact = input.exact === true && options.ignoresExact !== true;
      for (const scope of exact ? [input.scope] : walkFrom(input.scope)) {
        const value = stored.get(keyOf(scope, input.envName, input.name));
        if (value !== undefined) {
          const read = { name: input.name, versionId: 1, value };
          return { kind: 'ok', value: options.omitsScope === true ? read : { ...read, scope } };
        }
      }
      return {
        kind: 'err',
        error: { code: 'secret-not-found', message: 'not found', name: input.name },
      };
    },
  } as unknown as SecretBinding;
  const kept = createInMemoryTriggerRegistry({ defaultProjectId: P as never });
  const registry: typeof kept =
    options.legacy === true
      ? {
          ...kept,
          register: (input: Parameters<typeof kept.register>[0]) => {
            if (input.kind !== 'webhook') return kept.register(input);
            const { hmacSecretScope: _, ...asBefore } = input;
            return kept.register(asBefore);
          },
        }
      : kept;
  let registers = 0;
  const counted: typeof kept = {
    ...registry,
    register: (input: Parameters<typeof kept.register>[0]) => {
      registers += 1;
      return registry.register(input);
    },
  };
  const check = checkBinding();
  const appFor = () =>
    createApp({
      ...createStubAppBindings(),
      triggerRegistry: counted,
      secretsBinding: secrets,
      projectBinding: {
        getDefault: async () => ({ id: P }),
        get: async (_t: unknown, id: string) => (id === P ? { id: P, orgId: ORG } : undefined),
      } as never,
      resolveToken,
      auditEvents,
      runHandler: {} as RunHandlerBinding,
      ...(options.receiver !== false && { webhookReceiver: { envName: ENV } }),
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: check },
      logger: createLogger({ write: (line) => logLines.push(line) }),
    });
  let app = appFor();
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1/webhooks${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const register = (token: string, extra: Record<string, unknown> = {}) =>
    call(token, 'POST', '', {
      flowId: 'acme.refund-review',
      flowVersion: '1.0.0',
      projectId: P,
      hmacSecretName: NAME,
      signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-WC-Webhook-Signature' },
      ...extra,
    });
  /** A delivery signed with `secret`: its answer's status. */
  const deliver = async (webhookId: string, secret: string) => {
    const body = JSON.stringify({ id: 4211 });
    const res = await app.request(`/v1/hooks/${TENANT}/${webhookId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-wc-webhook-signature': createHmac('sha256', secret).update(body).digest('base64'),
      },
      body,
    });
    return res.status;
  };
  return {
    stored,
    reads,
    audited,
    /** The app's log records, parsed. */
    logged: () => logLines.map((line) => JSON.parse(line) as Record<string, unknown>),
    asked,
    /** How many times the registry was asked to register a trigger. */
    registers: () => registers,
    put,
    call,
    register,
    deliver,
    /** A new app over the same stores: nothing kept from before. */
    restart: () => {
      app = appFor();
    },
  };
}

const project: Scope = { kind: 'project', tenantId: TENANT, projectId: P as never };
const tenant: Scope = { kind: 'tenant', tenantId: TENANT };
/** The answer without what differs between two registrations. */
const shape = (body: Record<string, unknown>) => {
  const { triggerId: _t, webhookId: _w, createdAt: _c, updatedAt: _u, ...rest } = body;
  return rest;
};

describe('where a named signing secret is read', () => {
  test("P's admin: P's secret is P's; a secret only the tenant has is never read for them", async () => {
    const h = setup();
    h.put(project, 'p-value');
    const own = await h.register('p-admin');
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.hmacSecretScope).toEqual({ kind: 'project', projectId: P });

    const other = setup();
    other.put(tenant, 'tenant-value');
    const named = await other.register('p-admin');
    // The broadest they administer: their project, where nothing is set yet.
    expect(named.body.hmacSecretScope).toEqual({ kind: 'project', projectId: P });
    expect(await other.deliver(named.body.webhookId, 'tenant-value')).toBe(401);
  });

  test('the answer is the same whether or not the tenant has the name', async () => {
    const withTenant = setup();
    withTenant.put(tenant, 'tenant-value');
    const without = setup();
    const a = await withTenant.register('p-admin');
    const b = await without.register('p-admin');
    expect(JSON.stringify(shape(a.body))).toBe(JSON.stringify(shape(b.body)));
  });

  test("the tenant's admin: the tenant's secret, or the tenant when none is set yet (register, then set)", async () => {
    const h = setup();
    h.put(tenant, 'tenant-value');
    const got = await h.register('tenant-admin');
    expect(got.body.hmacSecretScope).toEqual({ kind: 'tenant' });
    expect(await h.deliver(got.body.webhookId, 'tenant-value')).toBe(202);

    const first = setup();
    const early = await first.register('tenant-admin');
    expect(early.body.hmacSecretScope).toEqual({ kind: 'tenant' });
    first.put(tenant, 'set-after');
    first.restart();
    expect(await first.deliver(early.body.webhookId, 'set-after')).toBe(202);
  });

  test('a writer who administers no scope: none recorded, nothing verifies, until an admin names it again', async () => {
    const h = setup();
    h.put(project, 'p-value');
    const writer = await h.register('p-writer');
    expect(writer.status, JSON.stringify(writer.body)).toBe(201);
    expect(writer.body.hmacSecretScope).toBeNull();
    expect(await h.deliver(writer.body.webhookId, 'p-value')).toBe(401);
    const renamed = await h.call('p-admin', 'PATCH', `/${writer.body.triggerId}`, {
      hmacSecretName: NAME,
    });
    expect(renamed.body.hmacSecretScope).toEqual({ kind: 'project', projectId: P });
    h.restart();
    expect(await h.deliver(writer.body.webhookId, 'p-value')).toBe(202);
  });
});

describe('the same name in the tenant and in P', () => {
  test("a trigger in P reads P's, never the tenant's; P's removed, it's missing, never the tenant's", async () => {
    const h = setup();
    h.put(tenant, 'tenant-value');
    h.put(project, 'p-value');
    const t = await h.register('p-admin');
    expect(t.body.hmacSecretScope).toEqual({ kind: 'project', projectId: P });
    expect(await h.deliver(t.body.webhookId, 'p-value')).toBe(202);
    expect(await h.deliver(t.body.webhookId, 'tenant-value')).toBe(401);
    h.stored.delete(`project:${P}|${ENV}|${NAME}`);
    h.restart();
    expect(await h.deliver(t.body.webhookId, 'tenant-value')).toBe(401);
  });

  test('every read at a recorded scope is exact', async () => {
    const h = setup();
    h.put(project, 'p-value');
    const t = await h.register('p-admin');
    expect(await h.deliver(t.body.webhookId, 'p-value')).toBe(202);
    expect(h.reads).toEqual([{ scope: `project:${P}`, exact: true }]);
  });

  test("a trigger from before scopes were recorded reads the tenant's, walking as it did", async () => {
    const h = setup({ legacy: true });
    h.put(tenant, 'tenant-value');
    h.put(project, 'p-value');
    const t = await h.register('p-admin');
    const read = await h.call('p-admin', 'GET', `/${t.body.triggerId}`);
    expect(read.body).not.toHaveProperty('hmacSecretScope');
    expect(await h.deliver(t.body.webhookId, 'tenant-value')).toBe(202);
    expect(h.reads).toEqual([{ scope: 'tenant', exact: false }]);
  });

  test("a store that doesn't honour exact: a value it reads at another scope is refused, and that's audited without it", async () => {
    const h = setup({ ignoresExact: true });
    h.put(tenant, 'tenant-value');
    const t = await h.register('p-admin');
    expect(t.body.hmacSecretScope).toEqual({ kind: 'project', projectId: P });
    expect(await h.deliver(t.body.webhookId, 'tenant-value')).toBe(401);
    const refused = h.audited.filter((e) => e.kind === 'secret-resolved');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ outcome: 'failed', projectId: P });
    expect(JSON.stringify(refused[0])).toContain('secret-scope-mismatch');
    expect(JSON.stringify(h.audited)).not.toContain('tenant-value');
  });

  test('a refusal whose audit append fails is still refused, and logged at warn (subsystem audit)', async () => {
    const h = setup({ ignoresExact: true, refusesResolved: true });
    h.put(tenant, 'tenant-value');
    const t = await h.register('p-admin');
    expect(await h.deliver(t.body.webhookId, 'tenant-value')).toBe(401);
    expect(h.logged().filter((r) => r.subsystem === 'audit')).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'secret-resolved audit event failed: the audit store is down',
        kind: 'secret-resolved',
        code: 'persistence-error',
      }),
    ]);
    expect(JSON.stringify(h.logged())).not.toContain('tenant-value');
  });

  test("a store that doesn't report the scope it read: refused even at the right scope, and audited", async () => {
    const h = setup({ omitsScope: true });
    h.put(project, 'p-value');
    const t = await h.register('p-admin');
    expect(t.body.hmacSecretScope).toEqual({ kind: 'project', projectId: P });
    expect(await h.deliver(t.body.webhookId, 'p-value')).toBe(401);
    const refused = h.audited.filter((e) => e.kind === 'secret-resolved');
    expect(refused).toHaveLength(1);
    expect(JSON.stringify(refused[0])).toContain('secret-scope-mismatch');
    expect(JSON.stringify(h.audited)).not.toContain('p-value');
    // A trigger from before scopes were recorded isn't an exact read: as before.
    const legacy = setup({ omitsScope: true, legacy: true });
    legacy.put(tenant, 'tenant-value');
    const old = await legacy.register('p-admin');
    expect(await legacy.deliver(old.body.webhookId, 'tenant-value')).toBe(202);
  });

  test('a secret in another env is not the one the receiver reads', async () => {
    const h = setup();
    h.put(project, 'local-value', 'local');
    const t = await h.register('tenant-admin');
    // Not set in the env this deployment serves: the broadest scope, the tenant.
    expect(t.body.hmacSecretScope).toEqual({ kind: 'tenant' });
  });
});

describe('generateSecret', () => {
  test("a writer gets a new secret in the trigger's project, shown once, and its deliveries verify", async () => {
    const h = setup();
    const made = await h.register('p-writer', { generateSecret: true });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.hmacSecretScope).toEqual({ kind: 'project', projectId: P });
    const secret = made.body.signingSecret as string;
    expect(secret).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(h.stored.get(`project:${P}|${ENV}|${NAME}`)).toBe(secret);
    expect(await h.deliver(made.body.webhookId, secret)).toBe(202);
    const read = await h.call('p-writer', 'GET', `/${made.body.triggerId}`);
    expect(read.body).not.toHaveProperty('signingSecret');
  });

  test('a name the project already has is refused, never overwritten, and no trigger is left', async () => {
    const h = setup();
    h.put(project, 'p-value');
    const refused = await h.register('p-writer', { generateSecret: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('secret-write-conflict');
    expect(h.stored.get(`project:${P}|${ENV}|${NAME}`)).toBe('p-value');
    const listed = await h.call('p-admin', 'GET', '');
    expect(listed.body.data).toEqual([]);
  });

  test("a name the store can't write is its 400, before anything is stored: no trigger, no write, none audited", async () => {
    const h = setup({ writes: /^[A-Z_][A-Z0-9_]*$/ });
    const refused = await h.register('p-writer', { generateSecret: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('secret-name-invalid');
    expect(refused.body.error.message).toBe(`"${NAME}" isn't a name this store writes.`);
    expect(h.registers()).toBe(0);
    expect(h.stored.size).toBe(0);
    expect(h.audited.filter((e) => e.kind === 'secret-set')).toEqual([]);
    const made = await h.register('p-writer', {
      generateSecret: true,
      hmacSecretName: 'ACME_WOO_SECRET',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(h.stored.has(`project:${P}|${ENV}|ACME_WOO_SECRET`)).toBe(true);
  });

  test("naming a secret that's stored never asks: a store reads names it can't write", async () => {
    const h = setup({ writes: /^[A-Z_][A-Z0-9_]*$/ });
    h.put(project, 'p-value');
    const made = await h.register('p-admin');
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(await h.deliver(made.body.webhookId, 'p-value')).toBe(202);
    const renamed = await h.call('p-admin', 'PATCH', `/${made.body.triggerId}`, {
      hmacSecretName: 'acme-woo-orders',
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.hmacSecretName).toBe('acme-woo-orders');
    expect(h.asked).toEqual([]);
  });
});

describe('MCP endpoints and tools record where their secrets are read, the same way', () => {
  /**
   * An app with an MCP registry and a tool registry that keep what they're
   * given, and read it back as the stores do: a tool version with its
   * project and the scopes recorded with it, the latest the last published.
   */
  function items(options: { readonly envName?: boolean } = {}) {
    const stored = new Map<string, string>();
    const secrets = {
      async get(input: { scope: Scope; envName: string; name: string }) {
        return stored.has(keyOf(input.scope, input.envName, input.name))
          ? { name: input.name, currentVersion: 1 }
          : null;
      },
    } as unknown as SecretBinding;
    const endpoints = new Map<string, Record<string, unknown>>();
    const published: Record<string, unknown>[] = [];
    const versions = (toolId: string) =>
      published
        .filter((input) => (input.tool as { id: string }).id === toolId)
        .map(
          (input): Record<string, unknown> => ({
            ...(input.tool as Record<string, unknown>),
            projectId: input.projectId,
            ...(input.secretScopes !== undefined && { secretScopes: input.secretScopes }),
          }),
        );
    const latest = (toolId: string) => versions(toolId).at(-1) ?? null;
    const check = checkBinding();
    const app = createApp({
      ...createStubAppBindings(),
      secretsBinding: secrets,
      projectBinding: {
        getDefault: async () => ({ id: P }),
        get: async (_t: unknown, id: string) => (id === P ? { id: P, orgId: ORG } : undefined),
      } as never,
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      tenantHostAccess: 'local',
      ...(options.envName !== false && { envName: ENV }),
      mcpEndpointRegistry: {
        list: async () => ({ data: [...endpoints.values()] }),
        get: async ({ endpointId }: { endpointId: string }) => endpoints.get(endpointId) ?? null,
        register: async ({ endpoint }: { endpoint: Record<string, unknown> }) => {
          endpoints.set(endpoint.endpointId as string, endpoint);
          return { kind: 'ok', endpointId: endpoint.endpointId };
        },
        unregister: async () => ({ unregistered: false }),
      } as never,
      toolRegistry: {
        publish: async (input: Record<string, unknown>) => {
          published.push(input);
          const tool = input.tool as { id: string; version: string };
          return { kind: 'ok', toolId: tool.id, version: tool.version };
        },
        list: async () => {
          const ids = new Set(published.map((input) => (input.tool as { id: string }).id));
          return { data: [...ids].map(latest) };
        },
        get: async ({ toolId }: { toolId: string }) => latest(toolId),
        getVersion: async ({ toolId, version }: { toolId: string; version: string }) =>
          versions(toolId).find((v) => v.version === version) ?? null,
        listVersions: async ({ toolId }: { toolId: string }) => ({ data: versions(toolId) }),
        headExists: async ({ toolId }: { toolId: string }) => versions(toolId).length > 0,
      } as never,
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: check },
    });
    const post = async (token: string, path: string, body: unknown) => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    // A read, checked against the spec's schema for its answer.
    const get = async (path: string, schema: string) => {
      const res = await app.request(path, {
        headers: { authorization: 'Bearer tenant-admin' },
      });
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(validateAgainst(schema, body), path).toEqual([]);
      return body;
    };
    return { stored, endpoints, published, post, get };
  }

  test("an MCP endpoint in P: P's secret for P's admin; the tenant's never read for them", async () => {
    const h = items();
    h.stored.set(keyOf(tenant, ENV, 'TENANT_TOKEN'), 'x');
    h.stored.set(keyOf(project, ENV, 'P_TOKEN'), 'y');
    const endpoint = (endpointId: string, name: string) => ({
      endpointId,
      name: 'Docs',
      transport: 'streamable-http',
      config: { transport: 'streamable-http', url: 'https://mcp.acme.test/docs' },
      secretRef: { envName: ENV, name },
      scopeKind: 'project',
      scopeId: P,
    });
    expect(
      (await h.post('p-admin', '/v1/mcp/endpoints', endpoint('acme-own', 'P_TOKEN'))).status,
    ).toBe(201);
    expect(h.endpoints.get('acme-own')?.secretScopes).toEqual({
      P_TOKEN: { kind: 'project', projectId: P },
    });
    await h.post('p-admin', '/v1/mcp/endpoints', endpoint('acme-borrows', 'TENANT_TOKEN'));
    expect(h.endpoints.get('acme-borrows')?.secretScopes).toEqual({
      TENANT_TOKEN: { kind: 'project', projectId: P },
    });
    // A caller never sets it.
    const sent = await h.post('p-admin', '/v1/mcp/endpoints', {
      ...endpoint('acme-sets', 'P_TOKEN'),
      secretScopes: { P_TOKEN: { kind: 'tenant' } },
    });
    expect(sent.status).toBe(400);
  });

  test("a stdio MCP endpoint's secretEnv: each variable's secret, recorded as a bearer secret is", async () => {
    const h = items();
    h.stored.set(keyOf(tenant, ENV, 'TENANT_TOKEN'), 'x');
    h.stored.set(keyOf(project, ENV, 'P_TOKEN'), 'y');
    const res = await h.post('p-admin', '/v1/mcp/endpoints', {
      endpointId: 'acme-files',
      name: 'Files',
      transport: 'stdio',
      config: {
        transport: 'stdio',
        command: '/usr/local/bin/files-mcp',
        env: { LOG_LEVEL: 'info' },
      },
      secretEnv: {
        GITHUB_TOKEN: { envName: ENV, name: 'TENANT_TOKEN' },
        FILES_TOKEN: { envName: ENV, name: 'P_TOKEN' },
      },
      scopeKind: 'project',
      scopeId: P,
    });
    expect(res.status).toBe(201);
    expect(h.endpoints.get('acme-files')?.secretScopes).toEqual({
      TENANT_TOKEN: { kind: 'project', projectId: P },
      P_TOKEN: { kind: 'project', projectId: P },
    });
  });

  test("an MCP endpoint's header auth: each header's secret, recorded as a bearer secret is", async () => {
    const h = items();
    h.stored.set(keyOf(tenant, ENV, 'TENANT_KEY'), 'x');
    h.stored.set(keyOf(project, ENV, 'P_SECRET'), 'y');
    const res = await h.post('p-admin', '/v1/mcp/endpoints', {
      endpointId: 'acme-shop',
      name: 'Shop',
      transport: 'streamable-http',
      config: { transport: 'streamable-http', url: 'https://mcp.acme.test/mcp' },
      auth: {
        scheme: 'header',
        headers: [
          { name: 'X-Api-Key', secretRef: { envName: ENV, name: 'TENANT_KEY' } },
          {
            name: 'X-Api-Secret',
            secretRef: { envName: ENV, name: 'P_SECRET' },
            prefix: 'Secret ',
          },
        ],
      },
      scopeKind: 'project',
      scopeId: P,
    });
    expect(res.status).toBe(201);
    expect(h.endpoints.get('acme-shop')?.secretScopes).toEqual({
      TENANT_KEY: { kind: 'project', projectId: P },
      P_SECRET: { kind: 'project', projectId: P },
    });
  });

  test('a declared secret on a deployment that says no env: the broadest scope, without a lookup', async () => {
    const h = items({ envName: false });
    h.stored.set(keyOf(tenant, ENV, 'ACME_DECLARED'), 'x');
    const tool = {
      id: 'acme.declares',
      description: 'Declares a secret.',
      version: '1.0.0',
      input: { type: 'object' },
      output: { type: 'object' },
      projectId: P,
      codeArtifactRef: { kind: 'filesystem', modulePath: './tools/declares.js' },
      needsSpec: { secrets: { ACME_DECLARED: { type: 'string' } } },
    };
    const res = await h.post('p-admin', '/v1/tools', tool);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(h.published[0]?.secretScopes).toEqual({
      ACME_DECLARED: { kind: 'project', projectId: P },
    });
  });

  test("a spec tool in P: its secretRef's scope goes to the registry with the version", async () => {
    const h = items();
    h.stored.set(keyOf(tenant, ENV, 'ACME_API_KEY'), 'x');
    const tool = {
      id: 'acme.lookup',
      description: 'Looks things up.',
      version: '1.0.0',
      input: { type: 'object' },
      output: { type: 'object' },
      projectId: P,
      spec: {
        kind: 'http',
        method: 'GET',
        urlTemplate: 'https://api.acme.example/lookup',
        authorization: { kind: 'bearer', secretRef: { envName: ENV, name: 'ACME_API_KEY' } },
      },
    };
    const asAdmin = await h.post('tenant-admin', '/v1/tools', tool);
    expect(asAdmin.status, JSON.stringify(asAdmin.body)).toBe(201);
    expect(h.published[0]?.secretScopes).toEqual({ ACME_API_KEY: { kind: 'tenant' } });
    await h.post('p-admin', '/v1/tools', { ...tool, version: '1.0.1' });
    expect(h.published[1]?.secretScopes).toEqual({
      ACME_API_KEY: { kind: 'project', projectId: P },
    });
  });

  test("an MCP endpoint's reads answer the scopes recorded for it; one that names no secret, none", async () => {
    const h = items();
    h.stored.set(keyOf(project, ENV, 'P_TOKEN'), 'y');
    const endpoint = (endpointId: string) => ({
      endpointId,
      name: 'Docs',
      transport: 'stdio',
      config: { transport: 'stdio', command: '/usr/local/bin/docs-mcp', args: [] },
      scopeKind: 'project',
      scopeId: P,
    });
    const own = { ...endpoint('acme-own'), secretRef: { envName: ENV, name: 'P_TOKEN' } };
    expect((await h.post('p-admin', '/v1/mcp/endpoints', own)).status).toBe(201);
    expect((await h.post('p-admin', '/v1/mcp/endpoints', endpoint('acme-plain'))).status).toBe(201);
    // The list `kindgi exports create` reads, and the one-endpoint read.
    const listed = (await h.get('/v1/mcp/endpoints', 'MCPEndpointCollectionPage')).data as Record<
      string,
      unknown
    >[];
    const answers = async (endpointId: string) => [
      listed.find((e) => e.endpointId === endpointId),
      await h.get(`/v1/mcp/endpoints/${endpointId}`, 'MCPEndpoint'),
    ];
    for (const answer of await answers('acme-own')) {
      expect(answer?.endpointId).toBe('acme-own');
      expect(answer?.secretScopes).toEqual({ P_TOKEN: { kind: 'project', projectId: P } });
    }
    for (const answer of await answers('acme-plain')) {
      expect(answer?.endpointId).toBe('acme-plain');
      expect(answer).not.toHaveProperty('secretScopes');
    }
  });

  test("a tool version's reads answer the scopes recorded with it, a null kept; a tool that names no secret, none", async () => {
    const h = items();
    h.stored.set(keyOf(tenant, ENV, 'ACME_API_KEY'), 'x');
    const tool = (id: string, version: string) => ({
      id,
      description: 'Looks things up.',
      version,
      input: { type: 'object' },
      output: { type: 'object' },
      projectId: P,
    });
    const lookup = (version: string) => ({
      ...tool('acme.lookup', version),
      spec: {
        kind: 'http',
        method: 'GET',
        urlTemplate: 'https://api.acme.example/lookup',
        authorization: { kind: 'bearer', secretRef: { envName: ENV, name: 'ACME_API_KEY' } },
      },
    });
    const tenantWide = { ACME_API_KEY: { kind: 'tenant' } };
    const none = { ACME_API_KEY: null };
    expect((await h.post('tenant-admin', '/v1/tools', lookup('1.0.0'))).status).toBe(201);
    // A version kept with no scope usable for its secret (`null`), as the store holds it.
    const { projectId: _, ...manifest } = lookup('1.0.1');
    h.published.push({ projectId: P, tool: manifest, secretScopes: none });
    expect((await h.post('tenant-admin', '/v1/tools', tool('acme.plain', '1.0.0'))).status).toBe(
      201,
    );

    // The routes and queries `kindgi exports create` reads, and the one-version reads.
    const listed = (await h.get('/v1/tools?includeRetired=true', 'ToolCollectionPage'))
      .data as Record<string, unknown>[];
    const versions = async (toolId: string) =>
      (
        await h.get(
          `/v1/tools/${toolId}/versions?includeTombstoned=true`,
          'ToolVersionCollectionPage',
        )
      ).data as Record<string, unknown>[];
    expect(listed.find((t) => t.id === 'acme.lookup')?.secretScopes).toEqual(none);
    expect((await h.get('/v1/tools/acme.lookup', 'Tool')).secretScopes).toEqual(none);
    expect((await versions('acme.lookup')).map((v) => [v.version, v.secretScopes])).toEqual([
      ['1.0.0', tenantWide],
      ['1.0.1', none],
    ]);
    expect((await h.get('/v1/tools/acme.lookup/versions/1.0.0', 'Tool')).secretScopes).toEqual(
      tenantWide,
    );
    for (const answer of [
      listed.find((t) => t.id === 'acme.plain'),
      await h.get('/v1/tools/acme.plain', 'Tool'),
      ...(await versions('acme.plain')),
      await h.get('/v1/tools/acme.plain/versions/1.0.0', 'Tool'),
    ]) {
      expect(answer?.id).toBe('acme.plain');
      expect(answer).not.toHaveProperty('secretScopes');
    }

    // A caller never sets it: a register body doesn't carry it, so one sent back as read is refused.
    const sent = await h.post('tenant-admin', '/v1/tools', {
      ...lookup('1.0.2'),
      secretScopes: tenantWide,
    });
    expect(sent.status).toBe(400);
    expect(sent.body.error.code).toBe('validation-failed');
    expect(h.published).toHaveLength(3);
  });
});

describe('a deployment that says no env: recorded without a lookup, never left as before', () => {
  test('a webhook trigger: the broadest scope its registrant administers, or none for a writer', async () => {
    const h = setup({ receiver: false });
    h.put(tenant, 'tenant-value');
    const admin = await h.register('p-admin');
    expect(admin.body.hmacSecretScope).toEqual({ kind: 'project', projectId: P });
    const writer = await h.register('p-writer');
    expect(writer.body.hmacSecretScope).toBeNull();
  });
});
