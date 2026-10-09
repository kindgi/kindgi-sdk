// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A Kindgi license key, read and checked offline, as the runtime checks it
 * at startup: `kgi_lk_<base64url payload>.<base64url signature>`, the
 * payload JSON `{ v: 1, kid, sub, name, use, iat, exp }` (seconds), the
 * signature Ed25519 over the ASCII bytes of `kgi_lk_<base64url payload>`
 * by Kindgi's license signing key `kid`.
 *
 * `kindgi license renew` checks a renewed key with this before writing
 * it, so a key the runtime would refuse is never written.
 */

import { createPublicKey, verify } from 'node:crypto';

export const LICENSE_KEY_PREFIX = 'kgi_lk_';

/**
 * The license signing keys a released runtime trusts, by `kid`: their
 * Ed25519 public keys (base64). A new `kid` is added here, in a CLI
 * release, before Kindgi signs with it: otherwise renewal refuses a
 * correctly renewed key.
 */
export const KINDGI_LICENSE_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'lk-2026-1': 'cIC6PF4tmqQzkH/MG1GVguOCHIEPBe8zLJWh64pGgp8=',
});

export type LicenseUse = 'production' | 'non-production';

/** What a key says. */
export interface LicenseClaims {
  readonly keyId: string;
  readonly subject: string;
  readonly name: string;
  readonly use: LicenseUse;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export type LicenseKeyCheck =
  | { readonly kind: 'ok'; readonly claims: LicenseClaims }
  | {
      readonly kind: 'err';
      /** `malformed`: not a key; `unknown-key`: signed with a `kid` this CLI doesn't know; `bad-signature`. */
      readonly reason: 'malformed' | 'unknown-key' | 'bad-signature';
    };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const USES: readonly string[] = ['production', 'non-production'];

/**
 * Whether `key` is a license key Kindgi signed, and what it says. The
 * dates aren't judged here: renewal compares them with the current key's.
 */
export function checkLicenseKey(
  key: string,
  publicKeys: Readonly<Record<string, string>> = KINDGI_LICENSE_PUBLIC_KEYS,
): LicenseKeyCheck {
  const trimmed = key.trim();
  const dot = trimmed.lastIndexOf('.');
  if (!trimmed.startsWith(LICENSE_KEY_PREFIX) || dot <= LICENSE_KEY_PREFIX.length) {
    return { kind: 'err', reason: 'malformed' };
  }
  const signed = trimmed.slice(0, dot);
  const payloadPart = signed.slice(LICENSE_KEY_PREFIX.length);
  const signaturePart = trimmed.slice(dot + 1);
  if (!BASE64URL.test(payloadPart) || !BASE64URL.test(signaturePart)) {
    return { kind: 'err', reason: 'malformed' };
  }
  const payload = parsePayload(payloadPart);
  if (payload === undefined) return { kind: 'err', reason: 'malformed' };
  const publicKey = Object.hasOwn(publicKeys, payload.kid) ? publicKeys[payload.kid] : undefined;
  const raw = publicKey === undefined ? undefined : Buffer.from(publicKey, 'base64');
  if (raw === undefined || raw.length !== 32) return { kind: 'err', reason: 'unknown-key' };
  const signature = Buffer.from(signaturePart, 'base64url');
  const ok =
    signature.length === 64 &&
    verify(
      null,
      Buffer.from(signed, 'ascii'),
      createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
        format: 'jwk',
      }),
      signature,
    );
  if (!ok) return { kind: 'err', reason: 'bad-signature' };
  return {
    kind: 'ok',
    claims: {
      keyId: payload.kid,
      subject: payload.sub,
      name: payload.name,
      use: payload.use,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
    },
  };
}

interface Payload {
  readonly kid: string;
  readonly sub: string;
  readonly name: string;
  readonly use: LicenseUse;
  readonly iat: number;
  readonly exp: number;
}

function parsePayload(part: string): Payload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const p = value as Record<string, unknown>;
  const text = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  if (p.v !== 1 || !text(p.kid) || !text(p.sub) || !text(p.name)) return undefined;
  if (!USES.includes(p.use as string)) return undefined;
  if (!Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)) return undefined;
  if ((p.exp as number) <= (p.iat as number)) return undefined;
  return p as unknown as Payload;
}
