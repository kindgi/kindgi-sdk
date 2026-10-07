// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi tokens`, `kindgi service-accounts` and `kindgi people`, through the client. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const PROJECT = '0b9f4c1e-1111-4a2b-8c3d-000000000001';
const META = {
  id: 'tok-1',
  principal: { kind: 'service-account', id: 'sa-1' },
  role: 'member',
  capabilities: ['env:write'],
  label: 'ci',
  projectId: PROJECT,
  createdAt: '2026-10-06T12:00:00Z',
};
const ACCOUNT = {
  serviceAccountId: 'sa-1',
  name: 'acme-ci',
  grants: [
    { kind: 'tenant-admin' },
    { kind: 'tenant-member' },
    { kind: 'project', projectId: PROJECT, role: 'editor' },
  ],
  createdAt: '2026-10-06T12:00:00Z',
};

const GRANTS = {
  userId: 'u-9',
  tenantAdmin: false,
  tenantMember: true,
  projects: [{ projectId: PROJECT, role: 'editor' }],
  teams: [{ teamId: 'team-1', role: 'member' }],
  reviewer: { role: 'senior' },
};

async function run(argv: readonly string[]) {
  const calls: unknown[][] = [];
  const rec =
    (name: string, value: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return value;
    };
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        tokens: {
          create: rec('tokens.create', { meta: META, secret: 'kgi_ak_secret' }),
          list: rec('tokens.list', { data: [META], hasMore: false }),
          get: rec('tokens.get', META),
          revoke: rec('tokens.revoke', undefined),
        },
        serviceAccounts: {
          create: rec('sa.create', ACCOUNT),
          list: rec('sa.list', { data: [ACCOUNT], hasMore: false }),
          get: rec('sa.get', ACCOUNT),
          grant: rec('sa.grant', ACCOUNT),
          ungrant: rec('sa.ungrant', ACCOUNT),
          unregister: rec('sa.unregister', ACCOUNT),
        },
        users: {
          create: rec('users.create', 'u-9'),
          list: rec('users.list', {
            data: [
              {
                userId: 'u-9',
                displayName: 'Carol',
                primaryEmail: 'carol@acme.test',
                createdAt: '2026-10-06T12:00:00Z',
              },
            ],
            hasMore: false,
          }),
          get: rec('users.get', { userId: 'u-9' }),
          grants: rec('users.grants', GRANTS),
          grant: rec('users.grant', { ...GRANTS, tenantAdmin: true }),
          ungrant: rec('users.ungrant', GRANTS),
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi tokens', () => {
  test('create for a service account, limited to a project, expiring: the secret once, a warning on stderr', async () => {
    const before = Date.now();
    const { out, calls } = await run([
      'tokens',
      'create',
      '--for=sa:sa-1',
      '--role=member',
      `--project=${PROJECT}`,
      '--expires=30d',
      '--label=ci',
      '--capability=env:write',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    const spec = calls[0]?.[1] as Record<string, unknown>;
    expect(spec).toMatchObject({
      for: { kind: 'service-account', id: 'sa-1' },
      role: 'member',
      projectId: PROJECT,
      label: 'ci',
      capabilities: ['env:write'],
    });
    const expires = Date.parse(spec.expiresAt as string) - before;
    expect(expires).toBeGreaterThan(29 * 86_400_000);
    expect(expires).toBeLessThan(31 * 86_400_000);
    expect(JSON.parse(out.stdout)).toMatchObject({ secret: 'kgi_ak_secret' });
    expect(out.stderr).toContain('shown once');
  });

  test('create with nothing: a member key for you', async () => {
    const { out, calls } = await run(['tokens', 'create']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['tokens.create', {}]]);
  });

  test.each([
    [['--for=team:x'], '--for must be user:<id> or sa:<id>'],
    [['--for=user:'], '--for must be'],
    [['--role=owner'], '--role must be member or admin'],
    [['--expires=soon'], '--expires must be like 30d'],
  ])('create refuses %j before any call', async (flags, message) => {
    const { out, calls } = await run(['tokens', 'create', ...flags]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(message);
    expect(calls).toEqual([]);
  });

  test("list --for one principal's keys, as a table: whom each acts for, its project, no secrets", async () => {
    const { out, calls } = await run(['tokens', 'list', '--for=user:bob', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['tokens.list', { principal: { kind: 'user', id: 'bob' } }]]);
    expect(out.stdout).toContain('sa:sa-1');
    expect(out.stdout).toContain(PROJECT);
    expect(out.stdout).not.toContain('kgi_ak');
  });

  test('revoke names the key', async () => {
    const { calls } = await run(['tokens', 'revoke', 'tok-1']);
    expect(calls).toEqual([['tokens.revoke', 'tok-1']]);
  });
});

describe('kindgi service-accounts', () => {
  test('create with tenant admin and project roles', async () => {
    const { out, calls } = await run([
      'service-accounts',
      'create',
      'acme-ci',
      '--description=CI',
      '--tenant-admin',
      `--project=${PROJECT}:editor`,
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'sa.create',
        {
          name: 'acme-ci',
          description: 'CI',
          grants: [
            { kind: 'tenant-admin' },
            { kind: 'project', projectId: PROJECT, role: 'editor' },
          ],
        },
      ],
    ]);
  });

  test('grant and ungrant: tenant admin, or a project (with a role to grant)', async () => {
    const a = await run([
      'service-accounts',
      'grant',
      'sa-1',
      `--project=${PROJECT}`,
      '--role=viewer',
    ]);
    expect(a.calls).toEqual([
      ['sa.grant', 'sa-1', { kind: 'project', projectId: PROJECT, role: 'viewer' }],
    ]);
    const b = await run(['service-accounts', 'ungrant', 'sa-1', '--tenant-admin']);
    expect(b.calls).toEqual([['sa.ungrant', 'sa-1', { kind: 'tenant-admin' }]]);
    const neither = await run(['service-accounts', 'grant', 'sa-1']);
    expect(neither.out.exitCode).toBe(1);
    expect(neither.out.stderr).toContain(
      'Give one of --tenant-admin, --tenant-member or --project',
    );
    const noRole = await run(['service-accounts', 'grant', 'sa-1', `--project=${PROJECT}`]);
    expect(noRole.out.stderr).toContain('--role must be one of');
    const badProject = await run(['service-accounts', 'create', 'x', `--project=${PROJECT}`]);
    expect(badProject.out.stderr).toContain('--project must be <project-id>:<role>');
  });

  test('tenant member: on create, granted, taken back; never with another target', async () => {
    const created = await run(['service-accounts', 'create', 'acme-deploy', '--tenant-member']);
    expect(created.calls).toEqual([
      ['sa.create', { name: 'acme-deploy', grants: [{ kind: 'tenant-member' }] }],
    ]);
    const granted = await run(['service-accounts', 'grant', 'sa-1', '--tenant-member']);
    expect(granted.calls).toEqual([['sa.grant', 'sa-1', { kind: 'tenant-member' }]]);
    const taken = await run(['service-accounts', 'ungrant', 'sa-1', '--tenant-member']);
    expect(taken.calls).toEqual([['sa.ungrant', 'sa-1', { kind: 'tenant-member' }]]);
    const both = await run([
      'service-accounts',
      'grant',
      'sa-1',
      '--tenant-member',
      '--tenant-admin',
    ]);
    expect(both.out.exitCode).toBe(1);
    expect(both.calls).toEqual([]);
  });

  test('list --all as a table, with each grant in words; unregister', async () => {
    const { out, calls } = await run(['service-accounts', 'list', '--all', '--table']);
    expect(calls).toEqual([['sa.list', { includeUnregistered: true }]]);
    expect(out.stdout).toContain(`tenant admin; tenant member; editor on ${PROJECT}`);
    const gone = await run(['service-accounts', 'unregister', 'sa-1']);
    expect(gone.calls).toEqual([['sa.unregister', 'sa-1']]);
  });
});

describe('kindgi people', () => {
  test('add prints the new id; --name is required', async () => {
    const { out, calls } = await run(['people', 'add', '--name=Carol', '--email=carol@acme.test']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['users.create', { displayName: 'Carol', email: 'carol@acme.test' }]]);
    expect(JSON.parse(out.stdout)).toEqual({
      userId: 'u-9',
      displayName: 'Carol',
      email: 'carol@acme.test',
    });
    // What being added gives them, and what's next.
    expect(out.stderr).toBe(
      'Added to the tenant: they can read its settings. Give them a project role to work on its agents and runs, then their first key: kindgi tokens create --for=user:u-9\n',
    );
    const quiet = await run(['people', 'add', '--name=Dana', '--quiet']);
    expect([quiet.out.stdout, quiet.out.stderr]).toEqual(['', '']);
    const missing = await run(['people', 'add']);
    expect(missing.out.stderr).toContain('--name is required');
  });

  test('list --query as a table', async () => {
    const { out, calls } = await run(['people', 'list', '--query=Ca', '--table']);
    expect(calls).toEqual([['users.list', { query: 'Ca' }]]);
    expect(out.stdout).toContain('carol@acme.test');
  });
});

