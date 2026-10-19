// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Injectable seams for `kindgi deploy` — the client-side POST
 * orchestrator that lands a signed pack image on a Kindgi runtime
 * (the one deployment wire call). Every side effect flows through this interface so tests
 * substitute fixtures without ever booting `kindgi build` or hitting
 * a real api-server.
 *
 * Three slots — the shape of the pipeline `commands/deploy.ts`
 * composes:
 *
 *   1. `runBuild` — inline `kindgi build` when the envelope isn't
 *      already on disk. Composed from a fresh `BuildRunners` set (the
 *      command wires its own `ctx.buildRunners` through).
 *   2. `loadEnvelope` — read + JSON-parse `deploy-envelope.json` from a
 *      resolved absolute path.
 *   3. `postDeployment` — POST the built body to `/v1/deployments`,
 *      returning the parsed response record (or the wire error).
 *
 * The build inline step reuses the exact same `BuildRunners` seam
 * `kindgi build` uses — no fresh interface, no duplicated
 * plumbing. `kindgi deploy` = `kindgi build` + one more POST.
 */

import type { DeployEnvelope } from '../build/envelope.js';
import type { PackEnvNameRecord } from '../env/pack-env-hint.js';
import type { ServedEnv } from '../value-target.js';

// ---------------------------------------------------------------------
// Envelope loader
// ---------------------------------------------------------------------

export interface LoadEnvelopeOptions {
  readonly path: string;
}

export type LoadEnvelopeResult =
  | { readonly kind: 'ok'; readonly envelope: DeployEnvelope }
  | {
      readonly kind: 'err';
      readonly code: 'envelope-not-found' | 'envelope-invalid-json' | 'envelope-schema-mismatch';
      readonly message: string;
      readonly path: string;
    };

// ---------------------------------------------------------------------
// POST /v1/deployments — request + response types
// ---------------------------------------------------------------------

/**
 * Exact wire body per `packages/api/src/openapi/schemas.ts`'s
 * `DeploymentRegistrationBodySchema`. `tenantId` is deliberately absent
 * — the server derives it from the bearer token. The client's signed
 * envelope MUST have signed against the same tenantId the token
 * authenticates as, or the server rejects with `signature-invalid`.
 */
export interface PostDeploymentBody {
  readonly imageRef: string;
  readonly artifactVersion: string;
  readonly index: Readonly<Record<string, unknown>>;
  readonly indexHash: string;
  readonly signerKeyId: string;
  readonly signerPublicKey: string;
  readonly signature: string;
  readonly publishedAt: string;
  /** The project to deploy into (`--project`); absent: tenant-wide, the Default project. */
  readonly projectId?: string;
}

/**
 * Wire response for `POST /v1/deployments` — the `DeploymentRecord`
 * shape from `packages/api/src/openapi/schemas.ts:3071`.
 */
export interface DeploymentRecord {
  readonly deploymentId: string;
  readonly tenantId: string;
  readonly imageRef: string;
  readonly imageDigest: string;
  readonly artifactVersion: string;
  readonly indexHash: string;
  readonly signerKeyId: string;
  readonly signerPublicKey: string;
  readonly signature: string;
  readonly publishedAt: string;
  readonly activatedAt: string;
  readonly primitives: {
    readonly tools: number;
    readonly guardrails: number;
    readonly agents: number;
    readonly flows: number;
  };
  /** What the deployment shipped; agents and flows under the versions they're registered as. */
  readonly contents?: {
    readonly agents?: readonly DeployedVersionRecord[];
    readonly flows?: readonly DeployedVersionRecord[];
  };
  /**
   * Its own pack service, on a runtime that runs one per deployment
   * (Kindgi hosted): `DeploymentEndpoint` in `@kindgi/api`.
   */
  readonly endpoint?: DeploymentEndpointRecord;
}

