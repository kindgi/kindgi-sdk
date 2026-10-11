// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, EnvName } from '@kindgi/types';
import type { ScopeRef } from '../scope-wire.js';

import { scopeForBody, scopeToQuery } from '../scope-wire.js';
import { readSse, unwrapSseData } from '../streaming.js';
import type { Transport } from '../transport.js';

/**
 * Secrets resource — full lifecycle over `SecretBinding`.
 *
 * Wire calls target `/v1/secrets/*`. Rotation is the one method that
 * abstracts across sync vs async providers:
 *
 *   - **Sync providers** return 201 with the outcome inline; SDK
 *     resolves the returned Promise immediately.
 *   - **Async providers** return 202 with `{ rotationId, statusUrl }`;
 *     SDK polls `GET /v1/secrets/:name/rotations/:rotationId` with
 *     **exponential backoff 1s → 30s max, 15-min total ceiling**.
 *     A terminal failure resolves with a `failed` (or `cancelled`)
 *     outcome; passing the ceiling resolves with `timeout`.
 *
 * The abstraction is opt-out via `mode: 'raw'` — callers that want
 * to observe SSE or self-manage polling get the wire response
 * unchanged.
 *
 * Wire-safety: `value` NEVER returns from any read path. The
 * only method that accepts plaintext is `set` (and `rotate` when a
 * caller passes `newValue`). `getVersion` + `listVersions` return
 * metadata only; the `value` field on the wire is always `null` for
 * those routes.
 */
export interface SecretsClient {
  list(input: SecretListInput): Promise<SecretListPage>;
  get(input: SecretGetInput): Promise<SecretRecord | null>;
  getVersion(input: SecretGetVersionInput): Promise<SecretVersionRecord | null>;
  listVersions(input: SecretListVersionsInput): Promise<SecretVersionPage>;
  set(input: SecretSetInput): Promise<SecretSetOutcome>;
  /**
   * Rotate a secret. Default `mode: 'wait-for-complete'` — SDK polls
   * async providers to terminal state before resolving. `mode: 'raw'`
   * returns the wire response unchanged (escape hatch for callers
   * that want SSE or self-managed polling).
   */
  rotate(input: SecretRotateInput): Promise<RotationOutcome>;
  revoke(input: SecretRevokeInput): Promise<SecretRevokeOutcome>;

  readonly rotations: SecretRotationsClient;
}

export interface SecretRotationsClient {
  /**
   * Fetch the current status of a rotation attempt (used by callers
   * who opted into `rotate({mode: 'raw'})` and are polling manually).
   *
   * @wire GET /v1/secrets/:name/rotations/:rotationId
   */
  get(input: SecretRotationGetInput): Promise<RotationStatus>;

  /**
   * SSE stream of rotation progress events. Terminates when the
   * rotation reaches a terminal state (`succeeded` | `failed`).
   *
   * @wire GET /v1/secrets/:name/rotations/:rotationId/events
   */
  events(
    input: SecretRotationEventsInput,
    options?: {
      readonly signal?: AbortSignal;
      readonly initialBackoffMs?: number;
      readonly maxBackoffMs?: number;
    },
  ): AsyncIterable<unknown>;
}

export interface SecretRotationGetInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
  readonly rotationId: string;
}

export type SecretRotationEventsInput = SecretRotationGetInput;

// -------------------- inputs --------------------

export interface SecretListInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly cursor?: Cursor;
  readonly namePrefix?: string;
  readonly includeRevoked?: boolean;
  readonly limit?: number;
}

export interface SecretGetInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
}

export interface SecretGetVersionInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
  readonly versionId: number;
}

export interface SecretListVersionsInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
  readonly cursor?: Cursor;
  readonly limit?: number;
}

export interface SecretSetInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
  readonly value: string;
  readonly writeMode: 'create-new' | 'add-version';
  readonly ifVersion?: number;
  readonly rotationDueAt?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  /**
   * Under `kindgi dev` only: write the app's own env file (`.env.local` by
   * default) instead of Kindgi's `.kindgi/secrets.env`, for a value the app
   * reads too (a webhook signing secret). A runtime with a secrets store
   * refuses it.
   */
  readonly appEnvFile?: boolean;
}

export interface SecretRotateInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
  readonly newValue?: string;
  readonly revokeOldAfterMs?: number;
  /**
   * Rotation mode. Default `wait-for-complete` — SDK polls async
   * providers to terminal state. `raw` bypasses polling for callers
   * who want to observe SSE or self-manage polling.
   */
  readonly mode?: 'wait-for-complete' | 'raw';
  /**
   * Idempotency-Key. Rotation is a mutating verb; providing an
   * idempotency-key guarantees at-most-once execution across retries.
   */
  readonly idempotencyKey?: string;
  /**
   * Test-only polling overrides. Production callers leave this
   * undefined — the defaults are 1s initial, 30s max, 15-min
   * ceiling. Exposed so unit tests exercise
   * the poll loop without waiting 15 minutes.
   */
  readonly pollingOverrides?: PollingOverrides;
}

