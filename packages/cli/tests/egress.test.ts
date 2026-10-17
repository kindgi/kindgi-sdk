// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi egress`: the addresses the deployment's calls come from, read
 * from `GET /v1/tenant`'s `egress` through the client. A table for
 * people, both lists for `--json`, and a plain line when the deployment
 * publishes none (or its runtime is from before `egress`). The
 * addresses are from the documentation ranges (RFC 5737, RFC 3849).
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

const SHARED =
  "Every tenant on this deployment calls from these addresses: admitting them admits all of their calls, so keep your site's own credentials too.\n";
const NONE = 'This deployment publishes no egress addresses.\n';

async function run(argv: readonly string[], tenant: () => Promise<Record<string, unknown>>) {
  let calls = 0;
  const out = await runCli({
    argv: [...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        tenant: {
          get: async () => {
            calls += 1;
            return tenant();
          },
        },
      }) as never,
  });
  return { out, calls };
}

const TENANT = {
  id: 't-acme',
  name: 'Acme',
  slug: 'acme',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const BOTH = {
  ...TENANT,
  egress: { server: ['192.0.2.10'], deployments: ['198.51.100.20', '2001:db8::1'] },
};

describe('kindgi egress', () => {
  test('a table of each address and whose calls come from it, then that every tenant shares them', async () => {
    const { out, calls } = await run(['egress'], async () => BOTH);
    expect(out.exitCode).toBe(0);
    expect(calls).toBe(1);
    expect(out.stdout).toBe(
      [
        'CALLS        ADDRESS',
        '───────────  ─────────────',
        'server       192.0.2.10',
        'deployments  198.51.100.20',
        'deployments  2001:db8::1',
        '',
        SHARED,
      ].join('\n'),
    );
    expect(out.stderr).toBe('');
  });

  test('--table: the same table', async () => {
    const plain = await run(['egress'], async () => BOTH);
    const table = await run(['egress', '--table'], async () => BOTH);
    expect(table.out.stdout).toBe(plain.out.stdout);
  });

  test('--json: both lists, as the runtime gives them', async () => {
    const { out } = await run(['egress', '--json'], async () => BOTH);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(BOTH.egress);
  });

  test('one list published: only its rows; --json has the other, empty', async () => {
    const one = async () => ({ ...TENANT, egress: { server: [], deployments: ['198.51.100.20'] } });
    const table = await run(['egress'], one);
    expect(table.out.stdout).toContain('deployments  198.51.100.20\n');
    expect(table.out.stdout).not.toContain('server ');
    const json = await run(['egress', '--json'], one);
    expect(JSON.parse(json.out.stdout)).toEqual({ server: [], deployments: ['198.51.100.20'] });
  });

  test('none published, or a runtime from before egress: one line, exit 0; --json has both lists empty', async () => {
    const { out } = await run(['egress'], async () => TENANT);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(NONE);
    const json = await run(['egress', '--json'], async () => TENANT);
    expect(json.out.exitCode).toBe(0);
    expect(JSON.parse(json.out.stdout)).toEqual({ server: [], deployments: [] });
  });

  test('a refusal: the error on stderr, exit 1, nothing on stdout', async () => {
    const refusal = fromWire(
      {
        code: 'tenant-not-found',
        message: 'No tenant with id "t-gone"',
        details: { tenantId: 't-gone' },
      },
      404,
    );
    const { out } = await run(['egress'], async () => {
      throw new KindgiApiError(refusal);
    });
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe('Error [not-found]: No tenant with id "t-gone"\n');
  });
});