/** A deployment's pack service, as the tenant sees it: its status, never its URL. */
export interface DeploymentEndpointRecord {
  readonly status: 'pending' | 'ready' | 'cleared';
  readonly since: string;
  /** While it waits (`pending`, or `cleared` and `waiting`): why there's no pack service yet, a fixed code. */
  readonly problem?: { readonly code: string; readonly since: string };
  /** `cleared` only: a pack service is wanted for it again, and it lists as needing one. */
  readonly waiting?: true;
  /** `cleared` only: why no pack service is wanted for it now (`superseded`, `pack-suspended`, …). */
  readonly retired?: string;
}

/** An agent or flow a deployment shipped (`DeployedVersion` in `@kindgi/api`). */
export interface DeployedVersionRecord {
  readonly id: string;
  readonly version: string;
  readonly authoredVersion?: string;
  readonly reason?: 'pins-changed' | 'unpinned' | 'version-taken';
  readonly newVersion?: boolean;
  readonly pinChanges?: readonly {
    readonly kind: 'tool' | 'prompt' | 'setting' | 'agent';
    readonly id: string;
    readonly from?: string;
    readonly to?: string;
  }[];
}

export interface PostDeploymentOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly body: PostDeploymentBody;
  readonly idempotencyKey: string;
  readonly fetchImpl: typeof fetch;
  readonly signal?: AbortSignal;
}

export type PostDeploymentResult =
  | {
      readonly kind: 'created';
      readonly status: 201;
      readonly record: DeploymentRecord;
      /** The server answered from its record of an earlier request with this Idempotency-Key (`X-Idempotent-Replay`). */
      readonly idempotentReplay?: boolean;
    }
  | {
      readonly kind: 'replayed';
      readonly status: 200;
      readonly record: DeploymentRecord;
      /** The server answered from its record of an earlier request with this Idempotency-Key (`X-Idempotent-Replay`). */
      readonly idempotentReplay?: boolean;
    }
  | {
      readonly kind: 'wire-error';
      readonly status: number;
      /** A replay of an earlier answer to this Idempotency-Key (a runtime before 0.1.3 also replays refusals). */
      readonly idempotentReplay?: boolean;
      /** The answer's `Retry-After`, in seconds, when it has one in whole seconds. */
      readonly retryAfterSeconds?: number;
      readonly error: {
        readonly code: string;
        readonly message: string;
        /** The wire's `details.issues`: each primitive the server refused, and why. */
        readonly details?: readonly Record<string, unknown>[];
        /**
         * Which limit refused it (the wire's `details.limit`), when the
         * server named one: on a `429`, or on an `image-unverifiable`
         * whose cause is `image-limit-exceeded`.
         */
        readonly limit?: string;
        /** Why the image couldn't be verified (the wire's `details.cause`), when the server named it. */
        readonly cause?: string;
        /** The project's position in its environment order (the wire's `details.position`, on a `409 environment-takes-promotions`). */
        readonly position?: number;
        /** That order's first environment (the wire's `details.firstProjectId`), when the caller may read it. */
        readonly firstProjectId?: string;
      };
    }
  | {
      readonly kind: 'transport-error';
      readonly message: string;
    };

// ---------------------------------------------------------------------
// Inline-build fallback
// ---------------------------------------------------------------------

export interface RunBuildOptions {
  /**
   * The parsed CLI options the build command would consume. The deploy
   * command derives this from its own flag set + the resolved env
   * block. Kept opaque so `deploy` doesn't need to know every flag
   * `build` accepts.
   */
  readonly buildArgv: readonly string[];
  /**
   * The pack directory (`--path`) — resolved absolute path. The build
   * inline step needs it to load `kindgi.config.ts` and locate the
   * default `.kindgi/build/` output.
   */
  readonly packDir: string;
}

export type RunBuildResult =
  | {
      readonly kind: 'ok';
      /** Absolute path of the freshly-emitted `deploy-envelope.json`. */
      readonly envelopePath: string;
      /** Human-readable banner lines from the underlying build. */
      readonly banner: string;
    }
  | {
      readonly kind: 'err';
      readonly exitCode: number;
      readonly stderr: string;
    };

