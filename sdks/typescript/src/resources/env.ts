// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, EnvName } from '@kindgi/types';
import type { ScopeRef } from '../scope-wire.js';

import { scopeForBody, scopeToQuery } from '../scope-wire.js';
import type { Transport } from '../transport.js';

/**
 * Env resource — non-sensitive per-environment values.
 *
 * Env is non-sensitive by definition — `value` returns on every read
 * path; only the `secrets.*` client redacts. Scope + envName are
 * required on every method (wire encoding: query params on
 * GET/DELETE; body-embedded on writes with cross-field validation
 * server-side).
 *
 * Every method takes `{ scope, envName, ... }` — no ambient scope
 * resolution in the SDK (that's a platform-layer concern). Callers
 * pass an explicit `Scope` discriminated primitive from
 * `@kindgi/platform`.
 */
export interface EnvClient {
  /**
   * Cursor-paginated list of env metadata + values under
   * `(scope, envName)`. Callers pass `namePrefix` for slug filtering.
   *
   * @wire `GET /v1/env?scopeKind=&scopeId=&envName=&cursor=&namePrefix=`.
   */
  list(input: EnvListInput): Promise<EnvListPage>;

  /**
   * Fetch a single env record. Returns `null` when the record does
   * not exist under `(scope, envName, name)` — sits below the HTTP 404
   * so callers can branch on `null` rather than catch a NotFoundError.
   *
   * @wire `GET /v1/env/:name?scopeKind=&scopeId=&envName=`.
   */
  get(input: EnvGetInput): Promise<EnvRecord | null>;

  /**
   * Write / overwrite an env value. `ifRevision` provides optimistic
   * concurrency: on mismatch the server returns 409 `env-write-conflict`
   * which we surface as a discriminated `revision-conflict` outcome
   * (no exception — writes race, and this is data, not error).
   *
   * @wire `PUT /v1/env/:name?scopeKind=&scopeId=&envName=` with body
   *   `{ scope, envName, name, value, ifRevision?, tags? }`.
   */
  set(input: EnvSetInput): Promise<EnvSetOutcome>;

  /**
   * Idempotent delete — `deleted: false` on unknown key (not an error).
   *
   * @wire `DELETE /v1/env/:name?scopeKind=&scopeId=&envName=`.
   */
  delete(input: EnvDeleteInput): Promise<EnvDeleteOutcome>;
}

// -------------------- inputs --------------------

export interface EnvListInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly cursor?: Cursor;
  readonly namePrefix?: string;
  readonly limit?: number;
}

export interface EnvGetInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
}

export interface EnvSetInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
  readonly value: string;
  readonly ifRevision?: number;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface EnvDeleteInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
}

// -------------------- outputs --------------------

