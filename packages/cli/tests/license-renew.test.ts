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
import { type AddressInfo, createServer } from 'node:net';
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
import { type PushAnswer, atLeast, renewLicense } from '../src/license/renew.js';
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
    ['not a key', () => 'surprise', 'the answer held no license key (malformed)'],
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
      'Enroll this deployment first: kindgi license enroll --for <your GitHub login, or the em- id your key page shows> --renewer <where to keep its key>.',
    );

    const down = (async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
          code: 'ECONNREFUSED',
        }),
      });
    }) as unknown as typeof fetch;
    const unreachable = await renewLicense(d.input, deps(down));
    expect(unreachable.kind === 'failed' && unreachable.message).toContain(
      "https://access.kindgi.com couldn't be reached (connect ECONNREFUSED 127.0.0.1:443). The key in",
    );
    expect(unreachable.kind === 'failed' && unreachable.message).toContain(
      'is unchanged; try again later.',
    );
  });

  test.each([
    [
      'a refused connection, the cause in its code alone',
      new TypeError('fetch failed', {
        cause: Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }),
      }),
      '(ECONNREFUSED)',
    ],
    [
      'an unknown host',
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND access.kindgi.invalid'), {
          code: 'ENOTFOUND',
        }),
      }),
      '(getaddrinfo ENOTFOUND access.kindgi.invalid)',
    ],
    [
      'no answer in time',
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      '(no answer in time)',
    ],
    ['a fetch failure with no cause', new TypeError('fetch failed'), '(fetch failed)'],
  ])('unreachable, %s: says why', async (_label, thrown, why) => {
    const d = deployment(licenseKey());
    const down = (async () => {
      throw thrown;
    }) as unknown as typeof fetch;
    const out = await renewLicense(d.input, deps(down));
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && out.message).toContain(`couldn't be reached ${why}`);
  });

  test('unreachable through the real fetch: a closed port says the connection was refused', async () => {
    const closed = await new Promise<number>((done) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => done(port));
      });
    });
    const d = deployment(licenseKey());
    const out = await renewLicense(
      { ...d.input, origin: `http://127.0.0.1:${closed}` },
      { now: () => NOW, publicKeys },
    );
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && out.message).toMatch(/couldn't be reached \([^)]*ECONNREFUSED/);
  });

  test("an error answer without the service's own code (a 5xx, a proxy's page): failed, try again; nothing written", async () => {
    const key = licenseKey();
    const d = deployment(key);
    const html = (async () =>
      new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 503,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const out = await renewLicense(d.input, deps(html));
    expect(out).toMatchObject({ kind: 'failed' });
    expect(out.kind === 'failed' && out.message).toMatch(
      /^https:\/\/access\.kindgi\.com answered 503\. The key in .+ is unchanged; try again later\.$/,
    );
    expect(readFileSync(d.env, 'utf8')).toContain(`KINDGI_LICENSE_KEY=${key}\n`);
  });

  test("the service's own refusal keeps its code and words", async () => {
    const d = deployment(licenseKey());
    const s = service(d.renewer, () => ({
      status: 429,
      body: { error: 'rate-limited', message: 'Too many renewals; try in an hour.' },
    }));
    expect(await renewLicense(d.input, deps(s.fetchImpl))).toMatchObject({
      kind: 'refused',
      status: 429,
      error: 'rate-limited',
      message: 'Too many renewals; try in an hour.',
    });
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

describe('which key is newer', () => {
  test('the same expiry and an earlier iat: a rolled-back key, never written', async () => {
    const current = licenseKey({ iat: NOW / 1000 - 2 * DAY });
    const d = deployment(current);
    const older = licenseKey({ iat: NOW / 1000 - 3 * DAY });
    const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: older } }));
    const out = await renewLicense(d.input, deps(s.fetchImpl));
    expect(out.kind === 'failed' && out.message).toContain(
      'it expires with the current one and was issued before it',
    );
    expect(readFileSync(d.env, 'utf8')).toContain(`KINDGI_LICENSE_KEY=${current}\n`);
  });

  test('the same expiry and a later iat: newer, written', async () => {
    const d = deployment(licenseKey());
    const next = licenseKey({ iat: NOW / 1000 });
    const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: next } }));
    expect(await renewLicense(d.input, deps(s.fetchImpl))).toMatchObject({ kind: 'renewed' });
    expect(readFileSync(d.env, 'utf8')).toContain(`KINDGI_LICENSE_KEY=${next}\n`);
  });

  test('signed for longer than its kid allows: too-long, never written', async () => {
    const current = licenseKey();
    const d = deployment(current);
    const next = licenseKey({ iat: NOW / 1000, exp: NOW / 1000 + 46 * DAY });
    const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: next } }));
    const out = await renewLicense(d.input, {
      ...deps(s.fetchImpl),
      maxDays: { 'test-lk': 45 },
    });
    expect(out.kind === 'failed' && out.message).toContain(
      'it was signed for longer than its signing key allows (too-long)',
    );
    expect(readFileSync(d.env, 'utf8')).toContain(`KINDGI_LICENSE_KEY=${current}\n`);
  });

  test('a current key past its cap: renewed like any other, by a key within it', async () => {
    // 45 days, under a cap of 44.
    const d = deployment(licenseKey());
    const next = licenseKey({ iat: NOW / 1000, exp: NOW / 1000 + 44 * DAY });
    const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: next } }));
    const out = await renewLicense(d.input, { ...deps(s.fetchImpl), maxDays: { 'test-lk': 44 } });
    expect(out).toMatchObject({ kind: 'renewed' });
    expect(readFileSync(d.env, 'utf8')).toContain(`KINDGI_LICENSE_KEY=${next}\n`);
  });
});