// ---------------------------------------------------------------------
// Post-deploy secret sync
// ---------------------------------------------------------------------

/**
 * Wire body for `POST /v1/deployments/:deploymentId/secrets`. Mirror
 * of the server-side `DeploymentSecretsSyncRequestSchema` in
 * `packages/api/src/openapi/schemas.ts`. Each entry sets exactly one
 * of `ref` (validate-only) or `value` (write new version).
 *
 * The CLI only emits `{ name, value }` entries — the `.env.<envName>`
 * file carries plaintext values, and the server-side scope is derived
 * from the deployment row itself (never the wire).
 */
export interface SyncSecretsBody {
  readonly envName: string;
  readonly secrets: readonly (
    | { readonly name: string; readonly ref: string }
    | { readonly name: string; readonly value: string }
  )[];
}

export interface SyncSecretsReference {
  readonly name: string;
  readonly ref: string;
  readonly version: number;
}

export interface SyncSecretsSuccess {
  readonly resolved: number;
  readonly added: number;
  readonly references: readonly SyncSecretsReference[];
}

export interface SyncSecretsOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly deploymentId: string;
  readonly body: SyncSecretsBody;
  readonly idempotencyKey: string;
  readonly fetchImpl: typeof fetch;
  readonly signal?: AbortSignal;
}

export type SyncSecretsResult =
  | { readonly kind: 'ok'; readonly status: 200; readonly response: SyncSecretsSuccess }
  | {
      readonly kind: 'wire-error';
      readonly status: number;
      /** A replay of an earlier answer to this Idempotency-Key (a runtime before 0.1.3 also replays refusals). */
      readonly idempotentReplay?: boolean;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    }
  | {
      readonly kind: 'transport-error';
      readonly message: string;
    };

// ---------------------------------------------------------------------
// DeployRunners interface
// ---------------------------------------------------------------------

/**
 * Injected seams the `deploy` command consumes. Every side effect must
 * pass through one of these — no `fetch()` inside `commands/deploy.ts`,
 * no direct filesystem writes outside `loadEnvelope`, no inline build
 * outside `runBuild`. Tests substitute per-field to exercise every
 * branch without ever booting `kindgi build`, hitting a real
 * api-server, or reading a real envelope file.
 */
/** A read of every page of one of the tenant's lists. */
export interface ListOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly fetchImpl: typeof fetch;
  readonly signal?: AbortSignal;
}

/** `kindgi deploy --project <slug>`: the tenant's projects with that slug. */
export interface FindProjectsOptions extends ListOptions {
  readonly slug: string;
}

/** A project as `GET /v1/projects` lists it. */
export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly slug?: string;
  readonly orgId?: string;
}

/** Every project the token can read (`GET /v1/projects`). */
export type ListProjectsResult =
  | { readonly kind: 'ok'; readonly projects: readonly ProjectRow[] }
  | { readonly kind: 'error'; readonly message: string };

/** An environment order as `GET /v1/environment-orders` lists it: a project the caller can't read is position-only. */
export interface EnvironmentOrderRow {
  readonly entries: readonly { readonly position: number; readonly projectId?: string }[];
}

/** Every environment order the token can read a project in (`GET /v1/environment-orders`). */
export type ListEnvironmentOrdersResult =
  | { readonly kind: 'ok'; readonly orders: readonly EnvironmentOrderRow[] }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Every project of the tenant with the slug: none, one, or (a slug is
 * unique within an org, so two orgs may share one) several.
 */
export type FindProjectsResult =
  | {
      readonly kind: 'ok';
      readonly projects: readonly {
        readonly id: string;
        readonly name: string;
        readonly orgId?: string;
      }[];
    }
  | { readonly kind: 'error'; readonly message: string };

/**
 * `kindgi deploy --sync-secrets`, or an `--env` whose pack environment names a
 * project: what the runtime says it serves (whoami's `servedEnv`).
 */
export interface ServedEnvOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly fetchImpl: typeof fetch;
  readonly signal?: AbortSignal;
}

