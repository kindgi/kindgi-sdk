// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { Scope } from '@kindgi/platform';
import type { EnvName, OrgId, ProjectId, TenantId } from '@kindgi/types';

import type { EnvRecord } from '../src/env-binding.js';
import { type PackEnvDeps, packEnvCheck, packEnvValues } from '../src/pack-env.js';
import type { SecretRecord } from '../src/secrets-binding.js';

/**
 * A pack's declared env on a server that runs a pack service per
 * deployment: each name is looked for at the deployment's project, then its
 * org, then the tenant, and only plain values are served. A name set only as
 * a secret, or both ways, is never served.
 */

const tenantId = randomUUID() as TenantId;
const orgId = randomUUID() as OrgId;
const staging = randomUUID() as ProjectId;
const prod = randomUUID() as ProjectId;
const loose = randomUUID() as ProjectId;
const defaultProject = randomUUID() as ProjectId;
const envName = 'prod' as EnvName;

let clock = Date.parse('2026-10-18T03:00:00.000Z');
const tick = () => new Date(clock++).toISOString();

const tenantScope: Scope = { kind: 'tenant', tenantId };
const orgScope: Scope = { kind: 'org', tenantId, orgId };
const projectScope = (projectId: ProjectId): Scope => ({ kind: 'project', tenantId, projectId });

function scopeKey(scope: Scope): string {
  if (scope.kind === 'project') return `project:${scope.projectId}`;
  if (scope.kind === 'org') return `org:${scope.orgId}`;
  return 'tenant';
}

/** The env and secret stores in memory: a removed value's row is gone, and setting it again makes a new one. */
function stores() {
  const env = new Map<string, EnvRecord>();
  const secrets = new Map<string, SecretRecord>();
  const key = (scope: Scope, name: string) => `${scopeKey(scope)}|${name}`;
  const deps: PackEnvDeps = {
    env: {
      async get({ scope, envName: e, name }) {
        return e === envName ? (env.get(key(scope, name)) ?? null) : null;
      },
    },
    secrets: {
      async get({ scope, envName: e, name }) {
        return e === envName ? (secrets.get(key(scope, name)) ?? null) : null;
      },
    },
    projects: {
      async get(_t, projectId) {
        if (projectId === staging || projectId === prod) {
          return { id: projectId, orgId } as never;
        }
        return { id: projectId } as never;
      },
      async getDefault() {
        return { id: defaultProject } as never;
      },
    },
  };
  const setEnv = (scope: Scope, name: string, value: string) => {
    const now = tick();
    const old = env.get(key(scope, name));
    env.set(key(scope, name), {
      scope,
      envName,
      name,
      value,
      revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    });
  };
  const removeEnv = (scope: Scope, name: string) => env.delete(key(scope, name));
  const setSecret = (scope: Scope, name: string, revoked = false) => {
    const now = tick();
    secrets.set(key(scope, name), {
      scope,
      envName,
      name,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      ...(revoked && { revokedAt: now }),
    });
  };
  return { deps, setEnv, removeEnv, setSecret };
}

const declaration = (required: string[], optional: string[] = []) => ({ required, optional });