describe('a new key handed to the running server first (--runtime)', () => {
  /** A second `kid`, for a renewal that changes it: signed by the same key here. */
  const PLAN_KID = 'test-lk-plan';
  const twoKids = { ...publicKeys, [PLAN_KID]: publicKeys['test-lk'] };

  /**
   * A renewal that answers a new key (signed with `nextKid`), with a server
   * that answers `answer`, recording what it saw.
   */
  async function pushed(
    answer: PushAnswer,
    minimumRuntime: Readonly<Record<string, string>> = {},
    nextKid = 'test-lk',
  ) {
    const current = licenseKey();
    const d = deployment(current);
    const next = licenseKey({ kid: nextKid, iat: NOW / 1000, exp: NOW / 1000 + 45 * DAY });
    const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: next } }));
    const handed: { key: string; file: string }[] = [];
    const out = await renewLicense(
      {
        ...d.input,
        push: async (key) => {
          handed.push({ key, file: readFileSync(d.env, 'utf8') });
          return answer;
        },
      },
      { ...deps(s.fetchImpl), publicKeys: twoKids, minimumRuntime },
    );
    return { out, current, next, handed, file: () => readFileSync(d.env, 'utf8') };
  }

  test('taken: written after the server took it, and it runs it now', async () => {
    const { out, current, next, handed, file } = await pushed({ kind: 'taken' });
    expect(out).toMatchObject({ kind: 'renewed', runtime: { kind: 'taken' } });
    expect(handed).toHaveLength(1);
    expect(handed[0]?.key).toBe(next);
    // Handed over before anything was written.
    expect(handed[0]?.file).toContain(`KINDGI_LICENSE_KEY=${current}\n`);
    expect(file()).toContain(`KINDGI_LICENSE_KEY=${next}\n`);
  });

  test('refused by the server: never written, whatever the key, saying why', async () => {
    for (const minimumRuntime of [{}, { [PLAN_KID]: '0.7.0' }]) {
      const { out, current, file } = await pushed(
        { kind: 'refused', error: 'license-key-refused', message: 'The key is older.' },
        minimumRuntime,
        PLAN_KID,
      );
      expect(out.kind).toBe('failed');
      expect(out.kind === 'failed' && out.message).toContain(
        "The runtime refused the new key (license-key-refused): The key is older. It wasn't written.",
      );
      expect(file()).toContain(`KINDGI_LICENSE_KEY=${current}\n`);
    }
  });

  test("a server that can't take one, or wasn't handed it: written for its next start, unless the key needs a later runtime", async () => {
    for (const answer of [
      { kind: 'absent', said: 'https://kindgi.acme.example has no PUT' },
      { kind: 'not-handed', said: "https://kindgi.acme.example couldn't be asked" },
    ] as const) {
      for (const [label, minimumRuntime] of [
        ['no minimum', {}],
        // A runtime that can't take a key can't say its release: a minimum
        // before 0.7.0 is written as it always was.
        ['a minimum before 0.7.0, rising', { [PLAN_KID]: '0.1.8' }],
        // The runtime that started with the current key starts with this one:
        // a server down for want of a new key gets it.
        ['0.7.0, as the current key needs', { 'test-lk': '0.7.0', [PLAN_KID]: '0.7.0' }],
        ['0.7.0, lower than the current key needs', { 'test-lk': '0.8.0', [PLAN_KID]: '0.7.0' }],
      ] as const) {
        const { out, next, file } = await pushed(answer, minimumRuntime, PLAN_KID);
        expect(out, `${answer.kind}, ${label}`).toMatchObject({
          kind: 'renewed',
          runtime: { kind: 'next-start', said: answer.said },
        });
        expect(file(), `${answer.kind}, ${label}`).toContain(`KINDGI_LICENSE_KEY=${next}\n`);
      }
    }
  });

  test("a key that needs a runtime which takes keys: never written beside one that can't", async () => {
    const absent = await pushed(
      { kind: 'absent', said: 'https://kindgi.acme.example has no PUT' },
      { [PLAN_KID]: '0.7.0' },
      PLAN_KID,
    );
    expect(absent.out.kind === 'failed' && absent.out.message).toContain(
      "The new key needs runtime 0.7.0 or later, and the runtime didn't take it (https://kindgi.acme.example has no PUT), so it wasn't written.",
    );
    expect(absent.out.kind === 'failed' && absent.out.message).toContain(
      'Upgrade the runtime first, then run renew again.',
    );
    expect(absent.file()).toContain(`KINDGI_LICENSE_KEY=${absent.current}\n`);
    // Rising from a minimum of its own.
    const notHanded = await pushed(
      { kind: 'not-handed', said: "https://kindgi.acme.example couldn't be asked" },
      { 'test-lk': '0.7.0', [PLAN_KID]: '0.8.1' },
      PLAN_KID,
    );
    expect(notHanded.out.kind === 'failed' && notHanded.out.message).toContain(
      'Run renew again once the runtime takes it.',
    );
    expect(notHanded.file()).toContain(`KINDGI_LICENSE_KEY=${notHanded.current}\n`);
  });

  test("without a server to hand it to: written, saying the runtime a key needs when an older one can't check it", async () => {
    for (const [minimumRuntime, needs] of [
      [{}, undefined],
      [{ [PLAN_KID]: '0.1.8' }, undefined],
      [{ [PLAN_KID]: '0.7.0' }, '0.7.0'],
      [{ 'test-lk': '0.7.0', [PLAN_KID]: '0.7.0' }, undefined],
    ] as const) {
      const d = deployment(licenseKey());
      const next = licenseKey({ kid: PLAN_KID, iat: NOW / 1000, exp: NOW / 1000 + 45 * DAY });
      const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: next } }));
      const out = await renewLicense(d.input, {
        ...deps(s.fetchImpl),
        publicKeys: twoKids,
        minimumRuntime,
      });
      expect(out.kind).toBe('renewed');
      expect(out.kind === 'renewed' && out.needsRuntime).toBe(needs);
      expect(readFileSync(d.env, 'utf8')).toContain(`KINDGI_LICENSE_KEY=${next}\n`);
    }
  });

  test('the same key: nothing handed over, nothing written', async () => {
    const key = licenseKey();
    const d = deployment(key);
    const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: key } }));
    let handed = 0;
    const out = await renewLicense(
      {
        ...d.input,
        push: async () => {
          handed++;
          return { kind: 'taken' };
        },
      },
      deps(s.fetchImpl),
    );
    expect(out.kind).toBe('unchanged');
    expect(handed).toBe(0);
  });

  test('which release is later: by major, minor, then patch', () => {
    expect(atLeast('0.7.0', '0.7.0')).toBe(true);
    expect(atLeast('0.10.0', '0.7.0')).toBe(true);
    expect(atLeast('1.0.0', '0.7.0')).toBe(true);
    expect(atLeast('0.7.1', '0.7.0')).toBe(true);
    expect(atLeast('0.6.9', '0.7.0')).toBe(false);
    expect(atLeast('0.1.8', '0.7.0')).toBe(false);
  });
});

