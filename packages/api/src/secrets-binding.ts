// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TupleEnqueueHook } from '@kindgi/authz';
import type { Scope } from '@kindgi/platform';
import type { Cursor, EnvName, Result } from '@kindgi/types';

/**
 * Secret names starting with this prefix are reserved for framework-internal
 * material (e.g. webhook HMAC keys the runtime manages). `SecretBinding.set` rejects them
 * from callers unless the adapter was constructed to allow reserved names.
 * Every adapter enforces the same prefix — import it, don't redefine it.
 */
export const RESERVED_SECRET_NAME_PREFIX = 'kindgi.';

/**
 * Caller-plugged secret store — the framework consumer's surface for
 * every secret-lifecycle op. Every method is scope + env-scoped, where
 * `scope` is the discriminated primitive from `@kindgi/platform`
 * (Tenant / Org / Project). Writes declare the scope explicitly; reads
 * resolve via most-specific-wins walk across the scope hierarchy.
 *
 * Callers (routes, runtime dispatch, SDK clients) speak this interface
 * ONLY. Concrete storage — envelope-encrypted bytes in a database,
 * delegation to an external secret manager, etc. — is a `SecretBinding`
 * implementation choice.
 *
 * Wire-safety: plaintext is returned only by `resolve`. `SecretRecord`
 * carries no value, and `SecretVersionRecord.value` is always `null`
 * from `getVersion` / `listVersions`. All list / get paths return
 * metadata only. This is a STRUCTURAL guardrail of the interface, not
 * a caller convention.
 *
 * Env-safety: cross-env reads are refused. A caller in `envName:
 * staging` cannot resolve a secret written under `envName: production`
 * — adapter returns `secret-not-found` (indistinguishable from
 * "doesn't exist" by design; refuses to leak the existence of a
 * cross-env sibling).
 */
export interface SecretBinding {
  // -------------------- read --------------------

  /** Cursor-paginated list of secret metadata. Never returns `value`. */
  list(input: SecretListInput): Promise<SecretListPage>;

  /** Fetch metadata for a single secret. `null` when unknown. */
  get(input: SecretGetInput): Promise<SecretRecord | null>;

  /**
   * Resolve a secret's plaintext value at dispatch time. Distinct
   * method from `get` — different capability gate, different audit
   * event, different rate profile. Called by the runtime (handler
   * dispatch, deploy-time sync, boot — see `ResolveContext.caller`),
   * not by the HTTP routes. Emits a `secret-resolved` compliance-evidence
   * event on every call.
   */
  resolve(input: SecretResolveInput): Promise<Result<SecretResolveOutcome, SecretError>>;

  /** Metadata for a specific version. */
  getVersion(input: SecretGetVersionInput): Promise<SecretVersionRecord | null>;

  /** List all versions for a secret. Metadata only. */
  listVersions(input: SecretListVersionsInput): Promise<SecretVersionPage>;

  // -------------------- write --------------------

  /**
   * Create a secret OR write a new version. `writeMode` discriminates:
   *   - `'create-new'` fails with `already-exists` if the secret exists
   *   - `'add-version'` writes a new version, bumps counter atomically
   */
  set(input: SecretSetInput): Promise<SecretSetOutcome>;

  /**
   * Explicit rotation. Adapters that support caller-driven rotation
   * accept `newValue`; provider-driven rotation (a secret manager's own
   * rotation workflow) ignores it and returns the new version once the
   * provider workflow completes. Emits a `secret-rotated` event.
   */
  rotate(input: SecretRotateInput): Promise<Result<SecretRotateOutcome, SecretError>>;

  /**
   * Revoke a secret. Retains the record (soft-delete) so audit trails
   * remain resolvable; adapters MUST return `null` from `get` /
   * `resolve` for revoked secrets. `hard: true` performs irreversible
   * destroy for GDPR right-to-erasure. Emits a `secret-revoked` event.
   */
  revoke(input: SecretRevokeInput): Promise<Result<SecretRevokeOutcome, SecretError>>;

