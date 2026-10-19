// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi tokens`, `kindgi service-accounts` and `kindgi people`, through the client. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { KindgiApiError, fromWire } from '@kindgi/client';

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

const CAROL = {
  userId: 'u-9',
  tenantId: 't-1',
  displayName: 'Carol',
  primaryEmail: 'carol@acme.test',
  createdAt: '2026-10-06T12:00:00Z',
};
const INVITE = { state: 'pending', expiresAt: '2026-10-13T12:00:00Z' };

const SECOND_FACTOR = {
  setUp: true,
  since: '2026-10-07T12:00:00Z',
  recoveryCodesLeft: 8,
  usable: true,
  required: false,
};
const SETTINGS = { required: false, onPreviousSecret: 0, unusable: 0 };

/** A tenant admin's permissions, on a runtime that holds the tenant's observer. */
const PERMISSIONS = {
  tenantId: 't-1',
  tenant: { admin: true, member: true, observer: false },
  tokenCapabilities: [],
};
/** A refusal as the client throws it. */
const wireError = (code: string, status: number) =>
  new KindgiApiError(fromWire({ code, message: `refused: ${code}`, details: {} }, status));

/** What `users.*` answers, where a test needs another answer. */
interface UsersAnswers {
  readonly create?: unknown;
  readonly grants?: unknown;
  readonly list?: unknown;
  readonly resendInvite?: unknown;
  readonly removeSecondFactor?: unknown;
  /** What `identity.me.permissions()` answers, or throws. */
  readonly permissions?: () => Promise<unknown>;
  readonly settings?: {
    readonly required: boolean;
    readonly onPreviousSecret: number;
    readonly unusable: number;
  };
}

