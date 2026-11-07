// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A person's own test project (`Project.testFor`) reads only the secrets
 * and env values set in it. Its items' secrets are looked for at the
 * project alone (`secretScopeChain`), so the project is what's recorded for
 * them, even for the workspace's admin and even when only the workspace
 * holds the name. A deployment's values and a pack's env there are looked
 * for at the project alone too. A shared project still looks at its org and
 * the workspace.
 */

import { createHmac } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEventBinding } from '@kindgi/audit-events';
import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { EnvName, OrgId, ProjectId, TenantId, UserId } from '@kindgi/types';

import type { Deployment } from '../src/deployment-binding.js';
import { type DeploymentValuesDeps, deploymentValues } from '../src/deployment-values.js';
import { createApp } from '../src/index.js';
import type { RunHandlerBinding, SecretBinding, TokenResolver } from '../src/index.js';
import type { Authorizer } from '../src/middleware/authorize.js';
import { type PackEnvDeps, packEnvCheck } from '../src/pack-env.js';
import { secretScopeChain, secretScopesFor } from '../src/secret-scope.js';
import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';

const TENANT = '00000000-0000-4000-8000-00000000000a' as TenantId;
/** A shared project, in ORG. */
const SHARED = '00000000-0000-4000-8000-0000000000a1' as ProjectId;
/** The workspace admin's own test project, in no org. */
const MINE = '00000000-0000-4000-8000-0000000000a2' as ProjectId;
const ORG = '00000000-0000-4000-8000-0000000000b1' as OrgId;
const ADMIN = 'user-admin' as UserId;
const ENV = 'test' as EnvName;

const tenant: Scope = { kind: 'tenant', tenantId: TENANT };
const org: Scope = { kind: 'org', tenantId: TENANT, orgId: ORG };
const at = (projectId: ProjectId): Scope => ({ kind: 'project', tenantId: TENANT, projectId });

const records: Record<string, { id: ProjectId; orgId?: OrgId; testFor?: UserId }> = {
  [SHARED]: { id: SHARED, orgId: ORG },
  [MINE]: { id: MINE, testFor: ADMIN },
};
const projects = {
  get: async (_t: TenantId, id: ProjectId) => records[id] ?? null,
  getDefault: async () => records[SHARED],
} as never;

function scopeKey(scope: Scope): string {
  if (scope.kind === 'project') return `project:${scope.projectId}`;
  if (scope.kind === 'org') return `org:${scope.orgId}`;
  return 'tenant';
}
const keyOf = (scope: Scope, name: string) => `${scopeKey(scope)}|${name}`;
/** What a store keeps with a value it holds. */
const stamped = (scope: Scope, name: string) => ({
  scope,
  envName: ENV,
  name,
  createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-07T00:00:00.000Z',
});

/** A secret store: each scope apart, a read walking up unless it's `exact`. */
function secretStore() {
  const stored = new Map<string, string>();
  const walk = (scope: Scope): readonly Scope[] =>
    scope.kind === 'project'
      ? [scope, ...(records[scope.projectId]?.orgId !== undefined ? [org] : []), tenant]
      : scope.kind === 'org'
        ? [scope, tenant]
        : [tenant];
  const binding = {
    async get(input: { scope: Scope; envName: string; name: string }) {
      return input.envName === ENV && stored.has(keyOf(input.scope, input.name))
        ? { ...stamped(input.scope, input.name), currentVersion: 1 }
        : null;
    },
    async resolve(input: { scope: Scope; envName: string; name: string; exact?: true }) {
      for (const scope of input.exact === true ? [input.scope] : walk(input.scope)) {
        const value = stored.get(keyOf(scope, input.name));
        if (input.envName === ENV && value !== undefined) {
          return { kind: 'ok', value: { name: input.name, versionId: 1, value, scope } };
        }
      }
      return {
        kind: 'err',
        error: { code: 'secret-not-found', message: 'not found', name: input.name },
      };
    },
  } as unknown as SecretBinding;
  const put = (scope: Scope, name: string, value = 'set') => stored.set(keyOf(scope, name), value);
  return { binding, put };
}

