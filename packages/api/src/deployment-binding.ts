// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { PinChange } from '@kindgi/agents';
import type { Cursor, SigningKeyId, TenantId, VersionDerivationReason } from '@kindgi/types';

/**
 * Caller-plugged surface for the deployment ledger — the audit anchor
 * row written by `POST /v1/deployments`. Mirrors the
 * caller-plugged pattern of `BlobStorageBinding` /
 * `PolicyRegistryBinding`: the API package does NOT own deployment
 * storage. Deployments plug their own store (a database, or in-memory for
 * tests) through this interface.
 *
 * Semantics:
 *   - A deployment is the append-only record of a signed image landing
 *     at the API. Its `imageDigest` (extracted from `imageRef`) is the
 *     idempotency key — re-registering the same digest returns the
 *     existing record with no new `artifactVersion`.
 *   - The full signature envelope (`signerKeyId`, `signerPublicKey`,
 *     `signature`, canonical `indexHash`) is persisted so regulators
 *     can re-verify offline against the immutable image bytes.
 *   - Primitive counts (`tools` / `guardrails` / `agents` / `flows`)
 *     are captured for at-a-glance rendering; the full manifest set
 *     lives at `imageRef@sha256:…/app/index.json`.
 *
 * Every method is tenant-scoped: callers pass `tenantId` explicitly so
 * multi-tenant deployments can partition storage without exposing the
 * scoping inside the API package.
 *
 * Cursors are opaque — the binding chooses its encoding. The API layer
 * only validates that a cursor round-trips as a string.
 *
 * ## Seam only
 *
 * This file defines the seam the `packages/api/src/routes/deployments.ts`
 * route calls; no implementation is bundled.
 */
export interface DeploymentBinding {
  /**
   * Persist a signed deployment record. The API route checks the signer
   * against the trust list (`SigningKeyBinding.isTrusted`), verifies the
   * Ed25519 signature, verifies image pullability
   * (`ImageRegistryBinding.head`), and validates every primitive in the
   * index before calling — the binding receives a well-formed input.
   *
   * Idempotent per `imageDigest`: when the same digest is re-registered
   * under the same tenant the binding MUST return
   * `{ kind: 'already-registered', deployment }` with the existing row
   * (existing `artifactVersion` — the issuer-supplied value the row
   * originally pinned). Different digest → new row with the caller's
   * newly-supplied `artifactVersion` persisted verbatim.
   */
  register(input: DeploymentRegisterInput): Promise<DeploymentRegisterOutcome>;
  /**
   * Fetch a deployment by its server-allocated id. `null` when unknown
   * to the tenant. The route surfaces `null` as `404
   * deployment-not-found`.
   */
  get(input: DeploymentGetInput): Promise<Deployment | null>;
  /**
   * Fetch a deployment by its `imageDigest` (the sha256 of the pinned
   * OCI image). Used for the idempotency check on `register` and for
   * cross-referencing image identity from the sandbox layer at
   * dispatch. `null` when no record exists.
   */
  getByImageDigest(input: DeploymentGetByImageDigestInput): Promise<Deployment | null>;
  /**
   * Cursor-paginated list, sorted by `activatedAt` descending
   * (binding-defined tie-break, e.g. `deploymentId` desc). Filters
   * compose as AND.
   */
  list(input: DeploymentListInput): Promise<DeploymentPage>;
}

// -------------------- record --------------------

/**
 * Wire shape for a deployment record. Immutable once written — every
 * field is set atomically at `register` time.
 *
 * `signerPublicKey` is retained alongside `signerKeyId` so offline audit
 * can re-verify without hitting the tenant's trust list; the trust-list
 * check happens at `register` time inside the route (via
 * `SigningKeyBinding.isTrusted`).
 */
/**
 * Where a deployment's pack service stands, when the server routes pack
 * calls per deployment (`KINDGI_PACK_ROUTING=per-deployment`):
 * - `pending`: no pack service yet. Calls to its tools fail
 *   (`pack-endpoint-pending`), and are never sent to another deployment.
 * - `ready`: calls to its tools go to its own pack service.
 * - `cleared`: its pack service was taken down; calls fail
 *   (`pack-endpoint-cleared`).
 */
