// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Spec for the `retention` PolicyKind — one policy in the tenant policy
 * catalog describes "for domain X, tombstoned rows survive N seconds
 * past their tombstone time (`unregisteredAt`) before hard-purge". Two
 * kinds of caller deserialize this: (a) a retention executor (a
 * `PolicyExecutor<'retention', …>`) planning purges, (b) the
 * `RetentionBinding` behind `GET /v1/retention/scheduled` in
 * `@kindgi/api`.
 *
 * The registry stores this inside the standard `{ v: 1, doc: RetentionSpec }`
 * envelope on `Policy.spec` (`retentionSpecDoc` unwraps it). A tenant
 * has one retention policy per domain, plus at most one `domain: '*'`
 * policy as the tenant-wide default: publishing a second policy id for a
 * domain is refused (`policyScope`, `scope-taken`), and every version of
 * a policy id keeps its domain. A domain's own policy wins over `*`.
 *
 * Policies stored before that rule can still cover one domain twice.
 * Then the policy whose latest version is highest applies, and on equal
 * versions the lower policy id; the retention routes report the overlap
 * (`conflicts`) so one can be unregistered.
 */

/**
 * Closed vocabulary of tombstoning domains. Uses the object type names
 * of the authorization model in `@kindgi/authz` wherever one exists
 * (`policy`, `judgment`, `judge_class`, `provider` and `api_key` have
 * none), so a retention policy on `domain: 'tool'` names the same
 * resource kind that authorization checks refer to. `api_key`'s
 * tombstones are revoked and expired keys; `service_account`'s are
 * unregistered accounts.
 *
 * `'*'` is a wildcard — matches any domain that has no specific policy.
 * Useful shape for "unless overridden, everything sits for 90 days".
 * Except `memory` and `conversation`, which hold people's words: their
 * retention is opt-in, so only a policy naming them applies.
 *
 * `memory`: a fact whose last revision was invalidated (deleted, erased)
 * or whose current revision expired is purged, every revision, after the
 * grace; legal hold keeps it. `conversation`: an unregistered conversation
 * is purged after the grace, with its messages and their recall index.
 */
export const RETENTION_DOMAINS = [
  'org',
  'agent',
  'flow',
  'tool',
  'eval_suite',
  'guardrail',
  'mcp_endpoint',
  'env',
  'secret',
  'run',
  // An artifact's row (no authorization type of its own: it answers to
  // its project); its bytes go once no row names them.
  'artifact',
  'policy',
  'judgment',
  'judge_class',
  'provider',
  'memory',
  'conversation',
  'api_key',
  'service_account',
  '*',
] as const;
export type RetentionDomain = (typeof RETENTION_DOMAINS)[number];

/**
 * `graceSeconds` semantics — measured from the tombstoned row's
 * `unregisteredAt` timestamp. Special values:
 *   - `0`  → purge on next sweep, no grace window
 *   - `-1` → never purge (compliance hold; row stays tombstoned
 *            indefinitely). Sentinel value; a sweeper skips these
 *            with a single comparison.
 *
 * Real-world values sit between `86400` (1 day) and `31536000` (1 year).
 *
 * `mode`: only `'purge'` is accepted — `validateRetentionSpec` rejects
 * `'archive'` with `unsupported-mode`. `'archive'` is reserved for
 * moving rows to cold storage before hard-delete; keeping the field
 * makes callers state the mode explicitly and leaves room for archival
 * without a spec-shape change.
 */
export interface RetentionSpec {
  readonly domain: RetentionDomain;
  readonly graceSeconds: number;
  readonly mode: 'purge' | 'archive';
}

export type RetentionSpecValidationError =
  | { readonly code: 'invalid-domain'; readonly value: unknown }
  | { readonly code: 'invalid-grace'; readonly value: unknown }
  | { readonly code: 'invalid-mode'; readonly value: unknown }
  | { readonly code: 'unsupported-mode'; readonly value: 'archive' }
  | { readonly code: 'missing-field'; readonly field: 'domain' | 'graceSeconds' | 'mode' };

/**
 * The `RetentionSpec` inside a stored `retention` policy's `spec`: the
 * `doc` of the `{ v: 1, doc }` envelope, or `spec` itself when it isn't
 * wrapped.
 */
export function retentionSpecDoc(spec: unknown): unknown {
  if (typeof spec === 'object' && spec !== null && 'doc' in spec) {
    return (spec as { readonly doc: unknown }).doc;
  }
  return spec;
}

/**
 * Validate an unknown blob (typically the `.doc` inside the versioned
 * envelope) as a `RetentionSpec`. The `@kindgi/api` policies route
 * refuses a `retention` policy that fails it (`validatePolicySpec`), and
 * executors check it again when reading one back.
 *
 * Rejects `mode: 'archive'` with the dedicated `unsupported-mode` error,
 * distinct from `invalid-mode`, because the value is reserved but not
 * implemented.
 */
export function validateRetentionSpec(
  input: unknown,
):
  | { readonly kind: 'ok'; readonly value: RetentionSpec }
  | { readonly kind: 'err'; readonly error: RetentionSpecValidationError } {
  if (typeof input !== 'object' || input === null) {
    return { kind: 'err', error: { code: 'missing-field', field: 'domain' } };
  }
  const obj = input as Record<string, unknown>;

  if (!('domain' in obj)) {
    return { kind: 'err', error: { code: 'missing-field', field: 'domain' } };
  }
  if (
    typeof obj.domain !== 'string' ||
    !(RETENTION_DOMAINS as readonly string[]).includes(obj.domain)
  ) {
    return { kind: 'err', error: { code: 'invalid-domain', value: obj.domain } };
  }

  if (!('graceSeconds' in obj)) {
    return { kind: 'err', error: { code: 'missing-field', field: 'graceSeconds' } };
  }
  const grace = obj.graceSeconds;
  if (typeof grace !== 'number' || !Number.isFinite(grace) || (grace < 0 && grace !== -1)) {
    return { kind: 'err', error: { code: 'invalid-grace', value: grace } };
  }

  if (!('mode' in obj)) {
    return { kind: 'err', error: { code: 'missing-field', field: 'mode' } };
  }
  if (obj.mode !== 'purge' && obj.mode !== 'archive') {
    return { kind: 'err', error: { code: 'invalid-mode', value: obj.mode } };
  }
  if (obj.mode === 'archive') {
    return { kind: 'err', error: { code: 'unsupported-mode', value: 'archive' } };
  }

  return {
    kind: 'ok',
    value: {
      domain: obj.domain as RetentionDomain,
      graceSeconds: grace,
      mode: obj.mode,
    },
  };
}
