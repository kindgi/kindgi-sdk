// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A Kindgi license key, read and checked offline, as the runtime checks it
 * at startup: `kgi_lk_<base64url payload>.<base64url signature>`, the
 * payload JSON `{ v: 1, kid, sub, name, use, iat, exp }` (seconds), with
 * `warn` and `lim` when the key sets them, the signature Ed25519 over the
 * ASCII bytes of `kgi_lk_<base64url payload>` by Kindgi's license signing
 * key `kid`.
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
  // Production license keys, signed with a key of their own (not the self-serve one).
  'lk-2026-p2': 'bmWF6hVW/Cu6cRnuGG614ajJtOjuSseSllBa+rBobq8=',
});

/**
 * The `kid`s of keys a deployment renews itself without a sign-in, as the
 * runtime lists them: a key signed with one renews by command (`renewBy`),
 * whoever it's for. Each is also in `KINDGI_LICENSE_PUBLIC_KEYS`.
 */
export const PLAN_LICENSE_KEY_IDS: readonly string[] = Object.freeze([]);

/**
 * The most whole days a key signed with each `kid` may run, from its `iat`
 * to its `exp`, as the runtime caps them: a longer one is refused
 * (`too-long`). A `kid` not listed has no cap.
 */
export const LICENSE_KEY_MAX_DAYS: Readonly<Record<string, number>> = Object.freeze({});

/**
 * The first runtime release that trusts each `kid` added after license keys
 * shipped, as the runtime lists them: a key signed with one doesn't verify
 * on an older runtime.
 */
export const LICENSE_KEY_MINIMUM_RUNTIME: Readonly<Record<string, string>> = Object.freeze({
  'lk-2026-p2': '0.1.8',
});

export type LicenseUse = 'production' | 'non-production';

/** What a key limits (`lim`): a count it doesn't name isn't limited. */
export interface LicenseLimits {
  readonly flows?: number;
  readonly agents?: number;
}

/** What a key says. */
export interface LicenseClaims {
  readonly keyId: string;
  readonly subject: string;
  readonly name: string;
  readonly use: LicenseUse;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** Whole days before `expiresAt` the key warns from (`warn`), when it says; 30 otherwise. */
  readonly warnDays?: number;
  /** What the key limits (`lim`), when it says: a production key's only. */
  readonly limits?: LicenseLimits;
}

export type LicenseKeyCheck =
  | { readonly kind: 'ok'; readonly claims: LicenseClaims }
  | {
      readonly kind: 'err';
      /**
       * `malformed`: not a key; `unknown-key`: signed with a `kid` this CLI
       * doesn't know; `bad-signature`; `too-long`: it runs longer than its
       * `kid` allows (`LICENSE_KEY_MAX_DAYS`).
       */
      readonly reason: 'malformed' | 'unknown-key' | 'bad-signature' | 'too-long';
    };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const USES: readonly string[] = ['production', 'non-production'];
const DAY_SECONDS = 86_400;
/** The widest warning window a key may set, in whole days: the window it has without one. */
const MAX_WARN_DAYS = 30;
/** The most a `lim` member may say. */
const MAX_LIMIT = 100_000;
const LIMIT_NAMES = ['flows', 'agents'] as const;

/**
 * Whether `key` is a license key Kindgi signed, and what it says. The
 * dates aren't judged here: renewal compares them with the current key's.
 * Only how long the key runs is: a `kid` with a cap refuses a longer one.
 */
export function checkLicenseKey(
  key: string,
  publicKeys: Readonly<Record<string, string>> = KINDGI_LICENSE_PUBLIC_KEYS,
  maxDays: Readonly<Record<string, number>> = LICENSE_KEY_MAX_DAYS,
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
  const cap = Object.hasOwn(maxDays, payload.kid) ? maxDays[payload.kid] : undefined;
  if (cap !== undefined && payload.exp - payload.iat > cap * DAY_SECONDS) {
    return { kind: 'err', reason: 'too-long' };
  }
  return {
    kind: 'ok',
    claims: {
      keyId: payload.kid,
      subject: payload.sub,
      name: payload.name,
      use: payload.use,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
      ...(payload.warn !== undefined && { warnDays: payload.warn }),
      ...(payload.lim !== undefined && { limits: limitsOf(payload.lim) }),
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
  readonly warn?: number;
  readonly lim?: Readonly<Record<string, unknown>>;
}

function parsePayload(part: string): Payload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  const p = value;
  const text = (v: unknown) => typeof v === 'string' && v.trim() !== '';
  if (p.v !== 1 || !text(p.kid) || !text(p.sub) || !text(p.name)) return undefined;
  if (!USES.includes(p.use as string)) return undefined;
  if (!Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)) return undefined;
  if ((p.exp as number) <= (p.iat as number)) return undefined;
  if (p.warn !== undefined && !wholeFrom1To(p.warn, MAX_WARN_DAYS)) return undefined;
  if (p.lim !== undefined) {
    // Production keys only, so staging and CI are never limited; a member
    // this CLI doesn't know is left to the runtime that does.
    if (p.use !== 'production' || !isPlainObject(p.lim)) return undefined;
    const lim = p.lim;
    if (LIMIT_NAMES.some((n) => lim[n] !== undefined && !wholeFrom1To(lim[n], MAX_LIMIT))) {
      return undefined;
    }
  }
  return p as unknown as Payload;
}

function limitsOf(lim: Readonly<Record<string, unknown>>): LicenseLimits {
  const out: Record<string, number> = {};
  for (const name of LIMIT_NAMES) {
    if (lim[name] !== undefined) out[name] = lim[name] as number;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wholeFrom1To(value: unknown, max: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;
}
