// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type SigningKeyBinding, signEd25519, verifyEd25519 } from '@kindgi/crypto';
import type { RunId, SigningKeyId, TenantId } from '@kindgi/types';

/**
 * Public run tokens: short-lived, read-only tokens that let a browser
 * follow specific runs (`GET /v1/runs/{runId}/progress` and its event stream) with
 * nothing else allowed. The application's backend obtains one when it
 * starts a run (`POST /v1/runs` returns `publicAccessToken`) or mints one
 * (`POST /v1/tokens/public`), and hands it to the browser.
 *
 * Wire form: `kgi_pt_<base64url payload>.<base64url signature>`.
 * - payload: JSON `{ v: 1, kid, tenantId, runIds, iat, exp }` (seconds);
 * - signature: Ed25519 over the ASCII bytes of `kgi_pt_<base64url payload>`,
 *   by the key `kid` in the deployment's `SigningKeyBinding`.
 *
 * Stateless: nothing is stored. A token stops working when it expires;
 * removing its key from the binding revokes every token signed with it.
 */

export const PUBLIC_RUN_TOKEN_PREFIX = 'kgi_pt_';

/** A token's lifetime when the caller doesn't choose one: 15 minutes. */
export const DEFAULT_PUBLIC_RUN_TOKEN_TTL_SECONDS = 900;
/** The longest lifetime a token can have: 24 hours. */
export const MAX_PUBLIC_RUN_TOKEN_TTL_SECONDS = 86_400;
/** Runs one token can name. */
export const MAX_PUBLIC_RUN_TOKEN_RUNS = 50;

/** Tolerated clock difference for a token issued "in the future" (seconds). */
const CLOCK_SKEW_SECONDS = 60;
const PAYLOAD_VERSION = 1;

/** How a deployment issues and checks public run tokens. */
export interface PublicRunTokenConfig {
  /** Key store holding the Ed25519 signing key(s). */
  readonly signingKey: SigningKeyBinding;
  /**
   * The key new tokens are signed with. Tokens signed with another key in
   * the binding stay valid until they expire, so keys rotate by adding
   * the new key, switching `keyId`, and removing the old key a day later.
   */
  readonly keyId: SigningKeyId;
  /** Default lifetime; {@link DEFAULT_PUBLIC_RUN_TOKEN_TTL_SECONDS} when absent. */
  readonly defaultTtlSeconds?: number;
  /** Longest lifetime a mint may ask for; at most {@link MAX_PUBLIC_RUN_TOKEN_TTL_SECONDS}. */
  readonly maxTtlSeconds?: number;
  /**
   * Browser origins (e.g. `https://app.example.com`) allowed to call the
   * routes a public run token can use, cross-origin. Absent or empty: no
   * CORS headers are sent.
   */
  readonly allowedOrigins?: readonly string[];
}

