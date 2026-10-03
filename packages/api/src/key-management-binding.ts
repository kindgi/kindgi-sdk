// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result } from '@kindgi/types';

/**
 * Caller-plugged Key Management surface consumed by envelope-encryption
 * secret stores. The framework never talks to a KMS directly — every
 * wrap / unwrap / rewrap / destroy flows through this interface so a
 * deployment can choose a local key (dev + CI) or a managed KMS without
 * changing any framework code.
 *
 * The four load-bearing operations are `generateDek` (write path),
 * `unwrap` (read path), `rewrap` (KEK rotation batch job), and
 * `destroyDek` (cryptographic-erasure primitive backing
 * `SecretBinding.revoke({ hard: true })`). `probe` is a boot-time
 * reachability check the runtime runs before serving requests; a
 * failing probe fails boot fast so a mis-configured KMS never manifests
 * as a `secret-decryption-failed` at request time.
 */
export interface KeyManagementBinding {
  /**
   * Diagnostic identifier for the concrete KMS adapter. Emitted as
   * `kms-provider` on every compliance-evidence event so auditors can
   * filter `kms-provider = 'libsodium'` to find dev-shape leakage into
   * regulated deployments.
   */
  readonly providerName: string;

  /**
   * Generate a fresh Data Encryption Key + wrap it with the current KEK.
   * Returns the raw DEK (for immediate use in AES-GCM encryption; caller
   * MUST discard after encrypting), the wrapped bytes (persisted
   * alongside ciphertext), and the KEK id used (persisted for later
   * unwrap even after rotation).
   */
  generateDek(): Promise<Result<{ dek: Uint8Array; wrapped: Uint8Array; kekId: string }, KmsError>>;

  /** Unwrap a previously-wrapped DEK using the KEK it was wrapped with. */
  unwrap(input: {
    readonly kekId: string;
    readonly wrapped: Uint8Array;
  }): Promise<Result<Uint8Array, KmsError>>;

  /**
   * Rewrap a DEK from an old KEK to a new one. Used by the KEK-rotation
   * batch job — the DEK itself does NOT change (no ciphertext rewrite),
   * only its wrapping.
   */
  rewrap(input: {
    readonly oldKekId: string;
    readonly newKekId: string;
    readonly wrapped: Uint8Array;
  }): Promise<Result<Uint8Array, KmsError>>;

  /**
   * Destroy a specific DEK — cryptographic-erasure primitive backing
   * `SecretBinding.revoke({ hard: true })`. Semantics vary by provider
   * (scheduled key deletion, key-version destruction, ...). An adapter
   * that wraps with a local key cannot destroy an already-wrapped DEK in
   * isolation (the KEK is what would need destruction); it returns
   * `{ destroyed: true }` and relies on the caller having dropped the
   * ciphertext + wrapped bytes. Idempotent —
   * returns `{ destroyed: false }` if the KMS reports the DEK is
   * already gone.
   */
  destroyDek(input: {
    readonly kekId: string;
    readonly wrapped: Uint8Array;
  }): Promise<Result<{ destroyed: boolean }, KmsError>>;

  /**
   * Health check called at boot. Returns latency for observability.
   * A failing probe fails boot fast so a KMS
   * misconfiguration surfaces at deploy time, not at request time.
   */
  probe(): Promise<
    Result<{ reachable: true; providerVersion: string; latencyMs: number }, KmsError>
  >;
}

export type KmsError =
  | { readonly code: 'kms-unreachable'; readonly message: string; readonly cause?: unknown }
  | { readonly code: 'kms-unauthorized'; readonly message: string; readonly cause?: unknown }
  | {
      readonly code: 'kms-key-not-found';
      readonly message: string;
      readonly kekId: string;
    }
  | { readonly code: 'kms-wrap-failed'; readonly message: string; readonly cause?: unknown }
  | { readonly code: 'kms-unwrap-failed'; readonly message: string; readonly cause?: unknown };