describe('packEnvCheck: where each declared name is set', () => {
  test("each environment's project reads its own value, over its org's and the tenant's", async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://staging.acme.test');
    s.setEnv(projectScope(prod), 'API_BASE', 'https://acme.test');
    s.setEnv(orgScope, 'API_BASE', 'https://org.acme.test');
    s.setEnv(tenantScope, 'API_BASE', 'https://tenant.acme.test');
    const d = declaration(['API_BASE']);
    const inStaging = await packEnvValues(s.deps, {
      tenantId,
      projectId: staging,
      envName,
      declaration: d,
      deploymentId: 'd-staging',
    });
    const inProd = await packEnvValues(s.deps, {
      tenantId,
      projectId: prod,
      envName,
      declaration: d,
      deploymentId: 'd-prod',
    });
    expect(inStaging.values).toEqual({ API_BASE: 'https://staging.acme.test' });
    expect(inProd.values).toEqual({ API_BASE: 'https://acme.test' });
    expect(inStaging.check.names).toEqual([
      {
        name: 'API_BASE',
        required: true,
        kind: 'env',
        scope: { kind: 'project', id: staging },
        missing: false,
      },
    ]);
    expect(inStaging.check.revision).not.toBe(inProd.check.revision);
  });

  test("a value set at the project's org, or only at the tenant, is found there", async () => {
    const s = stores();
    s.setEnv(orgScope, 'REGION', 'eu');
    s.setEnv(tenantScope, 'LOG_LEVEL', 'info');
    const check = await packEnvCheck(s.deps, {
      tenantId,
      projectId: staging,
      envName,
      declaration: declaration(['REGION'], ['LOG_LEVEL']),
    });
    expect(check.names.map((n) => [n.name, n.scope])).toEqual([
      ['REGION', { kind: 'org', id: orgId }],
      ['LOG_LEVEL', { kind: 'tenant' }],
    ]);
    expect(check.problem).toBeUndefined();
  });

  test("a project in no org skips the org; another org's value is never read", async () => {
    const s = stores();
    s.setEnv(orgScope, 'REGION', 'eu');
    const check = await packEnvCheck(s.deps, {
      tenantId,
      projectId: loose,
      envName,
      declaration: declaration(['REGION']),
    });
    expect(check.names[0]).toMatchObject({ missing: true, problem: 'missing' });
    expect(check.problem).toBe('pack-env-missing');
  });

  test("a tenant-wide deployment reads at the tenant's Default project", async () => {
    const s = stores();
    s.setEnv(projectScope(defaultProject), 'API_BASE', 'https://default.acme.test');
    const read = await packEnvValues(s.deps, {
      tenantId,
      envName,
      declaration: declaration(['API_BASE']),
      deploymentId: 'd-tenant-wide',
    });
    expect(read.values).toEqual({ API_BASE: 'https://default.acme.test' });
  });

  test('a value in another env is never read', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://staging.acme.test');
    const check = await packEnvCheck(s.deps, {
      tenantId,
      projectId: staging,
      envName: 'dev' as EnvName,
      declaration: declaration(['API_BASE']),
    });
    expect(check.problem).toBe('pack-env-missing');
  });

  test('an optional name set nowhere is listed, missing, and no problem', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://staging.acme.test');
    const read = await packEnvValues(s.deps, {
      tenantId,
      projectId: staging,
      envName,
      declaration: declaration(['API_BASE'], ['LOG_LEVEL']),
      deploymentId: 'd',
    });
    expect(read.check.names[1]).toEqual({
      name: 'LOG_LEVEL',
      required: false,
      kind: null,
      scope: null,
      missing: true,
    });
    expect(read.check.problem).toBeUndefined();
    expect(read.values).toEqual({ API_BASE: 'https://staging.acme.test' });
  });

  test('a name set only as a secret is secret-not-yet, and nothing is served', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://staging.acme.test');
    s.setSecret(projectScope(staging), 'ACME_API_KEY');
    const read = await packEnvValues(s.deps, {
      tenantId,
      projectId: staging,
      envName,
      declaration: declaration(['API_BASE'], ['ACME_API_KEY']),
      deploymentId: 'd',
    });
    expect(read.check.problem).toBe('pack-env-secret-not-yet');
    expect(read.check.names[1]).toEqual({
      name: 'ACME_API_KEY',
      required: false,
      kind: 'secret',
      scope: { kind: 'project', id: staging },
      missing: false,
      problem: 'secret-not-yet',
    });
    expect(read.values).toBeUndefined();
  });

  test('a revoked secret is not set', async () => {
    const s = stores();
    s.setSecret(tenantScope, 'ACME_API_KEY', true);
    s.setEnv(tenantScope, 'ACME_API_KEY', 'not-a-secret-here');
    const check = await packEnvCheck(s.deps, {
      tenantId,
      projectId: staging,
      envName,
      declaration: declaration(['ACME_API_KEY']),
    });
    expect(check.problem).toBeUndefined();
  });

  test('a name set both ways is ambiguous, names both scopes, and comes first', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'DB_URL', 'postgres://db.acme.test/app');
    s.setSecret(tenantScope, 'DB_URL');
    s.setSecret(projectScope(staging), 'ACME_API_KEY');
    const read = await packEnvValues(s.deps, {
      tenantId,
      projectId: staging,
      envName,
      declaration: declaration(['DB_URL', 'MISSING_ONE'], ['ACME_API_KEY']),
      deploymentId: 'd',
    });
    expect(read.check.problem).toBe('pack-env-ambiguous');
    expect(read.check.names[0]).toEqual({
      name: 'DB_URL',
      required: true,
      kind: 'env',
      scope: { kind: 'project', id: staging },
      missing: false,
      problem: 'ambiguous',
      secretScope: { kind: 'tenant' },
    });
    expect(read.values).toBeUndefined();
  });
});