/** What a verified token grants. */
export interface PublicRunTokenClaims {
  readonly keyId: SigningKeyId;
  readonly tenantId: TenantId;
  /** The runs the token may read; their descendants are readable too. */
  readonly runIds: readonly RunId[];
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface MintPublicRunTokenInput {
  readonly signingKey: SigningKeyBinding;
  readonly keyId: SigningKeyId;
  readonly tenantId: TenantId;
  readonly runIds: readonly RunId[];
  readonly ttlSeconds: number;
  /** Clock in milliseconds; default `Date.now`. */
  readonly now?: () => number;
}

export type MintPublicRunTokenResult =
  | { readonly kind: 'ok'; readonly token: string; readonly expiresAt: Date }
  | {
      readonly kind: 'err';
      readonly reason: 'unknown-key' | 'invalid-input';
      readonly message: string;
    };

export type VerifyPublicRunTokenFailure = 'malformed' | 'unknown-key' | 'bad-signature' | 'expired';

export type VerifyPublicRunTokenResult =
  | { readonly kind: 'ok'; readonly claims: PublicRunTokenClaims }
  | { readonly kind: 'err'; readonly reason: VerifyPublicRunTokenFailure };

interface Payload {
  readonly v: number;
  readonly kid: string;
  readonly tenantId: string;
  readonly runIds: readonly string[];
  readonly iat: number;
  readonly exp: number;
}

/** Sign a token for `runIds` in `tenantId`, valid for `ttlSeconds`. */
export function mintPublicRunToken(input: MintPublicRunTokenInput): MintPublicRunTokenResult {
  if (
    input.runIds.length === 0 ||
    input.runIds.length > MAX_PUBLIC_RUN_TOKEN_RUNS ||
    !Number.isInteger(input.ttlSeconds) ||
    input.ttlSeconds <= 0 ||
    input.ttlSeconds > MAX_PUBLIC_RUN_TOKEN_TTL_SECONDS
  ) {
    return {
      kind: 'err',
      reason: 'invalid-input',
      message: `a token names 1–${MAX_PUBLIC_RUN_TOKEN_RUNS} runs and lives 1–${MAX_PUBLIC_RUN_TOKEN_TTL_SECONDS} seconds`,
    };
  }
  const privateKey = ed25519Key(input.signingKey, input.keyId, 'private');
  if (privateKey === null) {
    return {
      kind: 'err',
      reason: 'unknown-key',
      message: `no Ed25519 signing key "${input.keyId as unknown as string}" in the binding`,
    };
  }
  const iat = Math.floor((input.now ?? Date.now)() / 1000);
  const payload: Payload = {
    v: PAYLOAD_VERSION,
    kid: input.keyId as unknown as string,
    tenantId: input.tenantId as unknown as string,
    runIds: input.runIds.map((id) => id as unknown as string),
    iat,
    exp: iat + input.ttlSeconds,
  };
  const signed = `${PUBLIC_RUN_TOKEN_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signature = signEd25519(privateKey, Buffer.from(signed, 'ascii'));
  if (signature.kind === 'err') {
    return { kind: 'err', reason: 'unknown-key', message: signature.error.message };
  }
  return {
    kind: 'ok',
    token: `${signed}.${Buffer.from(signature.value).toString('base64url')}`,
    expiresAt: new Date(payload.exp * 1000),
  };
}

/** Check a token's form, signature and lifetime. Never throws. */
export function verifyPublicRunToken(
  token: string,
  options: { readonly signingKey: SigningKeyBinding; readonly now?: () => number },
): VerifyPublicRunTokenResult {
  if (!token.startsWith(PUBLIC_RUN_TOKEN_PREFIX)) return fail('malformed');
  const dot = token.lastIndexOf('.');
  if (dot <= PUBLIC_RUN_TOKEN_PREFIX.length) return fail('malformed');
  const signed = token.slice(0, dot);
  const payloadPart = signed.slice(PUBLIC_RUN_TOKEN_PREFIX.length);
  const signaturePart = token.slice(dot + 1);
  if (!BASE64URL.test(payloadPart) || !BASE64URL.test(signaturePart)) return fail('malformed');

  const payload = parsePayload(payloadPart);
  if (payload === null) return fail('malformed');

  const keyId = payload.kid as SigningKeyId;
  const publicKey = ed25519Key(options.signingKey, keyId, 'public');
  if (publicKey === null) return fail('unknown-key');
  const verified = verifyEd25519(
    publicKey,
    Buffer.from(signed, 'ascii'),
    Buffer.from(signaturePart, 'base64url'),
  );
  if (verified.kind === 'err' || !verified.value) return fail('bad-signature');

  const now = Math.floor((options.now ?? Date.now)() / 1000);
  if (now >= payload.exp || payload.iat > now + CLOCK_SKEW_SECONDS) return fail('expired');

  return {
    kind: 'ok',
    claims: {
      keyId,
      tenantId: payload.tenantId as TenantId,
      runIds: payload.runIds as readonly RunId[],
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
    },
  };
}

/**
 * Check a deployment's configuration at startup: the signing key exists
 * and is Ed25519, and the lifetimes are in range. Returns the effective
 * lifetimes; throws on a misconfiguration so the server fails to start.
 */
export function resolvePublicRunTokenConfig(config: PublicRunTokenConfig): {
  readonly defaultTtlSeconds: number;
  readonly maxTtlSeconds: number;
} {
  if (ed25519Key(config.signingKey, config.keyId, 'private') === null) {
    throw new Error(
      `publicRunTokens: no Ed25519 key "${config.keyId as unknown as string}" with a private key in signingKey`,
    );
  }
  const maxTtlSeconds = config.maxTtlSeconds ?? MAX_PUBLIC_RUN_TOKEN_TTL_SECONDS;
  const defaultTtlSeconds = config.defaultTtlSeconds ?? DEFAULT_PUBLIC_RUN_TOKEN_TTL_SECONDS;
  if (
    !Number.isInteger(maxTtlSeconds) ||
    maxTtlSeconds <= 0 ||
    maxTtlSeconds > MAX_PUBLIC_RUN_TOKEN_TTL_SECONDS
  ) {
    throw new Error(
      `publicRunTokens.maxTtlSeconds must be an integer in 1–${MAX_PUBLIC_RUN_TOKEN_TTL_SECONDS}`,
    );
  }
  if (
    !Number.isInteger(defaultTtlSeconds) ||
    defaultTtlSeconds <= 0 ||
    defaultTtlSeconds > maxTtlSeconds
  ) {
    throw new Error('publicRunTokens.defaultTtlSeconds must be an integer in 1–maxTtlSeconds');
  }
  return { defaultTtlSeconds, maxTtlSeconds };
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function fail(reason: VerifyPublicRunTokenFailure): VerifyPublicRunTokenResult {
  return { kind: 'err', reason };
}

/** The key's bytes when the binding holds it as an Ed25519 key; else `null`. */
function ed25519Key(
  binding: SigningKeyBinding,
  keyId: SigningKeyId,
  side: 'public' | 'private',
): Uint8Array | null {
  const descriptor = binding.listKeys().find((key) => key.keyId === keyId);
  if (descriptor === undefined || descriptor.algorithm !== 'ed25519') return null;
  return side === 'public' ? binding.getPublicKey(keyId) : binding.getPrivateKey(keyId);
}

function parsePayload(encoded: string): Payload | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const runIds = p.runIds;
  const valid =
    p.v === PAYLOAD_VERSION &&
    typeof p.kid === 'string' &&
    p.kid.length > 0 &&
    typeof p.tenantId === 'string' &&
    p.tenantId.length > 0 &&
    Array.isArray(runIds) &&
    runIds.length > 0 &&
    runIds.length <= MAX_PUBLIC_RUN_TOKEN_RUNS &&
    runIds.every((id) => typeof id === 'string' && id.length > 0) &&
    Number.isInteger(p.iat) &&
    Number.isInteger(p.exp) &&
    (p.exp as number) > (p.iat as number) &&
    (p.exp as number) - (p.iat as number) <= MAX_PUBLIC_RUN_TOKEN_TTL_SECONDS;
  return valid ? (p as unknown as Payload) : null;
}
