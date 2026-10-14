// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `secret-scope.ts`: the scopes a named secret is looked for at, and the
 * one recorded: the first the caller administers that has it, else the
 * broadest they administer, else none. Through the routes:
 * webhook-secret-scope.test.ts.
 */

import { describe, expect, test } from 'vitest';

import type { Scope } from '@kindgi/platform';
import type { EnvName, OrgId, ProjectId, TenantId } from '@kindgi/types';

import { namedSecretScope, secretScopeChain } from '../src/secret-scope.js';

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
