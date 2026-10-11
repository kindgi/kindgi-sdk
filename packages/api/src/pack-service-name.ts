// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The name of a deployment's pack service, when each deployment runs in a
 * pack service of its own: `kp-` and the first 20 characters of the
 * lowercase, unpadded RFC 4648 base32 of `sha256("<tenantId>:<deploymentId>")`
 * (100 bits). Whatever runs the services (an orchestrator) names each one
 * this way, and the server checks that an endpoint's host begins with the
 * name, so one tenant's deployment is never pointed at another's service.
 * It's built from opaque ids, never a customer's name, and fits a Cloud Run
 * service name (lowercase letters, digits and hyphens, a letter first,
 * 23 characters).
 */

import { createHash } from 'node:crypto';

/** The prefix of every pack service name. */
export const PACK_SERVICE_NAME_PREFIX = 'kp-';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const NAME_CHARACTERS = 20;

/** `kp-` and 20 base32 characters, from the tenant and the deployment. */
export function packServiceName(tenantId: string, deploymentId: string): string {
  const digest = createHash('sha256').update(`${tenantId}:${deploymentId}`, 'utf8').digest();
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < NAME_CHARACTERS) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === NAME_CHARACTERS) break;
  }
  return `${PACK_SERVICE_NAME_PREFIX}${out}`;
}

/**
 * Whether `host` belongs to the service named `name`: it begins with the
 * name and then `-` or `.`, so a longer name (`kp-…x`) doesn't pass. Cloud
 * Run's hosts are `<service>-<project number>.<region>.run.app`, and an
 * internal name may be `<service>.<domain>`. Compared lowercase.
 *
 * It checks the first label only: the domain is the hosts allowlist's to
 * check (`packEndpointHostAllowed`, `@kindgi/env-schema`), so a caller runs
 * both. Pass the URL's `hostname` (no port).
 */
export function hostNamesPackService(host: string, name: string): boolean {
  const lower = host.toLowerCase();
  return lower.startsWith(`${name}-`) || lower.startsWith(`${name}.`);
}