describe("kindgi people: a person's grants", () => {
  test('grants as a table: one row per grant, in words', async () => {
    const { out, calls } = await run(['people', 'grants', 'u-9', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['users.grants', 'u-9']]);
    expect(out.stdout).toContain(`project ${PROJECT}`);
    expect(out.stdout).toContain('team team-1');
    expect(out.stdout).toContain('reviewer roster');
    expect(out.stdout).toMatch(/tenant\s+member \(reads its settings\)/);
    expect(out.stdout).not.toMatch(/tenant\s+admin/);
  });

  test('grant and ungrant tenant admin; nothing else is granted here', async () => {
    const g = await run(['people', 'grant', 'u-9', '--tenant-admin']);
    expect(g.out.exitCode, g.out.stderr).toBe(0);
    expect(g.calls).toEqual([['users.grant', 'u-9', { kind: 'tenant-admin' }]]);
    expect(JSON.parse(g.out.stdout)).toMatchObject({ tenantAdmin: true });
    const u = await run(['people', 'ungrant', 'u-9', '--tenant-admin']);
    expect(u.calls).toEqual([['users.ungrant', 'u-9', { kind: 'tenant-admin' }]]);
    const none = await run(['people', 'grant', 'u-9']);
    expect(none.out.exitCode).toBe(1);
    expect(none.out.stderr).toContain('Give --tenant-admin');
    expect(none.calls).toEqual([]);
  });
});
