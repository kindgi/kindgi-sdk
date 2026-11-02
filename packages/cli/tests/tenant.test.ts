// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi tenant get` and `kindgi tenant rename`: through the client's
 * `tenant.get` and `tenant.update`, then the workspace as `tenant get`
 * prints it. The refusals go through the client's own reading of the wire
 * error, so their line names the server's code.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KindgiApiError, fromWire } from '@kindgi/client';
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

const TENANT_ID = '0b7c4a2e-9d1f-4e3a-8b6c-5d4e3f2a1b0c';

/** The runtime's refusals, as the wire carries them. */
const SLUG_TAKEN = fromWire(
  {
    code: 'tenant-slug-taken',
    message: 'Another workspace has the slug "acme-store".',
    details: { slug: 'acme-store' },
  },
  409,
);
const IN_CONFIG = fromWire(
  {
    code: 'tenant-slug-in-config',
    message: `The server's KINDGI_AUTH_VERIFIED_DOMAINS names this workspace by its slug (acme.com:acme), so its slug can't change yet: the server would find no workspace by it when it next starts. The server's operator names it there by its id (${TENANT_ID}) instead and restarts the server; then rename it.`,
    details: { slug: 'acme', domains: ['acme.com'] },
  },
  409,
);
const NOT_ADMIN = fromWire(
  { code: 'permission-denied', message: 'Only a tenant admin can rename the tenant' },
  403,
);

async function run(
  argv: readonly string[],
  options: {
    readonly refuse?: ReturnType<typeof fromWire>;
    /** The read after the rename fails with this. */
    readonly unread?: ReturnType<typeof fromWire>;
  } = {},
) {
  const calls: unknown[][] = [];
  let tenant: Record<string, unknown> = {
    id: TENANT_ID,
    name: 'Acme',
    slug: 'acme',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        tenant: {
          update: async (...args: unknown[]) => {
            calls.push(['update', ...args]);
            if (options.refuse !== undefined) throw new KindgiApiError(options.refuse);
            tenant = { ...tenant, ...(args[0] as object) };
            // The server answers 204: nothing comes back.
            return undefined;
          },
          get: async (...args: unknown[]) => {
            calls.push(['get', ...args]);
            if (options.unread !== undefined) throw new KindgiApiError(options.unread);
            return tenant;
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi tenant get', () => {
  test('prints the workspace as the client reads it', async () => {
    const { out, calls } = await run(['tenant', 'get']);
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['get']]);
    expect(JSON.parse(out.stdout)).toMatchObject({ id: TENANT_ID, name: 'Acme', slug: 'acme' });
  });
});

describe('kindgi tenant rename', () => {
  test('--name: changes the name only, then prints the workspace', async () => {
    const { out, calls } = await run(['tenant', 'rename', '--name=Acme Store']);
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['update', { name: 'Acme Store' }], ['get']]);
    expect(JSON.parse(out.stdout)).toMatchObject({ name: 'Acme Store', slug: 'acme' });
  });

  test('--slug, alone or with --name', async () => {
    const slug = await run(['tenant', 'rename', '--slug=acme-store']);
    expect(slug.out.exitCode).toBe(0);
    expect(slug.calls[0]).toEqual(['update', { slug: 'acme-store' }]);
    expect(JSON.parse(slug.out.stdout)).toMatchObject({ slug: 'acme-store' });
    const both = await run(['tenant', 'rename', '--name=Acme Store', '--slug=acme-store']);
    expect(both.calls[0]).toEqual(['update', { name: 'Acme Store', slug: 'acme-store' }]);
  });

  test("neither flag, an empty one, or a slug out of the server's rule: a usage error, exit 2, nothing sent", async () => {
    for (const argv of [
      ['tenant', 'rename'],
      ['tenant', 'rename', '--name='],
      ['tenant', 'rename', '--slug= '],
      ['tenant', 'rename', '--slug=Acme'],
      ['tenant', 'rename', '--slug=acme--store'],
      ['tenant', 'rename', '--slug=acme-'],
      ['tenant', 'rename', `--slug=${'a'.repeat(64)}`],
    ]) {
      const { out, calls } = await run(argv);
      expect(out.exitCode, argv.join(' ')).toBe(2);
      expect(calls, argv.join(' ')).toEqual([]);
    }
    const bad = await run(['tenant', 'rename', '--slug=acme--store']);
    expect(bad.out.stderr).toContain(
      '--slug=acme--store: lowercase letters, digits and single hyphens, starting and ending with a letter or digit, at most 63 characters',
    );
    const longest = await run(['tenant', 'rename', `--slug=${'a'.repeat(63)}`]);
    expect(longest.out.exitCode).toBe(0);
  });

  test('renamed, but the read after it fails: exit 0, and stderr says so', async () => {
    const { out } = await run(['tenant', 'rename', '--name=Acme Store'], {
      unread: fromWire({ code: 'internal-error', message: 'database unavailable' }, 503),
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(
      "Renamed your workspace, but couldn't read it back: database unavailable. `kindgi tenant get` shows it.\n",
    );
  });

  test('a slug taken, one the sign-in settings name, or not an admin: by their own codes, exit 1', async () => {
    const taken = await run(['tenant', 'rename', '--slug=acme-store'], { refuse: SLUG_TAKEN });
    expect(taken.out.exitCode).toBe(1);
    expect(taken.out.stderr).toBe(
      'Error [tenant-slug-taken]: Another workspace has the slug "acme-store".\n',
    );
    expect(taken.calls).toEqual([['update', { slug: 'acme-store' }]]);
    const configured = await run(['tenant', 'rename', '--slug=acme-store'], { refuse: IN_CONFIG });
    expect(configured.out.exitCode).toBe(1);
    expect(configured.out.stderr).toBe(`Error [tenant-slug-in-config]: ${IN_CONFIG.message}\n`);
    const member = await run(['tenant', 'rename', '--name=Globex'], { refuse: NOT_ADMIN });
    expect(member.out.exitCode).toBe(1);
    expect(member.out.stderr).toBe(
      'Error [permission-denied]: Only a tenant admin can rename the tenant\n',
    );
  });
});
