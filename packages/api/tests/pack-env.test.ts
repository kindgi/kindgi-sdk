// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { Scope } from '@kindgi/platform';
import type { EnvName, OrgId, ProjectId, TenantId } from '@kindgi/types';

import type { EnvCloudSecretRecord, EnvRecord } from '../src/env-binding.js';
import {
  type PackEnvDeps,
  type PackEnvValuesInput,
  packEnvCheck,
  packEnvValues,
} from '../src/pack-env.js';
import type { SecretError, SecretRecord, SecretResolveInput } from '../src/secrets-binding.js';

/**
 * A pack's declared env on a server that runs a pack service per
 * deployment: each name is looked for at the deployment's project, then its
 * org, then the tenant. Plain values are served; a name set only as a
 * secret is given only when the orchestrator asks for secret values, and a
 * name set both ways is never served.
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

/**
 * The env and secret stores in memory: a removed value's row is gone, and
 * setting it again makes a new one, with a new row id unless `rowIds` is off.
 * A secret's value is read at its current version and scope only; `faults`
 * makes a name's read fail with a code, `answerFrom` makes the store say it
 * read another scope, and `beforeResolve` runs before each read.
 */
function stores({ rowIds = true, now = tick }: { rowIds?: boolean; now?: () => string } = {}) {
  const env = new Map<string, EnvRecord>();
  const cloud = new Map<string, EnvCloudSecretRecord>();
  const secrets = new Map<string, SecretRecord>();
  const secretValues = new Map<string, string>();
  const faults = new Map<string, SecretError['code']>();
  const answerFrom = new Map<string, Scope | undefined>();
  const resolved: SecretResolveInput[] = [];
  const hooks: { beforeResolve?: (name: string) => void } = {};
  const key = (scope: Scope, name: string) => `${scopeKey(scope)}|${name}`;
  const refused = (code: SecretError['code'], name: string) => ({
    kind: 'err' as const,
    error: { code, message: `the store's own words about ${name}`, name } as SecretError,
  });
  const deps: PackEnvDeps = {
    env: {
      async get({ scope, envName: e, name }) {
        return e === envName ? (env.get(key(scope, name)) ?? null) : null;
      },
    },
    cloudSecrets: {
      async get({ scope, envName: e, name }) {
        return e === envName ? (cloud.get(key(scope, name)) ?? null) : null;
      },
    },
    secrets: {
      async get({ scope, envName: e, name }) {
        return e === envName ? (secrets.get(key(scope, name)) ?? null) : null;
      },
      async resolve(input) {
        resolved.push(input);
        hooks.beforeResolve?.(input.name);
        const fault = faults.get(input.name);
        if (fault !== undefined) return refused(fault, input.name);
        const record = secrets.get(key(input.scope, input.name));
        if (input.envName !== envName || input.exact !== true || record === undefined) {
          return refused('secret-not-found', input.name);
        }
        if (record.revokedAt !== undefined) return refused('secret-revoked', input.name);
        if (input.version !== record.currentVersion) {
          return refused('secret-version-not-found', input.name);
        }
        const at = answerFrom.has(input.name) ? answerFrom.get(input.name) : record.scope;
        return {
          kind: 'ok',
          value: {
            name: input.name,
            versionId: record.currentVersion,
            value: secretValues.get(key(input.scope, input.name)) ?? '',
            ...(at !== undefined && { scope: at }),
          },
        };
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
  const rowId = (old: { readonly recordId?: string } | undefined) =>
    rowIds ? { recordId: old?.recordId ?? randomUUID() } : {};
  const setEnv = (scope: Scope, name: string, value: string) => {
    const at = now();
    const old = env.get(key(scope, name));
    env.set(key(scope, name), {
      scope,
      envName,
      name,
      value,
      revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? at,
      updatedAt: at,
      ...rowId(old),
    });
  };
  const removeEnv = (scope: Scope, name: string) => env.delete(key(scope, name));
  const setCloud = (scope: Scope, name: string, cloudSecret: string) => {
    const at = now();
    const old = cloud.get(key(scope, name));
    cloud.set(key(scope, name), {
      scope,
      envName,
      name,
      cloudSecret,
      revision: (old?.revision ?? 0) + 1,
      createdAt: old?.createdAt ?? at,
      updatedAt: at,
      ...rowId(old),
    });
  };
  const removeCloud = (scope: Scope, name: string) => cloud.delete(key(scope, name));
  const setSecret = (scope: Scope, name: string, revoked = false, value = `sk-${name}`) => {
    const at = now();
    secrets.set(key(scope, name), {
      scope,
      envName,
      name,
      currentVersion: 1,
      createdAt: at,
      updatedAt: at,
      ...(revoked && { revokedAt: at }),
      ...rowId(undefined),
    });
    secretValues.set(key(scope, name), value);
  };
  /** A new version of a set secret: the same row. */
  const rotateSecret = (scope: Scope, name: string, value: string) => {
    const old = secrets.get(key(scope, name));
    if (old === undefined) throw new Error(`no secret ${name} to rotate`);
    secrets.set(key(scope, name), {
      ...old,
      currentVersion: old.currentVersion + 1,
      updatedAt: now(),
    });
    secretValues.set(key(scope, name), value);
  };
  const removeSecret = (scope: Scope, name: string) => secrets.delete(key(scope, name));
  return {
    deps,
    setEnv,
    removeEnv,
    setCloud,
    removeCloud,
    setSecret,
    rotateSecret,
    removeSecret,
    faults,
    answerFrom,
    resolved,
    hooks,
  };
}

/** The orchestrator's read, when it gives values or says why not. */
async function served(deps: PackEnvDeps, input: PackEnvValuesInput) {
  const read = await packEnvValues(deps, input);
  if (read.kind !== 'ok') throw new Error(`expected an answer, got ${read.kind}`);
  return read;
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
    const inStaging = await served(s.deps, {
      tenantId,
      projectId: staging,
      envName,
      declaration: d,
      deploymentId: 'd-staging',
    });
    const inProd = await served(s.deps, {
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

  test("a tenant-wide deployment reads at the tenant's default project", async () => {
    const s = stores();
    s.setEnv(projectScope(defaultProject), 'API_BASE', 'https://default.acme.test');
    const read = await served(s.deps, {
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
    const read = await served(s.deps, {
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
    const read = await served(s.deps, {
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
    const read = await served(s.deps, {
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

  test('with a store that has no row id, a value removed and set again is a new revision by its update time', async () => {
    const s = stores({ rowIds: false });
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

  test('a value removed and set again in the same millisecond, the same value, is a new revision: its row id is new', async () => {
    const s = stores({ now: () => '2026-10-18T03:00:00.000Z' });
    s.setEnv(projectScope(staging), 'API_BASE', 'https://a.acme.test');
    const applied = (await packEnvCheck(s.deps, input)).revision;
    s.removeEnv(projectScope(staging), 'API_BASE');
    s.setEnv(projectScope(staging), 'API_BASE', 'https://a.acme.test');
    expect((await packEnvCheck(s.deps, input)).revision).not.toBe(applied);
  });

  test('a secret removed and created again in the same millisecond is a new revision: its row id is new', async () => {
    const s = stores({ now: () => '2026-10-18T03:00:00.000Z' });
    s.setSecret(projectScope(staging), 'API_BASE');
    const before = (await packEnvCheck(s.deps, input)).revision;
    s.removeSecret(projectScope(staging), 'API_BASE');
    s.setSecret(projectScope(staging), 'API_BASE');
    expect((await packEnvCheck(s.deps, input)).revision).not.toBe(before);
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

  test('a secret set under a served name changes it, and so does revoking it', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://a.acme.test');
    const served = await packEnvCheck(s.deps, input);
    s.setSecret(tenantScope, 'API_BASE');
    const ambiguous = await packEnvCheck(s.deps, input);
    expect(ambiguous.problem).toBe('pack-env-ambiguous');
    expect(ambiguous.revision).not.toBe(served.revision);
    s.setSecret(tenantScope, 'API_BASE', true);
    const revoked = await packEnvCheck(s.deps, input);
    expect(revoked.problem).toBeUndefined();
    expect(revoked.revision).toBe(served.revision);
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
        return { kind: 'ok', value: undefined };
      },
    } as unknown as AuditEventBinding;
    return { events, binding };
  }

  test('each value served is audited as the deployment system read, without its value', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://audited.acme.test');
    const a = audit();
    await served(s.deps, {
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
    const read = await served(s.deps, {
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

describe('packEnvValues with secret values', () => {
  function audit({ fail }: { fail?: 'refused' | 'throws' } = {}) {
    const batches: AuditEvent[][] = [];
    const binding = {
      async append(batch: readonly AuditEvent[]) {
        if (fail === 'throws') throw new Error('the audit store is out');
        if (fail === 'refused') {
          return { kind: 'err', error: { code: 'persistence-error', message: 'refused' } };
        }
        batches.push([...batch]);
        return { kind: 'ok', value: undefined };
      },
    } as unknown as AuditEventBinding;
    const secretRows = () => batches.flat().filter((e) => e.kind === 'secret-resolved');
    return { batches, binding, secretRows };
  }

  function logger() {
    const warned: { message: string; fields: Record<string, unknown> }[] = [];
    const log = {
      warn: (message: string, fields: Record<string, unknown>) => warned.push({ message, fields }),
    } as never;
    return { warned, log };
  }

  const asked = (
    auditEvents: AuditEventBinding | undefined,
    d = declaration(['ACME_API_KEY', 'API_BASE'], ['SHOP_TOKEN']),
  ): PackEnvValuesInput => ({
    tenantId,
    projectId: staging,
    envName,
    declaration: d,
    deploymentId: 'd-secrets',
    ...(auditEvents !== undefined && { auditEvents }),
    secrets: { requestId: 'req-pack-env-1', systemKeyId: 'key-pack-env-1' },
  });

  test('a name set only as a secret is given with its revision, each audited in one append', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://staging.acme.test');
    s.setSecret(orgScope, 'ACME_API_KEY', false, 'sk-acme-given-value');
    s.setSecret(tenantScope, 'SHOP_TOKEN', false, 'sk-shop-given-value');
    const a = audit();
    const read = await served(s.deps, asked(a.binding));
    expect(read.check.problem).toBeUndefined();
    expect(read.values).toEqual({ API_BASE: 'https://staging.acme.test' });
    expect(Object.keys(read.secrets ?? {})).toEqual(['ACME_API_KEY', 'SHOP_TOKEN']);
    expect(read.secrets?.ACME_API_KEY?.value).toBe('sk-acme-given-value');
    expect(read.secrets?.SHOP_TOKEN?.value).toBe('sk-shop-given-value');
    expect(read.secrets?.ACME_API_KEY?.revision).toMatch(/^ps1-[0-9a-f]{64}$/);
    expect(read.secrets?.SHOP_TOKEN?.revision).not.toBe(read.secrets?.ACME_API_KEY?.revision);
    expect(read.check.names[0]).toEqual({
      name: 'ACME_API_KEY',
      required: true,
      kind: 'secret',
      scope: { kind: 'org', id: orgId },
      missing: false,
    });
    // Read where it was found, at the version found, as the pack env read.
    expect(s.resolved.map((r) => [r.name, scopeKey(r.scope), r.version, r.exact])).toEqual([
      ['ACME_API_KEY', `org:${orgId}`, 1, true],
      ['SHOP_TOKEN', 'tenant', 1, true],
    ]);
    expect(s.resolved[0]?.resolveContext).toEqual({
      caller: 'pack-env',
      deploymentId: 'd-secrets',
    });
    // Both secrets' rows in one append; the plain value's row is its own.
    const withSecrets = a.batches.filter((b) => b.some((e) => e.kind === 'secret-resolved'));
    expect(withSecrets).toHaveLength(1);
    expect(withSecrets[0]).toHaveLength(2);
    // Each row names who took it: the request, and the system key by its id.
    for (const row of a.secretRows()) {
      expect(row).toMatchObject({
        correlationId: 'req-pack-env-1',
        payload: { doc: { systemKeyId: 'key-pack-env-1' } },
      });
    }
    expect(a.secretRows()[0]).toMatchObject({
      kind: 'secret-resolved',
      outcome: 'succeeded',
      actor: 'system:d-secrets',
      tenantId,
      projectId: staging,
      payload: {
        doc: {
          name: 'ACME_API_KEY',
          envName,
          caller: 'pack-env',
          scope: { kind: 'org', orgId },
          recordVersion: 1,
          revision: read.secrets?.ACME_API_KEY?.revision,
          deploymentId: 'd-secrets',
        },
      },
    });
    expect(a.batches.flat().filter((e) => e.kind === 'env-resolved')).toHaveLength(1);
    expect(JSON.stringify(a.batches)).not.toContain('given-value');
    expect(JSON.stringify(read.check)).not.toContain('given-value');
  });

  test("a deployment that names no project: each secret's row is the default project's, the one its names were read for", async () => {
    const s = stores();
    s.setSecret(projectScope(defaultProject), 'ACME_API_KEY', false, 'sk-default-given-value');
    s.setSecret(tenantScope, 'SHOP_TOKEN', false, 'sk-shop-given-value');
    const a = audit();
    const { projectId: _named, ...tenantWide } = asked(
      a.binding,
      declaration(['ACME_API_KEY'], ['SHOP_TOKEN']),
    );
    const read = await served(s.deps, tenantWide);
    expect(Object.keys(read.secrets ?? {})).toEqual(['ACME_API_KEY', 'SHOP_TOKEN']);
    expect(s.resolved.map((r) => [r.name, scopeKey(r.scope)])).toEqual([
      ['ACME_API_KEY', `project:${defaultProject}`],
      ['SHOP_TOKEN', 'tenant'],
    ]);
    // The tenant's one too: the row is the project the read was for.
    expect(a.secretRows()).toMatchObject([
      { projectId: defaultProject, payload: { doc: { name: 'ACME_API_KEY' } } },
      { projectId: defaultProject, payload: { doc: { name: 'SHOP_TOKEN' } } },
    ]);
  });

  test('a tenant with no default project: its secret rows name no project', async () => {
    const s = stores();
    s.setSecret(tenantScope, 'ACME_API_KEY', false, 'sk-acme-given-value');
    const deps: PackEnvDeps = {
      ...s.deps,
      projects: { get: async () => undefined, getDefault: async () => undefined },
    };
    const a = audit();
    const { projectId: _named, ...tenantWide } = asked(a.binding, declaration(['ACME_API_KEY']));
    const read = await served(deps, tenantWide);
    expect(read.secrets?.ACME_API_KEY?.value).toBe('sk-acme-given-value');
    expect(a.secretRows()).toHaveLength(1);
    expect(a.secretRows()[0]).not.toHaveProperty('projectId');
  });

  test('none is read without the ask: such a name is secret-not-yet', async () => {
    const s = stores();
    s.setSecret(projectScope(staging), 'ACME_API_KEY');
    const a = audit();
    const { secrets: _asked, ...notAsked } = asked(a.binding);
    const read = await served(s.deps, notAsked);
    expect(read.check.problem).toBe('pack-env-secret-not-yet');
    expect(read.secrets).toBeUndefined();
    expect(s.resolved).toHaveLength(0);
    expect(a.secretRows()).toHaveLength(0);
  });

  test('with nowhere to audit them, none is read', async () => {
    const s = stores();
    s.setSecret(projectScope(staging), 'ACME_API_KEY');
    const read = await packEnvValues(s.deps, asked(undefined));
    expect(read).toEqual({ kind: 'unaudited' });
    expect(s.resolved).toHaveLength(0);
  });

  test('with no secret-only name, secrets is empty and no secret row is written', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://staging.acme.test');
    const a = audit();
    const read = await served(s.deps, asked(a.binding, declaration(['API_BASE'])));
    expect(read.secrets).toEqual({});
    expect(read.values).toEqual({ API_BASE: 'https://staging.acme.test' });
    expect(a.secretRows()).toHaveLength(0);
  });

  test('only declared names are read', async () => {
    const s = stores();
    s.setSecret(projectScope(staging), 'ACME_API_KEY');
    s.setSecret(projectScope(staging), 'NOT_DECLARED');
    const a = audit();
    const read = await served(s.deps, asked(a.binding, declaration(['ACME_API_KEY'])));
    expect(Object.keys(read.secrets ?? {})).toEqual(['ACME_API_KEY']);
    expect(s.resolved.map((r) => r.name)).toEqual(['ACME_API_KEY']);
  });

  test.each([
    ['ambiguous', 'pack-env-ambiguous'],
    ['missing', 'pack-env-missing'],
  ] as const)('a name that is %s: no secret is read, and no row is written', async (why, code) => {
    const s = stores();
    s.setSecret(projectScope(staging), 'ACME_API_KEY');
    if (why === 'ambiguous') {
      s.setEnv(projectScope(staging), 'API_BASE', 'https://staging.acme.test');
      s.setSecret(tenantScope, 'API_BASE');
    }
    const a = audit();
    const read = await served(s.deps, asked(a.binding));
    expect(read.check.problem).toBe(code);
    expect(read.values).toBeUndefined();
    expect(read.secrets).toBeUndefined();
    expect(s.resolved).toHaveLength(0);
    expect(a.batches).toHaveLength(0);
  });

  test('its revision is never made from the value', async () => {
    const at = '2026-10-18T03:30:00.000Z';
    const first = stores({ rowIds: false, now: () => at });
    const second = stores({ rowIds: false, now: () => at });
    first.setSecret(projectScope(staging), 'ACME_API_KEY', false, 'sk-one');
    second.setSecret(projectScope(staging), 'ACME_API_KEY', false, 'sk-two');
    const d = declaration(['ACME_API_KEY']);
    const one = await served(first.deps, asked(audit().binding, d));
    const two = await served(second.deps, asked(audit().binding, d));
    expect(one.secrets?.ACME_API_KEY?.value).toBe('sk-one');
    expect(two.secrets?.ACME_API_KEY?.value).toBe('sk-two');
    expect(two.secrets?.ACME_API_KEY?.revision).toBe(one.secrets?.ACME_API_KEY?.revision);
    expect(two.check.revision).toBe(one.check.revision);
  });

  test('its revision and the deployment revision both move: a new version, the org taking over, a delete and create', async () => {
    const s = stores();
    s.setSecret(orgScope, 'ACME_API_KEY', false, 'sk-org');
    s.setSecret(projectScope(staging), 'ACME_API_KEY', false, 'sk-project');
    const d = declaration(['ACME_API_KEY']);
    const read = async () => {
      const got = await served(s.deps, asked(audit().binding, d));
      // What the list compares: the check's revision, read without a value.
      expect((await packEnvCheck(s.deps, asked(undefined, d))).revision).toBe(got.check.revision);
      return { deployment: got.check.revision, given: got.secrets?.ACME_API_KEY };
    };
    const set = await read();
    expect(set.given?.value).toBe('sk-project');
    const again = await read();
    expect(again).toEqual(set);
    s.rotateSecret(projectScope(staging), 'ACME_API_KEY', 'sk-project-2');
    const rotated = await read();
    expect(rotated.given?.value).toBe('sk-project-2');
    s.setSecret(projectScope(staging), 'ACME_API_KEY', true);
    const orgs = await read();
    expect(orgs.given?.value).toBe('sk-org');
    s.removeSecret(orgScope, 'ACME_API_KEY');
    s.setSecret(orgScope, 'ACME_API_KEY', false, 'sk-org');
    const recreated = await read();
    expect(recreated.given?.value).toBe('sk-org');
    const steps = [set, rotated, orgs, recreated];
    expect(new Set(steps.map((x) => x.deployment)).size).toBe(4);
    expect(new Set(steps.map((x) => x.given?.revision)).size).toBe(4);
  });

  test("a secret that changes while it's read is read once more, from the start", async () => {
    const s = stores();
    s.setSecret(projectScope(staging), 'ACME_API_KEY', false, 'sk-before');
    let rotations = 0;
    s.hooks.beforeResolve = () => {
      if (rotations++ === 0) s.rotateSecret(projectScope(staging), 'ACME_API_KEY', 'sk-after');
    };
    const a = audit();
    const read = await served(s.deps, asked(a.binding, declaration(['ACME_API_KEY'])));
    expect(read.secrets?.ACME_API_KEY?.value).toBe('sk-after');
    expect(s.resolved.map((r) => r.version)).toEqual([1, 2]);
    const now = await packEnvCheck(s.deps, asked(undefined, declaration(['ACME_API_KEY'])));
    expect(now.revision).toBe(read.check.revision);
    expect(a.secretRows()).toHaveLength(1);
    expect(a.secretRows()[0]?.payload).toMatchObject({ doc: { recordVersion: 2 } });
  });

  test('a secret that changes on both reads: nothing is given, and no row is written', async () => {
    const s = stores();
    s.setSecret(projectScope(staging), 'ACME_API_KEY');
    let n = 0;
    s.hooks.beforeResolve = () =>
      s.rotateSecret(projectScope(staging), 'ACME_API_KEY', `sk-${n++}`);
    const a = audit();
    const read = await packEnvValues(s.deps, asked(a.binding, declaration(['ACME_API_KEY'])));
    expect(read).toEqual({ kind: 'unavailable', cause: 'changed' });
    expect(s.resolved).toHaveLength(2);
    expect(a.batches).toHaveLength(0);
  });

  test.each([
    ['secret-store-error'],
    ['secret-provider-unavailable'],
    ['secret-provider-rate-limited'],
  ] as const)('%s: the store is out, and nothing is given', async (code) => {
    const s = stores();
    s.setSecret(projectScope(staging), 'ACME_API_KEY');
    s.setSecret(projectScope(staging), 'SHOP_TOKEN');
    s.faults.set('ACME_API_KEY', code);
    const a = audit();
    const read = await packEnvValues(
      s.deps,
      asked(a.binding, declaration(['ACME_API_KEY', 'SHOP_TOKEN'])),
    );
    expect(read).toEqual({ kind: 'unavailable', cause: 'store' });
    expect(a.batches).toHaveLength(0);
  });

  test.each([['secret-revoked'], ['secret-not-found'], ['secret-version-not-found']] as const)(
    '%s at the version found, twice: a race, and nothing is given',
    async (code) => {
      const s = stores();
      s.setSecret(projectScope(staging), 'ACME_API_KEY');
      s.faults.set('ACME_API_KEY', code);
      const a = audit();
      const read = await packEnvValues(s.deps, asked(a.binding, declaration(['ACME_API_KEY'])));
      expect(read).toEqual({ kind: 'unavailable', cause: 'changed' });
      expect(s.resolved).toHaveLength(2);
      expect(a.batches).toHaveLength(0);
    },
  );

  test.each([
    ['secret-decryption-failed'],
    ['secret-provider-unauthorized'],
    ['secret-encryption-failed'],
  ] as const)(
    "%s: it's unreadable, no value is given, and the store's words aren't passed on",
    async (code) => {
      const s = stores();
      s.setEnv(projectScope(staging), 'API_BASE', 'https://staging.acme.test');
      s.setSecret(projectScope(staging), 'ACME_API_KEY');
      s.setSecret(projectScope(staging), 'SHOP_TOKEN', false, 'sk-readable-value');
      s.faults.set('ACME_API_KEY', code);
      const a = audit();
      const l = logger();
      const read = await served(s.deps, { ...asked(a.binding), log: l.log });
      expect(read.check.problem).toBe('pack-env-secret-unreadable');
      expect(read.check.names.find((n) => n.name === 'ACME_API_KEY')?.problem).toBe('unreadable');
      expect(read.check.names.find((n) => n.name === 'SHOP_TOKEN')?.problem).toBeUndefined();
      expect(read.values).toBeUndefined();
      expect(read.secrets).toBeUndefined();
      expect(a.batches).toHaveLength(0);
      expect(l.warned).toHaveLength(1);
      expect(l.warned[0]?.fields).toEqual({
        event: 'pack-env-secret-unreadable',
        deploymentId: 'd-secrets',
        name: 'ACME_API_KEY',
        code,
      });
      expect(JSON.stringify([read, l.warned])).not.toContain("the store's own words");
      expect(JSON.stringify([read, l.warned])).not.toContain('sk-readable-value');
    },
  );

  test.each([
    ['another scope', tenantScope],
    ['no scope', undefined],
  ] as const)('a store that says it read %s: unreadable', async (_why, at) => {
    const s = stores();
    s.setSecret(projectScope(staging), 'ACME_API_KEY');
    s.answerFrom.set('ACME_API_KEY', at);
    const a = audit();
    const read = await served(s.deps, asked(a.binding, declaration(['ACME_API_KEY'])));
    expect(read.check.problem).toBe('pack-env-secret-unreadable');
    expect(read.secrets).toBeUndefined();
    expect(a.batches).toHaveLength(0);
  });

  test('unreadable comes up only when nothing else stands in the way', async () => {
    const s = stores();
    s.setSecret(projectScope(staging), 'ACME_API_KEY');
    s.faults.set('ACME_API_KEY', 'secret-decryption-failed');
    const read = await served(
      s.deps,
      asked(audit().binding, declaration(['ACME_API_KEY', 'REQUIRED_TOO'])),
    );
    expect(read.check.problem).toBe('pack-env-missing');
    expect(s.resolved).toHaveLength(0);
  });

  test.each([['refused'], ['throws']] as const)(
    'rows that can not be written (%s): no value is given',
    async (fail) => {
      const s = stores();
      s.setEnv(projectScope(staging), 'API_BASE', 'https://staging.acme.test');
      s.setSecret(projectScope(staging), 'ACME_API_KEY', false, 'sk-unaudited-value');
      const a = audit({ fail });
      const l = logger();
      const read = await packEnvValues(s.deps, { ...asked(a.binding), log: l.log });
      expect(read).toEqual({ kind: 'unavailable', cause: 'audit' });
      expect(l.warned.map((w) => w.fields.event)).toEqual(['pack-env-secret-rows-unwritten']);
      expect(JSON.stringify(l.warned)).not.toContain('sk-unaudited-value');
    },
  );
});

describe('cloud secrets', () => {
  const PATH = 'projects/acme-prod/secrets/stripe-key/versions/3';
  const input = (required: string[], optional: string[] = []) => ({
    tenantId,
    projectId: staging,
    envName,
    declaration: declaration(required, optional),
    deploymentId: 'd',
  });

  test('a name set only to one is set, with no problem, and given by its path, unasked', async () => {
    const s = stores();
    s.setCloud(tenantScope, 'STRIPE_KEY', 'projects/acme-prod/secrets/tenant-key/versions/1');
    s.setCloud(projectScope(staging), 'STRIPE_KEY', PATH);
    s.setEnv(projectScope(staging), 'API_BASE', 'https://acme.test');
    const read = await served(s.deps, input(['STRIPE_KEY', 'API_BASE']));
    expect(read.check.problem).toBeUndefined();
    expect(read.check.names.find((n) => n.name === 'STRIPE_KEY')).toEqual({
      name: 'STRIPE_KEY',
      required: true,
      kind: 'cloud-secret',
      scope: { kind: 'project', id: staging },
      missing: false,
    });
    expect(read.values).toEqual({ API_BASE: 'https://acme.test' });
    expect(read.cloudSecrets).toEqual({ STRIPE_KEY: PATH });
    // The owner's check names it set, and never the path.
    const check = await packEnvCheck(s.deps, { ...input(['STRIPE_KEY']), secretOnly: 'set' });
    expect(check.names[0]).toMatchObject({ kind: 'cloud-secret', missing: false });
    expect(JSON.stringify(check)).not.toContain('projects/');
  });

  test('given with secret values asked too, and never read as a secret', async () => {
    const s = stores();
    s.setCloud(projectScope(staging), 'STRIPE_KEY', PATH);
    s.setSecret(projectScope(staging), 'ACME_API_KEY', false, 'sk-acme-given-value');
    const auditEvents = {
      append: async () => ({ kind: 'ok', value: undefined }),
    } as unknown as AuditEventBinding;
    const read = await served(s.deps, {
      ...input(['STRIPE_KEY', 'ACME_API_KEY']),
      auditEvents,
      secrets: { requestId: 'req-pack-env-1', systemKeyId: 'key-pack-env-1' },
    });
    expect(read.cloudSecrets).toEqual({ STRIPE_KEY: PATH });
    expect(Object.keys(read.secrets ?? {})).toEqual(['ACME_API_KEY']);
    expect(s.resolved.map((r) => r.name)).toEqual(['ACME_API_KEY']);
  });

  test.each([
    {
      ways: 'a plain value',
      set: (s: ReturnType<typeof stores>) => s.setEnv(tenantScope, 'STRIPE_KEY', 'x'),
      status: { kind: 'env', scope: { kind: 'tenant' } },
    },
    {
      ways: 'a secret',
      set: (s: ReturnType<typeof stores>) => s.setSecret(orgScope, 'STRIPE_KEY'),
      status: { kind: 'secret', scope: { kind: 'org', id: orgId } },
    },
    {
      ways: 'a plain value and a secret',
      set: (s: ReturnType<typeof stores>) => {
        s.setEnv(tenantScope, 'STRIPE_KEY', 'x');
        s.setSecret(orgScope, 'STRIPE_KEY');
      },
      status: {
        kind: 'env',
        scope: { kind: 'tenant' },
        secretScope: { kind: 'org', id: orgId },
      },
    },
  ])('one set as $ways too is ambiguous, naming each scope, and nothing is given', async (c) => {
    const s = stores();
    s.setCloud(projectScope(staging), 'STRIPE_KEY', PATH);
    c.set(s);
    const read = await served(s.deps, input(['STRIPE_KEY']));
    expect(read.check.problem).toBe('pack-env-ambiguous');
    expect(read.check.names[0]).toEqual({
      name: 'STRIPE_KEY',
      required: true,
      missing: false,
      problem: 'ambiguous',
      cloudSecretScope: { kind: 'project', id: staging },
      ...c.status,
    });
    expect(read.values).toBeUndefined();
    expect(read.cloudSecrets).toBeUndefined();
  });

  test('the revision moves when one is set, changed or removed, and only then', async () => {
    const s = stores();
    s.setEnv(projectScope(staging), 'API_BASE', 'https://acme.test');
    const before = (await packEnvCheck(s.deps, input(['API_BASE'], ['STRIPE_KEY']))).revision;
    // A runtime with no cloud secret store marks each name as before.
    const { cloudSecrets: _none, ...withoutStore } = s.deps;
    expect((await packEnvCheck(withoutStore, input(['API_BASE'], ['STRIPE_KEY']))).revision).toBe(
      before,
    );
    s.setCloud(projectScope(staging), 'STRIPE_KEY', PATH);
    const set = (await packEnvCheck(s.deps, input(['API_BASE'], ['STRIPE_KEY']))).revision;
    expect(set).not.toBe(before);
    s.setCloud(projectScope(staging), 'STRIPE_KEY', PATH.replace(/3$/, '4'));
    const changed = (await packEnvCheck(s.deps, input(['API_BASE'], ['STRIPE_KEY']))).revision;
    expect(changed).not.toBe(set);
    s.removeCloud(projectScope(staging), 'STRIPE_KEY');
    expect((await packEnvCheck(s.deps, input(['API_BASE'], ['STRIPE_KEY']))).revision).toBe(before);
  });

  test('none is looked for without a store: a name set only there is missing', async () => {
    const s = stores();
    s.setCloud(projectScope(staging), 'STRIPE_KEY', PATH);
    const { cloudSecrets: _none, ...withoutStore } = s.deps;
    const read = await served(withoutStore, input(['STRIPE_KEY']));
    expect(read.check.problem).toBe('pack-env-missing');
    expect(read.cloudSecrets).toBeUndefined();
  });
});