describe('the revision', () => {
  const input = {
    tenantId,
    projectId: staging,
    envName,
    declaration: declaration(['API_BASE'], ['LOG_LEVEL']),
  };

  test('changes on a write, and not on a name the pack does not declare', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://a.acme.test');
    const first = (await packEnvCheck(s.deps, input)).revision;
    s.setEnv(projectScope(staging), 'UNDECLARED', 'x');
    expect((await packEnvCheck(s.deps, input)).revision).toBe(first);
    s.setEnv(projectScope(staging), 'API_BASE', 'https://b.acme.test');
    expect((await packEnvCheck(s.deps, input)).revision).not.toBe(first);
  });

  test('a value removed and set again is a new revision, though its row starts again at 1', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://a.acme.test');
    const applied = (await packEnvCheck(s.deps, input)).revision;
    s.removeEnv(projectScope(staging), 'API_BASE');
    const removed = await packEnvCheck(s.deps, input);
    expect(removed.problem).toBe('pack-env-missing');
    s.setEnv(projectScope(staging), 'API_BASE', 'https://b.acme.test');
    const again = (await packEnvCheck(s.deps, input)).revision;
    expect(again).not.toBe(applied);
    expect(again).not.toBe(removed.revision);
  });

  test('an optional value removed changes it, with no problem', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://a.acme.test');
    s.setEnv(projectScope(staging), 'LOG_LEVEL', 'debug');
    const before = await packEnvCheck(s.deps, input);
    s.removeEnv(projectScope(staging), 'LOG_LEVEL');
    const after = await packEnvCheck(s.deps, input);
    expect(after.revision).not.toBe(before.revision);
    expect(after.problem).toBeUndefined();
  });

  test('a value set at a narrower scope than the one served changes it', async () => {
    const s = stores();
    s.setEnv(tenantScope, 'API_BASE', 'https://tenant.acme.test');
    const before = (await packEnvCheck(s.deps, input)).revision;
    s.setEnv(projectScope(staging), 'API_BASE', 'https://staging.acme.test');
    expect((await packEnvCheck(s.deps, input)).revision).not.toBe(before);
  });

  test('never carries a value', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://value-in-the-revision.acme.test');
    const check = await packEnvCheck(s.deps, input);
    expect(JSON.stringify(check)).not.toContain('value-in-the-revision');
    expect(check.revision).toMatch(/^pe1-[0-9a-f]{64}$/);
  });
});

describe('packEnvValues: the audit', () => {
  function audit() {
    const events: AuditEvent[] = [];
    const binding = {
      async append(batch: readonly AuditEvent[]) {
        events.push(...batch);
      },
    } as unknown as AuditEventBinding;
    return { events, binding };
  }

  test('each value served is audited as the deployment system read, without its value', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://audited.acme.test');
    const a = audit();
    await packEnvValues(s.deps, {
      tenantId,
      projectId: staging,
      envName,
      declaration: declaration(['API_BASE']),
      deploymentId: 'd-audited',
      auditEvents: a.binding,
    });
    expect(a.events).toHaveLength(1);
    expect(a.events[0]).toMatchObject({
      kind: 'env-resolved',
      actor: 'system:d-audited',
      projectId: staging,
    });
    expect(JSON.stringify(a.events)).not.toContain('audited.acme.test');
  });

  test('nothing is served, so nothing is audited, while there is a problem', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://a.acme.test');
    const a = audit();
    const read = await packEnvValues(s.deps, {
      tenantId,
      projectId: staging,
      envName,
      declaration: declaration(['API_BASE', 'REQUIRED_TOO']),
      deploymentId: 'd',
      auditEvents: a.binding,
    });
    expect(read.values).toBeUndefined();
    expect(a.events).toHaveLength(0);
  });
});
