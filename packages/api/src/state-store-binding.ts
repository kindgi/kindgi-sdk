// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId } from '@kindgi/types';

/**
 * Short-lived CSRF-`state` + PKCE-`code_verifier` cache used by the
 * OAuth login/callback pair. Values live between `/v1/auth/login/:id`
 * (which generates `state` + `code_verifier`) and
 * `/v1/auth/callback/:id` (which reads them back). TTL is measured in
 * minutes — long enough for a user to complete the provider hop, short
 * enough that a lost row is a non-event.
 *
 * The default `createInMemoryOauthStateStore` is appropriate for
 * single-process dev + tests. Multi-pod deployments MUST plug in a
 * shared store (Redis, Postgres) because the callback usually lands on
 * a different pod than the login. Mirror of the `IdempotencyStore`
 * caller-plugged pattern.
 *
 * Keyed by `state` alone — `state` carries 256 bits of entropy, so it
 * is uniquely identifying without a namespace. `take` matches on
 * `providerId` when supplied to guard against a stolen `state` being
 * replayed against the wrong provider mount; `tenantId` is returned in
 * the entry (the callback route learns it from the row, not the URL).
 */
export interface OauthStateStore {
  put(entry: OauthStateEntry): Promise<void>;
  /**
   * Consume the entry keyed by `state`. Returns `null` when unknown or
   * expired. When `providerId` is supplied, the returned entry MUST
   * match — the store returns `null` (and leaves the entry in place)
   * otherwise. `tenantId` is derived from the entry.
   */
  take(input: OauthStateTakeInput): Promise<OauthStateEntry | null>;
}

export interface OauthStateEntry {
  readonly state: string;
  readonly tenantId: TenantId;
  readonly providerId: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

export interface OauthStateTakeInput {
  readonly state: string;
  /** Optional cross-check — when set, entry must match or `take` returns null. */
  readonly providerId?: string;
}

/**
 * Trivial in-memory store — appropriate for tests + single-process dev.
 * Entries are single-use (`take` deletes on hit) and time out on their
 * own; the store performs a shallow expired-entry sweep on every call
 * so long-lived processes don't leak memory when a callback never
 * arrives.
 */
export function createInMemoryOauthStateStore(): OauthStateStore {
  const entries = new Map<string, OauthStateEntry>();

  const sweep = (now: number): void => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  };

  return {
    async put(entry) {
      sweep(Date.now());
      entries.set(entry.state, entry);
    },
    async take({ state, providerId }) {
      const now = Date.now();
      sweep(now);
      const entry = entries.get(state);
      if (entry === undefined) return null;
      if (providerId !== undefined && entry.providerId !== providerId) return null;
      entries.delete(state);
      if (entry.expiresAt <= now) return null;
      return entry;
    },
  };
}
