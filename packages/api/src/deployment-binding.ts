// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { PinChange } from '@kindgi/agents';
import type {
  Cursor,
  ProjectId,
  RecordedSecretScope,
  SigningKeyId,
  TenantId,
  VersionDerivationReason,
} from '@kindgi/types';

import type { PinActor } from './agent-pin-binding.js';
import {
  PACK_ENV_PROBLEM_CODES,
  PACK_ENV_SECRET_GIVE_CODES,
  type PackEnvDeclaration,
  type PackEnvHeldCode,
} from './pack-env.js';

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
   * Idempotent per `(projectId, imageDigest)`: when the same digest is
   * re-registered in the same project of the same tenant the binding MUST
   * return `{ kind: 'already-registered', deployment }` with the existing
   * row (existing `artifactVersion` — the issuer-supplied value the row
   * originally pinned). A registration with no `projectId` and one naming
   * the tenant's default project by its id are the SAME project for this
   * check: either finds the other, so a digest is registered once per
   * project however the default is named (a tenant with no default keeps a
   * project-less registration tenant-wide). A different project, or a
   * different digest → a new row, with the caller's newly-supplied
   * `artifactVersion` persisted verbatim.
   */
  register(input: DeploymentRegisterInput): Promise<DeploymentRegisterOutcome>;
  /**
   * Fetch a deployment by its server-allocated id. `null` when unknown
   * to the tenant. The route surfaces `null` as `404
   * deployment-not-found`.
   */
  get(input: DeploymentGetInput): Promise<Deployment | null>;
  /**
   * Fetch a deployment by its `imageDigest` (the sha256 of the pinned OCI
   * image), within `projectId` — or, absent, among the tenant-wide
   * deployments (the tenant's default project). A digest registered with no
   * project and one registered under the tenant's default by its id resolve
   * to each other here too (the default named either way is one project).
   * Used for the idempotency check on `register` and for cross-referencing
   * image identity from the sandbox layer at dispatch. `null` when no
   * record exists.
   */
  getByImageDigest(input: DeploymentGetByImageDigestInput): Promise<Deployment | null>;
  /**
   * Cursor-paginated list, sorted by `activatedAt` descending
   * (binding-defined tie-break, e.g. `deploymentId` desc). Filters
   * compose as AND.
   */
  list(input: DeploymentListInput): Promise<DeploymentPage>;
  /**
   * Promote a deployment into the next environment of its order, in one
   * transaction: a deployment in the target project with the source's
   * signed fields, contents, pack, pack checks and git `source` (as
   * `register` writes one, with its routes and pending endpoint) and
   * `promotedFromDeploymentId`, and its own `replaced` (the input's, never
   * the source's); the versions carried with it; and where each tool's
   * secrets are read in the target. Registries aren't touched,
   * and nothing is built: the image is the one the source runs.
   *
   * The route checks everything first (the order, the source served, the
   * signer, the values at the target): the binding receives a promotion
   * it may write.
   *
   * Idempotent per `imageDigest` in the target, as `register` is: when the
   * target has that digest already, the binding returns
   * `{ kind: 'already-registered', deployment }` with that row, and adds
   * the carried versions it doesn't record yet.
   *
   * Absent: the runtime can't promote (`501 promotions-unsupported`).
   */
  promote?(input: DeploymentPromoteInput): Promise<DeploymentPromoteOutcome>;
}

// -------------------- record --------------------

