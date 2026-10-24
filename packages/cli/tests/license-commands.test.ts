// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi license enroll` and `kindgi license renew`, as a person or a
 * scheduler runs them: real files for the license key and the renewer
 * key, a stand-in for access.kindgi.com that checks every signature as
 * the service does. The renewer's private key never shows in any output.
 */

import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { KindgiApiError, type KindgiClient, createClient } from '@kindgi/client';

import { LICENSE_KEY_PREFIX } from '../src/license/license-key.js';
import {
  decodeRenewerPrivateKey,
  enrollSigningInput,
  renewSigningInput,
} from '../src/license/protocol.js';
import { runCli } from '../src/main.js';

const NOW = 1_791_500_000_000;
const DAY = 86_400;
const ORIGIN = 'https://access.kindgi.com';

const signer = generateKeyPairSync('ed25519');
const publicKeys = {
  'test-lk': Buffer.from(
    signer.publicKey.export({ format: 'jwk' }).x as string,
    'base64url',
  ).toString('base64'),
};

function licenseKey(over: Record<string, unknown> = {}): string {
  const payload = {
    v: 1,
    kid: 'test-lk',
    sub: 'dom-acme.example',
    name: 'acme.example',
    use: 'non-production',
    iat: NOW / 1000 - 20 * DAY,
    exp: NOW / 1000 + 25 * DAY,
    ...over,
  };
  const signed = `${LICENSE_KEY_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${signed}.${sign(null, Buffer.from(signed, 'ascii'), signer.privateKey).toString('base64url')}`;
}

function workdir() {
  return mkdtempSync(join(tmpdir(), 'kindgi-license-'));
}

const cli = (cwd: string, argv: string[], extra: Record<string, unknown> = {}) =>
  runCli({ argv, env: { HOME: cwd }, home: cwd, cwd, ...extra });

/**
 * The Azure module's alerts on the renewal job's log, read from its KQL, so
 * renew's wording and the queries can't drift apart with every test green.
 * Container Apps logs each line of stdout and stderr as `Log_s`, and an alert
 * fires on a run with a line its query keeps. A query line this doesn't read
 * stops the test: teach it the new one.
 */
const AZURE_RENEWAL_TF = fileURLToPath(
  new URL('../../../deploy/azure-container-apps/license-renewal.tf', import.meta.url),
);

