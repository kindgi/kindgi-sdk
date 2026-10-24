// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi projects production <project-id> on|off|status`: `on` and `off`
 * through the client's `projects.setProduction`, `status` from the
 * project's `productionSince`. The two refusals go through the client's
 * own reading of the wire error, so their line names the server's code.
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

const SINCE = '2026-10-11T18:02:11.000Z';
const NEXT = 'https://platform.acme.example/account/billing';

/** The runtime's refusals, as the wire carries them. */
const NOT_ALLOWED = fromWire(
  {
    code: 'production-not-allowed',
    message: `This tenant can't put projects in production yet. To be allowed: ${NEXT}. Projects not in production keep working as staging.`,
    details: { projectId: 'p-shop', next: NEXT },
  },
  403,
);
const NOT_ADMIN = fromWire(
  { code: 'permission-denied', message: 'Only a tenant admin can put a project in production' },
  403,
);
const NO_TENANT = fromWire(
  {
    code: 'tenant-not-found',
    message: 'No tenant with id "t-gone"',
    details: { tenantId: 't-gone' },
  },
  404,
);

async function run(
  argv: readonly string[],
  options: { readonly since?: string; readonly refuse?: ReturnType<typeof fromWire> } = {},
) {
  const calls: unknown[][] = [];
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        projects: {
          get: async (...args: unknown[]) => {
            calls.push(['get', ...args]);
            if (options.refuse !== undefined) throw new KindgiApiError(options.refuse);
            return {
              id: 'p-shop',
              name: 'Shop',
              slug: 'shop',
              isDefault: false,
              ...(options.since !== undefined && { productionSince: options.since }),
            };
          },
          setProduction: async (...args: unknown[]) => {
            calls.push(['setProduction', ...args]);
            if (options.refuse !== undefined) throw new KindgiApiError(options.refuse);
            return { projectId: 'p-shop', productionSince: args[1] === true ? SINCE : null };
          },
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi projects production', () => {
  test('on: puts it in production, and says since when', async () => {
    const { out, calls } = await run(['projects', 'production', 'p-shop', 'on']);
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['setProduction', 'p-shop', true]]);
    expect(out.stdout).toBe(
      `p-shop is in production, since ${SINCE}: its runs are production runs.\n`,
    );
  });

  test('off: takes it out', async () => {
    const { out, calls } = await run(['projects', 'production', 'p-shop', 'off']);
    expect(out.exitCode).toBe(0);
    expect(calls).toEqual([['setProduction', 'p-shop', false]]);
    expect(out.stdout).toBe("p-shop isn't in production: its runs are staging runs.\n");
  });

  test('status: reads the project, in production or not, and changes nothing', async () => {
    const live = await run(['projects', 'production', 'p-shop', 'status'], { since: SINCE });
    expect(live.out.exitCode).toBe(0);
    expect(live.calls).toEqual([['get', 'p-shop']]);
    expect(live.out.stdout).toContain(`is in production, since ${SINCE}`);

    const staging = await run(['projects', 'production', 'p-shop', 'status']);
    expect(staging.out.exitCode).toBe(0);
    expect(staging.calls).toEqual([['get', 'p-shop']]);
    expect(staging.out.stdout).toContain("isn't in production");
  });

  test('--json: the same { projectId, productionSince } from on, off and status', async () => {
    const on = await run(['projects', 'production', 'p-shop', 'on', '--json']);
    expect(JSON.parse(on.out.stdout)).toEqual({ projectId: 'p-shop', productionSince: SINCE });
    const off = await run(['projects', 'production', 'p-shop', 'off', '--json']);
    expect(JSON.parse(off.out.stdout)).toEqual({ projectId: 'p-shop', productionSince: null });
    const status = await run(['projects', 'production', 'p-shop', 'status', '--json']);
    expect(JSON.parse(status.out.stdout)).toEqual({ projectId: 'p-shop', productionSince: null });
  });

  test('a tenant not allowed yet: the refusal by its own code, with where to go', async () => {
    const { out } = await run(['projects', 'production', 'p-shop', 'on'], { refuse: NOT_ALLOWED });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(
      `Error [production-not-allowed]: This tenant can't put projects in production yet. To be allowed: ${NEXT}. Projects not in production keep working as staging.\n`,
    );
  });

  test("someone who isn't a tenant admin: permission-denied, not the client's `auth`", async () => {
    const { out } = await run(['projects', 'production', 'p-shop', 'off'], { refuse: NOT_ADMIN });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(
      'Error [permission-denied]: Only a tenant admin can put a project in production\n',
    );
  });

  test('a tenant the runtime has no record of: tenant-not-found', async () => {
    const { out } = await run(['projects', 'production', 'p-shop', 'on'], { refuse: NO_TENANT });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('Error [tenant-not-found]: No tenant with id "t-gone"\n');
  });

  test('anything but on, off or status is a usage error, and calls nothing', async () => {
    const { out, calls } = await run(['projects', 'production', 'p-shop', 'yes']);
    expect(out.exitCode).toBe(2);
    expect(calls).toEqual([]);
    expect(out.stderr).toContain('The second argument is on, off or status, not "yes".');
    const missing = await run(['projects', 'production', 'p-shop']);
    expect(missing.out.exitCode).toBe(2);
    expect(missing.calls).toEqual([]);
  });
});