async function run(argv: readonly string[], answers: UsersAnswers = {}) {
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
        identity: {
          me: {
            permissions: async () => {
              calls.push(['identity.me.permissions']);
              return answers.permissions !== undefined ? answers.permissions() : PERMISSIONS;
            },
          },
        },
        auth: {
          settings: {
            get: rec('auth.settings.get', { secondFactor: answers.settings ?? SETTINGS }),
            update: async (...args: unknown[]) => {
              calls.push(['auth.settings.update', ...args]);
              const patch = args[0] as { secondFactor: { required: boolean } };
              return {
                secondFactor: { ...(answers.settings ?? SETTINGS), ...patch.secondFactor },
              };
            },
          },
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
          create: rec('users.create', answers.create ?? CAROL),
          list: rec('users.list', answers.list ?? { data: [CAROL], hasMore: false }),
          resendInvite: rec(
            'users.resendInvite',
            answers.resendInvite ?? {
              user: { ...CAROL, invite: { ...INVITE, sentAt: '2026-10-06T13:00:00Z' } },
              inviteEmail: { sent: true },
            },
          ),
          get: rec('users.get', { userId: 'u-9' }),
          secondFactor: rec('users.secondFactor', SECOND_FACTOR),
          removeSecondFactor: rec(
            'users.removeSecondFactor',
            answers.removeSecondFactor ?? { removed: true },
          ),
          grants: rec('users.grants', answers.grants ?? GRANTS),
          grant: rec('users.grant', { ...GRANTS, tenantAdmin: true }),
          ungrant: rec('users.ungrant', GRANTS),
          unregister: rec('users.unregister', {
            user: {
              userId: 'u-9',
              displayName: 'Carol',
              createdAt: '2026-10-06T12:00:00Z',
              unregisteredAt: '2026-10-07T12:00:00Z',
            },
            keysRevoked: 2,
            sessionsRevoked: 1,
            grantsRemoved: 3,
          }),
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

  test("create --expires with a date: that day's start in UTC, as the API takes a time", async () => {
    const { out, calls } = await run(['tokens', 'create', '--expires=2027-01-15']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['tokens.create', { expiresAt: '2027-01-15T00:00:00.000Z' }]]);
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
    [['--expires=Oct 9'], '--expires must be like 30d'],
    [['--expires=2026-10-09T12:00:00'], '--expires must be like 30d'],
  ])('create refuses %j before any call', async (flags, message) => {
    const { out, calls } = await run(['tokens', 'create', ...flags]);
    // Usage errors.
    expect(out.exitCode).toBe(2);
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
    expect(neither.out.exitCode).toBe(2);
    expect(neither.out.stderr).toContain(
      'Give one of --tenant-admin, --tenant-member or --project',
    );
    const noRole = await run(['service-accounts', 'grant', 'sa-1', `--project=${PROJECT}`]);
    expect(noRole.out.stderr).toContain('--role must be one of');
    const member = await run([
      'service-accounts',
      'grant',
      'sa-1',
      `--project=${PROJECT}`,
      '--role=member',
    ]);
    expect(member.out.exitCode).toBe(2);
    expect(member.out.stderr).toContain('--role must be one of viewer, editor, owner, admin');
    expect(member.calls).toEqual([]);
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
    expect(both.out.exitCode).toBe(2);
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
    // What being added gives them, and what's next. A runtime that doesn't
    // invite says nothing about an invitation.
    expect(out.stderr).toBe(
      'Added to the tenant: they can read its settings. Give them a project role to work on its agents and runs, then their first key: kindgi tokens create --for=user:u-9\n',
    );
    const quiet = await run(['people', 'add', '--name=Dana', '--quiet']);
    expect([quiet.out.stdout, quiet.out.stderr]).toEqual(['', '']);
    const missing = await run(['people', 'add']);
    expect(missing.out.stderr).toContain('--name is required');
  });

  test("add --observer adds the tenant's observer, who gets no key", async () => {
    const { out, calls } = await run([
      'people',
      'add',
      '--name=Carol',
      '--email=carol@acme.test',
      '--observer',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['identity.me.permissions'],
      ['users.create', { displayName: 'Carol', email: 'carol@acme.test', tenantRole: 'observer' }],
    ]);
    expect(out.stderr).toBe(
      "Added as the tenant's observer: give them a project role to view its agents and runs. An observer holds no key.\n",
    );
  });

  test('add --observer adds no one where the runtime holds no observer: an older one, or one that checks no access', async () => {
    const add = ['people', 'add', '--name=Carol', '--observer'];
    const older = { ...PERMISSIONS, tenant: { admin: true, member: true } };
    for (const permissions of [
      async () => older,
      async () => {
        throw wireError('route-not-found', 404);
      },
      async () => {
        throw wireError('permissions-unsupported', 501);
      },
    ]) {
      const { out, calls } = await run(add, { permissions });
      expect(out.exitCode).not.toBe(0);
      expect(calls).toEqual([['identity.me.permissions']]);
      expect(out.stderr).toContain(
        "--observer needs a runtime that holds the tenant's observer: a newer one, which checks access (it runs with an authorization store). No one was added.",
      );
    }
    // Any other refusal is said as it is, another 404 too, and no one is added either.
    for (const [code, status] of [
      ['database-busy', 503],
      ['tenant-not-found', 404],
    ] as const) {
      const { out, calls } = await run(add, {
        permissions: async () => {
          throw wireError(code, status);
        },
      });
      expect(out.exitCode, code).not.toBe(0);
      expect(calls).toEqual([['identity.me.permissions']]);
      expect(out.stderr).toContain(code);
      expect(out.stderr).not.toContain('No one was added');
    }
  });

  test('add says where the invitation went, and when it expires', async () => {
    const { out } = await run(['people', 'add', '--name=Carol', '--email=carol@acme.test'], {
      create: { ...CAROL, invite: INVITE, inviteEmail: { sent: true } },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      userId: 'u-9',
      displayName: 'Carol',
      email: 'carol@acme.test',
      invite: INVITE,
      inviteEmail: { sent: true },
    });
    expect(out.stderr).toContain(
      'The invitation went to carol@acme.test: they sign in with it before it expires (2026-10-13T12:00:00Z).\n',
    );
  });

  test('add --no-invite still invites them, not emailed: you tell them', async () => {
    const { out, calls } = await run(
      ['people', 'add', '--name=Carol', '--email=carol@acme.test', '--no-invite'],
      {
        create: { ...CAROL, invite: INVITE, inviteEmail: { sent: false, reason: 'not-requested' } },
      },
    );
    expect(calls).toEqual([
      ['users.create', { displayName: 'Carol', email: 'carol@acme.test', sendInvite: false }],
    ]);
    expect(out.stderr).toContain(
      'Invited, not emailed (--no-invite): tell them to sign in with carol@acme.test before it expires (2026-10-13T12:00:00Z).\n',
    );
  });

  test.each([
    ['no-email', 'No invitation: they have no email.\n'],
    [
      'not-configured',
      'Invited, but this deployment sends no email: tell them to sign in through a provider with carol@acme.test before it expires (2026-10-13T12:00:00Z).\n',
    ],
    [
      'send-failed',
      "Invited, but the invitation email didn't go out: send it again (kindgi people invite u-9), or tell them to sign in before it expires (2026-10-13T12:00:00Z).\n",
    ],
    [
      'capped',
      "Invited, but the tenant's invitations for today are used up: send it later (kindgi people invite u-9), or tell them to sign in before it expires (2026-10-13T12:00:00Z).\n",
    ],
  ])('add says why the invitation was not emailed: %s', async (reason, line) => {
    const { out } = await run(['people', 'add', '--name=Carol', '--email=carol@acme.test'], {
      create: {
        ...CAROL,
        ...(reason !== 'no-email' && { invite: INVITE }),
        inviteEmail: { sent: false, reason },
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr.endsWith(line)).toBe(true);
  });

  test('invite sends the invitation again: the record on stdout, where it went on stderr', async () => {
    const { out, calls } = await run(['people', 'invite', 'u-9']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['users.resendInvite', 'u-9']]);
    expect(JSON.parse(out.stdout)).toMatchObject({
      user: { userId: 'u-9', invite: { state: 'pending' } },
      inviteEmail: { sent: true },
    });
    expect(out.stderr).toBe(
      'The invitation went to carol@acme.test: they sign in with it before it expires (2026-10-13T12:00:00Z).\n',
    );
    const quiet = await run(['people', 'invite', 'u-9', '--quiet']);
    expect([quiet.out.stdout, quiet.out.stderr]).toEqual(['', '']);
    const missing = await run(['people', 'invite']);
    expect(missing.out.exitCode).toBe(2);
    expect(missing.calls).toEqual([]);
  });

  test('list --pending asks for the invited people only, with their STATE', async () => {
    const { out, calls } = await run(['people', 'list', '--pending', '--table'], {
      list: { data: [{ ...CAROL, invite: { ...INVITE, state: 'expired' } }], hasMore: false },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['users.list', { pending: true }]]);
    expect(out.stdout).toMatch(/STATE/);
    expect(out.stdout).toMatch(/carol@acme\.test\s+expired/);
  });

  test('list --query as a table', async () => {
    const { out, calls } = await run(['people', 'list', '--query=Ca', '--table']);
    expect(calls).toEqual([['users.list', { query: 'Ca' }]]);
    expect(out.stdout).toContain('carol@acme.test');
    expect(out.stdout).not.toContain('REMOVED');
  });

  test('list --include-removed asks for removed people too, with a REMOVED column', async () => {
    const { out, calls } = await run(['people', 'list', '--include-removed', '--table']);
    expect(calls).toEqual([['users.list', { includeUnregistered: true }]]);
    expect(out.stdout).toContain('REMOVED');
  });

  test('remove: the record on stdout, what went on stderr', async () => {
    const { out, calls } = await run(['people', 'remove', 'u-9']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['users.unregister', 'u-9']]);
    expect(JSON.parse(out.stdout)).toMatchObject({
      user: { userId: 'u-9', unregisteredAt: '2026-10-07T12:00:00Z' },
      keysRevoked: 2,
    });
    expect(out.stderr).toBe(
      'Removed Carol: 2 key(s) and 1 session(s) revoked, 3 role(s) and membership(s) taken away.\n',
    );
    // A missing argument is a usage error.
    const missing = await run(['people', 'remove']);
    expect(missing.out.exitCode).toBe(2);
    expect(missing.calls).toEqual([]);
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
    expect(out.stdout).not.toContain('observer');
  });

  test("grants as a table: the tenant's observer, in place of a member", async () => {
    const { out } = await run(['people', 'grants', 'u-9', '--table'], {
      grants: { ...GRANTS, tenantMember: false, tenantObserver: true },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/tenant\s+observer \(views only the projects it is given\)/);
    expect(out.stdout).not.toContain('member (reads its settings)');
  });

  test('grants as a table: a person a site signs in says their site gives them', async () => {
    const { out } = await run(['people', 'grants', 'u-9', '--table'], {
      grants: { ...GRANTS, siteManaged: true },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/site\s+its sign-in gives these: change their role on the site/);
    const other = await run(['people', 'grants', 'u-9', '--table']);
    expect(other.out.stdout).not.toContain('sign-in gives these');
  });

  test('grant and ungrant tenant admin; nothing else is granted here', async () => {
    const g = await run(['people', 'grant', 'u-9', '--tenant-admin']);
    expect(g.out.exitCode, g.out.stderr).toBe(0);
    expect(g.calls).toEqual([['users.grant', 'u-9', { kind: 'tenant-admin' }]]);
    expect(JSON.parse(g.out.stdout)).toMatchObject({ tenantAdmin: true });
    const u = await run(['people', 'ungrant', 'u-9', '--tenant-admin']);
    expect(u.calls).toEqual([['users.ungrant', 'u-9', { kind: 'tenant-admin' }]]);
    const none = await run(['people', 'grant', 'u-9']);
    expect(none.out.exitCode).toBe(2);
    expect(none.out.stderr).toContain('Give --tenant-admin or --tenant-observer');
    expect(none.calls).toEqual([]);
  });

  test("grant and ungrant the tenant's observer; one grant at a time", async () => {
    const g = await run(['people', 'grant', 'u-9', '--tenant-observer']);
    expect(g.out.exitCode, g.out.stderr).toBe(0);
    expect(g.calls).toEqual([['users.grant', 'u-9', { kind: 'tenant-observer' }]]);
    const u = await run(['people', 'ungrant', 'u-9', '--tenant-observer']);
    expect(u.out.exitCode, u.out.stderr).toBe(0);
    expect(u.calls).toEqual([['users.ungrant', 'u-9', { kind: 'tenant-observer' }]]);
    const both = await run(['people', 'grant', 'u-9', '--tenant-admin', '--tenant-observer']);
    expect(both.out.exitCode).toBe(2);
    expect(both.out.stderr).toContain('Give --tenant-admin or --tenant-observer, one of them');
    expect(both.calls).toEqual([]);
  });
});

describe('kindgi people and sign-in: a second factor', () => {
  test('people second-factor reads theirs', async () => {
    const { out, calls } = await run(['people', 'second-factor', 'u-9']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['users.secondFactor', 'u-9']]);
    expect(JSON.parse(out.stdout)).toEqual(SECOND_FACTOR);
  });

  test('people reset-second-factor removes it, and says what that means', async () => {
    const { out, calls } = await run(['people', 'reset-second-factor', 'u-9']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['users.removeSecondFactor', 'u-9']]);
    expect(JSON.parse(out.stdout)).toEqual({ removed: true });
    expect(out.stderr).toBe(
      "Removed u-9's second factor: they set one up again at their next sign-in where the workspace requires one.\n",
    );
  });

  test('people reset-second-factor for someone without one: nothing changed', async () => {
    const { out } = await run(['people', 'reset-second-factor', 'u-9'], {
      removeSecondFactor: { removed: false },
    });
    expect(out.stderr).toBe('u-9 had no second factor set up: nothing changed.\n');
  });

  test('sign-in settings reads them, and names what needs doing', async () => {
    const { out, calls } = await run(['sign-in', 'settings'], {
      settings: { required: true, onPreviousSecret: 2, unusable: 1 },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['auth.settings.get']]);
    expect(JSON.parse(out.stdout)).toEqual({
      secondFactor: { required: true, onPreviousSecret: 2, unusable: 1 },
    });
    expect(out.stderr).toBe(
      [
        'Signing in takes a second factor (your own identity provider is exempt; API keys are not covered).',
        "2 person(s)' second factor is still under the previous sign-in secret: keep it configured until this is 0.",
        "1 person(s)' second factor can't be read any more: they need a recovery code, or kindgi people reset-second-factor.",
        '',
      ].join('\n'),
    );
  });

  test.each([
    ['on', true],
    ['off', false],
  ] as const)('sign-in settings --require-second-factor=%s', async (flag, required) => {
    const { out, calls } = await run(['sign-in', 'settings', `--require-second-factor=${flag}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['auth.settings.update', { secondFactor: { required } }]]);
    expect(JSON.parse(out.stdout).secondFactor.required).toBe(required);
  });

  test('sign-in settings --require-second-factor takes on or off only', async () => {
    const { out, calls } = await run(['sign-in', 'settings', '--require-second-factor=yes']);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('--require-second-factor takes on or off (got yes)');
    expect(calls).toEqual([]);
  });
});