describe('an unchanged key, handed to a running server that runs an older one (--runtime)', () => {
  /** When the kept key expires, in milliseconds (`licenseKey`'s default `exp`). */
  const KEPT_EXP = NOW + 25 * DAY * 1000;

  /**
   * An unchanged renewal, beside a server that says it runs a key expiring
   * at `running` and answers a key handed to it with `answer`.
   */
  async function unchanged(running: number | undefined, answer: PushAnswer = { kind: 'taken' }) {
    const key = licenseKey();
    const d = deployment(key);
    const before = readFileSync(d.env, 'utf8');
    const inode = statSync(d.env).ino;
    const s = service(d.renewer, () => ({ status: 200, body: { licenseKey: key } }));
    const handed: string[] = [];
    const out = await renewLicense(
      {
        ...d.input,
        push: async (handedKey) => {
          handed.push(handedKey);
          return answer;
        },
        running: async () => (running === undefined ? undefined : new Date(running)),
      },
      deps(s.fetchImpl),
    );
    const untouched = readFileSync(d.env, 'utf8') === before && statSync(d.env).ino === inode;
    return { out, key, handed, untouched };
  }

  test('a server that runs a key expiring earlier: handed the kept key, nothing written', async () => {
    const { out, key, handed, untouched } = await unchanged(KEPT_EXP - 30 * DAY * 1000);
    expect(out).toMatchObject({ kind: 'unchanged', runtime: { kind: 'taken' } });
    expect(handed).toEqual([key]);
    expect(untouched).toBe(true);
  });

  test('not taken: still unchanged, saying why, so the next run hands it over again', async () => {
    for (const [answer, said] of [
      [
        { kind: 'not-handed', said: "https://kindgi.acme.example couldn't be asked" },
        "https://kindgi.acme.example couldn't be asked",
      ],
      [
        { kind: 'absent', said: 'https://kindgi.acme.example has no PUT /v1/license' },
        'https://kindgi.acme.example has no PUT /v1/license',
      ],
      [
        { kind: 'refused', error: 'license-key-refused', message: 'The key is older.' },
        'license-key-refused: The key is older',
      ],
    ] as const) {
      const { out, handed, untouched } = await unchanged(KEPT_EXP - DAY * 1000, answer);
      expect(out, answer.kind).toMatchObject({
        kind: 'unchanged',
        runtime: { kind: 'next-start', said },
      });
      expect(handed, answer.kind).toHaveLength(1);
      expect(untouched, answer.kind).toBe(true);
    }
  });

  test("a server in step, or one that can't say: handed nothing", async () => {
    for (const [label, running] of [
      ['runs the kept key', KEPT_EXP],
      ['runs a later key', KEPT_EXP + DAY * 1000],
      ["can't say", undefined],
    ] as const) {
      const { out, handed, untouched } = await unchanged(running);
      expect(out.kind, label).toBe('unchanged');
      expect(out.kind === 'unchanged' && Object.keys(out), label).not.toContain('runtime');
      expect(handed, label).toEqual([]);
      expect(untouched, label).toBe(true);
    }
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