export interface PollingOverrides {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly ceilingMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SecretRevokeInput {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
  readonly hard?: boolean;
  readonly reason?: string;
}

// -------------------- outputs --------------------

export interface SecretRecord {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
  readonly currentVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
  readonly revokeReason?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly rotationDueAt?: string;
}

export interface SecretVersionRecord {
  readonly scope: ScopeRef;
  readonly envName: EnvName;
  readonly name: string;
  readonly versionId: number;
  readonly createdAt: string;
  /** Wire always returns `null` here — there is no HTTP read path for plaintext. */
  readonly value: string | null;
  readonly revokedAt?: string;
}

export interface SecretListPage {
  readonly data: readonly SecretRecord[];
  /** Whether there's another page (`nextCursor` names it). */
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

export interface SecretVersionPage {
  readonly data: readonly SecretVersionRecord[];
  /** Whether there's another page (`nextCursor` names it). */
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

export type SecretSetOutcome =
  | { readonly kind: 'ok'; readonly record: SecretRecord; readonly versionId: number }
  | { readonly kind: 'already-exists'; readonly currentVersion: number }
  | { readonly kind: 'version-conflict'; readonly currentVersion: number };

export interface SecretRevokeOutcome {
  readonly revoked: boolean;
  readonly hard: boolean;
}

/**
 * Rotation outcome after the SDK has resolved sync-vs-async. Callers
 * who opt into `mode: 'raw'` receive a `RawRotationResponse` directly
 * (either 201 or 202 payload) — never the discriminated outcome below.
 */
export type RotationOutcome =
  | {
      readonly kind: 'ok';
      readonly newVersionId: number;
      readonly oldVersionId: number;
      readonly oldVersionRevokedAt?: string;
    }
  | {
      readonly kind: 'failed';
      readonly error: string;
    }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timeout'; readonly rotationId: string; readonly statusUrl: string }
  | { readonly kind: 'raw'; readonly response: RawRotationResponse };

/**
 * Wire-shape of the rotation POST. `sync` = 201 body; `async` = 202
 * body; SDK's `mode: 'raw'` returns exactly this shape.
 */
export type RawRotationResponse =
  | {
      readonly kind: 'sync';
      readonly newVersionId: number;
      readonly oldVersionId: number;
      readonly oldVersionRevokedAt?: string;
    }
  | {
      readonly kind: 'async';
      readonly rotationId: string;
      readonly statusUrl: string;
      readonly eventsUrl: string;
    };

/** Wire shape of `GET /v1/secrets/:name/rotations/:rotationId`. */
export interface RotationStatus {
  readonly rotationId: string;
  readonly status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly newVersionId?: number;
  readonly oldVersionId?: number;
  readonly error?: string;
}

// -------------------- polling defaults --------------------

/**
 * Exponential backoff 1s → 30s max, 15-min ceiling (provider-side
 * rotations can take several minutes).
 */
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_CEILING_MS = 15 * 60 * 1_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// -------------------- wire helpers --------------------

interface WireSecretListPage {
  readonly data: readonly SecretRecord[];
  /** Absent from older servers. */
  readonly hasMore?: boolean;
  readonly nextCursor?: string;
}

interface WireSecretVersionPage {
  readonly data: readonly SecretVersionRecord[];
  /** Absent from older servers. */
  readonly hasMore?: boolean;
  readonly nextCursor?: string;
}

interface WireSecretSetOk {
  readonly record: SecretRecord;
  readonly versionId: number;
}

interface WireErrorEnvelope {
  readonly error?: {
    readonly code?: string;
    readonly serverCode?: string;
    readonly fields?: Readonly<Record<string, unknown>>;
    // Fallback for direct wire hydration (not routed through fromWire).
    readonly currentVersion?: number;
  };
}

// -------------------- rotate helpers --------------------

/**
 * The rotate POST returns 201 or 202. Transport surfaces both as
 * successful 2xx and hands us the parsed JSON — but we need to peek
 * at the `kind` discriminator to know which shape came back. Transport
 * doesn't expose status codes, so the wire uses an explicit `kind`
 * field to make the discrimination readable.
 */
async function pollForRotationTerminal(
  transport: Transport,
  input: SecretRotateInput,
  rotationId: string,
): Promise<RotationOutcome> {
  const overrides = input.pollingOverrides;
  const initialDelay = overrides?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelay = overrides?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const ceiling = overrides?.ceilingMs ?? DEFAULT_CEILING_MS;
  const sleep = overrides?.sleep ?? defaultSleep;

  const q = scopeToQuery(input.scope);
  const startedAt = Date.now();
  let nextDelay = initialDelay;

  const query = {
    envName: input.envName as unknown as string,
    scopeKind: q.scopeKind,
    ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
  };
  const statusPath = `/v1/secrets/${encodeURIComponent(input.name)}/rotations/${encodeURIComponent(rotationId)}`;

  for (;;) {
    await sleep(nextDelay);
    const elapsed = Date.now() - startedAt;
    if (elapsed >= ceiling) {
      const statusUrl = `${transport.apiUrl}${statusPath}`;
      return { kind: 'timeout', rotationId, statusUrl };
    }

    const status = await transport.request<RotationStatus>({
      method: 'GET',
      path: statusPath,
      query,
    });

    if (status.status === 'succeeded') {
      if (status.newVersionId === undefined || status.oldVersionId === undefined) {
        // Server contract violation — surface as failed with a hint.
        return {
          kind: 'failed',
          error: 'succeeded status returned without newVersionId/oldVersionId',
        };
      }
      return {
        kind: 'ok',
        newVersionId: status.newVersionId,
        oldVersionId: status.oldVersionId,
      };
    }
    if (status.status === 'failed') {
      return { kind: 'failed', error: status.error ?? 'rotation failed' };
    }
    if (status.status === 'cancelled') {
      return { kind: 'cancelled' };
    }

    // pending — bump backoff (double until ceiling).
    nextDelay = Math.min(nextDelay * 2, maxDelay);
  }
}

// -------------------- factory --------------------

export function makeSecretsClient(transport: Transport): SecretsClient {
  return {
    async list(input) {
      const q = scopeToQuery(input.scope);
      const page = await transport.request<WireSecretListPage>({
        method: 'GET',
        path: '/v1/secrets',
        query: {
          envName: input.envName as unknown as string,
          scopeKind: q.scopeKind,
          ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
          ...(input.cursor !== undefined && { cursor: input.cursor as unknown as string }),
          ...(input.namePrefix !== undefined && { namePrefix: input.namePrefix }),
          ...(input.includeRevoked === true && { includeRevoked: true }),
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
        return await transport.request<SecretRecord>({
          method: 'GET',
          path: `/v1/secrets/${encodeURIComponent(input.name)}`,
          query: {
            envName: input.envName as unknown as string,
            scopeKind: q.scopeKind,
            ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
          },
        });
      } catch (err) {
        if (isKindOfNotFound(err, 'secret-not-found', 'secret')) return null;
        throw err;
      }
    },

    async getVersion(input) {
      const q = scopeToQuery(input.scope);
      try {
        return await transport.request<SecretVersionRecord>({
          method: 'GET',
          path: `/v1/secrets/${encodeURIComponent(input.name)}/versions/${input.versionId}`,
          query: {
            envName: input.envName as unknown as string,
            scopeKind: q.scopeKind,
            ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
          },
        });
      } catch (err) {
        if (isKindOfNotFound(err, 'secret-version-not-found', 'secret-version')) return null;
        throw err;
      }
    },

    async listVersions(input) {
      const q = scopeToQuery(input.scope);
      const page = await transport.request<WireSecretVersionPage>({
        method: 'GET',
        path: `/v1/secrets/${encodeURIComponent(input.name)}/versions`,
        query: {
          envName: input.envName as unknown as string,
          scopeKind: q.scopeKind,
          ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
          ...(input.cursor !== undefined && { cursor: input.cursor as unknown as string }),
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

    async set(input) {
      try {
        const ok = await transport.request<WireSecretSetOk>({
          method: 'POST',
          path: '/v1/secrets',
          body: {
            scope: scopeForBody(input.scope),
            envName: input.envName,
            name: input.name,
            value: input.value,
            writeMode: input.writeMode,
            ...(input.ifVersion !== undefined && { ifVersion: input.ifVersion }),
            ...(input.rotationDueAt !== undefined && { rotationDueAt: input.rotationDueAt }),
            ...(input.tags !== undefined && { tags: input.tags }),
            ...(input.appEnvFile === true && { appEnvFile: true }),
          },
          ...(input.idempotencyKey !== undefined && {
            idempotencyKey: input.idempotencyKey,
          }),
        });
        return { kind: 'ok', record: ok.record, versionId: ok.versionId };
      } catch (err) {
        const conflict = tryReadVersionConflict(err);
        if (conflict !== null) return conflict;
        throw err;
      }
    },

    async rotate(input) {
      const q = scopeToQuery(input.scope);
      const response = await transport.request<RawRotationResponse>({
        method: 'POST',
        path: `/v1/secrets/${encodeURIComponent(input.name)}/rotate`,
        query: {
          envName: input.envName as unknown as string,
          scopeKind: q.scopeKind,
          ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
        },
        body: {
          scope: scopeForBody(input.scope),
          envName: input.envName,
          ...(input.newValue !== undefined && { newValue: input.newValue }),
          ...(input.revokeOldAfterMs !== undefined && {
            revokeOldAfterMs: input.revokeOldAfterMs,
          }),
        },
        ...(input.idempotencyKey !== undefined && {
          idempotencyKey: input.idempotencyKey,
        }),
      });

      const mode = input.mode ?? 'wait-for-complete';
      if (mode === 'raw') {
        return { kind: 'raw', response };
      }

      if (response.kind === 'sync') {
        return {
          kind: 'ok',
          newVersionId: response.newVersionId,
          oldVersionId: response.oldVersionId,
          ...(response.oldVersionRevokedAt !== undefined && {
            oldVersionRevokedAt: response.oldVersionRevokedAt,
          }),
        };
      }

      // async — poll until terminal or ceiling exceeded.
      return pollForRotationTerminal(transport, input, response.rotationId);
    },

    async revoke(input) {
      const q = scopeToQuery(input.scope);
      return transport.request<SecretRevokeOutcome>({
        method: 'DELETE',
        path: `/v1/secrets/${encodeURIComponent(input.name)}`,
        query: {
          envName: input.envName as unknown as string,
          scopeKind: q.scopeKind,
          ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
          ...(input.hard === true && { hard: true }),
          ...(input.reason !== undefined && { reason: input.reason }),
        },
      });
    },

    rotations: {
      async get(input) {
        const q = scopeToQuery(input.scope);
        return transport.request<RotationStatus>({
          method: 'GET',
          path: `/v1/secrets/${encodeURIComponent(input.name)}/rotations/${encodeURIComponent(input.rotationId)}`,
          query: {
            envName: input.envName as unknown as string,
            scopeKind: q.scopeKind,
            ...(q.scopeId !== undefined && { scopeId: q.scopeId }),
          },
        });
      },
      events(input, options) {
        const q = scopeToQuery(input.scope);
        const params = new URLSearchParams();
        params.set('envName', input.envName as unknown as string);
        params.set('scopeKind', q.scopeKind);
        if (q.scopeId !== undefined) params.set('scopeId', q.scopeId);
        const url = `${transport.apiUrl}/v1/secrets/${encodeURIComponent(input.name)}/rotations/${encodeURIComponent(input.rotationId)}/events?${params.toString()}`;
        const source = readSse<unknown>({
          url,
          headers: transport.authHeaders(),
          fetchImpl: transport.fetchImpl,
          ...(options?.signal !== undefined && { signal: options.signal }),
          ...(options?.initialBackoffMs !== undefined && {
            initialBackoffMs: options.initialBackoffMs,
          }),
          ...(options?.maxBackoffMs !== undefined && {
            maxBackoffMs: options.maxBackoffMs,
          }),
        });
        return unwrapSseData(source);
      },
    },
  };
}

// -------------------- error introspection --------------------

/**
 * Robust check for a "not found" wire code in any shape it can take:
 * the raw code, a `ServerError` with that `serverCode` (how `fromWire`
 * hydrates `secret-not-found`, which it does not map to
 * `NotFoundError`), or a `NotFoundError` with the given
 * `resource.kind`.
 */
function isKindOfNotFound(err: unknown, wireCode: string, resourceKind: string): boolean {
  if (err === null || typeof err !== 'object') return false;
  const asAny = err as { readonly error?: Record<string, unknown> };
  const inner = asAny.error;
  if (inner === undefined) return false;
  const code = inner.code;
  const serverCode = inner.serverCode;
  if (code === wireCode) return true;
  if (code === 'server' && serverCode === wireCode) return true;
  if (
    code === 'not-found' &&
    typeof inner.resource === 'object' &&
    inner.resource !== null &&
    (inner.resource as Record<string, unknown>).kind === resourceKind
  ) {
    return true;
  }
  return false;
}

function tryReadVersionConflict(err: unknown): SecretSetOutcome | null {
  if (err === null || typeof err !== 'object') return null;
  const asAny = err as WireErrorEnvelope;
  const inner = asAny.error;
  if (inner === undefined) return null;
  const isConflict =
    inner.code === 'secret-write-conflict' ||
    inner.code === 'conflict' ||
    inner.serverCode === 'secret-write-conflict';
  if (!isConflict) return null;
  const fromFields = inner.fields?.currentVersion;
  const current = typeof fromFields === 'number' ? fromFields : inner.currentVersion;
  if (typeof current !== 'number') return null;
  // Server distinguishes `already-exists` from `version-conflict` at
  // the domain layer, but both map to the same 409 wire code. Both
  // return the current version — we surface as `version-conflict` since
  // callers handle them the same way (re-read + retry).
  return { kind: 'version-conflict', currentVersion: current };
}