/** A deployment as the routes answer it: named fields only. */
export function serializeDeployment(d: Deployment): Record<string, unknown> {
  return {
    deploymentId: d.deploymentId,
    tenantId: d.tenantId as unknown as string,
    imageRef: d.imageRef,
    imageDigest: d.imageDigest,
    artifactVersion: d.artifactVersion,
    indexHash: d.indexHash,
    signerKeyId: d.signerKeyId as unknown as string,
    signerPublicKey: d.signerPublicKey,
    signature: d.signature,
    publishedAt: d.publishedAt,
    activatedAt: d.activatedAt,
    ...(d.projectId !== undefined && { projectId: d.projectId as unknown as string }),
    ...(d.promotedFromDeploymentId !== undefined && {
      promotedFromDeploymentId: d.promotedFromDeploymentId,
    }),
    ...(d.packId !== undefined && { packId: d.packId }),
    ...(d.endpoint !== undefined && { endpoint: endpointToWire(d.endpoint) }),
    ...(d.packEnv !== undefined && {
      packEnv: { required: [...d.packEnv.required], optional: [...d.packEnv.optional] },
    }),
    primitives: {
      tools: d.primitives.tools,
      guardrails: d.primitives.guardrails,
      agents: d.primitives.agents,
      flows: d.primitives.flows,
    },
    contents: d.contents,
    ...(d.source !== undefined && { source: d.source }),
    ...(d.replaced !== undefined &&
      d.replaced.length > 0 && {
        replaced: d.replaced.map(({ blockId, from, to, reason, by }) => ({
          blockId,
          from,
          to,
          reason,
          by: { kind: by.kind, id: by.id },
        })),
      }),
  };
}

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
 * Why a deployment's pack service should go:
 * - `superseded`: nothing a call can still ask for needs it: for each tool
 *   version, pack check, agent and flow version it serves, a newer
 *   deployment into its project serves it too, or it's unregistered and not
 *   held (a check: no registered guardrail runs it in its project); and each
 *   tool it deployed without a version, a newer deployment into its project
 *   deploys without one too (from runtime 0.4.0; before, it meant newer
 *   deployments into its project shipped every tool version and check it
 *   does and deployed each tool it deployed without a version the same way,
 *   and was for good). One whose endpoint an earlier runtime made or last
 *   set is `superseded` as well, for good, once newer deployments into its
 *   project ship every tool version and check it does and deploy each tool
 *   it deployed without a version the same way. Otherwise it's needed again
 *   once something it serves that no newer deployment into its project
 *   serves is wanted again: a tool, agent or flow version registered or held
 *   again, or a check a newly registered guardrail runs in its project. A
 *   tool call a step made on it still goes back to it when the step runs
 *   again, and fails closed (`pack-endpoint-cleared`) once its endpoint is
 *   cleared;
 * - `tenant-closing`, `tenant-suspended`: every deployment of the tenant,
 *   routed or not, since nothing of it runs;
 * - `project-suspended`, `pack-suspended`: every deployment of the project,
 *   or this deployment.
 */
export const SYSTEM_DEPLOYMENT_RETIRE_REASONS = [
  'superseded',
  'tenant-closing',
  'tenant-suspended',
  'project-suspended',
  'pack-suspended',
] as const;

export type SystemDeploymentRetireReason = (typeof SYSTEM_DEPLOYMENT_RETIRE_REASONS)[number];

/**
 * Why a deployment waiting for its pack service has none yet: a `pending`
 * one, or a `cleared` one that's `waiting` (after a suspension is lifted). A
 * fixed code, never free text, so nothing about the operator's setup
 * reaches the tenant.
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
 *
 * The pack's declared environment can't be given to it (`pack-env.ts`), and
 * `GET /v1/deployments/{id}/pack-env` names each name:
 * - `pack-env-ambiguous`: a name is set two ways, as two of a plain value, a
 *   secret and a cloud secret;
 * - `pack-env-secret-not-yet`: a name is set only as a secret, and the
 *   orchestrator doesn't give secrets;
 * - `pack-env-missing`: a required name is set nowhere;
 * - `pack-env-secret-unreadable`: a name's secret is set, but it can't be
 *   read for a reason the platform fixes, not the owner. It's tried again.
 *
 * The orchestrator couldn't give the pack service its secrets:
 * - `pack-env-secrets-unaudited`: the runtime has nowhere to audit a secret
 *   it gives out, so it gives none. The platform fixes it, and it's tried
 *   again;
 * - `pack-env-secret-too-large`: a secret's value is over 32768 bytes, the
 *   most a pack service can be given;
 * - `pack-env-name-too-long`: a name set as a secret is too long for the
 *   secret it's kept in, which is named after the pack service;
 * - `pack-env-secret-capacity`: a name is set only as a secret, and there's
 *   no room just now for a pack service that can be given one, apart from
 *   other projects'. It's tried again.
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
  ...PACK_ENV_PROBLEM_CODES,
  ...PACK_ENV_SECRET_GIVE_CODES,
  'pack-env-secret-capacity',
] as const;

export type DeploymentEndpointProblemCode = (typeof DEPLOYMENT_ENDPOINT_PROBLEM_CODES)[number];

/** Why a deployment waiting for its pack service has none yet, and since when. */
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
   * While it waits for a pack service (`pending`, or `cleared` and
   * `waiting`): the last reason recorded while it waited. A `ready` one has
   * none, nor a `retired` one.
   */
  readonly problem?: DeploymentEndpointProblem;
  /**
   * `cleared` only: a pack service is wanted for it again, as once a
   * suspension that took its service down is lifted, and it lists as
   * needing one.
   * A `cleared` one carries this or `retired`, never both (from runtime
   * 0.1.9; an older server sends neither).
   */
  readonly waiting?: true;
  /**
   * `cleared` only: why no pack service is wanted for it now, as the
   * orchestrator is told to retire one. `superseded`: nothing a call can
   * still ask for needs it, until something it's still the newest into its
   * project for is registered or held again, unless it's gone for good (see
   * {@link SYSTEM_DEPLOYMENT_RETIRE_REASONS}); a tool call a step made on it
   * still goes back to it when the step runs again, and fails closed
   * (`pack-endpoint-cleared`). The others last until the tenant, project or
   * pack is restored.
   */
  readonly retired?: SystemDeploymentRetireReason;
  /**
   * `ready` only: the pack service runs on the values it was last given,
   * since the newest ones can't be given to it (a required one was removed,
   * say), or didn't start (`pack-env-update-failed`). It's gone once they
   * can, or do (from runtime 0.1.9).
   */
  readonly packEnvProblem?: {
    readonly code: PackEnvHeldCode;
    /** When it was recorded. ISO-8601. */
    readonly since: string;
  };
  /**
   * What keeps this build's pack service, whatever its status, while the
   * runtime runs one per build (from runtime 0.4.0). In kind, id, then
   * version order. `[]` when nothing does: it's retired (`superseded`), or
   * retired next. A suspended build has `retired` and still lists what keeps
   * it, since its service comes back when the suspension lifts. Absent when
   * builds aren't counted: one service serves every build, or an older
   * runtime. On a list page, the first {@link DEPLOYMENT_KEPT_FOR_PAGE_LIMIT}
   * entries, with `keptForTotal`; a get of one deployment gives them all.
   */
  readonly keptFor?: readonly DeploymentKeptFor[];
  /**
   * On a list page, with `keptFor`: how many entries there are, of which
   * `keptFor` holds the first {@link DEPLOYMENT_KEPT_FOR_PAGE_LIMIT}. A get
   * of one deployment doesn't send it.
   */
  readonly keptForTotal?: number;
}

