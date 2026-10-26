// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi webhooks`, through the client's `webhooks`. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { KindgiApiError } from '@kindgi/client';

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

const ID = '11111111-1111-4111-8111-111111111111';
const RECEIVE_URL = 'https://kindgi.acme.example/v1/hooks/t-1/w-1';
const TRIGGER = {
  triggerId: ID,
  webhookId: 'w-1',
  receiveUrl: RECEIVE_URL,
  flowId: 'acme.refund-review',
  flowVersion: '1.0.0',
  projectId: 'p-1',
  owner: { kind: 'user', id: 'u-1', displayName: 'Ada Lovelace' },
  hmacSecretName: 'acme-woo-secret',
  signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-WC-Webhook-Signature' },
  deliveryIdHeader: 'X-WC-Webhook-Delivery-ID',
  bodyLimitBytes: 262144,
  rateLimitPerMinute: 600,
  label: 'orders',
  status: 'active',
  lastFiredAt: null,
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
};
const FIRE = {
  fireId: 'f-1',
  triggerId: ID,
  firedAt: '2026-10-10T10:00:00.000Z',
  outcome: 'refused',
  detail: 'signature-invalid',
};

async function webhooks(
  argv: readonly string[],
  options: {
    trigger?: Record<string, unknown>;
    /** Thrown by the call of that name. */
    refuse?: { readonly register?: unknown };
  } = {},
) {
  const calls: unknown[][] = [];
  const trigger = options.trigger ?? TRIGGER;
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      const refused = (options.refuse as Record<string, unknown> | undefined)?.[name];
      if (refused !== undefined) throw refused;
      return result;
    };
  const out = await runCli({
    argv: ['webhooks', ...argv, '--url=https://x', '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () =>
      ({
        webhooks: {
          list: record('list', { data: [trigger], hasMore: false }),
          get: record('get', trigger),
          register: record('register', trigger),
          update: record('update', trigger),
          pause: record('pause', { ...trigger, status: 'paused' }),
          resume: record('resume', trigger),
          unregister: record('unregister', { triggerId: ID, unregistered: true }),
          fires: record('fires', { data: [FIRE], hasMore: false }),
          takeOwnership: record('takeOwnership', trigger),
        },
      }) as never,
  });
  return { out, calls };
}

