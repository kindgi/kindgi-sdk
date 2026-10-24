// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `secret-scope.ts`: the scopes a named secret is looked for at, and the
 * one recorded: the first the caller administers that has it, else the
 * fallback when they administer it, else the broadest they administer,
 * else none. Through the routes: webhook-secret-scope.test.ts, and
 * deployments-routes.test.ts for a deploy's fallback.
 */

import { describe, expect, test } from 'vitest';

import type { Scope } from '@kindgi/platform';
import type { EnvName, OrgId, ProjectId, TenantId } from '@kindgi/types';

import { findNamedSecretScope, namedSecretScope, secretScopeChain } from '../src/secret-scope.js';

const tenantId = 't-1' as TenantId;
const projectId = 'p-1' as ProjectId;
const orgId = 'o-1' as OrgId;
const project: Scope = { kind: 'project', tenantId, projectId };
const org: Scope = { kind: 'org', tenantId, orgId };
const tenant: Scope = { kind: 'tenant', tenantId };

const has = (...at: Scope['kind'][]) => ({
  get: async ({ scope }: { scope: Scope }) => (at.includes(scope.kind) ? { name: 'x' } : null),
});
const administers =
  (...at: Scope['kind'][]) =>
  async (scope: Scope) =>
    at.includes(scope.kind);
const ask = (secrets: ReturnType<typeof has>, admin?: ReturnType<typeof administers>) =>
  namedSecretScope({
    secrets: secrets as never,
    chain: secretScopeChain(project, orgId),
    ...(admin !== undefined && { administers: admin }),
    envName: 'test' as EnvName,
    name: 'x',
  });

describe('secretScopeChain', () => {
  test("a project's item: the project, its org, the tenant; an org's: the org, the tenant", () => {
    expect(secretScopeChain(project, orgId)).toEqual([project, org, tenant]);
    expect(secretScopeChain(project, undefined)).toEqual([project, tenant]);
    expect(secretScopeChain(org, undefined)).toEqual([org, tenant]);
    expect(secretScopeChain(tenant, undefined)).toEqual([tenant]);
  });
});

describe('namedSecretScope', () => {
  test('the first scope that has it, of those the caller administers', async () => {
    expect(await ask(has('project', 'tenant'), administers('project', 'org', 'tenant'))).toEqual(
      project,
    );
    expect(await ask(has('org', 'tenant'), administers('project', 'org'))).toEqual(org);
    // Never a scope the caller doesn't administer, though it has the secret.
    expect(await ask(has('tenant'), administers('project', 'org'))).toEqual(org);
  });

  test('none has it: the broadest the caller administers; none administered: null', async () => {
    expect(await ask(has(), administers('project'))).toEqual(project);
    expect(await ask(has(), administers('project', 'org', 'tenant'))).toEqual(tenant);
    expect(await ask(has('project'), administers())).toBeNull();
  });

  test("without authorization, every scope is the caller's", async () => {
    expect(await ask(has('tenant'))).toEqual(tenant);
    expect(await ask(has())).toEqual(tenant);
  });
});

describe('a fallback: what a name set nowhere is recorded at', () => {
  const other: Scope = { kind: 'project', tenantId, projectId: 'p-2' as ProjectId };
  const askWith = (
    secrets: ReturnType<typeof has>,
    fallback: Scope,
    admin?: ReturnType<typeof administers>,
  ) =>
    namedSecretScope({
      secrets: secrets as never,
      chain: secretScopeChain(project, orgId),
      ...(admin !== undefined && { administers: admin }),
      envName: 'test' as EnvName,
      name: 'x',
      fallback,
    });

  test('set nowhere: the fallback, in place of the broadest the caller administers', async () => {
    expect(await askWith(has(), project, administers('project', 'org', 'tenant'))).toEqual(project);
    expect(await askWith(has(), project, administers('project', 'org'))).toEqual(project);
    expect(await askWith(has(), org, administers('project', 'org', 'tenant'))).toEqual(org);
  });

  test("a fallback the caller doesn't administer: the broadest they do, as without one", async () => {
    expect(await askWith(has(), tenant, administers('project', 'org'))).toEqual(org);
    expect(await askWith(has(), project, administers('org', 'tenant'))).toEqual(tenant);
    // An editor who administers no scope still records none.
    expect(await askWith(has(), project, administers())).toBeNull();
  });

  test('a fallback outside the chain is never recorded', async () => {
    expect(await askWith(has(), other)).toEqual(tenant);
    expect(await askWith(has(), other, administers('project'))).toEqual(project);
  });

  test('without authorization, the fallback', async () => {
    expect(await askWith(has(), project)).toEqual(project);
  });

  test('found first is unchanged: a name set at a broader scope is recorded there', async () => {
    expect(await askWith(has('tenant'), project)).toEqual(tenant);
    expect(await askWith(has('org', 'tenant'), project, administers('project', 'org'))).toEqual(
      org,
    );
  });

  test('without the env, nothing is looked up: the fallback, found nowhere', async () => {
    const seen: string[] = [];
    const found = await findNamedSecretScope({
      secrets: {
        get: async ({ scope }: { scope: Scope }) => {
          seen.push(scope.kind);
          return null;
        },
      } as never,
      chain: secretScopeChain(project, orgId),
      envName: undefined,
      name: 'x',
      fallback: project,
    });
    expect(found).toEqual({ scope: project });
    expect(seen).toEqual([]);
  });
});

describe('findNamedSecretScope', () => {
  const seen: string[] = [];
  const stored = (...at: Scope['kind'][]) => ({
    get: async ({ scope }: { scope: Scope }) => {
      seen.push(scope.kind);
      return at.includes(scope.kind) ? { name: 'x', revokedAt: '2026-01-01T00:00:00Z' } : null;
    },
  });
  const find = (
    secrets: ReturnType<typeof stored>,
    admin?: ReturnType<typeof administers>,
    envName: EnvName | 'none' = 'test' as EnvName,
  ) =>
    findNamedSecretScope({
      secrets: secrets as never,
      chain: secretScopeChain(project, orgId),
      ...(admin !== undefined && { administers: admin }),
      envName: envName === 'none' ? undefined : envName,
      name: 'x',
    });

  test('the scope namedSecretScope records, with the secret found there, revoked or not', async () => {
    expect(await find(stored('org', 'tenant'))).toEqual({
      scope: org,
      found: { name: 'x', revokedAt: '2026-01-01T00:00:00Z' },
    });
    // Not where the caller may record it: the broadest they administer, found nowhere.
    expect(await find(stored('tenant'), administers('project', 'org'))).toEqual({ scope: org });
    expect(await find(stored(), administers('project'))).toEqual({ scope: project });
    expect(await find(stored('tenant'), administers())).toBeNull();
  });

  test('without the env, nothing is looked up: the broadest scope, found nowhere', async () => {
    seen.length = 0;
    expect(await find(stored('project'), undefined, 'none')).toEqual({ scope: tenant });
    expect(seen).toEqual([]);
  });
});
