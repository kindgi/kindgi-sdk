// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `kindgi webhooks`, through the client's `webhooks` (and `secrets`, for a generated secret). */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { generateSigningSecret } from '../src/commands/webhooks.js';
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
  options: { trigger?: Record<string, unknown>; secretExists?: boolean } = {},
) {
  const calls: unknown[][] = [];
  const trigger = options.trigger ?? TRIGGER;
  const record =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
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
        secrets: {
          set: record(
            'secrets.set',
            options.secretExists === true
              ? { kind: 'version-conflict', currentVersion: 1 }
              : { kind: 'ok', versionId: 1, record: { scope: { kind: 'tenant' } } },
          ),
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

  test('--generate-secret stores a letters-and-digits secret in --env and shows it once', async () => {
    const { out, calls } = await webhooks([
      'register',
      '--flow=acme.refund-review',
      '--flow-version=1.0.0',
      '--secret=acme-woo-secret',
      '--generate-secret',
      '--env=local',
      '--preset=woocommerce',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    const set = calls[0] as [string, { value: string; name: string; envName: string }];
    expect(set[0]).toBe('secrets.set');
    expect(set[1]).toMatchObject({
      scope: { kind: 'tenant' },
      envName: 'local',
      name: 'acme-woo-secret',
      writeMode: 'create-new',
    });
    expect(set[1].value).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(out.stderr).toContain(`shown this once): ${set[1].value}`);
    expect(calls[1]?.[0]).toBe('register');
  });

  test("--generate-secret needs --env, and won't overwrite a secret that exists", async () => {
    const noEnv = await webhooks([
      'register',
      '--flow=a',
      '--flow-version=1',
      '--secret=s',
      '--generate-secret',
    ]);
    expect(noEnv.out.exitCode).not.toBe(0);
    expect(noEnv.out.stderr).toContain('--generate-secret needs --env=<env>');
    expect(noEnv.calls).toEqual([]);

    const exists = await webhooks(
      [
        'register',
        '--flow=a',
        '--flow-version=1',
        '--secret=s',
        '--generate-secret',
        '--env=local',
      ],
      { secretExists: true },
    );
    expect(exists.out.exitCode).not.toBe(0);
    expect(exists.out.stderr).toContain('A secret named s already exists in local');
    expect(exists.calls.map((c) => c[0])).toEqual(['secrets.set']);
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
    expect(out.stdout).toContain('Ada Lovelace');
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
});

describe('a generated signing secret', () => {
  test('letters and digits for HMAC senders; `whsec_` and base64 for Standard Webhooks', () => {
    expect(generateSigningSecret(undefined)).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(
      generateSigningSecret({
        kind: 'hmac-sha256',
        encoding: 'base64',
        header: 'X-WC-Webhook-Signature',
      }),
    ).toMatch(/^[A-Za-z0-9]{40}$/);
    const sw = generateSigningSecret({ kind: 'standard-webhooks' });
    expect(sw).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(sw.slice(6), 'base64')).toHaveLength(32);
  });
});