describe('kindgi webhooks register', () => {
  test('--preset=woocommerce sets the scheme and the delivery-id header, and says where to paste them', async () => {
    const { out, calls } = await webhooks([
      'register',
      '--flow=acme.refund-review',
      '--flow-version=1.0.0',
      '--secret=acme-woo-secret',
      '--preset=woocommerce',
      '--project=p-1',
      '--label=orders',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'register',
        {
          flowId: 'acme.refund-review',
          flowVersion: '1.0.0',
          hmacSecretName: 'acme-woo-secret',
          signature: { kind: 'hmac-sha256', encoding: 'base64', header: 'X-WC-Webhook-Signature' },
          deliveryIdHeader: 'X-WC-Webhook-Delivery-ID',
          projectId: 'p-1',
          label: 'orders',
        },
      ],
    ]);
    expect(out.stderr).toContain(`Receive URL (the sender posts here): ${RECEIVE_URL}`);
    expect(out.stderr).toContain('Settings → Advanced → Webhooks');
  });

  test('--preset=drupal-webhooks: hex after `sha256=` in X-Hub-Signature-256, deduped on X-Drupal-Delivery', async () => {
    const { calls } = await webhooks([
      'register',
      '--flow=acme.content-review',
      '--flow-version=2.0.0',
      '--secret=acme-drupal',
      '--preset=drupal-webhooks',
    ]);
    expect(calls[0]?.[1]).toMatchObject({
      signature: {
        kind: 'hmac-sha256',
        encoding: 'hex',
        header: 'X-Hub-Signature-256',
        prefix: 'sha256=',
      },
      deliveryIdHeader: 'X-Drupal-Delivery',
    });
  });

  const GENERATE = [
    'register',
    '--flow=acme.refund-review',
    '--flow-version=1.0.0',
    '--secret=acme-woo-secret',
    '--generate-secret',
    '--preset=woocommerce',
  ];

  test('--generate-secret asks the runtime to make it, and shows it once', async () => {
    const value = 'Q7mZp2Lk9Xv4Rt8Bn3Wc6Yh1Jd5Fg0Sa2Ke7Uo4Hi';
    const { out, calls } = await webhooks(GENERATE, {
      trigger: {
        ...TRIGGER,
        hmacSecretScope: { kind: 'project', projectId: 'p-1' },
        signingSecret: value,
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    // One call: the runtime makes and stores it, in the trigger's project.
    expect(calls.map((c) => c[0])).toEqual(['register']);
    expect(calls[0]?.[1]).toMatchObject({
      hmacSecretName: 'acme-woo-secret',
      generateSecret: true,
    });
    expect(out.stderr).toContain(
      `Signing secret (stored as acme-woo-secret in project p-1; shown this once): ${value}`,
    );
  });

  test('--generate-secret --quiet: the signing secret alone on stdout, and no notes', async () => {
    const value = 'Q7mZp2Lk9Xv4Rt8Bn3Wc6Yh1Jd5Fg0Sa2Ke7Uo4Hi';
    const { out } = await webhooks([...GENERATE, '--quiet'], {
      trigger: {
        ...TRIGGER,
        hmacSecretScope: { kind: 'project', projectId: 'p-1' },
        signingSecret: value,
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toBe(`${value}\n`);
    expect(out.stderr).toBe('');
  });

  test('a secret its registrant administers no scope for: said plainly, with the fix', async () => {
    const { out } = await webhooks(
      GENERATE.filter((a) => a !== '--generate-secret'),
      {
        trigger: { ...TRIGGER, hmacSecretScope: null },
      },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain(
      `Nothing is read for acme-woo-secret until a project admin names it again (\`kindgi webhooks update ${ID} --secret=acme-woo-secret\`)`,
    );
  });

  test('--quiet: a secret nothing reads, and no receive URL, are still said; the notes are not', async () => {
    const { receiveUrl: _, ...noUrl } = TRIGGER;
    const { out } = await webhooks(
      [...GENERATE.filter((a) => a !== '--generate-secret'), '--quiet'],
      { trigger: { ...noUrl, hmacSecretScope: null } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe(
      [
        `  No receive URL: this deployment has no public URL configured. Set KINDGI_PUBLIC_URL on the runtime to the address your sender reaches it at, then \`kindgi webhooks get ${ID}\` shows it.`,
        `  Nothing is read for acme-woo-secret until a project admin names it again (\`kindgi webhooks update ${ID} --secret=acme-woo-secret\`): you don't administer a scope it could be read at. Or register with --generate-secret, which stores a new one in the project.`,
        '',
      ].join('\n'),
    );
  });

  test('--quiet with a receive URL and a readable secret: nothing on stderr', async () => {
    const { out } = await webhooks([
      ...GENERATE.filter((a) => a !== '--generate-secret'),
      '--quiet',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toBe('');
  });

  test('a named secret: nothing is made, and nothing is shown', async () => {
    const { out, calls } = await webhooks(GENERATE.filter((a) => a !== '--generate-secret'));
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls[0]?.[1]).not.toHaveProperty('generateSecret');
    expect(out.stderr).not.toContain('shown this once');
  });

  test('--generate-secret refused (the name is taken): the error as it came, and nothing shown', async () => {
    const { out } = await webhooks(GENERATE, {
      refuse: {
        register: new KindgiApiError({
          code: 'conflict',
          reason: 'secret-write-conflict',
          message:
            'A secret named acme-woo-secret already exists in local: name another, or name this one without `generateSecret`.',
        }),
      },
    });
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('A secret named acme-woo-secret already exists in local');
    expect(out.stderr).not.toContain('shown this once');
  });

  test('custom scheme flags; a preset and custom flags together are refused; an unknown preset too', async () => {
    const { calls } = await webhooks([
      'register',
      '--flow=a',
      '--flow-version=1',
      '--secret=s',
      '--signature-header=X-Signature',
      '--signature-encoding=hex',
      '--signature-prefix=v1=',
      '--delivery-id-header=X-Event-Id',
      '--body-limit=65536',
      '--rate-limit=120',
    ]);
    expect(calls[0]?.[1]).toMatchObject({
      signature: { kind: 'hmac-sha256', encoding: 'hex', header: 'X-Signature', prefix: 'v1=' },
      deliveryIdHeader: 'X-Event-Id',
      bodyLimitBytes: 65536,
      rateLimitPerMinute: 120,
    });
    const both = await webhooks([
      'register',
      '--flow=a',
      '--flow-version=1',
      '--secret=s',
      '--preset=github',
      '--signature-header=X',
    ]);
    expect(both.out.stderr).toContain('--preset sets the scheme');
    const unknown = await webhooks([
      'register',
      '--flow=a',
      '--flow-version=1',
      '--secret=s',
      '--preset=acme',
    ]);
    expect(unknown.out.stderr).toContain('--preset must be one of woocommerce|drupal-webhooks');
  });

  test('without a public URL, it says why there is no receive URL and how to get one', async () => {
    const { receiveUrl: _, ...noUrl } = TRIGGER;
    const { out } = await webhooks(['register', '--flow=a', '--flow-version=1', '--secret=s'], {
      trigger: noUrl,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain('No receive URL: this deployment has no public URL configured');
    expect(out.stderr).toContain('KINDGI_PUBLIC_URL');
  });
});

describe('kindgi webhooks: the rest of the group', () => {
  test('list with a project and a status, as a table', async () => {
    const { out, calls } = await webhooks(['list', '--project=p-1', '--status=active', '--table']);
    expect(calls).toEqual([['list', { projectId: 'p-1', status: 'active' }]]);
    expect(out.stdout).toContain('acme.refund-review@1.0.0');
    expect(out.stdout).toContain('base64 X-WC-Webhook-Signature');
    expect(out.stdout).toContain('RUNS AS');
    expect(out.stdout).toContain('Ada Lovelace (personal)');
  });

  test('list: a shared trigger names its service account; one with no owner says an admin can take it over', async () => {
    const shared = await webhooks(['list', '--table'], {
      trigger: { ...TRIGGER, owner: { kind: 'service', id: 'sa-1', displayName: 'acme-bot' } },
    });
    expect(shared.out.stdout).toContain('acme-bot (shared)');
    const none = await webhooks(['list', '--table'], {
      trigger: { ...TRIGGER, owner: { kind: 'service', id: 'unknown' } },
    });
    expect(none.out.stdout).toContain('no owner (an admin can take it over)');
    expect(none.out.stdout).not.toContain('(shared)');
  });

  test('pause says the events of a paused trigger are dropped', async () => {
    const { out, calls } = await webhooks(['pause', ID]);
    expect(calls).toEqual([['pause', ID]]);
    expect(out.stderr).toContain('their events are dropped');
    expect(out.stderr).toContain('WooCommerce never resends them');
  });

  test('update: a new version, another secret, and `none` stops deduping', async () => {
    const { calls } = await webhooks([
      'update',
      ID,
      '--flow-version=1.1.0',
      '--secret=acme-woo-secret-2',
      '--delivery-id-header=none',
    ]);
    expect(calls).toEqual([
      [
        'update',
        ID,
        { flowVersion: '1.1.0', hmacSecretName: 'acme-woo-secret-2', deliveryIdHeader: null },
      ],
    ]);
  });

  test('fires as a table; get prints the receive URL; resume, take-ownership and unregister by id', async () => {
    const fires = await webhooks(['fires', ID, '--table']);
    expect(fires.out.stdout).toContain('signature-invalid');
    const got = await webhooks(['get', ID]);
    expect(got.out.stderr).toContain(RECEIVE_URL);
    for (const [cmd, call] of [
      ['resume', 'resume'],
      ['take-ownership', 'takeOwnership'],
      ['unregister', 'unregister'],
    ] as const) {
      const { calls } = await webhooks([cmd, ID]);
      expect(calls).toEqual([[call, ID]]);
    }
  });

  test('--run-as names a service account on register and take-over', async () => {
    const BOT = '22222222-2222-4222-8222-222222222222';
    const reg = await webhooks([
      'register',
      '--flow=acme.refund-review',
      '--flow-version=1.0.0',
      '--secret=acme-woo-secret',
      `--run-as=${BOT}`,
    ]);
    expect(reg.out.exitCode, reg.out.stderr).toBe(0);
    expect(reg.calls[0]).toMatchObject(['register', { runAsServiceAccountId: BOT }]);

    const take = await webhooks(['take-ownership', ID, `--run-as=${BOT}`]);
    expect(take.calls).toEqual([['takeOwnership', ID, { runAsServiceAccountId: BOT }]]);
  });

  test('--allow-unattended: repeatable on register and update; `none` clears on update only', async () => {
    const reg = await webhooks([
      'register',
      '--flow=acme.refund-review',
      '--flow-version=1.0.0',
      '--secret=acme-woo-secret',
      '--allow-unattended=acme.refund',
      '--allow-unattended=acme.notify',
    ]);
    expect(reg.out.exitCode, reg.out.stderr).toBe(0);
    expect(reg.calls[0]).toMatchObject([
      'register',
      { toolsAllowedUnattended: ['acme.refund', 'acme.notify'] },
    ]);

    const cleared = await webhooks(['update', ID, '--allow-unattended=none']);
    expect(cleared.calls).toEqual([['update', ID, { toolsAllowedUnattended: [] }]]);
    const replaced = await webhooks(['update', ID, '--allow-unattended=acme.refund']);
    expect(replaced.calls).toEqual([['update', ID, { toolsAllowedUnattended: ['acme.refund'] }]]);
    const kept = await webhooks(['update', ID, '--label=orders']);
    expect(kept.calls).toEqual([['update', ID, { label: 'orders' }]]);

    const noneAtRegister = await webhooks([
      'register',
      '--flow=acme.refund-review',
      '--flow-version=1.0.0',
      '--secret=acme-woo-secret',
      '--allow-unattended=none',
    ]);
    expect(noneAtRegister.out.exitCode).not.toBe(0);
    expect(noneAtRegister.out.stderr).toContain(
      '--allow-unattended=none clears the list on update',
    );
    expect(noneAtRegister.calls).toEqual([]);
    const noneWithIds = await webhooks([
      'update',
      ID,
      '--allow-unattended=none',
      '--allow-unattended=acme.refund',
    ]);
    expect(noneWithIds.out.exitCode).not.toBe(0);
    expect(noneWithIds.calls).toEqual([]);
  });

  test('take-ownership names the tools the trigger keeps allowed unattended, when it lists any', async () => {
    const listed = await webhooks(['take-ownership', ID], {
      trigger: { ...TRIGGER, toolsAllowedUnattended: ['acme.refund'] },
    });
    expect(listed.out.exitCode, listed.out.stderr).toBe(0);
    expect(listed.out.stderr).toContain('It keeps its tools allowed unattended (acme.refund)');
    expect(listed.out.stderr).toContain(
      "their calls in its runs still don't wait for a person's yes just because no person started them, now as the new owner.",
    );
    expect(listed.out.stderr).toContain(`kindgi webhooks update ${ID} --allow-unattended=none`);
    const none = await webhooks(['take-ownership', ID]);
    expect(none.out.stderr).not.toContain('allowed unattended');
  });

  test('--quiet: get, pause and take-ownership say nothing; no receive URL and kept tools are still said', async () => {
    for (const argv of [
      ['get', ID],
      ['pause', ID],
      ['take-ownership', ID],
    ]) {
      const { out } = await webhooks([...argv, '--quiet']);
      expect(out.exitCode, out.stderr).toBe(0);
      expect([argv, out.stdout, out.stderr]).toEqual([argv, '', '']);
    }
    const { receiveUrl: _, ...noUrl } = TRIGGER;
    const got = await webhooks(['get', ID, '--quiet'], { trigger: noUrl });
    expect(got.out.stderr).toBe(
      `  No receive URL: this deployment has no public URL configured. Set KINDGI_PUBLIC_URL on the runtime to the address your sender reaches it at, then \`kindgi webhooks get ${ID}\` shows it.\n`,
    );
    const taken = await webhooks(['take-ownership', ID, '--quiet'], {
      trigger: { ...TRIGGER, toolsAllowedUnattended: ['acme.refund'] },
    });
    expect(taken.out.stderr).toContain('It keeps its tools allowed unattended (acme.refund)');
    expect(taken.out.stderr).not.toContain('now runs as');
  });
});
