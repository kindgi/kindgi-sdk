// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi sites`, through the client's `projects.sites`. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const DEFAULT_PROJECT = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://acme-store.example';
const APPROVALS_URL = `${ORIGIN}/wp-admin/admin.php?page=kindgi&approval={approvalId}`;
const SITE = {
  siteId: SITE_ID,
  projectId: PROJECT,
  displayName: 'Acme store',
  origin: ORIGIN,
  approvalsUrl: APPROVALS_URL,
  allowedRoles: ['administrator', 'shop_manager'],
  roleMap: {
    administrator: { ask: true, reviewer: 'standard' },
    shop_manager: { ask: true, reviewer: 'standard' },
  },
  reviewerCeiling: 'standard',
  vouching: true,
  peopleCap: 50,
  newPeoplePerDay: 20,
  keys: [] as { kid: string; thumbprint: string; addedAt: string }[],
  createdAt: '2026-10-10T00:00:00.000Z',
};
const KEY = { kid: 'k1', thumbprint: 'thumb-1', addedAt: '2026-10-10T00:01:00.000Z' };
const CODE = { code: 'acme-code-1', expiresAt: '2026-10-10T00:15:00.000Z' };
const PERSON_ID = '44444444-4444-4444-8444-444444444444';
const PERSON = { userId: PERSON_ID, displayName: 'Jane', createdAt: '2026-10-10T00:02:00.000Z' };

async function sites(argv: readonly string[]) {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  const out = await runCli({
    argv: ['sites', ...argv, '--url=https://kindgi.acme.example', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        projects: {
          getDefault: record('getDefault', { id: DEFAULT_PROJECT }),
          sites: {
            list: record('list', {
              data: [
                { ...SITE, keys: [KEY] },
                { ...SITE, siteId: 'site-2', displayName: 'Acme outlet', keys: [] },
                { ...SITE, siteId: 'site-3', pausedAt: '2026-10-11T00:00:00.000Z', keys: [KEY] },
              ],
              hasMore: false,
            }),
            register: record('register', { site: SITE, enrollment: CODE }),
            get: record('get', SITE),
            update: record('update', SITE),
            pause: record('pause', { ...SITE, pausedAt: '2026-10-11T00:00:00.000Z' }),
            resume: record('resume', SITE),
            unregister: record('unregister', {
              ...SITE,
              unregisteredAt: '2026-10-11T00:00:00.000Z',
            }),
            newEnrollmentCode: record('newEnrollmentCode', CODE),
            revokeKey: record('revokeKey', SITE),
            restorePerson: record('restorePerson', { user: PERSON }),
          },
        },
      }) as never,
  });
  return { out, calls };
}

const REQUIRED = ['--name=Acme store', `--origin=${ORIGIN}`, `--approvals-url=${APPROVALS_URL}`];

describe('kindgi sites register', () => {
  test("in the Default project: the site's settings as given, and its code once, with where to paste it", async () => {
    const { out, calls } = await sites(['register', ...REQUIRED]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['getDefault'],
      [
        'register',
        DEFAULT_PROJECT,
        { displayName: 'Acme store', origin: ORIGIN, approvalsUrl: APPROVALS_URL },
      ],
    ]);
    expect(JSON.parse(out.stdout)).toEqual({ site: SITE, enrollment: CODE });
    expect(out.stderr).toContain(`Registered site ${SITE_ID} on project ${PROJECT}`);
    expect(out.stderr).toContain('"<name>, via Acme store"');
    expect(out.stderr).toContain(
      `One-time code (shown this once; it works until ${CODE.expiresAt}): ${CODE.code}`,
    );
    expect(out.stderr).toContain('under Kindgi → Settings');
    expect(out.stderr).toContain('this CLI uses https://kindgi.acme.example');
    expect(out.stderr).toContain(`\`kindgi sites code ${SITE_ID}\` gives a new one`);
  });

  test('every setting, in a project given', async () => {
    const roleMapFile = join(cwd, 'roles.json');
    await writeFile(
      roleMapFile,
      JSON.stringify({ shop_manager: { ask: true, reviewer: 'senior' }, editor: { ask: true } }),
    );
    const { out, calls } = await sites([
      'register',
      ...REQUIRED,
      '--allowed-role=shop_manager',
      '--allowed-role=editor',
      `--role-map=@${roleMapFile}`,
      '--reviewer-ceiling=senior',
      '--vouching=off',
      '--people-cap=5',
      '--new-people-per-day=2',
      `--project=${PROJECT}`,
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'register',
        PROJECT,
        {
          displayName: 'Acme store',
          origin: ORIGIN,
          approvalsUrl: APPROVALS_URL,
          allowedRoles: ['shop_manager', 'editor'],
          roleMap: { shop_manager: { ask: true, reviewer: 'senior' }, editor: { ask: true } },
          reviewerCeiling: 'senior',
          vouching: false,
          peopleCap: 5,
          newPeoplePerDay: 2,
        },
      ],
    ]);
    expect(out.stderr).toContain(`\`kindgi sites code ${SITE_ID} --project=${PROJECT}\``);
  });

  test.each([
    [
      'without --approvals-url',
      ['--name=Acme store', `--origin=${ORIGIN}`],
      '--approvals-url=<url> are required',
    ],
    [
      'without --name',
      [`--origin=${ORIGIN}`, `--approvals-url=${APPROVALS_URL}`],
      '--name=<shown name>',
    ],
    [
      'a ceiling that is no reviewer role',
      [...REQUIRED, '--reviewer-ceiling=admin'],
      '--reviewer-ceiling must be `standard` or `senior`',
    ],
    [
      'vouching that is neither on nor off',
      [...REQUIRED, '--vouching=yes'],
      '--vouching must be `on` or `off`',
    ],
  ])('%s: refused before any call', async (_, flags, said) => {
    const { out, calls } = await sites(['register', ...flags]);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain(said);
    expect(calls).toEqual([]);
  });
});

