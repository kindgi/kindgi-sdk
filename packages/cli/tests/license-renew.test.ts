// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * One renewal against a stand-in for access.kindgi.com that checks each
 * request's signature as the service does, with the license key and the
 * renewer key in real files: the key is written only when it's new and
 * the runtime would take it; anything else leaves the file as it was.
 */

import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { LICENSE_KEY_PREFIX } from '../src/license/license-key.js';
import {
  type RenewerKey,
  encodeRenewerPrivateKey,
  generateRenewerKey,
  renewSigningInput,
} from '../src/license/protocol.js';
import { renewLicense } from '../src/license/renew.js';
import { SecretRefError, secretStoreFor } from '../src/license/stores.js';

const ORIGIN = 'https://access.kindgi.com';
const NOW = 1_791_500_000_000;
const DAY = 86_400;

/** Kindgi's license signing key, for these tests. */
const signer = generateKeyPairSync('ed25519');
const publicKeys = {
  'test-lk': Buffer.from(
    signer.publicKey.export({ format: 'jwk' }).x as string,
    'base64url',
  ).toString('base64'),
};

function licenseKey(over: Record<string, unknown> = {}, by = signer.privateKey): string {
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
  return `${signed}.${sign(null, Buffer.from(signed, 'ascii'), by).toString('base64url')}`;
}

/** access.kindgi.com, as far as one renewal goes: the signature checked, then `answer`. */
function service(renewer: RenewerKey, answer: () => { status: number; body: unknown }) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push(String(url));
    const body = Buffer.from(String(init.body));
    const signature = Buffer.from(
      String((init.headers as Record<string, string>)['kindgi-renewer-signature']),
      'base64url',
    );
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(renewer.publicKey).toString('base64url') },
      format: 'jwk',
    });
    const parsed = JSON.parse(body.toString()) as { renewerId: string; ts: number };
    if (
      !verify(null, Buffer.from(renewSigningInput(ORIGIN, body)), publicKey, signature) ||
      parsed.renewerId !== renewer.renewerId ||
      parsed.ts !== NOW / 1000
    ) {
      return Response.json({ error: 'unauthorized', message: 'no' }, { status: 401 });
    }
    const { status, body: out } = answer();
    return Response.json(out, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function deployment(current: string | undefined, envMode = 0o640) {
  const dir = mkdtempSync(join(tmpdir(), 'kindgi-renew-'));
  const env = join(dir, 'kindgi.env');
  writeFileSync(
    env,
    `# kindgi.env\nKINDGI_DATABASE_URL=postgres://db/kindgi\n${current === undefined ? '' : `KINDGI_LICENSE_KEY=${current}\n`}KINDGI_API_PORT=8080\n`,
    { mode: envMode },
  );
  const renewer = generateRenewerKey();
  const renewerFile = join(dir, 'renewer.key');
  writeFileSync(renewerFile, `${encodeRenewerPrivateKey(renewer)}\n`, { mode: 0o600 });
  return {
    env,
    renewer,
    input: {
      key: secretStoreFor(`env-file:${env}#KINDGI_LICENSE_KEY`),
      renewer: secretStoreFor(`file:${renewerFile}`),
      origin: ORIGIN,
    },
  };
}

const deps = (fetchImpl: typeof fetch) => ({ fetch: fetchImpl, now: () => NOW, publicKeys });

describe('a renewal', () => {
  test('the same key: unchanged, nothing written', async () => {
    const key = licenseKey();
    const d = deployment(key);
    const before = readFileSync(d.env, 'utf8');
    const inode = statSync(d.env).ino;
    const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: key } }));
    const out = await renewLicense(d.input, deps(s.fetchImpl));
    expect(out).toMatchObject({ kind: 'unchanged', renewerId: d.renewer.renewerId });
    expect(readFileSync(d.env, 'utf8')).toBe(before);
    // Not rewritten either: a write replaces the file (a new inode).
    expect(statSync(d.env).ino).toBe(inode);
    expect(s.seen).toEqual(['https://access.kindgi.com/v1/renew']);
  });

  test('a new key: written in its line, the rest of the file and its mode kept', async () => {
    const d = deployment(licenseKey());
    const next = licenseKey({ iat: NOW / 1000, exp: NOW / 1000 + 45 * DAY });
    const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: next } }));
    const out = await renewLicense(d.input, deps(s.fetchImpl));
    expect(out).toMatchObject({ kind: 'renewed', claims: { subject: 'dom-acme.example' } });
    expect(readFileSync(d.env, 'utf8')).toBe(
      `# kindgi.env\nKINDGI_DATABASE_URL=postgres://db/kindgi\nKINDGI_LICENSE_KEY=${next}\nKINDGI_API_PORT=8080\n`,
    );
    expect(statSync(d.env).mode & 0o777).toBe(0o640);
  });

  test('refused by the service: its code and message, nothing written', async () => {
    const key = licenseKey();
    const d = deployment(key);
    const s = service(d.renewer, () => ({
      status: 403,
      body: { error: 'renewer-stopped', message: "This deployment's renewal was stopped." },
    }));
    expect(await renewLicense(d.input, deps(s.fetchImpl))).toEqual({
      kind: 'refused',
      status: 403,
      error: 'renewer-stopped',
      message: "This deployment's renewal was stopped.",
      renewerId: d.renewer.renewerId,
    });
    expect(readFileSync(d.env, 'utf8')).toContain(`KINDGI_LICENSE_KEY=${key}\n`);
  });

  test.each([
    [
      'for another licensee',
      () => licenseKey({ sub: 'gh-1', name: 'mallory' }),
      "it's for mallory",
    ],
    ['another use', () => licenseKey({ use: 'production' }), "it's a production key"],
    [
      'expiring sooner',
      () => licenseKey({ exp: NOW / 1000 + 2 * DAY }),
      'expires before the current one',
    ],
    [
      'signed by someone else',
      () => licenseKey({}, generateKeyPairSync('ed25519').privateKey),
      'bad-signature',
    ],
    ['a kid this CLI doesn’t know', () => licenseKey({ kid: 'lk-2099-1' }), 'update the CLI'],
    ['not a key', () => 'surprise', 'malformed'],
  ])('an answer %s is never written', async (_label, answer, why) => {
    const key = licenseKey();
    const d = deployment(key);
    const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: answer() } }));
    const out = await renewLicense(d.input, deps(s.fetchImpl));
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && out.message).toContain(why);
    expect(readFileSync(d.env, 'utf8')).toContain(`KINDGI_LICENSE_KEY=${key}\n`);
  });

  test('nothing to renew, no renewer key, or no answer: said plainly, nothing written', async () => {
    const none = deployment(undefined);
    const s = service(none.renewer, () => ({ status: 200, body: {} }));
    const noKey = await renewLicense(none.input, deps(s.fetchImpl));
    expect(noKey.kind === 'failed' && noKey.message).toContain(
      'The first one comes from signing in at access.kindgi.com',
    );
    expect(s.seen).toEqual([]);

    const d = deployment(licenseKey());
    const noRenewer = await renewLicense(
      { ...d.input, renewer: secretStoreFor(`file:${d.env}.missing`) },
      deps(s.fetchImpl),
    );
    expect(noRenewer.kind === 'failed' && noRenewer.message).toContain(
      'kindgi license enroll --for',
    );

    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const unreachable = await renewLicense(d.input, deps(down));
    expect(unreachable.kind === 'failed' && unreachable.message).toContain(
      "https://access.kindgi.com couldn't be reached (fetch failed)",
    );
  });

  test('signed for this service only: another origin is refused by it', async () => {
    const d = deployment(licenseKey());
    const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: licenseKey() } }));
    const out = await renewLicense(
      { ...d.input, origin: 'https://access-staging.kindgi.com' },
      deps(s.fetchImpl),
    );
    expect(out).toMatchObject({ kind: 'refused', status: 401 });
  });
});