  /**
   * `true` for a binding that keeps secrets in the pack's env files
   * (`kindgi dev`): its `set` honors `appEnvFile`. Any other binding
   * leaves it unset, and `POST /v1/secrets` refuses `appEnvFile`.
   */
  readonly writesAppEnvFiles?: boolean;
}

// -------------------- record types --------------------

export interface SecretRecord {
  readonly scope: Scope;
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
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly versionId: number;
  readonly createdAt: string;
  /**
   * Always `null` from `getVersion` / `listVersions`; plaintext comes only
   * from `resolve` (`SecretResolveOutcome.value`).
   */
  readonly value: string | null;
  readonly revokedAt?: string;
}

// -------------------- inputs --------------------

export interface SecretListInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly limit: number;
  readonly cursor?: Cursor;
  readonly namePrefix?: string;
  readonly tagFilter?: Readonly<Record<string, string>>;
  readonly includeRevoked?: boolean;
}

export interface SecretListPage {
  readonly data: readonly SecretRecord[];
  readonly nextCursor?: Cursor;
}

export interface SecretGetInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
}

export interface SecretResolveInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly version?: number;
  readonly resolveContext: ResolveContext;
}

/**
 * Uniform across `EnvBinding.resolve` + `SecretBinding.resolve`.
 * Names the caller of the resolution for audit-emit attribution.
 *
 * Declared here (rather than in a separate module) because the
 * `SecretBinding` interface is the larger of the two — env-binding.ts
 * imports the type back from this module to keep the ownership flow
 * one-directional (env → secrets, not both).
 */
export interface ResolveContext {
  readonly runId?: string;
  readonly deploymentId?: string;
  readonly nodeId?: string;
  readonly caller: 'dispatch' | 'deploy-sync' | 'admin-cli' | 'boot-bridge' | 'webhook-receiver';
}

export interface SecretResolveOutcome {
  readonly name: string;
  readonly versionId: number;
  readonly value: string;
}

export interface SecretGetVersionInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly versionId: number;
}

export interface SecretListVersionsInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface SecretVersionPage {
  readonly data: readonly SecretVersionRecord[];
  readonly nextCursor?: Cursor;
}

export interface SecretSetInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly value: string;
  readonly writeMode: 'create-new' | 'add-version';
  readonly tags?: Readonly<Record<string, string>>;
  readonly rotationDueAt?: string;
  readonly ifVersion?: number;
  /**
   * Only for a binding with `writesAppEnvFiles` (`kindgi dev`'s env files):
   * write the app's own env file instead of Kindgi's secrets file, for a
   * value the app reads too (a webhook signing secret).
   */
  readonly appEnvFile?: boolean;
  /**
   * The request's `Idempotency-Key`, when it had one. A binding that
   * writes to an external store in a second step (the secret-manager
   * backend) uses it to finish a retried write instead of starting a new
   * version: a retry with the same key completes the version the first
   * attempt began. Bindings that write in one transaction may ignore it.
   */
  readonly idempotencyKey?: string;
  /**
   * REQUIRED. Called inside the binding's write tx on FRESH insert
   * (writeMode: 'create-new' → new secret identity). Receives the new
   * secret's id as the FGA subject id. Returns tuples for
   * the same tx — typically `tuplesForCreate({kind:'secret', id,
   * tenantId, scope}, creatorUserId?)`. Not invoked on `add-version`
   * (identity already exists in FGA). See `AgentPublishInput.enqueueTuples`
   * for the design rationale.
   */
  readonly enqueueTuples: TupleEnqueueHook;
}

