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
  type RenewalUsage,
  type RenewerKey,
  decodeRenewerPrivateKey,
  readRenewalUsage,
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
  /**
   * The deployment's use since the current key was issued, from its
   * runtime (`--runtime`): sent with the request. Without it, none is sent.
   */
  readonly usage?: (since: Date) => Promise<RenewalUsage>;
}

/** What the request said about the deployment's use: sent, or why not. */
export type CountsSent =
  | { readonly sent: true; readonly usage: RenewalUsage }
  | { readonly sent: false; readonly reason: string };

/**
 * Why a production key's renewal sends no counts: by design, so `renew
 * --quiet` leaves its line out. The Azure module's counts alert leaves out
 * this reason by its text: keep it.
 */
export const PRODUCTION_NO_COUNTS = "a production key's renewal carries no counts";

export type RenewOutcome =
  | {
      readonly kind: 'renewed' | 'unchanged';
      readonly claims: LicenseClaims;
      readonly renewerId: string;
      /** With a runtime to ask (`usage`): the counts sent, or why none were. */
      readonly counts?: CountsSent;
    }
  /** The service said no: its code and message (`renewer-stopped`, `key-revoked`, `held-for-review`, …). */
  | {
      readonly kind: 'refused';
      readonly status: number;
      readonly error: string;
      readonly message: string;
      readonly renewerId?: string;
      readonly counts?: CountsSent;
    }
  /** Nothing to renew with, nothing usable came back, or the service couldn't be reached. */
  | { readonly kind: 'failed'; readonly message: string; readonly renewerId?: string };

export async function renewLicense(input: RenewInput, deps: RenewDeps = {}): Promise<RenewOutcome> {
  const origin = (input.origin ?? KINDGI_ACCESS_ORIGIN).replace(/\/+$/, '');
  const publicKeys = deps.publicKeys ?? KINDGI_LICENSE_PUBLIC_KEYS;
  const held = await whatIsHeld(input, publicKeys);
  if (held.kind === 'failed') return held;
  const { renewerId } = held.renewer;

  // The counts are the period's since the current key was issued; a runtime
  // that can't say renews without them (the service records that), never
  // not at all.
  const counts =
    input.usage === undefined ? undefined : await countUsage(input.usage, held.current);
  const request = signRenewRequest(held.renewer, {
    origin,
    now: Math.floor((deps.now ?? Date.now)() / 1000),
    ...(counts?.sent === true && { usage: counts.usage }),
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
    // The service's own refusals name their code; any other error answer
    // (a 5xx, a proxy's page) refuses nothing: the next run may succeed.
    if (typeof body.error !== 'string') {
      return {
        kind: 'failed',
        renewerId,
        message: `${origin} answered ${res.status}. The key in ${input.key.describe} is unchanged; try again later.`,
      };
    }
    return {
      kind: 'refused',
      status: res.status,
      error: body.error,
      message:
        typeof body.message === 'string' ? body.message : `${origin} answered ${res.status}.`,
      renewerId,
      ...(counts !== undefined && { counts }),
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
  const sent = counts === undefined ? {} : { counts };
  if (answer === held.currentKey) {
    return { kind: 'unchanged', claims: renewed.claims, renewerId, ...sent };
  }
  await input.key.write(answer);
  return { kind: 'renewed', claims: renewed.claims, renewerId, ...sent };
}

/**
 * The deployment's use since the current key was issued, or why it wasn't
 * had: a production key's renewal carries none (counts are for free keys),
 * and the runtime is asked only for a free one.
 */
async function countUsage(
  usage: (since: Date) => Promise<RenewalUsage>,
  current: LicenseClaims,
): Promise<CountsSent> {
  if (current.use === 'production') return { sent: false, reason: PRODUCTION_NO_COUNTS };
  let answer: unknown;
  try {
    answer = await usage(current.issuedAt);
  } catch (cause) {
    return { sent: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
  const counts = readRenewalUsage(answer);
  return counts === undefined
    ? { sent: false, reason: "the runtime's answer isn't counts" }
    : { sent: true, usage: counts };
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
      message: `There's no renewer key in ${input.renewer.describe}. Enroll this deployment first: kindgi license enroll --for <your GitHub login, or the em- id your key page shows> --renewer <where to keep its key>.`,
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
    return { kind: 'unreachable', reason: networkReason(cause) };
  }
}

/**
 * What stopped a request, as exactly as the error says it. fetch's own
 * `fetch failed` says nothing; its cause does (`connect ECONNREFUSED …`,
 * `getaddrinfo ENOTFOUND …`, a certificate's), or just its code.
 */
export function networkReason(err: unknown): string {
  const said: string[] = [];
  let at: unknown = err;
  for (let depth = 0; at instanceof Error && depth < 4; depth++) {
    if (at.name === 'TimeoutError') return 'no answer in time';
    const code = (at as { code?: unknown }).code;
    const text = at.message !== '' ? at.message : typeof code === 'string' ? code : '';
    if (text !== '' && text !== 'fetch failed') said.push(text);
    at = at.cause;
  }
  return said.at(-1) ?? (err instanceof Error && err.message !== '' ? err.message : String(err));
}

/**
 * Why an answer mustn't be written, or `undefined`: a key a released
 * runtime accepts, for the same licensee and use, expiring no earlier.
 */
function whyNotWritten(renewed: LicenseKeyCheck, current: LicenseClaims): string | undefined {
  if (renewed.kind === 'err') {
    if (renewed.reason === 'unknown-key') {
      return "it's signed with a key this CLI doesn't know yet (unknown-key): update the CLI, then try again";
    }
    if (renewed.reason === 'malformed') {
      return 'the answer held no license key (malformed): a page from a proxy or another server, perhaps';
    }
    return `it isn't a key a released runtime accepts (${renewed.reason})`;
  }
  const next = renewed.claims;
  if (next.subject !== current.subject) return `it's for ${next.name}, not ${current.name}`;
  if (next.use !== current.use) return `it's a ${next.use} key, not a ${current.use} one`;
  if (next.expiresAt < current.expiresAt) return 'it expires before the current one';
  return undefined;
}