describe('where a secret is kept', () => {
  test('file: a new one is 0600; a replaced one keeps its mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kindgi-store-'));
    const store = secretStoreFor(`file:${join(dir, 'k')}`);
    expect(await store.read()).toBeUndefined();
    await store.write('one');
    expect(statSync(join(dir, 'k')).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, 'k'), 'two\n');
    chmodSync(join(dir, 'k'), 0o644);
    await store.write('three');
    expect(await store.read()).toBe('three');
    expect(statSync(join(dir, 'k')).mode & 0o777).toBe(0o644);
  });

  test('env-file: export and quotes read; a missing line appended; a missing file created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kindgi-store-'));
    const path = join(dir, 'kindgi.env');
    writeFileSync(path, 'A=1\nexport KINDGI_LICENSE_KEY="kgi_lk_x.y"\n');
    const store = secretStoreFor(`env-file:${path}#KINDGI_LICENSE_KEY`);
    expect(await store.read()).toBe('kgi_lk_x.y');
    await store.write('kgi_lk_a.b');
    expect(readFileSync(path, 'utf8')).toBe('A=1\nexport KINDGI_LICENSE_KEY=kgi_lk_a.b\n');
    const other = secretStoreFor(`env-file:${path}#OTHER`);
    await other.write('v');
    expect(readFileSync(path, 'utf8')).toBe('A=1\nexport KINDGI_LICENSE_KEY=kgi_lk_a.b\nOTHER=v\n');
    const fresh = secretStoreFor(`env-file:${join(dir, 'new.env')}#K`);
    await fresh.write('v');
    expect(readFileSync(join(dir, 'new.env'), 'utf8')).toBe('K=v\n');
    expect(statSync(join(dir, 'new.env')).mode & 0o777).toBe(0o600);
  });

  test('a reference that names no place is refused, saying what one looks like', () => {
    for (const ref of [
      'kindgi.env',
      'env-file:kindgi.env',
      'env-file:#K',
      'file:',
      's3://bucket/k',
      'env-file:x#1BAD',
    ]) {
      expect(() => secretStoreFor(ref), ref).toThrow(SecretRefError);
    }
    expect(() => secretStoreFor('kindgi.env')).toThrow(
      `Use file:<path>, env-file:<path>#<NAME> (for example env-file:kindgi.env#KINDGI_LICENSE_KEY), gcp:projects/<project>/secrets/<name>, azure:https://<vault>.vault.azure.net/secrets/<name>, or aws:<region>:<secret name> (or aws:<the secret's ARN>).`,
    );
  });
});
