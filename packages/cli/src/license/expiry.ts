// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Where a license key stands, as the runtime judges it at startup, and
 * what to do about it: `kindgi doctor` and `kindgi license renew` say the
 * same thing the runtime's banner does.
 *
 * - more than 30 days left: valid;
 * - 30 days or fewer: expiring (the runtime warns);
 * - expired less than 14 days ago: the runtime still starts, with a warning;
 * - after that: the runtime doesn't start with it.
 */

import type { LicenseClaims } from './license-key.js';

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
    return { kind: daysLeft <= LICENSE_WARN_DAYS ? 'expiring' : 'valid', daysLeft };
  }
  if (-left < LICENSE_GRACE_DAYS * DAY_MS) {
    return {
      kind: 'grace',
      lastStart: new Date(claims.expiresAt.getTime() + LICENSE_GRACE_DAYS * DAY_MS),
    };
  }
  return { kind: 'expired' };
}

/** A key from access.kindgi.com (`gh-<id>`, `dom-<domain>`), not one Kindgi issued by hand. */
export function isSelfServe(subject: string): boolean {
  return /^gh-\d+$/.test(subject) || /^dom-[a-z0-9.-]+$/.test(subject);
}

/**
 * How to get the next key: renew it from the deployment (`renewCommand`),
 * or sign in at access.kindgi.com, for a self-serve key; for a key Kindgi
 * issued, write to contact@kindgi.com.
 */
export function renewAdvice(claims: LicenseClaims, renewCommand: string): string {
  return isSelfServe(claims.subject)
    ? `${renewCommand}, or sign in at https://access.kindgi.com for a new key`
    : 'Write to contact@kindgi.com for the next key';
}
