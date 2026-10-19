// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId, Timestamp } from '@kindgi/types';

/**
 * A person's second factor in a tenant (an authenticator app's codes, and
 * recovery codes for when the app is lost), and the tenant's setting that
 * requires one at sign-in:
 *
 * - `/v1/identity/me/second-factor`: the person's own, from a session only
 *   (an API key can't set one up or take one off).
 * - `/v1/identity/users/:userId/second-factor`: a tenant admin reads
 *   whether a person has one, and removes it (a lost phone).
 * - `/v1/auth/settings`: a tenant admin requires one, or stops requiring it.
 *
 * Sign-in itself, and its second step, run in the deployment. So does
 * holding sessions to the setting: once a tenant requires a second factor,
 * a session made without one ends at its next request (the session store's
 * `resolveToken`), and token sign-in is refused. API keys aren't sessions:
 * they still work.
 *
 * The binding audits what it changes, and never logs or audits a key or a
 * code.
 */

export interface SecondFactorRef {
  readonly tenantId: TenantId;
  readonly userId: string;
}

/** A code from the person's authenticator app, or one of their recovery codes (used up). */
export type SecondFactorProof = { readonly code: string } | { readonly recoveryCode: string };

export type SecondFactorStatus =
  | {
      readonly setUp: false;
      /** A key was given to set one up, and isn't confirmed yet. */
      readonly started: boolean;
    }
  | {
      readonly setUp: true;
      readonly since: Timestamp;
      readonly recoveryCodesLeft: number;
      /**
       * `false`: its key can't be opened any more (the deployment's sign-in
       * secret changed past it). A recovery code still works; so does
       * setting it up again, or an admin removing it.
       */
      readonly usable: boolean;
    };

/** A proof that didn't pass. */
export type SecondFactorRefusal =
  | { readonly kind: 'wrong' }
  /** Too many wrong codes lately: nothing is checked until `retryAfterMs`. */
  | { readonly kind: 'locked'; readonly retryAfterMs: number }
  /** A code from the app, for a key that can't be opened any more: a recovery code still works. */
  | { readonly kind: 'unusable' };

export type SecondFactorStartOutcome =
  /** A new key, in the clear, shown once; nothing changes until it's confirmed. */
  | {
      readonly kind: 'started';
      readonly key: string;
      /** The `otpauth://` URI an authenticator app takes, as a QR code. */
      readonly uri: string;
    }
  /** One is set up: replacing it takes a proof from it. */
  | { readonly kind: 'proof-needed' }
  | SecondFactorRefusal;

export type SecondFactorConfirmOutcome =
  /** Set up: the 10 recovery codes, given this once. */
  | { readonly kind: 'confirmed'; readonly recoveryCodes: readonly string[] }
  /** No key given to set one up, or the one given is too old. */
  | { readonly kind: 'not-started' }
  | Exclude<SecondFactorRefusal, { kind: 'unusable' }>;

export type SecondFactorRecoveryCodesOutcome =
  /** 10 new ones; the old ones stop working. */
  | { readonly kind: 'replaced'; readonly recoveryCodes: readonly string[] }
  | { readonly kind: 'not-set-up' }
  | SecondFactorRefusal;

export type SecondFactorRemoveOutcome =
  | { readonly kind: 'removed' }
  | { readonly kind: 'not-set-up' }
  /** The tenant requires one: only an admin can remove it. */
  | { readonly kind: 'required' }
  | SecondFactorRefusal;

export interface SecondFactorSettings {
  /** Whether signing in by the deployment's own ways in takes a second factor. */
  readonly required: boolean;
  /**
   * People whose key is still kept under the deployment's previous sign-in
   * secret: they move to the current one at their next code. Keep the
   * previous secret configured until this is 0.
   */
  readonly onPreviousSecret: number;
  /** People whose key opens under neither secret: they need a recovery code, or an admin. */
  readonly unusable: number;
}

export interface SecondFactorBinding {
  status(ref: SecondFactorRef): Promise<SecondFactorStatus>;
  /**
   * Start setting one up. With one set up already, `proof` from it is
   * needed: the new key replaces it at the confirm.
   */
  start(ref: SecondFactorRef, proof?: SecondFactorProof): Promise<SecondFactorStartOutcome>;
  /** A code from the new key, to set it up. */
  confirm(ref: SecondFactorRef, code: string): Promise<SecondFactorConfirmOutcome>;
  newRecoveryCodes(
    ref: SecondFactorRef,
    proof: SecondFactorProof,
  ): Promise<SecondFactorRecoveryCodesOutcome>;
  /** The person takes theirs off: refused while the tenant requires one. */
  remove(ref: SecondFactorRef, proof: SecondFactorProof): Promise<SecondFactorRemoveOutcome>;
  /**
   * A tenant admin removes a person's (`by`: `user:<id>` or
   * `service_account:<id>`), and the person is told. Their sessions stay:
   * removing one gives no one access. `false` when they had none.
   */
  removeFor(ref: SecondFactorRef, by: string): Promise<boolean>;
  /** Whether the tenant requires one: read on each token sign-in. */
  required(tenantId: TenantId): Promise<boolean>;
  settings(tenantId: TenantId): Promise<SecondFactorSettings>;
  setRequired(input: {
    readonly tenantId: TenantId;
    readonly required: boolean;
    readonly by: string;
  }): Promise<SecondFactorSettings>;
}
