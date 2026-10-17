// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A statement the plugin signs (PHP, libsodium) verifies as Kindgi checks
 * one: against the enrolled public JWK alone, EdDSA and the media type
 * pinned. Its `kid` is the key's RFC 7638 thumbprint.
 *
 * Runs PHP: `KINDGI_PHP` is the command (default `php`; a command with
 * arguments is split on spaces), and `KINDGI_PHP_PLUGIN_DIR` is the
 * plugin's folder as that PHP sees it (default: this folder's parent).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [php, ...phpArgs] = (process.env.KINDGI_PHP ?? 'php').split(' ').filter(Boolean);
const pluginDir = process.env.KINDGI_PHP_PLUGIN_DIR ?? join(here, '..');

const SITE = {
  site_id: '7c1f3a52-9d84-4c1e-b6a0-2f5e8d9c0b17',
  audience: 'https://kindgi.acme.example',
};

function sign(person) {
  const input = {
    seed: randomBytes(32).toString('base64'),
    site: SITE,
    person,
    now: Math.floor(Date.now() / 1000),
    jti: 'jti-1',
  };
  const out = execFileSync(
    php,
    [...phpArgs, `${pluginDir}/tests/sign.php`, JSON.stringify(input)],
    {
      encoding: 'utf8',
    },
  );
  return { ...JSON.parse(out), now: input.now };
}

const part = (jws, index) =>
  JSON.parse(Buffer.from(jws.split('.')[index], 'base64url').toString('utf8'));

/** Kindgi's check: the signature, under the enrolled key only. */
function verifies(statement, jwk) {
  const [header, payload, signature] = statement.split('.');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  return verify(
    null,
    Buffer.from(`${header}.${payload}`),
    key,
    Buffer.from(signature, 'base64url'),
  );
}

test('verifies under the enrolled public key, with the header and claims Kindgi pins', () => {
  const { jwk, statement, now } = sign({
    subject: 'b2f4c0de-1111-4222-8333-944455556666',
    name: 'Zoë 𝒜da',
    roles: ['shop_manager'],
    email: 'zoe@acme-store.example',
  });
  assert.equal(statement.split('.').length, 3);
  assert.deepEqual(part(statement, 0), { alg: 'EdDSA', typ: 'kindgi-site+jwt', kid: jwk.kid });
  assert.deepEqual(part(statement, 1), {
    iss: SITE.site_id,
    aud: SITE.audience,
    sub: 'b2f4c0de-1111-4222-8333-944455556666',
    iat: now,
    exp: now + 60,
    jti: 'jti-1',
    name: 'Zoë 𝒜da',
    roles: ['shop_manager'],
    email: 'zoe@acme-store.example',
  });
  assert.ok(verifies(statement, jwk));
});

test("the kid is the key's RFC 7638 thumbprint, and only the public half is in the JWK", () => {
  const { jwk } = sign({ subject: 's', name: 'Ada', roles: [] });
  assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'kid', 'kty', 'x']);
  const thumbprint = createHash('sha256')
    .update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }))
    .digest('base64url');
  assert.equal(jwk.kid, thumbprint);
});

test("a changed claim, or another site's key, doesn't verify", () => {
  const { jwk, statement } = sign({ subject: 's', name: 'Ada', roles: ['shop_manager'] });
  const [header, , signature] = statement.split('.');
  const forged = Buffer.from(
    JSON.stringify({ ...part(statement, 1), roles: ['administrator'] }),
  ).toString('base64url');
  assert.equal(verifies(`${header}.${forged}.${signature}`, jwk), false);
  const other = sign({ subject: 's', name: 'Ada', roles: ['shop_manager'] });
  assert.equal(verifies(statement, other.jwk), false);
});
