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
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: readonly Record<string, unknown>[];
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
}
