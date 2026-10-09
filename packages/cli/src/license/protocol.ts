// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The renewal protocol, the deployment's side. A deployment renews its own
 * license key with an Ed25519 key pair it made (`kindgi license enroll`):
 * access.kindgi.com keeps only the public half, and each request is
 * signed, so nothing replayable crosses the wire. The test vectors in
 * `tests/license-protocol.test.ts` pin every byte.
 *
 * - **The renewer's private key**, as kept in the deployment's own secret
 *   store: `kgi_lrk_<the 32-byte seed, base64url>`. Never printed.
 * - **The renewer id:** `lr_` and the first 22 characters of the base64url
 *   SHA-256 of the 32-byte public key.
 * - **The enroll line** the person pastes on access.kindgi.com:
 *   `kgi_lrp_<public key>.<account>.<signature>`, each part base64url; the
 *   account is their GitHub login, lowercased; the signature covers
 *   `kindgi-license-enroll-v1\n<origin>\n<renewer id>\n<account>`.
 * - **A renewal:** `POST <origin>/v1/renew`, the JSON body
 *   `{"renewerId","ts","nonce"}`, and the header
 *   `kindgi-renewer-signature`: Ed25519 over
 *   `kindgi-license-renew-v1\nPOST <origin>/v1/renew\n<base64url SHA-256 of
 *   the body>`.
 */

import {
  type KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';

/** Where Kindgi's dev access lives: what enroll lines and renewals are signed for by default. */
export const KINDGI_ACCESS_ORIGIN = 'https://access.kindgi.com';
export const RENEWER_PRIVATE_PREFIX = 'kgi_lrk_';
export const RENEWER_PUBLIC_PREFIX = 'kgi_lrp_';
export const RENEW_PATH = '/v1/renew';
export const RENEW_SIGNATURE_HEADER = 'kindgi-renewer-signature';

/** The PKCS#8 DER prefix of an Ed25519 private key, before its 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A renewer's key pair, held in memory only. */
export interface RenewerKey {
  readonly privateKey: KeyObject;
  /** The 32-byte public key. */
  readonly publicKey: Uint8Array;
  readonly renewerId: string;
}

/** A new renewer key pair. */
export function generateRenewerKey(): RenewerKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  return renewerKeyFrom(privateKey);
}

function renewerKeyFrom(privateKey: KeyObject): RenewerKey {
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  const publicKey = new Uint8Array(Buffer.from(x as string, 'base64url'));
  return { privateKey, publicKey, renewerId: renewerIdOf(publicKey) };
}

/** The renewer id of a public key: `lr_` and 22 characters of its SHA-256. */
export function renewerIdOf(publicKey: Uint8Array): string {
  return `lr_${createHash('sha256').update(publicKey).digest('base64url').slice(0, 22)}`;
}

/** The private key as the secret store keeps it: `kgi_lrk_<seed>`. */
export function encodeRenewerPrivateKey(key: RenewerKey): string {
  const der = key.privateKey.export({ format: 'der', type: 'pkcs8' });
  return `${RENEWER_PRIVATE_PREFIX}${Buffer.from(der.subarray(ED25519_PKCS8_PREFIX.length)).toString('base64url')}`;
}

/**
 * The private key read back from the secret store; `undefined` when the
 * value isn't one (an empty secret, another secret, a cut-off value).
 */
export function decodeRenewerPrivateKey(value: string): RenewerKey | undefined {
  const text = value.trim();
  if (!text.startsWith(RENEWER_PRIVATE_PREFIX)) return undefined;
  const encoded = text.slice(RENEWER_PRIVATE_PREFIX.length);
  if (!BASE64URL.test(encoded)) return undefined;
  const seed = Buffer.from(encoded, 'base64url');
  if (seed.length !== 32) return undefined;
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return renewerKeyFrom(privateKey);
}

/** What an enroll line's signature covers. */
export function enrollSigningInput(origin: string, renewerId: string, account: string): string {
  return `kindgi-license-enroll-v1\n${origin}\n${renewerId}\n${account.toLowerCase()}`;
}

/** The line to paste on access.kindgi.com: made for `account` (a GitHub login) there. */
export function enrollLine(
  key: RenewerKey,
  account: string,
  origin = KINDGI_ACCESS_ORIGIN,
): string {
  const signature = sign(
    null,
    Buffer.from(enrollSigningInput(origin, key.renewerId, account), 'utf8'),
    key.privateKey,
  );
  return [
    `${RENEWER_PUBLIC_PREFIX}${Buffer.from(key.publicKey).toString('base64url')}`,
    Buffer.from(account.toLowerCase(), 'utf8').toString('base64url'),
    signature.toString('base64url'),
  ].join('.');
}

/** What a renewal's signature covers: the service's origin and the body's digest. */
export function renewSigningInput(origin: string, body: Uint8Array): string {
  const digest = createHash('sha256').update(body).digest('base64url');
  return `kindgi-license-renew-v1\nPOST ${origin}${RENEW_PATH}\n${digest}`;
}

/** A renewal request, signed: its body and the signature header's value. */
export function signRenewRequest(
  key: RenewerKey,
  options: {
    readonly origin?: string;
    /** Seconds since the epoch. */
    readonly now?: number;
    readonly nonce?: string;
  } = {},
): { readonly body: string; readonly signature: string } {
  const body = JSON.stringify({
    renewerId: key.renewerId,
    ts: options.now ?? Math.floor(Date.now() / 1000),
    nonce: options.nonce ?? randomBytes(16).toString('base64url'),
  });
  const signature = sign(
    null,
    Buffer.from(renewSigningInput(options.origin ?? KINDGI_ACCESS_ORIGIN, Buffer.from(body))),
    key.privateKey,
  ).toString('base64url');
  return { body, signature };
}