/** `kindgi deploy --hosted`: the deployment as the runtime has it now. */
export interface GetDeploymentOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly deploymentId: string;
  readonly fetchImpl: typeof fetch;
  readonly signal?: AbortSignal;
}

export type GetDeploymentResult =
  | { readonly kind: 'ok'; readonly record: DeploymentRecord }
  | { readonly kind: 'error'; readonly message: string };

/** `GET /v1/deployments/:id/pack-env`: where each name the deployment's pack declares is set, never a value. */
export interface PackEnvRecord {
  /** The env the values are read at. */
  readonly envName: string;
  readonly data: readonly PackEnvNameRecord[];
  /** `pack-env-missing` and the like, when something stands in the way. */
  readonly problem?: string;
}

export type GetPackEnvResult =
  | { readonly kind: 'ok'; readonly packEnv: PackEnvRecord }
  /** The server's pack services take their env from how they're run (501), or it's older (404). */
  | { readonly kind: 'not-served' }
  | { readonly kind: 'error'; readonly message: string };

export interface DeployRunners {
  /** Read `deploy-envelope.json` from disk + structurally validate. */
  readonly loadEnvelope: (opts: LoadEnvelopeOptions) => Promise<LoadEnvelopeResult>;
  /** POST the deployment body to `/v1/deployments`. */
  readonly postDeployment: (opts: PostDeploymentOptions) => Promise<PostDeploymentResult>;
  /**
   * Inline-build fallback used when no `deploy-envelope.json` is present
   * on disk and `--from-envelope` was not explicitly supplied.
   * Production wiring shells out (in-process) to the same `runBuild`
   * exported from `commands/build.ts`, threading the current
   * `ctx.buildRunners` through so tests keep control of every stage.
   * Absent in test fixtures that supply their own envelope — the
   * command surfaces a clear error if inline build is required but no
   * runner is wired.
   */
  readonly runBuild?: (opts: RunBuildOptions) => Promise<RunBuildResult>;
  /**
   * Post-deploy secret sync. Called ONLY when the
   * user passes `--sync-secrets` AND a local `.env.<envName>` file
   * carries entries. POSTs plaintext values (the wire-carry point is
   * the developer boundary; the server responds with references
   * only). Absent runner in tests → the command surfaces a clear
   * "runner not wired" error even when the flag is passed.
   */
  readonly syncSecrets?: (opts: SyncSecretsOptions) => Promise<SyncSecretsResult>;
  /** `--project <slug>`: the projects with that slug (`GET /v1/projects`, every page). */
  readonly findProjects?: (opts: FindProjectsOptions) => Promise<FindProjectsResult>;
  /**
   * A refusal into a later environment of an environment order: the
   * projects and the orders, to name each environment a build goes through
   * on its way there. Absent: the hint names none.
   */
  readonly listProjects?: (opts: ListOptions) => Promise<ListProjectsResult>;
  readonly listEnvironmentOrders?: (opts: ListOptions) => Promise<ListEnvironmentOrdersResult>;
  /**
   * `--sync-secrets`, or an `--env` whose pack environment names a project:
   * the env the runtime serves (`GET /v1/identity/whoami`), or `undefined`
   * when it names none or can't be asked.
   */
  readonly servedEnv?: (opts: ServedEnvOptions) => Promise<ServedEnv | undefined>;
  /** `--hosted`: the deployment, read again while its pack service starts (`GET /v1/deployments/:id`). */
  readonly getDeployment?: (opts: GetDeploymentOptions) => Promise<GetDeploymentResult>;
  /** `--hosted`: where each name the pack declares is set, when a required one stands in the way. */
  readonly getPackEnv?: (opts: GetDeploymentOptions) => Promise<GetPackEnvResult>;
  /** `--hosted`: the pause between those reads. Default: a timer, cut short by Ctrl+C. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** `--hosted`: the clock the wait is measured on, in milliseconds. Default: `Date.now()`. */
  readonly now?: () => number;
}
