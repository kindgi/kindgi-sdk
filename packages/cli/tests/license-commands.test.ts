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

import { describe, expect, test } from 'vitest';

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
      'Add this deployment on https://access.kindgi.com, signed in as Octo',
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
      [['--for', 'not a login', '--renewer', 'file:r'], '--for must be a GitHub login'],
      [['--renewer', 'file:r'], '--for is required'],
      [['--for', 'octo'], '--renewer is required'],
      [
        ['--for', 'octo', '--renewer', 'renewer.key'],
        '--renewer: "renewer.key" isn\'t a place to keep a secret',
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
      '⚠ It expires in 10 days. If renew keeps answering unchanged, sign in at https://access.kindgi.com',
    );
  });

  test("a production key's warning says to extend the term with Kindgi, not to sign in", async () => {
    const soon = licenseKey({
      sub: 'acme-prod',
      name: 'Acme Corp',
      use: 'production',
      exp: NOW / 1000 + 10 * DAY,
    });
    const { dir, renewer } = await enrolled(soon);
    const out = await cli(
      dir,
      ['license', 'renew', '--env-file', 'kindgi.env', '--renewer', 'file:renewer.key'],
      { ...deps, fetchImpl: service(renewer, () => Response.json({ licenseKey: soon })) },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/^unchanged: Acme Corp's production key, until /);
    expect(out.stdout).toContain(
      '⚠ It expires in 10 days. If renew keeps answering unchanged, write to contact@kindgi.com to extend the term.',
    );
    expect(out.stdout).not.toContain('sign in');
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