export type DeploymentEndpointStatus = 'pending' | 'ready' | 'cleared';

/**
 * Why a `pending` deployment has no pack service yet. A fixed code, never
 * free text, so nothing about the operator's setup reaches the tenant.
 *
 * The server refused the endpoint it was given:
 * - `endpoint-url-invalid`: not `https`, or with user info or a path;
 * - `endpoint-host-not-allowed`: the host isn't on the operator's allowlist;
 * - `endpoint-name-mismatch`: the host doesn't name this deployment's
 *   service (`packServiceName`);
 * - `endpoint-unreachable`: the pack service didn't answer `/v1/info`;
 * - `endpoint-info-mismatch`: it answered as another pack or version;
 * - `image-not-allowed`: the image is outside the tenant's repository.
 *
 * The pack service couldn't be created:
 * - `tenant-not-provisioned`: the tenant has nowhere to run pack services yet;
 * - `capacity-unavailable`: no room for another pack service just now;
 * - `service-start-failed`: the image was deployed but didn't start.
 */
export const DEPLOYMENT_ENDPOINT_PROBLEM_CODES = [
  'endpoint-url-invalid',
  'endpoint-host-not-allowed',
  'endpoint-name-mismatch',
  'endpoint-unreachable',
  'endpoint-info-mismatch',
  'image-not-allowed',
  'tenant-not-provisioned',
  'capacity-unavailable',
  'service-start-failed',
] as const;

export type DeploymentEndpointProblemCode = (typeof DEPLOYMENT_ENDPOINT_PROBLEM_CODES)[number];

/** Why a `pending` deployment has no pack service yet, and since when. */
export interface DeploymentEndpointProblem {
  readonly code: DeploymentEndpointProblemCode;
  /** When it was recorded. ISO-8601. */
  readonly since: string;
}

/** A deployment's pack service, as a tenant sees it: never its URL or token. */
export interface DeploymentEndpoint {
  readonly status: DeploymentEndpointStatus;
  /** When the status last changed. ISO-8601. */
  readonly since: string;
  /**
   * With `pending` only: the last reason it has no pack service yet. Gone
   * once the status changes.
   */
  readonly problem?: DeploymentEndpointProblem;
}

export interface Deployment {
  readonly deploymentId: string;
  readonly tenantId: TenantId;
  /** Full digest-pinned image reference, e.g. `registry.example.com/acme/pack@sha256:…`. */
  readonly imageRef: string;
  /** `sha256` hex-encoded digest extracted from `imageRef` (idempotency key). */
  readonly imageDigest: string;
  /**
   * Issuer-supplied `YYYYMMDD.N` — matches the value inside the signed
   * envelope. Bindings persist it verbatim; the
   * signature is only offline-verifiable if the same bytes round-trip.
   */
  readonly artifactVersion: string;
  /** `sha256` of the canonicalised `index.json` extracted from the image. */
  readonly indexHash: string;
  /** Which key signed the deploy. Cross-checked against `SigningKeyBinding`. */
  readonly signerKeyId: SigningKeyId;
  /** Retained for offline audit. Base64 of the raw public-key bytes. */
  readonly signerPublicKey: string;
  /** Base64 of the Ed25519 signature over the canonicalised envelope. */
  readonly signature: string;
  /** Issuer-supplied timestamp inside the signed envelope. ISO-8601. */
  readonly publishedAt: string;
  /** Server-side ledger timestamp — when `register` returned OK. ISO-8601. */
  readonly activatedAt: string;
  /**
   * Its pack service's status, when the server routes pack calls per
   * deployment. Absent otherwise (one pack service for every deployment),
   * and from a binding that doesn't track it.
   */
  readonly endpoint?: DeploymentEndpoint;
  /**
   * Counts of primitives in the deployment's `index.json`. Not
   * authoritative — the image is. Populated for cheap admin rendering.
   */
  readonly primitives: DeploymentPrimitiveCounts;
  /**
   * Exactly what the deployment shipped: each primitive's id and, for
   * the versioned ones, its version. Versions are immutable, so this is
   * enough to know which code a deployment made live.
   */
  readonly contents: DeploymentContents;
}

