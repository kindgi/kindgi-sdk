// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Whether a name says the value under it is a credential: an HTTP header's
 * name (`X-Api-Key`, `X-Auth-Token`) or an env variable's (`GITHUB_TOKEN`,
 * `OPENAI_API_KEY`). One rule for both, so a client can tell which names a
 * server refuses in plaintext before it asks.
 */

/** Names that always carry a credential. */
const CREDENTIAL_NAMES = new Set(['authorization', 'proxy-authorization', 'cookie']);
/** A `-`/`_`-separated part that marks a name as a credential's. */
const CREDENTIAL_PARTS = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'credential',
  'credentials',
  'signature',
  'session',
  'auth',
  'authorization',
  'authentication',
]);
/**
 * Two adjacent parts that do (`X-Api-Key`, `Ocp-Apim-Subscription-Key`,
 * `x-functions-key`). A lone `key` doesn't: `X-Idempotency-Key`,
 * `X-Cache-Key` and `X-Partition-Key` are plain.
 */
const CREDENTIAL_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'],
  ['access', 'key'],
  ['private', 'key'],
  ['auth', 'key'],
  ['subscription', 'key'],
  ['functions', 'key'],
  ['application', 'key'],
  ['app', 'key'],
  ['master', 'key'],
  ['client', 'key'],
  ['partner', 'key'],
];

/**
 * Whether `name` says it carries a credential, ignoring case: `Authorization`,
 * `Proxy-Authorization`, `Cookie`, or a name with a `-`/`_`-separated part
 * such as `token`, `secret`, `password`, `apikey`, `session`, `signature` or
 * `auth`, or the parts `api` `key` (`X-Api-Key`, `X-Auth-Token`,
 * `X-Session-Id`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`).
 */
export function isCredentialName(name: string): boolean {
  const lower = name.toLowerCase();
  if (CREDENTIAL_NAMES.has(lower)) return true;
  const parts = lower.split(/[-_]/);
  if (parts.some((p) => CREDENTIAL_PARTS.has(p))) return true;
  return parts.some((p, i) => CREDENTIAL_PAIRS.some(([a, b]) => p === a && parts[i + 1] === b));
}