/**
 * What a kept build's pack service is kept for:
 * - `tool`: a tool version this build is the newest into its project to
 *   route, still registered or held. A tool deployed without a version has
 *   no `version` and neither flag: it's kept until a newer deployment into
 *   the project ships the tool.
 * - `agent`, `flow`: a version this build is the newest into its project to
 *   ship or carry, still registered or held.
 * - `guardrail`: a registered guardrail that runs a pack check this build is
 *   the newest into its project to route. It has no `version`.
 *
 * A later runtime may add kinds.
 */
export const DEPLOYMENT_KEPT_FOR_KINDS = ['tool', 'agent', 'flow', 'guardrail'] as const;

export type DeploymentKeptForKind = (typeof DEPLOYMENT_KEPT_FOR_KINDS)[number];

/** How many `keptFor` entries a deployment carries on a list page. */
export const DEPLOYMENT_KEPT_FOR_PAGE_LIMIT = 20;

/** One thing a build's pack service is kept for. */
export interface DeploymentKeptFor {
  readonly kind: DeploymentKeptForKind;
  readonly id: string;
  /** The version kept for; absent for a guardrail, or a tool deployed without one. */
  readonly version?: string;
  /** The version (or guardrail) is registered. */
  readonly registered?: true;
  /**
   * A pin or a run that hasn't finished uses the version. Unregistering it
   * then lets the build go only once the pin's own version is unregistered
   * or the run finishes. Set beside `registered` when both are true.
   */
  readonly held?: true;
}

/**
 * A deployment's endpoint as the routes answer it: named fields only, so its
 * URL and token never leave the server. A `cleared` one carries `waiting` or
 * `retired` (`waiting`, should a binding give both), and no other carries
 * either. The problem shows while it waits: `pending`, or `cleared` and
 * `waiting`.
 */
export function endpointToWire(endpoint: DeploymentEndpoint): DeploymentEndpoint {
  const waiting = endpoint.status === 'cleared' && endpoint.waiting === true;
  const retired = endpoint.status === 'cleared' && !waiting ? endpoint.retired : undefined;
  return {
    status: endpoint.status,
    since: endpoint.since,
    ...((endpoint.status === 'pending' || waiting) &&
      endpoint.problem !== undefined && {
        problem: { code: endpoint.problem.code, since: endpoint.problem.since },
      }),
    ...(waiting && { waiting: true }),
    ...(retired !== undefined && { retired }),
    ...(endpoint.status === 'ready' &&
      endpoint.packEnvProblem !== undefined && {
        packEnvProblem: {
          code: endpoint.packEnvProblem.code,
          since: endpoint.packEnvProblem.since,
        },
      }),
    ...(endpoint.keptFor !== undefined && { keptFor: endpoint.keptFor.map(keptForToWire) }),
    ...(endpoint.keptFor !== undefined &&
      endpoint.keptForTotal !== undefined && { keptForTotal: endpoint.keptForTotal }),
  };
}