// `| where Log_s <operator> <string>`, the string verbatim (@"…") or plain ("…").
const WHERE_LOG_S =
  /^\| where Log_s (matches regex|contains|!contains) (@"(?:[^"]|"")*"|"(?:[^"\\]|\\.)*")$/;

function azureAlert(resource: string): (line: string) => boolean {
  const tf = readFileSync(AZURE_RENEWAL_TF, 'utf8');
  const at = tf.indexOf(`"azurerm_monitor_scheduled_query_rules_alert_v2" "${resource}"`);
  const query = at < 0 ? undefined : /<<-KQL\n([\s\S]*?)\n\s*KQL\n/.exec(tf.slice(at))?.[1];
  if (query === undefined) throw new Error(`no query for ${resource} in ${AZURE_RENEWAL_TF}`);
  const [table, ...rest] = query.split('\n').map((line) => line.trim());
  expect(table, resource).toBe('ContainerAppConsoleLogs_CL');
  const keeps = rest
    .filter(
      (line) =>
        line !==
        '| where column_ifexists("ContainerJobName_s", "") == "${var.name_prefix}-license-renew"',
    )
    .map((line): ((log: string) => boolean) => {
      const where = WHERE_LOG_S.exec(line);
      if (where === null) {
        throw new Error(`${resource}: a query line this test doesn't read: ${line}`);
      }
      const [, operator, literal = ''] = where;
      // A verbatim string (@"…") doubles its quotes; a plain one escapes as JSON does.
      const text = literal.startsWith('@')
        ? literal.slice(2, -1).replaceAll('""', '"')
        : (JSON.parse(literal) as string);
      if (/[$%]\{/.test(text)) throw new Error(`${resource}: Terraform fills in ${text}`);
      if (operator === 'matches regex') {
        // KQL's regexes are RE2's, with no lookaround or backreference: one
        // would pass here and fail in Log Analytics.
        if (/\(\?<?[=!]|\\[1-9]|\\k</.test(text)) {
          throw new Error(`${resource}: RE2 has no lookaround or backreference: ${text}`);
        }
        const regex = new RegExp(text);
        return (log) => regex.test(log);
      }
      // KQL's contains ignores case.
      const has = (log: string) => log.toLowerCase().includes(text.toLowerCase());
      return operator === 'contains' ? has : (log) => !has(log);
    });
  if (keeps.length === 0) throw new Error(`${resource}: its query tests no Log_s`);
  return (line) => keeps.every((keep) => keep(line));
}

const fires = (alert: (line: string) => boolean, out: { stdout: string; stderr: string }) =>
  [...out.stdout.split('\n'), ...out.stderr.split('\n')].some(alert);

describe('kindgi license enroll', () => {
  test('makes the renewer key at --renewer (0600, never printed) and prints the line to add', async () => {
    const dir = workdir();
    const out = await cli(dir, [
      'license',
      'enroll',
      '--for',
      'Octo',
      '--renewer',
      'file:renewer.key',
    ]);
    expect(out.exitCode).toBe(0);
    const stored = readFileSync(join(dir, 'renewer.key'), 'utf8').trim();
    expect(stored).toMatch(/^kgi_lrk_/);
    expect(statSync(join(dir, 'renewer.key')).mode & 0o777).toBe(0o600);
    expect(`${out.stdout}${out.stderr}`).not.toContain(stored);
    expect(`${out.stdout}${out.stderr}`).not.toContain('kgi_lrk_');

    const key = decodeRenewerPrivateKey(stored);
    const line = out.stdout.match(/^ {2}(kgi_lrp_\S+)$/m)?.[1] ?? '';
    expect(out.stdout).toContain(
      `Renewer ${key?.renewerId}: its private key is in the file ${join(dir, 'renewer.key')}.`,
    );
    expect(out.stdout).toContain(
      'Add this deployment on https://access.kindgi.com, signed in as the person it\'s for (Octo), under "Renew the key from your deployment":',
    );
    expect(out.stdout).toContain(
      'kindgi license renew --key <where the license key is> --renewer file:renewer.key',
    );
    // The line is what the service checks: this key's signature, for octo, there.
    const [pub, account, signature] = line.split('.');
    expect(Buffer.from(account ?? '', 'base64url').toString()).toBe('octo');
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: (pub ?? '').slice(8) },
      format: 'jwk',
    });
    expect(
      verify(
        null,
        Buffer.from(enrollSigningInput(ORIGIN, key?.renewerId ?? '', 'octo')),
        publicKey,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
  });

  test('an email user: --for takes the em- id their key page shows, and the line is for it', async () => {
    const dir = workdir();
    const id = 'em-kqzt3xw7mfa2rb5ndl6hpye4cv';
    const out = await cli(dir, ['license', 'enroll', '--for', id, '--renewer', 'file:r.key']);
    expect(out.exitCode).toBe(0);
    // The page names an email user by their address, so the output doesn't call the id a sign-in.
    expect(out.stdout).toContain(`signed in as the person it's for (${id}), under`);
    const key = decodeRenewerPrivateKey(readFileSync(join(dir, 'r.key'), 'utf8').trim());
    const [pub, account, signature] = (out.stdout.match(/^ {2}(kgi_lrp_\S+)$/m)?.[1] ?? '').split(
      '.',
    );
    expect(Buffer.from(account ?? '', 'base64url').toString()).toBe(id);
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: (pub ?? '').slice(8) },
      format: 'jwk',
    });
    expect(
      verify(
        null,
        Buffer.from(enrollSigningInput(ORIGIN, key?.renewerId ?? '', id)),
        publicKey,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
  });

  test('again: the same key, the same line; --replace: a new one', async () => {
    const dir = workdir();
    const first = await cli(dir, ['license', 'enroll', '--for', 'octo', '--renewer', 'file:r.key']);
    const again = await cli(dir, ['license', 'enroll', '--for', 'octo', '--renewer', 'file:r.key']);
    expect(again.stdout).toContain('its private key is already in');
    const lineOf = (s: string) => s.match(/^ {2}(kgi_lrp_\S+)$/m)?.[1];
    expect(lineOf(again.stdout)).toBe(lineOf(first.stdout));
    const replaced = await cli(dir, [
      'license',
      'enroll',
      '--for',
      'octo',
      '--renewer',
      'file:r.key',
      '--replace',
    ]);
    expect(lineOf(replaced.stdout)).not.toBe(lineOf(first.stdout));
  });

  test('refused: a place holding something else, a login that isn’t one, a missing flag, a plain-http service', async () => {
    const dir = workdir();
    writeFileSync(join(dir, 'license.key'), `${licenseKey()}\n`);
    const occupied = await cli(dir, [
      'license',
      'enroll',
      '--for',
      'octo',
      '--renewer',
      'file:license.key',
    ]);
    expect(occupied.exitCode).toBe(2);
    expect(occupied.stderr).toContain("already holds something that isn't a renewer key");
    expect(readFileSync(join(dir, 'license.key'), 'utf8')).toBe(`${licenseKey()}\n`);
    for (const [argv, message] of [
      [
        ['--for', 'not a login', '--renewer', 'file:r'],
        '--for must be your GitHub login, or the em- id your key page shows. Got "not a login".',
      ],
      [
        ['--renewer', 'file:r'],
        '--for is required: your GitHub login, or the em- id your key page shows.',
      ],
      [['--for', 'octo'], '--renewer is required'],
      [
        ['--for', 'octo', '--renewer', 'renewer.key'],
        "--renewer: That isn't a place to keep a secret, and it isn't repeated here",
      ],
      [
        ['--for', 'octo', '--renewer', 'file:r', '--access-url', 'http://access.example.com'],
        '--access-url must be',
      ],
    ] as const) {
      const out = await cli(dir, ['license', 'enroll', ...argv]);
      expect([out.exitCode, out.stderr.includes(message)], message).toEqual([2, true]);
    }
  });
});

describe('kindgi license renew', () => {
  /** A deployment enrolled: its kindgi.env with a key, its renewer key file. */
  async function enrolled(current = licenseKey()) {
    const dir = workdir();
    writeFileSync(join(dir, 'kindgi.env'), `KINDGI_API_PORT=8080\nKINDGI_LICENSE_KEY=${current}\n`);
    await cli(dir, ['license', 'enroll', '--for', 'octo', '--renewer', 'file:renewer.key']);
    const renewer = decodeRenewerPrivateKey(readFileSync(join(dir, 'renewer.key'), 'utf8'));
    if (renewer === undefined) throw new Error('not enrolled');
    return { dir, renewer };
  }

  function service(
    renewer: NonNullable<ReturnType<typeof decodeRenewerPrivateKey>>,
    answer: () => Response,
  ) {
    return (async (url: string, init: RequestInit) => {
      const body = Buffer.from(String(init.body));
      const sig = Buffer.from(
        String((init.headers as Record<string, string>)['kindgi-renewer-signature']),
        'base64url',
      );
      const pub = createPublicKey({
        key: {
          kty: 'OKP',
          crv: 'Ed25519',
          x: Buffer.from(renewer.publicKey).toString('base64url'),
        },
        format: 'jwk',
      });
      if (
        String(url) !== `${ORIGIN}/v1/renew` ||
        !verify(null, Buffer.from(renewSigningInput(ORIGIN, body)), pub, sig)
      ) {
        return Response.json({ error: 'unauthorized', message: 'no' }, { status: 401 });
      }
      return answer();
    }) as unknown as typeof fetch;
  }

  const deps = { licenseDeps: { renew: { now: () => NOW, publicKeys } } };

  test('--env-file: a new key written in its line; one line saying so', async () => {
    const { dir, renewer } = await enrolled();
    const next = licenseKey({ iat: NOW / 1000, exp: NOW / 1000 + 45 * DAY });
    const out = await cli(
      dir,
      ['license', 'renew', '--env-file', 'kindgi.env', '--renewer', 'file:renewer.key'],
      { ...deps, fetchImpl: service(renewer, () => Response.json({ licenseKey: next })) },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.split('\n')).toEqual([
      `renewed: acme.example's non-production key, until ${new Date((NOW / 1000 + 45 * DAY) * 1000).toISOString().slice(0, 10)} (renewer ${renewer.renewerId})`,
      'The runtime uses the new key from its next start; until then it runs on the one it started with.',
      '',
    ]);
    expect(readFileSync(join(dir, 'kindgi.env'), 'utf8')).toBe(
      `KINDGI_API_PORT=8080\nKINDGI_LICENSE_KEY=${next}\n`,
    );
  });

  test('unchanged, with the 30-day warning when it’s close', async () => {
    const soon = licenseKey({ exp: NOW / 1000 + 10 * DAY });
    const { dir, renewer } = await enrolled(soon);
    const out = await cli(
      dir,
      [
        'license',
        'renew',
        '--key',
        'env-file:kindgi.env#KINDGI_LICENSE_KEY',
        '--renewer',
        'file:renewer.key',
      ],
      {
        ...deps,
        fetchImpl: service(renewer, () => Response.json({ licenseKey: soon })),
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(
      /^unchanged: acme\.example's non-production key, until \d{4}-\d{2}-\d{2}/,
    );
    expect(out.stdout).toContain(
      "⚠ It expires in 10 days. If renew keeps answering unchanged, stop this deployment's renewer at https://access.kindgi.com, then sign in there for a new key",
    );
  });

  // By the key's subject, as `kindgi doctor` and the runtime's banner say it:
  // a key Kindgi issued (any use) is extended with Kindgi; a self-serve one
  // (`gh-…`, `dom-…`, any use) comes from signing in.
  test.each([
    ['Kindgi issued, production', 'acme-prod', 'production', 'contact'],
    ['Kindgi issued, non-production', 'acme-eval', 'non-production', 'contact'],
    ['self-serve, production (a company domain)', 'dom-acme.example', 'production', 'sign in'],
  ])("a key %s: the warning's next step", async (_label, sub, use, next) => {
    const soon = licenseKey({ sub, name: 'Acme Corp', use, exp: NOW / 1000 + 10 * DAY });
    const { dir, renewer } = await enrolled(soon);
    const out = await cli(
      dir,
      ['license', 'renew', '--env-file', 'kindgi.env', '--renewer', 'file:renewer.key'],
      { ...deps, fetchImpl: service(renewer, () => Response.json({ licenseKey: soon })) },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`^unchanged: Acme Corp's ${use} key, until `));
    expect(out.stdout).toContain(
      next === 'contact'
        ? '⚠ It expires in 10 days. If renew keeps answering unchanged, write to contact@kindgi.com to extend the term.'
        : "⚠ It expires in 10 days. If renew keeps answering unchanged, stop this deployment's renewer at https://access.kindgi.com, then sign in there for a new key.",
    );
    expect(out.stdout).not.toContain(next === 'contact' ? 'sign in' : 'contact@kindgi.com');
  });

  // The Azure module's expiring alert, as its query reads this run's lines.
  test("the Azure module's expiring alert, from its query: within a week and past the key's date, not at 7 days", async () => {
    const expiring = azureAlert('license_key_expiring');
    for (const [days, raised] of [
      [6, true],
      [0, true],
      [-3, true],
      [7, false],
      [10, false],
    ] as const) {
      const key = licenseKey({ exp: NOW / 1000 + days * DAY });
      const { dir, renewer } = await enrolled(key);
      const out = await cli(
        dir,
        ['license', 'renew', '--env-file', 'kindgi.env', '--renewer', 'file:renewer.key'],
        { ...deps, fetchImpl: service(renewer, () => Response.json({ licenseKey: key })) },
      );
      expect(out.exitCode, `${days} days`).toBe(0);
      // The 30-day warning is there either way: the alert reads its days.
      expect(out.stdout, `${days} days`).toMatch(/^⚠ /m);
      expect(fires(expiring, out), `${days} days`).toBe(raised);
    }
  });

  test('refused, or nothing usable: exit 1, the reason on stderr, the key as it was', async () => {
    const { dir, renewer } = await enrolled();
    const before = readFileSync(join(dir, 'kindgi.env'), 'utf8');
    const refused = await cli(
      dir,
      ['license', 'renew', '--env-file', 'kindgi.env', '--renewer', 'file:renewer.key'],
      {
        ...deps,
        fetchImpl: service(renewer, () =>
          Response.json(
            { error: 'renewer-stopped', message: "This deployment's renewal was stopped." },
            { status: 403 },
          ),
        ),
      },
    );
    expect([refused.exitCode, refused.stderr]).toEqual([
      1,
      "refused (renewer-stopped): This deployment's renewal was stopped.\n",
    ]);
    const someoneElses = await cli(
      dir,
      ['license', 'renew', '--env-file', 'kindgi.env', '--renewer', 'file:renewer.key'],
      {
        ...deps,
        fetchImpl: service(renewer, () =>
          Response.json({ licenseKey: licenseKey({ sub: 'gh-1', name: 'mallory' }) }),
        ),
      },
    );
    expect(someoneElses.exitCode).toBe(1);
    expect(someoneElses.stderr).toContain("wasn't written: it's for mallory");
    expect(readFileSync(join(dir, 'kindgi.env'), 'utf8')).toBe(before);
  });

  /** A runtime's `license.usage`, recording what it was asked. */
  function runtime(answer: (since: Date) => Promise<Record<string, unknown>>) {
    const asked: { url: string; token: string; since: string }[] = [];
    const clientFactory = (url: string, token: string) =>
      ({
        license: {
          usage: async ({ since }: { since: Date }) => {
            asked.push({ url, token, since: since.toISOString() });
            return answer(since);
          },
        },
      }) as unknown as KindgiClient;
    return { asked, clientFactory };
  }
  const USAGE = {
    since: '2026-10-05T12:00:00.000Z',
    until: '2026-10-25T12:00:00.000Z',
    runtimeVersion: '0.1.8',
    runs: 1200,
    people: 4,
  };
  /** A new key, so a renewal that went through says `renewed:`. */
  const NEXT_KEY = licenseKey({ iat: NOW / 1000, exp: NOW / 1000 + 45 * DAY });
  const RENEW_WITH_RUNTIME = [
    'license',
    'renew',
    '--env-file',
    'kindgi.env',
    '--renewer',
    'file:renewer.key',
    '--runtime',
    'https://runtime.acme.example',
    '--runtime-token',
    'file:runtime.token',
  ];

  test("--runtime: the renewal carries the runtime's counts since the key was issued, signed with it", async () => {
    const { dir, renewer } = await enrolled();
    writeFileSync(join(dir, 'runtime.token'), 'kgi_bt_test\n');
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = service(renewer, () => Response.json({ licenseKey: licenseKey() }));
    const recording = (async (url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const rt = runtime(async () => ({ ...USAGE, projectsInProduction: 1, tenants: ['acme'] }));
    const out = await cli(dir, RENEW_WITH_RUNTIME, {
      ...deps,
      fetchImpl: recording,
      clientFactory: rt.clientFactory,
    });
    expect(out.exitCode).toBe(0);
    expect(rt.asked).toEqual([
      {
        url: 'https://runtime.acme.example',
        token: 'kgi_bt_test',
        since: new Date(NOW - 20 * DAY * 1000).toISOString(),
      },
    ]);
    // Counts only, the fields named: nothing else the runtime answers is sent.
    expect(bodies[0]?.usage).toEqual({ ...USAGE, projectsInProduction: 1 });
    expect(out.stdout).toContain(
      'counts: sent (1200 runs, 4 people, 1 in production since 2026-10-05, runtime 0.1.8)',
    );
  });

  test("a runtime that can't say: renewed without counts, and the line says why", async () => {
    const { dir, renewer } = await enrolled();
    writeFileSync(join(dir, 'runtime.token'), 'kgi_bt_test\n');
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = service(renewer, () => Response.json({ licenseKey: licenseKey() }));
    const recording = (async (url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const older = runtime(async () => {
      throw new KindgiApiError({
        code: 'not-found',
        message: 'Not Found',
        resource: { kind: 'route', id: '/v1/license/usage' },
      });
    });
    const out = await cli(dir, RENEW_WITH_RUNTIME, {
      ...deps,
      fetchImpl: recording,
      clientFactory: older.clientFactory,
    });
    expect(out.exitCode).toBe(0);
    expect(bodies[0]).not.toHaveProperty('usage');
    expect(out.stdout).toContain(
      "counts: not sent (https://runtime.acme.example answered 404: it doesn't report its use (GET /v1/license/usage)); this renewal goes without them.",
    );

    writeFileSync(join(dir, 'runtime.token'), '\n');
    const empty = await cli(dir, RENEW_WITH_RUNTIME, {
      ...deps,
      fetchImpl: recording,
      clientFactory: runtime(async () => USAGE).clientFactory,
    });
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("counts: not sent (there's no token in");
  });

  test("--runtime keeps the URL's path: a runtime served under a prefix", async () => {
    const { dir, renewer } = await enrolled();
    writeFileSync(join(dir, 'runtime.token'), 'kgi_bt_test\n');
    const rt = runtime(async () => USAGE);
    const argv = RENEW_WITH_RUNTIME.map((a) =>
      a === 'https://runtime.acme.example' ? 'https://acme.example/kindgi/' : a,
    );
    const out = await cli(dir, argv, {
      ...deps,
      fetchImpl: service(renewer, () => Response.json({ licenseKey: licenseKey() })),
      clientFactory: rt.clientFactory,
    });
    expect(out.exitCode).toBe(0);
    expect(rt.asked.map((a) => a.url)).toEqual(['https://acme.example/kindgi']);
  });

  test("a token that can't go in a header: never sent, never printed, and the key renews", async () => {
    for (const [inner, problem] of [
      ['\n', 'a line break'],
      ['\r\n', 'a line break'],
      ['\0', 'a control character'],
    ] as const) {
      const { dir, renewer } = await enrolled();
      writeFileSync(join(dir, 'runtime.token'), `kgi_bt_CANARYONE${inner}CANARYTWO\n`);
      const rt = runtime(async () => USAGE);
      const out = await cli(dir, RENEW_WITH_RUNTIME, {
        ...deps,
        fetchImpl: service(renewer, () => Response.json({ licenseKey: NEXT_KEY })),
        clientFactory: rt.clientFactory,
      });
      expect(out.exitCode, JSON.stringify(inner)).toBe(0);
      expect(rt.asked).toEqual([]);
      expect(out.stdout).toMatch(/^renewed: /);
      expect(out.stdout).toContain(
        `counts: not sent (the token in the file ${join(dir, 'runtime.token')} can't be sent in a header: it has ${problem}); this renewal goes without them.`,
      );
      expect(`${out.stdout}${out.stderr}`).not.toMatch(/CANARY/);
    }
  });

  test("a runtime's answer that isn't counts: renewed without them, the answer never quoted", async () => {
    for (const answer of [
      {},
      { ...USAGE, runs: { 'canary-tenant': 1 } },
      { ...USAGE, people: -1 },
      { ...USAGE, runs: 1.5 },
      { ...USAGE, projectsInProduction: '2' },
      { ...USAGE, since: 'canary-time' },
      // Times Date.parse takes, as access.kindgi.com doesn't: a name, an
      // offset (even a zero one), more than nine digits of a second, a day
      // that doesn't exist, a time before any key.
      { ...USAGE, since: 'canary 2026' },
      { ...USAGE, until: 'canary@acme.example 2026' },
      { ...USAGE, since: '2026-10-05T14:00:00+02:00' },
      { ...USAGE, since: '2026-10-05T12:00:00+00:00' },
      { ...USAGE, until: '2026-10-25T12:00:00.0000000000Z' },
      { ...USAGE, since: '2026-02-30T00:00:00Z' },
      { ...USAGE, since: '2025-12-31T23:59:59Z' },
      { ...USAGE, since: USAGE.until, until: USAGE.since },
      { ...USAGE, runs: 1_000_000_001 },
      { ...USAGE, runtimeVersion: 'canary version with spaces' },
      { ...USAGE, runtimeVersion: `0.${'1'.repeat(80)}` },
    ]) {
      const { dir, renewer } = await enrolled();
      writeFileSync(join(dir, 'runtime.token'), 'kgi_bt_test\n');
      const bodies: Record<string, unknown>[] = [];
      const fetchImpl = service(renewer, () => Response.json({ licenseKey: NEXT_KEY }));
      const recording = (async (url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return fetchImpl(url, init);
      }) as unknown as typeof fetch;
      const out = await cli(dir, RENEW_WITH_RUNTIME, {
        ...deps,
        fetchImpl: recording,
        clientFactory: runtime(async () => answer as Record<string, unknown>).clientFactory,
      });
      const what = JSON.stringify(answer);
      expect(out.exitCode, what).toBe(0);
      expect(out.stdout, what).toMatch(/^renewed: /);
      expect(bodies[0], what).not.toHaveProperty('usage');
      expect(out.stdout, what).toContain(
        "counts: not sent (the runtime's answer isn't counts); this renewal goes without them.",
      );
      expect(`${out.stdout}${out.stderr}`, what).not.toMatch(/canary|1111/);
    }
  });

  test('counts at the edges access.kindgi.com keeps are sent: a version with `_`, a billion runs', async () => {
    const { dir, renewer } = await enrolled();
    writeFileSync(join(dir, 'runtime.token'), 'kgi_bt_test\n');
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = service(renewer, () => Response.json({ licenseKey: NEXT_KEY }));
    const recording = (async (url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const edge = { ...USAGE, runtimeVersion: '0.1.8+build_7', runs: 1_000_000_000 };
    const out = await cli(dir, RENEW_WITH_RUNTIME, {
      ...deps,
      fetchImpl: recording,
      clientFactory: runtime(async () => edge).clientFactory,
    });
    expect(out.exitCode).toBe(0);
    expect(bodies[0]?.usage).toEqual(edge);
    expect(out.stdout).toContain(
      'counts: sent (1000000000 runs, 4 people since 2026-10-05, runtime 0.1.8+build_7)',
    );
  });

  test("a production key's renewal: the runtime isn't asked", async () => {
    const { dir, renewer } = await enrolled(licenseKey({ use: 'production' }));
    writeFileSync(join(dir, 'runtime.token'), 'kgi_bt_test\n');
    const rt = runtime(async () => USAGE);
    const out = await cli(dir, RENEW_WITH_RUNTIME, {
      ...deps,
      fetchImpl: service(renewer, () =>
        Response.json({ licenseKey: licenseKey({ use: 'production' }) }),
      ),
      clientFactory: rt.clientFactory,
    });
    expect(rt.asked).toEqual([]);
    expect(out.stdout).toContain(
      "counts: not sent (a production key's renewal carries no counts); this renewal goes without them.",
    );
  });

  test("a runtime that can't be reached, through the client: what stopped it", async () => {
    const { dir, renewer } = await enrolled();
    writeFileSync(join(dir, 'runtime.token'), 'kgi_bt_test\n');
    const refused = (async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), {
          code: 'ECONNREFUSED',
        }),
      });
    }) as unknown as typeof fetch;
    const out = await cli(dir, RENEW_WITH_RUNTIME, {
      ...deps,
      fetchImpl: service(renewer, () => Response.json({ licenseKey: licenseKey() })),
      clientFactory: (url: string, token: string) =>
        createClient({ apiUrl: url, auth: { kind: 'apiToken', token }, fetch: refused }),
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(
      "counts: not sent (https://runtime.acme.example couldn't be asked (connect ECONNREFUSED 10.0.0.5:443)); this renewal goes without them.",
    );
  });

  test("a 200 that isn't JSON, through the client: an answer, not counts, its body never quoted", async () => {
    const { dir, renewer } = await enrolled();
    writeFileSync(join(dir, 'runtime.token'), 'kgi_bt_test\n');
    // An auth proxy's sign-in page, answered with 200.
    const signIn = (async () =>
      new Response('<!DOCTYPE html><title>canary sign-in</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const out = await cli(dir, RENEW_WITH_RUNTIME, {
      ...deps,
      fetchImpl: service(renewer, () => Response.json({ licenseKey: licenseKey() })),
      clientFactory: (url: string, token: string) =>
        createClient({ apiUrl: url, auth: { kind: 'apiToken', token }, fetch: signIn }),
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(
      'counts: not sent (https://runtime.acme.example answered, but not with counts: a page from a proxy or another server, perhaps); this renewal goes without them.',
    );
    expect(`${out.stdout}${out.stderr}`).not.toMatch(/canary|DOCTYPE|JSON/);
  });

  test('a runtime with no answer in time, through the client: said so', async () => {
    const { dir, renewer } = await enrolled();
    writeFileSync(join(dir, 'runtime.token'), 'kgi_bt_test\n');
    const silent = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const out = await cli(dir, RENEW_WITH_RUNTIME, {
      ...deps,
      fetchImpl: service(renewer, () => Response.json({ licenseKey: licenseKey() })),
      clientFactory: (url: string, token: string) =>
        createClient({
          apiUrl: url,
          auth: { kind: 'apiToken', token },
          fetch: silent,
          timeoutMs: 20,
        }),
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(
      "counts: not sent (https://runtime.acme.example couldn't be asked (no answer in time)); this renewal goes without them.",
    );
  });

  test('held for review: the counts line, then the refusal, exit 1', async () => {
    const { dir, renewer } = await enrolled();
    writeFileSync(join(dir, 'runtime.token'), 'kgi_bt_test\n');
    const out = await cli(dir, RENEW_WITH_RUNTIME, {
      ...deps,
      fetchImpl: service(renewer, () =>
        Response.json(
          { error: 'held-for-review', message: 'Write to contact@kindgi.com.' },
          { status: 403 },
        ),
      ),
      clientFactory: runtime(async () => USAGE).clientFactory,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr.split('\n')).toEqual([
      'counts: sent (1200 runs, 4 people since 2026-10-05, runtime 0.1.8)',
      'refused (held-for-review): Write to contact@kindgi.com.',
      '',
    ]);
  });

  // The Azure module's counts alert, as its query reads this run's lines.
  test("the Azure module's counts alert, from its query: renewed, unchanged or refused without counts, never with them or a production key's", async () => {
    const notSent = azureAlert('license_counts_not_sent');
    const notFound = runtime(async () => {
      throw new KindgiApiError({
        code: 'not-found',
        message: 'Not Found',
        resource: { kind: 'route', id: '/v1/license/usage' },
      });
    });
    const current = licenseKey();
    const { dir, renewer } = await enrolled(current);
    writeFileSync(join(dir, 'runtime.token'), 'kgi_bt_test\n');
    const renew = (answer: () => Response, clientFactory = notFound.clientFactory) =>
      cli(dir, RENEW_WITH_RUNTIME, {
        ...deps,
        fetchImpl: service(renewer, answer),
        clientFactory,
      });

    const renewed = await renew(() => Response.json({ licenseKey: NEXT_KEY }));
    expect(renewed.exitCode).toBe(0);
    expect(renewed.stdout).toMatch(/^renewed: /);
    expect(fires(notSent, renewed), 'renewed').toBe(true);
    writeFileSync(join(dir, 'kindgi.env'), `KINDGI_API_PORT=8080\nKINDGI_LICENSE_KEY=${current}\n`);

    const unchanged = await renew(() => Response.json({ licenseKey: current }));
    expect(unchanged.exitCode).toBe(0);
    expect(unchanged.stdout).toMatch(/^unchanged: /);
    expect(fires(notSent, unchanged), 'unchanged').toBe(true);

    const refused = await renew(() =>
      Response.json(
        { error: 'held-for-review', message: 'Write to contact@kindgi.com.' },
        { status: 403 },
      ),
    );
    expect(refused.exitCode).toBe(1);
    expect(fires(notSent, refused), 'refused').toBe(true);

    const sent = await renew(
      () => Response.json({ licenseKey: current }),
      runtime(async () => USAGE).clientFactory,
    );
    expect(sent.stdout).toMatch(/^counts: sent \(/m);
    expect(fires(notSent, sent), 'sent').toBe(false);

    const production = licenseKey({ use: 'production' });
    writeFileSync(
      join(dir, 'kindgi.env'),
      `KINDGI_API_PORT=8080\nKINDGI_LICENSE_KEY=${production}\n`,
    );
    const productions = await renew(() => Response.json({ licenseKey: production }));
    expect(productions.exitCode).toBe(0);
    // Its counts line is there, and the alert leaves it out.
    expect(productions.stdout).toMatch(/^counts: not sent \(/m);
    expect(fires(notSent, productions), "a production key's").toBe(false);
  });

  test('--runtime and --runtime-token go together; --runtime is a URL', async () => {
    const { dir } = await enrolled();
    const base = ['license', 'renew', '--env-file', 'kindgi.env', '--renewer', 'file:renewer.key'];
    for (const extra of [
      ['--runtime', 'https://runtime.acme.example'],
      ['--runtime-token', 'file:runtime.token'],
      ['--runtime', 'not a url canary', '--runtime-token', 'file:runtime.token'],
      ['--runtime', 'ftp://runtime.acme.example', '--runtime-token', 'file:runtime.token'],
      [
        '--runtime',
        'https://operator:canary-password@runtime.acme.example',
        '--runtime-token',
        'file:runtime.token',
      ],
      // The token itself where its reference goes.
      ['--runtime', 'https://runtime.acme.example', '--runtime-token', 'kgi_bt_canary'],
    ]) {
      const out = await cli(dir, [...base, ...extra], deps);
      expect(out.exitCode, extra.join(' ')).toBe(2);
      expect(out.stderr, extra.join(' ')).toMatch(/--runtime/);
      expect(`${out.stdout}${out.stderr}`, extra.join(' ')).not.toMatch(/canary/);
    }
  });

  test('--key or --env-file, one of them; --renewer required', async () => {
    const dir = workdir();
    for (const [argv, message] of [
      [['--renewer', 'file:r'], 'Give --key <ref> or --env-file <path>'],
      [
        ['--key', 'file:k', '--env-file', 'kindgi.env', '--renewer', 'file:r'],
        'Give --key <ref> or --env-file <path>',
      ],
      [['--env-file', 'kindgi.env'], '--renewer is required'],
    ] as const) {
      const out = await cli(dir, ['license', 'renew', ...argv]);
      expect([out.exitCode, out.stderr.includes(message)], message).toEqual([2, true]);
    }
  });
});