describe('kindgi sites: the rest of the group', () => {
  test('code: a new one-time code, shown once, with where to paste it', async () => {
    const { out, calls } = await sites(['code', SITE_ID, `--project=${PROJECT}`]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['newEnrollmentCode', PROJECT, SITE_ID]]);
    expect(JSON.parse(out.stdout)).toEqual(CODE);
    expect(out.stderr).toContain(`): ${CODE.code}`);
    expect(out.stderr).toContain('under Kindgi → Settings');
  });

  test('list as a table: each site, its state and its keys; unregistered ones when asked', async () => {
    const { out, calls } = await sites(['list', '--include-unregistered', '--limit=10', '--table']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['getDefault'],
      ['list', DEFAULT_PROJECT, { limit: 10, includeUnregistered: true }],
    ]);
    const lines = out.stdout.split('\n');
    expect(lines.find((l) => l.includes(SITE_ID))).toMatch(/Acme store.*signing in\s+1/);
    expect(lines.find((l) => l.includes('site-2'))).toMatch(/Acme outlet.*not connected\s+0/);
    expect(lines.find((l) => l.includes('site-3'))).toMatch(/paused\s+1/);
  });

  test('update: only the settings given; none is refused before any call', async () => {
    const changed = await sites(['update', SITE_ID, '--name=Acme shop', '--people-cap=80']);
    expect(changed.out.exitCode, changed.out.stderr).toBe(0);
    expect(changed.calls).toEqual([
      ['getDefault'],
      ['update', DEFAULT_PROJECT, SITE_ID, { displayName: 'Acme shop', peopleCap: 80 }],
    ]);
    const none = await sites(['update', SITE_ID]);
    expect(none.out.exitCode).not.toBe(0);
    expect(none.out.stderr).toContain('Nothing to change');
    expect(none.calls).toEqual([]);
  });

  test('get, pause, resume, unregister and revoke-key: by site id, in the project given', async () => {
    for (const name of ['get', 'pause', 'resume', 'unregister'] as const) {
      const { out, calls } = await sites([name, SITE_ID, `--project=${PROJECT}`]);
      expect(out.exitCode, out.stderr).toBe(0);
      expect(calls).toEqual([[name, PROJECT, SITE_ID]]);
    }
    const revoked = await sites(['revoke-key', SITE_ID, 'k1', `--project=${PROJECT}`]);
    expect(revoked.out.exitCode, revoked.out.stderr).toBe(0);
    expect(revoked.calls).toEqual([['revokeKey', PROJECT, SITE_ID, 'k1']]);
  });

  test('restore-person: the site and the person by id, in the project given or the Default one', async () => {
    const restored = await sites(['restore-person', SITE_ID, PERSON_ID, `--project=${PROJECT}`]);
    expect(restored.out.exitCode, restored.out.stderr).toBe(0);
    expect(restored.calls).toEqual([['restorePerson', PROJECT, SITE_ID, PERSON_ID]]);
    expect(JSON.parse(restored.out.stdout)).toEqual({ user: PERSON });
    const inDefault = await sites(['restore-person', SITE_ID, PERSON_ID]);
    expect(inDefault.out.exitCode, inDefault.out.stderr).toBe(0);
    expect(inDefault.calls).toEqual([
      ['getDefault'],
      ['restorePerson', DEFAULT_PROJECT, SITE_ID, PERSON_ID],
    ]);
    // The person's id is required: nothing is asked without it.
    const noPerson = await sites(['restore-person', SITE_ID, `--project=${PROJECT}`]);
    expect(noPerson.out.exitCode).not.toBe(0);
    expect(noPerson.calls).toEqual([]);
  });
});