function keptForToWire(entry: DeploymentKeptFor): DeploymentKeptFor {
  return {
    kind: entry.kind,
    id: entry.id,
    ...(entry.version !== undefined && { version: entry.version }),
    ...(entry.registered === true && { registered: true }),
    ...(entry.held === true && { held: true }),
  };
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
   * The project the deploy named: its agents, flows, tools and guardrails
   * were registered into it, and its secret sync writes there. Absent for a
   * tenant-wide deploy, whose primitives went into the tenant's default
   * project and whose secrets sync tenant-wide.
   */
  readonly projectId?: ProjectId;
  /**
   * The names its pack service reads from its process environment, as the
   * image's index declares them (`env`). Absent when it declares none, and
   * from a binding that doesn't keep them (from runtime 0.1.9).
   */
  readonly packEnv?: PackEnvDeclaration;
  /**
   * When this deployment was created by promoting another into a later
   * environment of its order, the source deployment it was promoted from.
   * Absent for a deployment registered directly.
   */
  readonly promotedFromDeploymentId?: string;
  /** The pack's id, from the image's index (`packId`), when the binding keeps it. */
  readonly packId?: string;
  /**
   * Its pack service's status, when the server routes pack calls per
   * deployment. Absent otherwise (one pack service for every deployment),
   * for a deployment that ships nothing a pack service serves (no tool, and
   * no guardrail check but built-in ones: a pack of agents and flows only),
   * which needs none, and from a binding that doesn't track it.
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
  /**
   * Where its pack lives in git, as `kindgi deploy` read it from the work
   * tree it ran in. Absent for a deploy made outside git, one recorded
   * before deploys said, and from a binding that doesn't keep it.
   */
  readonly source?: DeploymentSource;
  /**
   * The blocks the deploy put back to an older version than ran, on
   * purpose (`replace`). A deployment a promotion made has its own: the
   * blocks that promotion's pins put back in its project, never the
   * source's. Absent when it put back none, and from a binding that
   * doesn't keep them.
   */
  readonly replaced?: readonly DeploymentReplacedBlock[];
}

/**
 * Where a deployment's pack lives in git, when the deploy ran inside a
 * work tree. No local path and no credential are in it: `repo` is a host
 * and a path, and `path` and each file are relative.
 */
export interface DeploymentSource {
  /**
   * The `origin` remote as `host/owner/name` (a group path may stand for
   * the owner: `host/group/sub/name`), with no scheme, user, password,
   * token or `.git`. Absent when the work tree has no `origin`, or one
   * that isn't a host and a path.
   */
  readonly repo?: string;
  /** The pack's folder, relative to the repository's root: `.` when it's the root. */
  readonly path: string;
  /** The commit checked out (`HEAD`), its full hex id. */
  readonly commit: string;
  /** The branch checked out; absent on a detached `HEAD`. */
  readonly branch?: string;
  /** The pack's folder had changes the commit doesn't hold (`git status`, untracked files included). */
  readonly dirty: boolean;
  /** Each of the pack's blocks by id: its file, relative to the pack's folder. */
  readonly blockFiles: Readonly<Record<string, string>>;
}

/**
 * A block a deploy put back on purpose: the newest version that ran in a
 * project of one of its agents, the files' older one the deploy shipped,
 * why, and who deployed.
 */
