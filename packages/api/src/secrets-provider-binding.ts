// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Scope } from '@kindgi/platform';
import type { EnvName, Result } from '@kindgi/types';

/**
 * Adapter surface below `SecretBinding`. External-secret-manager
 * deployments plug this in behind a secrets router (a thin
 * `SecretBinding` implementation that delegates every method to a
 * wired provider). Provider adapter packages MUST ship under
 * a secrets-provider adapter naming for discoverability.
 *
 * Provider adapters MUST NOT emit compliance-evidence events
 * themselves — the `SecretBinding` router owns that. Adapters are
 * dumb translators between the framework's uniform surface and the
 * provider's native API.
 */
export interface SecretProviderBinding {
  readonly providerName: string;
  getSecret(
    input: SecretProviderGetInput,
  ): Promise<Result<SecretProviderPayload | null, SecretProviderError>>;
  getSecretVersion(
    input: SecretProviderGetVersionInput,
  ): Promise<Result<SecretProviderPayload | null, SecretProviderError>>;
  listSecrets(
    input: SecretProviderListInput,
  ): Promise<Result<SecretProviderListOutput, SecretProviderError>>;
  putSecret(
    input: SecretProviderPutInput,
  ): Promise<Result<SecretProviderPutOutput, SecretProviderError>>;
  rotateSecret(
    input: SecretProviderRotateInput,
  ): Promise<Result<SecretProviderRotateOutput, SecretProviderError>>;
  deleteSecret(
    input: SecretProviderDeleteInput,
  ): Promise<Result<SecretProviderDeleteOutput, SecretProviderError>>;
  probe(): Promise<Result<SecretProviderProbeOutput, SecretProviderError>>;
}

/**
 * How the provider knows which scope + env to talk to. Three
 * strategies (mode governs provider-instance sharing; `scope` carries
 * the full discriminated `Scope` from `@kindgi/platform` for
 * path-encoding):
 *
 *   - `mode: 'shared-provider'` — one provider instance for all
 *     tenants + envs; adapter encodes scope + env into `name`
 *     (e.g. Vault: `secret/data/<scopeKind>/<tenantId>/<orgId|projectId|_>/<envName>/<name>`).
 *   - `mode: 'per-tenant-provider'` — provider constructed per
 *     tenant; adapter encodes scope-level (org/project id) + env.
 *   - `mode: 'per-tenant-env-provider'` — provider constructed per
 *     (tenant, env) pair; adapter still encodes scope-level
 *     (org/project) into `name` when non-tenant. For providers with a
 *     native `environment` concept (env dimension only).
 *
 * Scope-hierarchy resolution is done framework-side by the
 * `SecretBinding` router BEFORE delegating to a provider — each
 * `Provider*Input` call targets exactly one scope level. Providers
 * do not walk the hierarchy.
 *
 * `SecretProviderScope` carries the full discriminated `Scope`
 * primitive, not just `tenantId`.
 */
export type SecretProviderScope =
  | {
      readonly mode: 'shared-provider';
      readonly scope: Scope;
      readonly envName: EnvName;
      readonly namespace?: string;
    }
  | { readonly mode: 'per-tenant-provider'; readonly scope: Scope; readonly envName: EnvName }
  | { readonly mode: 'per-tenant-env-provider'; readonly scope: Scope; readonly envName: EnvName };

export interface SecretProviderGetInput {
  readonly providerScope: SecretProviderScope;
  readonly name: string;
}

export interface SecretProviderGetVersionInput {
  readonly providerScope: SecretProviderScope;
  readonly name: string;
  readonly versionId: number;
  /**
   * The provider's own id for this version, when the caller recorded it
   * (the router does, from `SecretProviderPutOutput.providerVersion`).
   * Adapters whose native versions aren't integers (Azure Key Vault's
   * hex ids, AWS's UUIDs) fetch by it; the others may ignore it.
   */
  readonly providerVersion?: string;
}

export interface SecretProviderPayload {
  readonly name: string;
  readonly versionId: number;
  readonly createdAt: string;
  readonly value: string;
  /** The provider's own id for this version (see `SecretProviderPutOutput.providerVersion`). */
  readonly providerVersion?: string;
}

export interface SecretProviderListInput {
  readonly providerScope: SecretProviderScope;
  readonly namePrefix?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface SecretProviderListOutput {
  readonly data: readonly SecretProviderMetadata[];
  readonly nextCursor?: string;
}

export interface SecretProviderMetadata {
  readonly name: string;
  readonly currentVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
}

export interface SecretProviderPutInput {
  readonly providerScope: SecretProviderScope;
  readonly name: string;
  readonly value: string;
  readonly writeMode: 'create-new' | 'add-version';
  /**
   * Kindgi's number for the version this write creates, when the caller
   * numbers versions itself (the router does). Adapters make the write
   * idempotent per `(name, versionId)`: if that version already exists
   * (a retry after the provider wrote it but the caller couldn't record
   * it), they return it instead of writing again, so a retry never
   * leaves an orphaned version. Key Vault tags the version, AWS stages
   * it, Vault checks-and-sets, GCP's own numbers match.
   */
  readonly versionId?: number;
}

export type SecretProviderPutOutput =
  | {
      readonly kind: 'ok';
      readonly versionId: number;
      readonly createdAt: string;
      /**
       * The provider's own id for the version written: a Key Vault
       * version, an AWS `VersionId`, or Vault's or GCP's version number
       * as a string. The router records it, so Kindgi's version numbers
       * stay its own whatever the provider uses.
       */
      readonly providerVersion?: string;
      /**
       * This write ended a revoke's provider-side retention early: the
       * secret was revoked, and setting it again meant deleting the
       * revoked values for good (AWS Secrets Manager, whose revoke keeps
       * the whole secret restorable until the name is set again). Absent
       * on every other write.
       */
      readonly revokedValuesPurged?: true;
    }
  | { readonly kind: 'already-exists' }
  | { readonly kind: 'version-conflict'; readonly currentVersion: number };

export interface SecretProviderRotateInput {
  readonly providerScope: SecretProviderScope;
  readonly name: string;
  readonly newValue?: string;
  readonly revokeOldAfterMs?: number;
  /** Kindgi's number for the new version: idempotent as `SecretProviderPutInput.versionId`. */
  readonly versionId?: number;
}

export type SecretProviderRotateOutput =
  | {
      readonly kind: 'ok';
      readonly newVersionId: number;
      readonly oldVersionId: number;
      /** The provider's own id for the new version (see `SecretProviderPutOutput`). */
      readonly newProviderVersion?: string;
    }
  | { readonly kind: 'rotation-pending'; readonly resumeToken: string };

export interface SecretProviderDeleteInput {
  readonly providerScope: SecretProviderScope;
  readonly name: string;
  readonly hard: boolean;
}

export interface SecretProviderDeleteOutput {
  readonly deleted: boolean;
}

export interface SecretProviderProbeOutput {
  readonly reachable: true;
  readonly providerVersion?: string;
  readonly latencyMs?: number;
}

/**
 * Uniform error shape across every provider adapter. Adapters map
 * their native failure conditions to these codes; the router
 * translates them further into `SecretError` codes.
 */
export type SecretProviderError =
  | { readonly code: 'unreachable'; readonly message: string; readonly cause?: unknown }
  | { readonly code: 'unauthorized'; readonly message: string; readonly cause?: unknown }
  | {
      readonly code: 'rate-limited';
      readonly message: string;
      readonly retryAfterMs?: number;
    }
  | { readonly code: 'unsupported'; readonly message: string; readonly feature: string }
  | { readonly code: 'provider-error'; readonly message: string; readonly cause?: unknown };