describe('secretScopeChain', () => {
  test("a test project's item: the project alone; a shared project's: its org and the workspace too", () => {
    expect(secretScopeChain(at(MINE), records[MINE])).toEqual([at(MINE)]);
    expect(secretScopeChain(at(MINE), { orgId: ORG, testFor: ADMIN })).toEqual([at(MINE)]);
    expect(secretScopeChain(at(SHARED), records[SHARED])).toEqual([at(SHARED), org, tenant]);
  });
});

describe("what's recorded for the secrets its items name", () => {
  // The record a tool, an MCP endpoint, a webhook trigger, a deploy and a
  // promotion each make when they're registered.
  const recorded = async (projectId: ProjectId, authorizer?: Authorizer) => {
    const secrets = secretStore();
    secrets.put(tenant, 'TENANT_ONLY');
    secrets.put(org, 'ORG_ONLY');
    secrets.put(at(MINE), 'IN_MINE');
    return secretScopesFor(
      {} as never,
      { secrets: secrets.binding, projects, ...(authorizer !== undefined && { authorizer }) },
      at(projectId),
      ['TENANT_ONLY', 'ORG_ONLY', 'IN_MINE', 'NOWHERE'].map((name) => ({ envName: ENV, name })),
    );
  };
  const administersAll = { can: async () => true } as unknown as Authorizer;

  test.each([
    ['the workspace admin', administersAll],
    ['no authorization', undefined],
  ] as const)('%s: every one is the test project, wherever else the name is set', async (_n, a) => {
    const mine = { kind: 'project', projectId: MINE };
    expect(await recorded(MINE, a)).toEqual({
      TENANT_ONLY: mine,
      ORG_ONLY: mine,
      IN_MINE: mine,
      NOWHERE: mine,
    });
  });

  test("in a shared project, the same names are its org's and the workspace's", async () => {
    expect(await recorded(SHARED, administersAll)).toEqual({
      TENANT_ONLY: { kind: 'tenant' },
      ORG_ONLY: { kind: 'org', orgId: ORG },
      IN_MINE: { kind: 'tenant' },
      NOWHERE: { kind: 'tenant' },
    });
  });
});

describe('a webhook trigger in it, through the routes', () => {
  const NAME = 'acmeWooSecret';
  const allow = (): Decision => ({
    allowed: true,
    reason: 'test: granted',
    evidence: { action: 'admin', relation: '', resource: '', actorSubject: '' },
  });
  const authzCheckBinding = {
    check: async (_p: Principal, _a: Action, _r: ResourceRef) => allow(),
    checkBatch: async (_p: Principal, _a: Action, resources: readonly ResourceRef[]) =>
      resources.map(allow),
  } as unknown as AuthzCheckBinding;
  const resolveToken: TokenResolver = async (token) =>
    token === 'admin-token' ? { tenantId: TENANT, userId: ADMIN } : null;
  const auditEvents = {
    append: async () => ({ kind: 'ok', value: undefined }),
  } as unknown as AuditEventBinding;

  function setup() {
    const secrets = secretStore();
    const triggers = createInMemoryTriggerRegistry({ defaultProjectId: SHARED });
    const appFor = () =>
      createApp({
        ...createStubAppBindings(),
        triggerRegistry: triggers,
        secretsBinding: secrets.binding,
        projectBinding: projects,
        resolveToken,
        auditEvents,
        runHandler: {} as RunHandlerBinding,
        webhookReceiver: { envName: ENV },
        authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
      });
    let app = appFor();
    const register = async (projectId: ProjectId) => {
      const res = await app.request('/v1/webhooks', {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          flowId: 'acme.refund-review',
          flowVersion: '1.0.0',
          projectId,
          hmacSecretName: NAME,
          signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-WC-Webhook-Signature' },
        }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
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
      put: (scope: Scope, value: string) => secrets.put(scope, NAME, value),
      register,
      deliver,
      /** A new app over the same stores: nothing kept from before. */
      restart: () => {
        app = appFor();
      },
    };
  }

  test("the workspace's signing secret is never read for it; the one set in it is", async () => {
    const h = setup();
    h.put(tenant, 'workspace-value');
    const made = await h.register(MINE);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.hmacSecretScope).toEqual({ kind: 'project', projectId: MINE });
    expect(await h.deliver(made.body.webhookId, 'workspace-value')).toBe(401);
    h.put(at(MINE), 'own-value');
    h.restart();
    expect(await h.deliver(made.body.webhookId, 'own-value')).toBe(202);
  });

  test('in a shared project, the same registration records the workspace and reads its secret', async () => {
    const h = setup();
    h.put(tenant, 'workspace-value');
    const made = await h.register(SHARED);
    expect(made.body.hmacSecretScope).toEqual({ kind: 'tenant' });
    expect(await h.deliver(made.body.webhookId, 'workspace-value')).toBe(202);
  });
});

