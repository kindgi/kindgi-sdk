// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The license key `kindgi dev` runs the runtime with: the shell's
 * `KINDGI_LICENSE_KEY`, else the one `kindgi auth registry` kept
 * (`~/.kindgi/license/license-key`). Every runtime needs a key, the one
 * `kindgi dev` starts included: without one, `kindgi dev` refuses before
 * it starts anything.
 *
 * Checked offline, as the runtime checks it. A key near or past its
 * expiry is said up front, and the runtime's own check decides; a value
 * that isn't a key is refused here.
 *
 * The key reaches the container by name only (`--env KINDGI_LICENSE_KEY`),
 * its value in the environment of the `docker run` that starts it: never
 * in the arguments, and never in `runtime.env`, which sits in the project.
 */

import { LICENSE_GRACE_DAYS, devRenewAdvice, standingOf } from '../license/expiry.js';
import {
  HOME_LICENSE_KEY_DISPLAY,
  homeLicenseKeyPath,
  readHomeLicenseKey,
} from '../license/home-key.js';
import { KINDGI_LICENSE_PUBLIC_KEYS, checkLicenseKey } from '../license/license-key.js';

/** The runtime's setting, and the shell variable `kindgi dev` reads first. */
export const DEV_LICENSE_KEY_VAR = 'KINDGI_LICENSE_KEY';

export type DevLicenseKey =
  | {
      readonly kind: 'ok';
      readonly key: string;
      /** Where it came from, for messages: `KINDGI_LICENSE_KEY`, or the kept file's path. */
      readonly from: string;
      /** Whose key and until when; absent when this CLI can't read it (signed with a key it doesn't know). */
      readonly what?: string;
      /** Said up front: near or past its expiry, or signed with a key this CLI doesn't know. */
      readonly warning?: string;
    }
  | { readonly kind: 'error'; readonly message: string };

export interface DevLicenseKeyInput {
  /** The shell `kindgi dev` runs in. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The home folder (`homeFolder`); `undefined` when there's none. */
  readonly home: string | undefined;
  readonly now?: () => number;
  /** The keys a license key is checked against; default Kindgi's own. */
  readonly publicKeys?: Readonly<Record<string, string>>;
}

/** Why `kindgi dev` won't start: no key in the shell, and none kept. */
export const NO_DEV_LICENSE_KEY = `kindgi dev needs a license key, as every Kindgi runtime does. Get a free one at https://access.kindgi.com, then run kindgi auth registry with it: it logs Docker in and keeps the key for kindgi dev (${HOME_LICENSE_KEY_DISPLAY}). Or set ${DEV_LICENSE_KEY_VAR} in this shell.`;

/** The key `kindgi dev` runs with, checked: or why it can't start. */
export async function resolveDevLicenseKey(input: DevLicenseKeyInput): Promise<DevLicenseKey> {
  const fromShell = input.env[DEV_LICENSE_KEY_VAR]?.trim();
  let key: string | undefined;
  let from: string;
  if (fromShell !== undefined && fromShell !== '') {
    key = fromShell;
    from = DEV_LICENSE_KEY_VAR;
  } else {
    from = homeLicenseKeyPath(input.home) ?? HOME_LICENSE_KEY_DISPLAY;
    try {
      key = await readHomeLicenseKey(input.home);
    } catch (cause) {
      return {
        kind: 'error',
        message: `Couldn't read the license key in ${from}: ${(cause as Error).message}`,
      };
    }
  }
  if (key === undefined) return { kind: 'error', message: NO_DEV_LICENSE_KEY };

  const checked = checkLicenseKey(key, input.publicKeys ?? KINDGI_LICENSE_PUBLIC_KEYS);
  if (checked.kind === 'err') {
    if (checked.reason === 'unknown-key') {
      return {
        kind: 'ok',
        key,
        from,
        warning: `The license key in ${from} is signed with a key this CLI doesn't know yet, so the runtime checks it: update the Kindgi CLI.`,
      };
    }
    return {
      kind: 'error',
      message: `The value in ${from} isn't a Kindgi license key (${checked.reason}). Give the whole key, starting kgi_lk_, to kindgi auth registry: from https://access.kindgi.com, or the one Kindgi sent you.`,
    };
  }

  const { claims } = checked;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const whose = `${claims.name}'s ${claims.use} key`;
  const advice = devRenewAdvice(claims);
  const standing = standingOf(claims, (input.now ?? Date.now)());
  switch (standing.kind) {
    case 'valid':
      return {
        kind: 'ok',
        key,
        from,
        what: `${whose}, until ${day(claims.expiresAt)} (${standing.daysLeft} days)`,
      };
    case 'expiring':
      return {
        kind: 'ok',
        key,
        from,
        what: `${whose}, until ${day(claims.expiresAt)}`,
        warning: `${whose} expires in ${standing.daysLeft} days (${day(claims.expiresAt)}). ${advice}.`,
      };
    case 'grace':
      return {
        kind: 'ok',
        key,
        from,
        what: `${whose}, expired on ${day(claims.expiresAt)}`,
        warning: `${whose} expired on ${day(claims.expiresAt)}: the runtime starts with it until ${day(standing.lastStart)}. ${advice}.`,
      };
    case 'expired':
      return {
        kind: 'ok',
        key,
        from,
        what: `${whose}, expired on ${day(claims.expiresAt)}`,
        warning: `${whose} expired on ${day(claims.expiresAt)}, more than ${LICENSE_GRACE_DAYS} days ago: the runtime won't start with it. ${advice}.`,
      };
  }
}
