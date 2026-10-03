// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TupleEnqueueHook } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { Cursor, EnvName, Result } from '@kindgi/types';

import type { ResolveContext } from './secrets-binding.js';

export type { ResolveContext } from './secrets-binding.js';

/**
 * Caller-plugged env store — non-sensitive per-env values. Same
 * `(scope, envName, name)` structural key as `SecretBinding`, same
 * discriminated `Scope` primitive from `@kindgi/platform`.
 * Emits `env-resolved` compliance-evidence events on every `resolve`
 * — symmetric with secrets, gives operators the same debugging
 * superpower ("what did this run see for its env at start?").
 *
 * What differs from `SecretBinding`:
 *   - `value` returns on the wire (env is non-sensitive by
 *     definition); no capability gate on read.
 *   - Revision counter, not version-with-rotation-ceremony. Overwrite
 *     bumps `revision`; there's no revoke, no hard-delete, no
 *     rotation-workflow-with-async-completion.
 *   - No encryption at rest.
 *
 * Env-safety: cross-env reads are refused. Same structural rule as
 * secrets.
 */
export interface EnvBinding {
  /** Cursor-paginated list. Returns `value` for every entry. */
  list(input: EnvListInput): Promise<EnvListPage>;

  /** Fetch a single entry. `null` when unknown. */
  get(input: EnvGetInput): Promise<EnvRecord | null>;

  /**
   * Resolve at dispatch time. Same `ResolveContext` as secrets. Emits
   * `env-resolved` compliance-evidence event on every call.
   */
  resolve(input: EnvResolveInput): Promise<Result<EnvResolveOutcome, EnvError>>;

  /**
   * Write / overwrite an env value. Every write bumps `revision`.
   * `ifRevision` provides optimistic concurrency guard.
   */
  set(input: EnvSetInput): Promise<EnvSetOutcome>;

  /**
   * Idempotent delete. Returns `{ deleted: false }` on unknown key.
   * No soft-delete — env is a plain overwrite-shaped store; delete
   * means gone.
   */
  delete(input: EnvDeleteInput): Promise<EnvDeleteOutcome>;
}

export interface EnvRecord {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly value: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface EnvListInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly namePrefix?: string;
  readonly tagFilter?: Readonly<Record<string, string>>;
}

export interface EnvListPage {
  readonly data: readonly EnvRecord[];
  readonly nextCursor?: Cursor;
}

export interface EnvGetInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
}

export interface EnvResolveInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly resolveContext: ResolveContext;
}

export interface EnvResolveOutcome {
  readonly name: string;
  readonly value: string;
  readonly revision: number;
}

export interface EnvSetInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly value: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly ifRevision?: number;
  /**
   * REQUIRED. Called inside the binding's write tx on FRESH insert
   * (new env-var identity). Receives the new entry's id as the FGA
   * subject id. Not invoked on revision-update (identity already exists).
   * See `AgentPublishInput.enqueueTuples` for the design rationale.
   */
  readonly enqueueTuples: TupleEnqueueHook;
}

export type EnvSetOutcome =
  | { readonly kind: 'ok'; readonly record: EnvRecord }
  | { readonly kind: 'revision-conflict'; readonly currentRevision: number }
  | { readonly kind: 'error'; readonly code: string; readonly message: string };

export interface EnvDeleteInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
}

export interface EnvDeleteOutcome {
  readonly deleted: boolean;
}

export type EnvError =
  | { readonly code: 'env-not-found'; readonly message: string; readonly name: string }
  | {
      readonly code: 'env-write-conflict';
      readonly message: string;
      readonly currentRevision: number;
    }
  | { readonly code: 'env-store-error'; readonly message: string; readonly cause?: unknown };