describe("a deployment's values and a pack's env there", () => {
  const plain = new Set([keyOf(tenant, 'ACME_REGION'), keyOf(org, 'ACME_REGION')]);
  const env = {
    get: async ({ scope, envName, name }: { scope: Scope; envName: string; name: string }) =>
      envName === ENV && plain.has(keyOf(scope, name))
        ? ({ ...stamped(scope, name), value: 'set', revision: 1 } as never)
        : null,
  };
  const secretsAtTheTop = () => {
    const secrets = secretStore();
    secrets.put(tenant, 'ACME_TOKEN');
    return secrets.binding;
  };

  const valuesIn = (projectId: ProjectId) => {
    const deps: DeploymentValuesDeps = {
      envName: ENV,
      secrets: secretsAtTheTop(),
      projects,
      tools: {
        get: async () => null,
        getVersion: async () =>
          ({
            id: 'acme.search',
            version: '1.0.0',
            needsSpec: {
              secrets: { ACME_TOKEN: { type: 'string' } },
              env: { ACME_REGION: { type: 'string' } },
            },
          }) as never,
      },
      agents: { getVersion: async () => null },
      env,
    };
    const deployment = {
      deploymentId: 'd-1',
      tenantId: TENANT,
      contents: {
        tools: [{ id: 'acme.search', version: '1.0.0' }],
        guardrails: [],
        agents: [],
        flows: [],
      },
    } as unknown as Deployment;
    return deploymentValues(deps, { deployment, carried: [], projectId });
  };

  test("a tool's secret and env value set only for the workspace are missing in it", async () => {
    const neededBy = { type: 'tool', id: 'acme.search', version: '1.0.0' };
    expect(await valuesIn(MINE)).toEqual([
      { name: 'ACME_TOKEN', kind: 'secret', neededBy, problem: 'missing' },
      { name: 'ACME_REGION', kind: 'env', neededBy, problem: 'missing' },
    ]);
    expect(await valuesIn(SHARED)).toEqual([
      { name: 'ACME_TOKEN', kind: 'secret', neededBy, foundAt: 'tenant' },
      { name: 'ACME_REGION', kind: 'env', neededBy, foundAt: 'org' },
    ]);
  });

  test("a pack's declared names set only for the workspace are set nowhere for it", async () => {
    const deps: PackEnvDeps = { env, secrets: secretsAtTheTop() as never, projects };
    const check = (projectId: ProjectId) =>
      packEnvCheck(deps, {
        tenantId: TENANT,
        projectId,
        envName: ENV,
        declaration: { required: ['ACME_REGION', 'ACME_TOKEN'], optional: [] },
        secretOnly: 'set',
      });
    const mine = await check(MINE);
    expect(mine.names.map((n) => [n.name, n.kind, n.missing])).toEqual([
      ['ACME_REGION', null, true],
      ['ACME_TOKEN', null, true],
    ]);
    const shared = await check(SHARED);
    expect(shared.names.map((n) => [n.name, n.kind, n.scope?.kind])).toEqual([
      ['ACME_REGION', 'env', 'org'],
      ['ACME_TOKEN', 'secret', 'tenant'],
    ]);
  });
});
