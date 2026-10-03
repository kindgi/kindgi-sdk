// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Public-key fingerprint helper. `sha256:<first-12-bytes-hex>` — short
 * enough to eyeball in a list, long enough to disambiguate keys within
 * a single tenant's tree. Consumers wanting the full digest hash the
 * public PEM themselves.
 *
 * Framework-grade note: this is intentionally NOT the same shape as
 * `@kindgi/crypto`'s wire fingerprint (if one lands) — this is a
 * CLI-local display convenience. When `SigningKeyBinding` admin ops
 * ship, the CLI should switch to the server's canonical fingerprint.
 */

import { createHash } from 'node:crypto';

/**
 * Compute a short fingerprint (`sha256:<first 12 bytes as hex>`) over
 * the given public-key material. Accepts raw bytes or a PEM string.
 */
export function shortFingerprint(input: Uint8Array | string): string {
  const hash = createHash('sha256');
  hash.update(typeof input === 'string' ? input : Buffer.from(input));
  const hex = hash.digest('hex').slice(0, 24);
  return `sha256:${hex}`;
}