export interface DeploymentReplacedBlock {
  readonly blockId: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly by: PinActor;
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
  /**
   * The pack's data blocks, each `{ id, version }`. Absent on a deployment
   * recorded before deployments listed them, and from a binding that
   * doesn't keep them.
   */
  readonly blocks?: readonly DeployedPrimitive[];
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
  /**
   * The id to register it under, a UUID the route mints before the
   * pack's blocks are published, so each block version names the deploy
   * it came from. Absent: the binding allocates one. Unused when the
   * digest is already registered (that row keeps its id).
   */
  readonly deploymentId?: string;
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
   * The project the deploy named, which its primitives were registered
   * into; absent for a tenant-wide deploy (the tenant's default project).
   * A binding keeps it on the deployment and, when it routes pack calls per
   * deployment, keys each route by the project the primitives went into
   * (this one, else the default project), so a call reaches the deployment
   * of its own project.
   */
  readonly projectId?: ProjectId;
  /**
   * The check ids the image's pack service serves: its guardrails whose
   * check runs in the image (a check module), not a built-in one. A
   * binding that routes each check call to the deployment that shipped it
   * keeps them, as it keeps `contents.tools` for tool calls.
   */
  readonly packChecks?: readonly string[];
  /**
   * The names the image's pack service reads from its process environment
   * (the index's `env`), validated. A binding that runs a pack service per
   * deployment keeps them, so whatever runs it can give it their values.
   */
  readonly packEnv?: PackEnvDeclaration;
  /** Where the pack lives in git (`Deployment.source`), when the deploy said. */
  readonly source?: DeploymentSource;
  /** The blocks the deploy put back on purpose (`Deployment.replaced`). */
  readonly replaced?: readonly DeploymentReplacedBlock[];
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
  /**
   * Which project to look up within: a digest deploys once per project, so
   * the same image can be registered in more than one (a later environment
   * of its order takes it by promotion). Absent = the tenant's default (a
   * tenant-wide deploy, stored with no project).
   */
  readonly projectId?: ProjectId;
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
  /**
   * Only the deployments in this project. The tenant's default project
   * also finds the deployments that name no project (they serve there).
   */
  readonly projectId?: ProjectId;
  /** Only the deployments of this pack (`packId`). */
  readonly packId?: string;
}

export interface DeploymentPage {
  readonly data: readonly Deployment[];
  readonly nextCursor?: Cursor;
  /**
   * How many builds keep a pack service, per project, among the deployments
   * the project filter selects, whatever the page and the other filters,
   * while the runtime runs one per build (from runtime 0.4.0): those whose
   * `keptFor` isn't empty. With `projectId`, that project's alone (the
   * default's counts the deployments that name no project); without, one
   * entry per project the tenant's kept builds serve. The route sums the
   * ones the caller reads into the page's `keptBuilds`. Absent when builds
   * aren't counted.
   */
  readonly keptBuilds?: readonly DeploymentKeptBuilds[];
}

/** How many builds keep a pack service in one project. */
export interface DeploymentKeptBuilds {
  /**
   * The project they serve: the default for a deployment that names none.
   * Absent for those of a tenant with no default.
   */
  readonly projectId?: ProjectId;
  readonly builds: number;
}

// -------------------- promote --------------------

/**
 * A version that moves with a deployment to the next environment: an edit
 * of a version it ships (`carriedVersions`). No deployment lists it, so
 * the promotion records it with the deployment it moved with.
 */
export interface CarriedVersion {
  readonly kind: 'agent' | 'flow';
  readonly id: string;
  readonly version: string;
}

/** Where each secret a tool version names is read in the project a promotion targets. */
export interface PromotedToolSecretScopes {
  readonly toolId: string;
  readonly version: string;
  /** By secret name, as a deploy records them (`secret-scope.ts`); `null`: no scope found. */
  readonly secretScopes: Readonly<Record<string, RecordedSecretScope | null>>;
}

export interface DeploymentPromoteInput {
  readonly tenantId: TenantId;
  /** The deployment promoted. */
  readonly sourceDeploymentId: string;
  /**
   * The project it's promoted into; absent for the tenant's default
   * project, stored with no project as a deploy naming none is.
   */
  readonly projectId?: ProjectId;
  /** The versions carried with it, recorded with the target's deployment. */
  readonly carried: readonly CarriedVersion[];
  /** Each tool version it ships, with where its secrets are read in the target. */
  readonly toolSecretScopes: readonly PromotedToolSecretScopes[];
  /**
   * The blocks this promotion's pins put back on purpose in the target
   * (`replace`), from its own check against what runs there; `by` is who
   * promoted. Recorded as the new deployment's `replaced`, never the
   * source's. A target that has the digest already keeps its row as it is.
   */
  readonly replaced?: readonly DeploymentReplacedBlock[];
}

export type DeploymentPromoteOutcome =
  | {
      /** A new deployment in the target. `carried`: the versions recorded with it. */
      readonly kind: 'ok';
      readonly deployment: Deployment;
      readonly carried: readonly CarriedVersion[];
    }
  | {
      /**
       * The target has this digest already: that row, unchanged.
       * `carried`: the versions it didn't record yet, now recorded.
       */
      readonly kind: 'already-registered';
      readonly deployment: Deployment;
      readonly carried: readonly CarriedVersion[];
    }
  | {
      /** Any other write failure — persistence error, invalid input. */
      readonly kind: 'error';
      readonly code: string;
      readonly message: string;
    };
