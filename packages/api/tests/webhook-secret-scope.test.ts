// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a webhook trigger's signing secret is read (`secret-scope.ts`):
 * recorded when it's registered, as its registrant may read the secret,
 * then the only scope the receiver reads. With a store that keeps each
 * scope apart, and three people: the tenant's admin, project P's admin,
 * and a writer in P who administers nothing.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { EnvName, TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, SecretBinding, TokenResolver } from '../src/index.js';
import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

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

function setup(options: { readonly receiver?: boolean } = {}) {
  // The store, each scope apart.
  const stored = new Map<string, string>();
  const put = (scope: Scope, value: string, env: string = ENV) =>
    stored.set(keyOf(scope, env, NAME), value);
  const secrets = {
    async get(input: { scope: Scope; envName: string; name: string }) {
      return stored.has(keyOf(input.scope, input.envName, input.name))
        ? { name: input.name, currentVersion: 1, scope: input.scope }
        : null;
    },
    async set(input: { scope: Scope; envName: string; name: string; value: string }) {
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
    async resolve(input: { scope: Scope; envName: string; name: string }) {
      const value = stored.get(keyOf(input.scope, input.envName, input.name));
      return value === undefined
        ? {
            kind: 'err',
            error: { code: 'secret-not-found', message: 'not found', name: input.name },
          }
        : { kind: 'ok', value: { name: input.name, versionId: 1, value } };
    },
  } as unknown as SecretBinding;
  const registry = createInMemoryTriggerRegistry({ defaultProjectId: P as never });
  const check = checkBinding();
  const appFor = () =>
    createApp({
      ...createStubAppBindings(),
      triggerRegistry: registry,
      secretsBinding: secrets,
      projectBinding: {
        getDefault: async () => ({ id: P }),
        get: async (_t: unknown, id: string) => (id === P ? { id: P, orgId: ORG } : undefined),
      } as never,
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      ...(options.receiver !== false && { webhookReceiver: { envName: ENV } }),
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: check },
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
});

describe('MCP endpoints and tools record where their secrets are read, the same way', () => {
  /** An app with an MCP registry and a tool registry that keep what they're given. */
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
        list: async () => ({ data: [] }),
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
        get: async () => null,
        headExists: async () => false,
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
    return { stored, endpoints, published, post };
  }

  test("an MCP endpoint in P: P's secret for P's admin; the tenant's never read for them", async () => {
    const h = items();
    h.stored.set(keyOf(tenant, ENV, 'TENANT_TOKEN'), 'x');
    h.stored.set(keyOf(project, ENV, 'P_TOKEN'), 'y');
    const endpoint = (endpointId: string, name: string) => ({
      endpointId,
      name: 'Docs',
      transport: 'stdio',
      config: { transport: 'stdio', command: '/usr/local/bin/docs-mcp', args: [] },
      secretRef: { envName: ENV, name },
      scopeKind: 'project',
      scopeId: P,
    });
    expect(
      (await h.post('p-admin', '/v1/mcp/endpoints', endpoint('acme.own', 'P_TOKEN'))).status,
    ).toBe(201);
    expect(h.endpoints.get('acme.own')?.secretScopes).toEqual({
      P_TOKEN: { kind: 'project', projectId: P },
    });
    await h.post('p-admin', '/v1/mcp/endpoints', endpoint('acme.borrows', 'TENANT_TOKEN'));
    expect(h.endpoints.get('acme.borrows')?.secretScopes).toEqual({
      TENANT_TOKEN: { kind: 'project', projectId: P },
    });
    // A caller never sets it.
    const sent = await h.post('p-admin', '/v1/mcp/endpoints', {
      ...endpoint('acme.sets', 'P_TOKEN'),
      secretScopes: { P_TOKEN: { kind: 'tenant' } },
    });
    expect(sent.status).toBe(400);
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
