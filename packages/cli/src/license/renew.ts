// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * One renewal, the deployment's side: read the current license key and the
 * renewer's private key from where the deployment keeps them, ask
 * access.kindgi.com (a signed `POST /v1/renew`), check the answer offline,
 * and write it only when it's a new key the runtime will accept.
 *
 * The answer is checked before anything is written: signed by a key a
 * released runtime trusts, for the same licensee and use as the current
 * key, and expiring no earlier. A wrong, rolled-back or someone else's key
 * is never written. Most days the key is unchanged and nothing is written.
 */

import {
  KINDGI_LICENSE_PUBLIC_KEYS,
  type LicenseClaims,
  type LicenseKeyCheck,
  checkLicenseKey,
} from './license-key.js';
import {
  KINDGI_ACCESS_ORIGIN,
  RENEW_PATH,
  RENEW_SIGNATURE_HEADER,
  type RenewerKey,
  decodeRenewerPrivateKey,
  signRenewRequest,
} from './protocol.js';
import type { SecretStore } from './stores.js';

export interface RenewDeps {
  readonly fetch?: typeof fetch;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
  readonly publicKeys?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** What `kindgi license renew` runs with: tests hand in their own clock and fetch. */
export interface LicenseCommandDeps {
  readonly renew?: RenewDeps;
}

export interface RenewInput {
  /** Where the license key is kept; the new one is written there. */
  readonly key: SecretStore;
  /** Where the renewer's private key is kept (`kindgi license enroll` wrote it). */
  readonly renewer: SecretStore;
  /** access.kindgi.com, or another instance's origin. */
  readonly origin?: string;
}

export type RenewOutcome =
  | {
      readonly kind: 'renewed' | 'unchanged';
      readonly claims: LicenseClaims;
      readonly renewerId: string;
    }
  /** The service said no: its code and message (`renewer-stopped`, `key-revoked`, …). */
  | {
      readonly kind: 'refused';
      readonly status: number;
      readonly error: string;
      readonly message: string;
      readonly renewerId?: string;
    }
  /** Nothing to renew with, nothing usable came back, or the service couldn't be reached. */
  | { readonly kind: 'failed'; readonly message: string; readonly renewerId?: string };

export async function renewLicense(input: RenewInput, deps: RenewDeps = {}): Promise<RenewOutcome> {
  const origin = (input.origin ?? KINDGI_ACCESS_ORIGIN).replace(/\/+$/, '');
  const publicKeys = deps.publicKeys ?? KINDGI_LICENSE_PUBLIC_KEYS;
  const held = await whatIsHeld(input, publicKeys);
  if (held.kind === 'failed') return held;
  const { renewerId } = held.renewer;

  const request = signRenewRequest(held.renewer, {
    origin,
    now: Math.floor((deps.now ?? Date.now)() / 1000),
  });
  const asked = await ask(origin, request, deps);
  if (asked.kind === 'unreachable') {
    return {
      kind: 'failed',
      renewerId,
      message: `${origin} couldn't be reached (${asked.reason}). The key in ${input.key.describe} is unchanged; try again later.`,
    };
  }
  const { res, body } = asked;
  if (!res.ok) {
    return {
      kind: 'refused',
      status: res.status,
      error: typeof body.error === 'string' ? body.error : `http-${res.status}`,
      message:
        typeof body.message === 'string' ? body.message : `${origin} answered ${res.status}.`,
      renewerId,
    };
  }

  const answer = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
  const renewed = checkLicenseKey(answer, publicKeys);
  const problem = whyNotWritten(renewed, held.current);
  if (renewed.kind === 'err' || problem !== undefined) {
    return {
      kind: 'failed',
      renewerId,
      message: `The key ${origin} sent wasn't written: ${problem}. The key in ${input.key.describe} is unchanged.`,
    };
  }
  if (answer === held.currentKey) return { kind: 'unchanged', claims: renewed.claims, renewerId };
  await input.key.write(answer);
  return { kind: 'renewed', claims: renewed.claims, renewerId };
}

/** The current key (checked) and the renewer's key, or what's missing. */
async function whatIsHeld(
  input: RenewInput,
  publicKeys: Readonly<Record<string, string>>,
): Promise<
  | {
      readonly kind: 'held';
      readonly currentKey: string;
      readonly current: LicenseClaims;
      readonly renewer: RenewerKey;
    }
  | { readonly kind: 'failed'; readonly message: string }
> {
  const currentKey = await input.key.read();
  if (currentKey === undefined) {
    return {
      kind: 'failed',
      message: `There's no license key in ${input.key.describe} to renew. The first one comes from signing in at access.kindgi.com; put it there.`,
    };
  }
  const current = checkLicenseKey(currentKey, publicKeys);
  if (current.kind === 'err') {
    return {
      kind: 'failed',
      message: `The value in ${input.key.describe} isn't a license key this CLI can check (${current.reason}).`,
    };
  }
  const renewerValue = await input.renewer.read();
  const renewer = renewerValue === undefined ? undefined : decodeRenewerPrivateKey(renewerValue);
  if (renewer === undefined) {
    return {
      kind: 'failed',
      message: `There's no renewer key in ${input.renewer.describe}. Enroll this deployment first: kindgi license enroll --for <your GitHub login> --renewer <where to keep its key>.`,
    };
  }
  return { kind: 'held', currentKey, current: current.claims, renewer };
}

/** One signed request; a network failure is said, never thrown. */
async function ask(
  origin: string,
  request: { readonly body: string; readonly signature: string },
  deps: RenewDeps,
): Promise<
  | { readonly kind: 'answered'; readonly res: Response; readonly body: Record<string, unknown> }
  | { readonly kind: 'unreachable'; readonly reason: string }
> {
  try {
    const res = await (deps.fetch ?? fetch)(`${origin}${RENEW_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RENEW_SIGNATURE_HEADER]: request.signature },
      body: request.body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { kind: 'answered', res, body };
  } catch (cause) {
    return { kind: 'unreachable', reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Why an answer mustn't be written, or `undefined`: a key a released
 * runtime accepts, for the same licensee and use, expiring no earlier.
 */
function whyNotWritten(renewed: LicenseKeyCheck, current: LicenseClaims): string | undefined {
  if (renewed.kind === 'err') {
    return `it isn't a key a released runtime accepts (${renewed.reason}): update the CLI, then try again`;
  }
  const next = renewed.claims;
  if (next.subject !== current.subject) return `it's for ${next.name}, not ${current.name}`;
  if (next.use !== current.use) return `it's a ${next.use} key, not a ${current.use} one`;
  if (next.expiresAt < current.expiresAt) return 'it expires before the current one';
  return undefined;
}