export type SecretSetOutcome =
  | {
      readonly kind: 'ok';
      readonly record: SecretRecord;
      readonly versionId: number;
      /**
       * Setting a revoked secret again deleted its revoked values for good,
       * ending the backend's recovery window early (AWS Secrets Manager:
       * `SecretProviderPutOutput.revokedValuesPurged`). Absent otherwise.
       */
      readonly revokedValuesPurged?: true;
    }
  | { readonly kind: 'already-exists'; readonly record: SecretRecord }
  | { readonly kind: 'version-conflict'; readonly currentVersion: number }
  | { readonly kind: 'error'; readonly code: string; readonly message: string };

export interface SecretRotateInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly newValue?: string;
  readonly revokeOldAfterMs?: number;
  /** The request's `Idempotency-Key`, when it had one: as `SecretSetInput.idempotencyKey`. */
  readonly idempotencyKey?: string;
}

/**
 * Discriminated `SecretRotateOutcome`.
 *
 * Sync providers (stores that write the new version immediately)
 * return `{ kind: 'ok', newVersionId, oldVersionId, oldVersionRevokedAt? }`
 * inline. The `/v1/secrets` HTTP route translates this to a 201
 * response.
 *
 * Async providers (a secret manager whose rotation workflow completes
 * later) return `{ kind: 'rotation-pending', resumeToken, provider }`.
 * The HTTP route mints a `rotationId`, records it in the caller-plugged
 * `RotationStatusStore`, and returns 202 with `{ rotationId, statusUrl,
 * eventsUrl }`. `resumeToken` is the provider-native handle a
 * background process uses to poll the async workflow to terminal.
 */
export type SecretRotateOutcome =
  | {
      readonly kind: 'ok';
      readonly newVersionId: number;
      readonly oldVersionId: number;
      readonly oldVersionRevokedAt?: string;
    }
  | {
      readonly kind: 'rotation-pending';
      readonly resumeToken: string;
      readonly provider: string;
    };

export interface SecretRevokeInput {
  readonly scope: Scope;
  readonly envName: EnvName;
  readonly name: string;
  readonly hard?: boolean;
  readonly reason?: string;
}

export interface SecretRevokeOutcome {
  readonly revoked: boolean;
  readonly hard: boolean;
}

export type SecretError =
  | {
      readonly code: 'secret-not-found';
      readonly message: string;
      readonly name: string;
      /**
       * Why it isn't there, when it's more than "never stored": `deleted-at-provider` when the
       * secret is mapped but its provider has no value for it (deleted there). Absent: it was
       * never stored. A tool's optional secret is "not set" only when it was never stored.
       */
      readonly reason?: 'deleted-at-provider';
    }
  | { readonly code: 'secret-revoked'; readonly message: string; readonly name: string }
  | {
      readonly code: 'secret-version-not-found';
      readonly message: string;
      readonly name: string;
      readonly versionId: number;
    }
  | {
      readonly code: 'secret-encryption-failed';
      readonly message: string;
      readonly cause?: unknown;
    }
  | {
      readonly code: 'secret-decryption-failed';
      readonly message: string;
      readonly cause?: unknown;
    }
  | {
      readonly code: 'secret-provider-unavailable';
      readonly message: string;
      readonly cause?: unknown;
    }
  | {
      readonly code: 'secret-provider-unauthorized';
      readonly message: string;
      readonly cause?: unknown;
    }
  | {
      readonly code: 'secret-provider-rate-limited';
      readonly message: string;
      readonly retryAfterMs?: number;
    }
  | {
      readonly code: 'secret-write-conflict';
      readonly message: string;
      readonly currentVersion: number;
    }
  /**
   * The store doesn't do this by design (the dev store keeps no versions to
   * rotate and no revocation): the message says what to do instead.
   */
  | { readonly code: 'secret-operation-unsupported'; readonly message: string }
  | { readonly code: 'secret-store-error'; readonly message: string; readonly cause?: unknown }
  /**
   * A model provider's key, asked for by something that isn't its provider
   * (`guardProviderKeys`): a tool, an MCP endpoint or a webhook endpoint.
   */
  | {
      readonly code: 'provider-key-refused';
      readonly message: string;
      readonly name: string;
      readonly providerId: string;
    };
