// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a license key stands, as the runtime judges it at startup, and
 * what to do about it: `kindgi doctor` and `kindgi license renew` say the
 * same thing the runtime's banner does.
 *
 * - more days left than the key's warning window (`warn`, else 30): valid;
 * - within it: expiring (the runtime warns);
 * - expired less than 14 days ago: the runtime still starts, with a warning;
 * - after that: the runtime doesn't start with it.
 */

import { type LicenseClaims, PLAN_LICENSE_KEY_IDS } from './license-key.js';

export const LICENSE_WARN_DAYS = 30;
export const LICENSE_GRACE_DAYS = 14;
const DAY_MS = 86_400_000;

export type LicenseStanding =
  | { readonly kind: 'valid' | 'expiring'; readonly daysLeft: number }
  | { readonly kind: 'grace'; readonly lastStart: Date }
  | { readonly kind: 'expired' };

export function standingOf(claims: LicenseClaims, now: number): LicenseStanding {
  const left = claims.expiresAt.getTime() - now;
  if (left > 0) {
    const daysLeft = Math.floor(left / DAY_MS);
    return { kind: daysLeft <= warnDaysOf(claims) ? 'expiring' : 'valid', daysLeft };
  }
  if (-left < LICENSE_GRACE_DAYS * DAY_MS) {
    return {
      kind: 'grace',
      lastStart: new Date(claims.expiresAt.getTime() + LICENSE_GRACE_DAYS * DAY_MS),
    };
  }
  return { kind: 'expired' };
}

/** The days before it expires that a key warns from: its own `warn`, or 30. */
export function warnDaysOf(claims: LicenseClaims): number {
  return claims.warnDays ?? LICENSE_WARN_DAYS;
}

/** A key from access.kindgi.com (`gh-<id>`, `em-<id>`, `dom-<domain>`), not one Kindgi issued by hand. */
export function isSelfServe(subject: string): boolean {
  return (
    /^gh-\d+$/.test(subject) ||
    /^em-[a-z2-7]{26}$/.test(subject) ||
    /^dom-[a-z0-9.-]+$/.test(subject)
  );
}

/**
 * Which way to the next key, as the runtime's banner and `GET /v1/license`
 * (`renewBy`) say it: `command`, a key this deployment renews itself (a
 * self-serve key, or one signed with a `kid` of `PLAN_LICENSE_KEY_IDS`);
 * `contact`, a key Kindgi issued by hand.
 */
export function renewByOf(
  claims: LicenseClaims,
  planKeyIds: readonly string[] = PLAN_LICENSE_KEY_IDS,
): 'command' | 'contact' {
  return isSelfServe(claims.subject) || planKeyIds.includes(claims.keyId) ? 'command' : 'contact';
}

/**
 * How to get the next key, in the runtime's startup banner's words, so
 * `kindgi doctor`, the banner and the console say the same: for a
 * self-serve key, renew it from the deployment (`renewCommand`) or sign in
 * at access.kindgi.com, which shows its latest key and renews it unless a
 * deployment renewed it this week and it hasn't expired; for a key signed
 * with a plan `kid`, renew it from the deployment, as a sign-in hands out
 * self-serve keys only; for a key Kindgi issued, write to Kindgi.
 */
export function renewAdvice(
  claims: LicenseClaims,
  renewCommand: string,
  planKeyIds: readonly string[] = PLAN_LICENSE_KEY_IDS,
): string {
  if (isSelfServe(claims.subject)) {
    return `Renew it: from this deployment (${renewCommand}), or sign in at https://access.kindgi.com, which shows its latest key and renews it unless a deployment renewed it this week and it hasn't expired`;
  }
  return renewByOf(claims, planKeyIds) === 'command'
    ? `Renew it from this deployment: ${renewCommand}`
    : 'Renew it: contact@kindgi.com';
}