/** A primitive a deployment shipped. Guardrails have no version. */
export interface DeployedPrimitive {
  readonly id: string;
  readonly version?: string;
}

/**
 * An agent or flow a deployment shipped, under the version it's
 * registered as. A deploy registers one under another version than its
 * definition's when that version is registered already with other pins
 * or content (versions never change); then `authoredVersion` is the
 * definition's and `reason` says why.
 */
export interface DeployedVersion extends DeployedPrimitive {
  /** The version the agent's definition names, when it differs from `version`. */
  readonly authoredVersion?: string;
  readonly reason?: VersionDerivationReason;
  /** `true`: this deploy registered `version`; `false`: an earlier deploy did. */
  readonly newVersion?: boolean;
  /** For `pins-changed`: the pins that differ from `authoredVersion`'s. */
  readonly pinChanges?: readonly PinChange[];
}

/** An agent a deployment shipped (`DeployedVersion`). */
export type DeployedAgent = DeployedVersion;

/** A flow a deployment shipped (`DeployedVersion`). */
export type DeployedFlow = DeployedVersion;

export interface DeploymentContents {
  readonly tools: readonly DeployedPrimitive[];
  readonly guardrails: readonly DeployedPrimitive[];
  readonly agents: readonly DeployedAgent[];
  readonly flows: readonly DeployedFlow[];
}

export interface DeploymentPrimitiveCounts {
  readonly tools: number;
  readonly guardrails: number;
  readonly agents: number;
  readonly flows: number;
}

// -------------------- register --------------------

/**
 * Everything the ledger needs to persist a signed deployment. The route
 * assembles this from the request body + verified sig envelope; the
 * binding does not re-verify the signature (that's the route's job).
 */
export interface DeploymentRegisterInput {
  readonly tenantId: TenantId;
  readonly imageRef: string;
  readonly imageDigest: string;
  /**
   * Issuer-supplied `YYYYMMDD.N`. Part of the canonical signed envelope
   * — persisted verbatim so offline verification
   * can reproduce the exact bytes.
   */
  readonly artifactVersion: string;
  readonly indexHash: string;
  readonly signerKeyId: SigningKeyId;
  readonly signerPublicKey: string;
  readonly signature: string;
  readonly publishedAt: string;
  readonly primitives: DeploymentPrimitiveCounts;
  readonly contents: DeploymentContents;
  /**
   * The pack's id, from the image's index (`packId`). A binding that runs a
   * pack service per deployment keeps it, so whatever runs those services
   * can tell one pack's deployments from another's.
   */
  readonly packId?: string;
  /**
   * The check ids the image's pack service serves: its guardrails whose
   * check runs in the image (a check module), not a built-in one. A
   * binding that routes each check call to the deployment that shipped it
   * keeps them, as it keeps `contents.tools` for tool calls.
   */
  readonly packChecks?: readonly string[];
}

export type DeploymentRegisterOutcome =
  | {
      readonly kind: 'ok';
      readonly deployment: Deployment;
    }
  | {
      /**
       * Same `imageDigest` was already registered for this tenant. The
       * binding returns the existing row unchanged; the route surfaces
       * as `200 OK` (idempotent replay), NOT `409`.
       */
      readonly kind: 'already-registered';
      readonly deployment: Deployment;
    }
  | {
      /** Any other write failure — persistence error, invalid input. */
      readonly kind: 'error';
      readonly code: string;
      readonly message: string;
    };

// -------------------- get --------------------

export interface DeploymentGetInput {
  readonly tenantId: TenantId;
  readonly deploymentId: string;
}

export interface DeploymentGetByImageDigestInput {
  readonly tenantId: TenantId;
  readonly imageDigest: string;
}

// -------------------- list --------------------

export interface DeploymentListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /**
   * Optional prefix filter on `Deployment.imageRef`. Useful for
   * `registry.example.com/acme/support-pack@sha256:` matches within a
   * multi-image tenant.
   */
  readonly imageRefPrefix?: string;
  /**
   * Restrict to a specific signing key. Useful for revocation audits —
   * "which deploys did the compromised key sign?"
   */
  readonly signerKeyId?: SigningKeyId;
}

export interface DeploymentPage {
  readonly data: readonly Deployment[];
  readonly nextCursor?: Cursor;
}