export interface EnvRecord {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
  readonly value: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface EnvListPage {
  readonly data: readonly EnvRecord[];
  /** Whether there's another page (`nextCursor` names it). */
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

/**
 * Discriminated write outcome. Mirrors the server's `EnvSetOutcome`
 * so `switch (outcome.kind)` handles the concurrency branch inline
 * rather than through exception unwinding.
 */
export type EnvSetOutcome =
  | { readonly kind: 'ok'; readonly record: EnvRecord }
  | { readonly kind: 'revision-conflict'; readonly currentRevision: number };

export interface EnvDeleteOutcome {
  readonly deleted: boolean;
}

// -------------------- wire helpers --------------------

interface WireEnvPage {
  readonly data: readonly EnvRecord[];
  /** Absent from older servers. */
  readonly hasMore?: boolean;
  readonly nextCursor?: string;
}

interface WireEnvSetErrorEnvelope {
  readonly error?: {
    readonly code?: string;
    readonly serverCode?: string;
    readonly fields?: Readonly<Record<string, unknown>>;
    // Direct wire hydrations carry the fields at the top level rather
    // than nested under `fields`.
    readonly currentRevision?: number;
  };
}

export function makeEnvClient(transport: Transport): EnvClient {
  return {
    async list(input) {
      const q = scopeToQuery(input.scope);
      const page = await transport.request<WireEnvPage>({
        method: 'GET',
        path: '/v1/env',
        query: {
          envName: input.envName as unknown as string,
          scopeKind: q.scopeKind,
          ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
          ...(input.cursor !== undefined && {
            cursor: input.cursor as unknown as string,
          }),
          ...(input.namePrefix !== undefined && { namePrefix: input.namePrefix }),
          ...(input.limit !== undefined && { limit: input.limit }),
        },
      });
      return {
        data: page.data,
        hasMore: page.hasMore ?? page.nextCursor !== undefined,
        ...(page.nextCursor !== undefined && {
          nextCursor: page.nextCursor as unknown as Cursor,
        }),
      };
    },

    async get(input) {
      const q = scopeToQuery(input.scope);
      try {
        return await transport.request<EnvRecord>({
          method: 'GET',
          path: `/v1/env/${encodeURIComponent(input.name)}`,
          query: {
            envName: input.envName as unknown as string,
            scopeKind: q.scopeKind,
            ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
          },
        });
      } catch (err) {
        // 404 `env-not-found` → null (see the `get` contract above).
        if (isEnvNotFound(err)) return null;
        throw err;
      }
    },

    async set(input) {
      const q = scopeToQuery(input.scope);
      try {
        const record = await transport.request<EnvRecord>({
          method: 'PUT',
          path: `/v1/env/${encodeURIComponent(input.name)}`,
          query: {
            envName: input.envName as unknown as string,
            scopeKind: q.scopeKind,
            ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
          },
          body: {
            scope: scopeForBody(input.scope),
            envName: input.envName,
            name: input.name,
            value: input.value,
            ...(input.ifRevision !== undefined && { ifRevision: input.ifRevision }),
            ...(input.tags !== undefined && { tags: input.tags }),
          },
        });
        return { kind: 'ok', record };
      } catch (err) {
        const conflict = tryReadRevisionConflict(err);
        if (conflict !== null) {
          return { kind: 'revision-conflict', currentRevision: conflict };
        }
        throw err;
      }
    },

    async delete(input) {
      const q = scopeToQuery(input.scope);
      return transport.request<EnvDeleteOutcome>({
        method: 'DELETE',
        path: `/v1/env/${encodeURIComponent(input.name)}`,
        query: {
          envName: input.envName as unknown as string,
          scopeKind: q.scopeKind,
          ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
        },
      });
    },
  };
}

// -------------------- error introspection --------------------

/**
 * Env `get` collapses 404 `env-not-found` to `null`. `fromWire` (see
 * `errors.ts`) has no explicit case for `env-not-found`, so it arrives
 * as a `ServerError` with `serverCode: 'env-not-found'`. The helper
 * also accepts the raw wire code and a `NotFoundError` whose resource
 * kind is `'env'`.
 */
function isEnvNotFound(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const asAny = err as { readonly error?: Record<string, unknown> };
  const inner = asAny.error;
  if (inner === undefined) return false;
  const code = inner.code;
  const serverCode = inner.serverCode;
  if (code === 'env-not-found') return true;
  if (
    code === 'not-found' &&
    typeof inner.resource === 'object' &&
    inner.resource !== null &&
    (inner.resource as Record<string, unknown>).kind === 'env'
  ) {
    return true;
  }
  if (code === 'server' && serverCode === 'env-not-found') return true;
  return false;
}

/**
 * Env `set` collapses 409 `env-write-conflict` to a discriminated
 * outcome. Returns the `currentRevision` when the error matches, or
 * `null` when it does not (rethrow-worthy).
 */
function tryReadRevisionConflict(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null;
  const asAny = err as WireEnvSetErrorEnvelope;
  const inner = asAny.error;
  if (inner === undefined) return null;
  const isConflict =
    inner.code === 'env-write-conflict' ||
    inner.code === 'conflict' ||
    inner.serverCode === 'env-write-conflict';
  if (!isConflict) return null;
  // Server places `currentRevision` under `details` → SDK's `fromWire`
  // maps that onto `fields.currentRevision` for `ServerError`. Fall
  // back to the top-level field for direct wire hydrations.
  const fromFields = inner.fields?.currentRevision;
  if (typeof fromFields === 'number') return fromFields;
  const cur = inner.currentRevision;
  if (typeof cur !== 'number') return null;
  return cur;
}
