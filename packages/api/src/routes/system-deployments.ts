// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import type { AuditEventBinding } from '@kindgi/audit-events';
import type { Logger } from '@kindgi/log';
import type { EnvName, ProjectId, TenantId } from '@kindgi/types';

import {
  DEPLOYMENT_ENDPOINT_PROBLEM_CODES,
  type DeploymentBinding,
  type DeploymentEndpoint,
  type DeploymentEndpointProblem,
  type DeploymentEndpointProblemCode,
  type SystemDeploymentRetireReason,
  endpointToWire,
} from '../deployment-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import {
  type SystemTenantDirectory,
  ownSystemScope,
  requireSystemScope,
  systemReadAcrossTenants,
  withSystemTenantContext,
} from '../middleware/system.js';
import {
  PACK_ENV_HELD_CODES,
  PACK_ENV_RETRY_MS,
  type PackEnvDeclaration,
  type PackEnvDeps,
  type PackEnvHeldCode,
  type PackEnvPlatformHold,
  type PackEnvSecretsAsk,
  isPackEnvPlatformHold,
  packEnvCheck,
  packEnvValues,
} from '../pack-env.js';
import { hostNamesPackService, packServiceName } from '../pack-service-name.js';
import type { SystemScope } from '../system.js';
import type { AppEnv } from '../types.js';

/**
 * A deployment as the orchestrator needs it to create or retire its pack
 * service: ids and the image, nothing of the tenant beyond its id.
 */
export interface SystemDeploymentEntry {
  readonly tenantId: TenantId;
  readonly deploymentId: string;
  /** The pack it deploys (the image index's `packId`). */
  readonly packId: string;
  /**
   * The deployment's project: the one it named, else the tenant's default;
   * absent only when the tenant has none.
   */
  readonly projectId?: string;
  /** Digest-pinned, as registered: the service is created from exactly this. */
  readonly imageRef: string;
  readonly imageDigest: string;
  readonly artifactVersion: string;
  /** ISO-8601. */
  readonly activatedAt: string;
}

/** A deployment whose pack service should run: one that needs a service, or one whose service is ready. */
export interface SystemDeploymentToServe extends SystemDeploymentEntry {
  /**
   * Keep an instance of its service running: in its project, calls route to
   * it for something that's always on there. That's a tool version reached
   * from a version a pin holds (an agent's, a flow's or a tool's) or from
   * the Latest of each agent no pin covers there, or a pack check a
   * registered guardrail runs there. Otherwise its service can scale to
   * zero. Absent from a binding that doesn't say: not warm.
   */
  readonly warm?: boolean;
}

/**
 * A deployment that needs a pack service: whether to start it `warm`, and
 * why it has none yet, if a problem was recorded.
 */
export interface SystemDeploymentMissing extends SystemDeploymentToServe {
  /**
   * The last problem recorded for it (`PUT …/endpoint/problem`), with when
   * that code was first recorded, so the orchestrator can space its tries.
   * Absent when none is.
   */
  readonly problem?: DeploymentEndpointProblem;
}

export interface SystemDeploymentToRetire extends SystemDeploymentEntry {
  readonly reason: SystemDeploymentRetireReason;
}

/**
 * One page across tenants, or `cursor-unreadable` for a cursor the binding
 * never issued (stale or tampered): the route answers it `400`, as every
 * system list does.
 */
export type SystemDeploymentPage<T> =
  | {
      readonly kind: 'ok';
      readonly data: readonly T[];
      /** Absent on the last page. */
      readonly nextCursor?: string;
    }
  | { readonly kind: 'cursor-unreadable' };

/**
 * How the server calls a deployment's pack service:
 * - `google-id-token`: with an ID token for the endpoint's URL (Cloud
 *   Run's invoker check), and the pack token;
 * - `token`: with the pack token only.
 */
export type PackEndpointAuth = 'google-id-token' | 'token';

export const PACK_ENDPOINT_AUTHS: readonly PackEndpointAuth[] = ['google-id-token', 'token'];

export interface SetPackEndpointInput {
  readonly tenantId: TenantId;
  readonly deploymentId: string;
  /** `https://<host>` (and a port, if any): no user info, path, query or fragment. */
  readonly url: string;
  readonly auth: PackEndpointAuth;
  /** The pack service's token. Stored wrapped; never returned, logged or recorded. */
  readonly token: string;
  /**
   * The revision of the pack env values the service was made with, from
   * `GET …/pack-env`, when its pack declares an environment. Kept as the one
   * it runs (`SystemPackEnvServed.appliedRevision`).
   */
  readonly packEnvRevision?: string;
}

/** The checks the binding runs: what the server needs the pack service, or the tenant's record, for. */
export type SetPackEndpointOutcome =
  | { readonly kind: 'ok'; readonly endpoint: DeploymentEndpoint }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'suspended'; readonly reason: 'project-suspended' | 'pack-suspended' }
  | {
      readonly kind: 'refused';
      readonly code: Extract<
        DeploymentEndpointProblemCode,
        'endpoint-unreachable' | 'endpoint-info-mismatch' | 'image-not-allowed'
      >;
      /** For `endpoint-info-mismatch`: the names of the fields that differed, never their values. */
      readonly differs?: readonly string[];
    };

export interface DeploymentRef {
  readonly tenantId: TenantId;
  readonly deploymentId: string;
}

export interface PackEnvRecordInput extends DeploymentRef {
  readonly revision: string;
  readonly held?: PackEnvHeldCode;
  /** The revision the caller found the service running; absent: none. */
  readonly appliedRevision?: string;
}

/** A deployment with a `ready` pack service, whose pack declares an environment. */
export interface SystemPackEnvServed extends SystemDeploymentEntry {
  readonly packEnv: PackEnvDeclaration;
  /** The revision its service runs: given with its endpoint, or recorded since. */
  readonly appliedRevision?: string;
  /**
   * The newest revision held back, why, and since when (ISO-8601). Its
   * service still runs `appliedRevision`.
   */
  readonly held?: {
    readonly revision: string;
    readonly code: PackEnvHeldCode;
    readonly since: string;
  };
}

/**
 * Where the runtime keeps each deployment's pack service: its endpoint
 * (URL, auth, wrapped token), its status and problem, and whether it's
 * suspended. Every method but the two lists acts inside the named tenant's
 * row-level security.
 */
export interface SystemDeploymentsBinding {
  /**
   * Across tenants, oldest `activatedAt` first: deployments that need a
   * pack service. Each is routed (the newest deployment with routes for some
   * tool version or pack check), has no endpoint or a cleared one, and
   * nothing about it is closing or suspended. Each says whether its new
   * service should start `warm`.
   */
  listNeedingEndpoint(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<SystemDeploymentPage<SystemDeploymentMissing>>;
  /**
   * Across tenants, oldest `activatedAt` first: deployments whose endpoint
   * is `ready` and whose pack service stays (no `listToRetire` reason
   * applies), each with `warm`, so the services kept warm are the ones
   * calls are always routed to.
   */
  listReady(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<SystemDeploymentPage<SystemDeploymentToServe>>;
  /**
   * Across tenants, oldest `activatedAt` first: deployments with an
   * endpoint whose pack service should go, each with its `reason`.
   */
  listToRetire(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<SystemDeploymentPage<SystemDeploymentToRetire>>;
  /**
   * Records the endpoint, once the binding's own checks pass: the project
   * and pack aren't suspended; the image is in the tenant's repository; the
   * pack service answers `/v1/info` (with the `kindgi-tenant-id` header) as
   * this deployment. A refusal is recorded as the endpoint's `problem`.
   * The same body twice records it once.
   */
  setEndpoint(input: SetPackEndpointInput): Promise<SetPackEndpointOutcome>;
  /** Clears the endpoint (`cleared`): calls fail closed. Clearing twice keeps the first time. */
  clearEndpoint(
    input: DeploymentRef,
  ): Promise<
    { readonly kind: 'ok'; readonly endpoint: DeploymentEndpoint } | { readonly kind: 'not-found' }
  >;
  /**
   * Records why a deployment waiting for its pack service has none yet: a
   * pending one, or a cleared one that lists as needing a pack service
   * again (`waiting`). Any other is `not-pending`.
   */
  recordProblem(
    input: DeploymentRef & { readonly code: DeploymentEndpointProblemCode },
  ): Promise<
    | { readonly kind: 'ok'; readonly endpoint: DeploymentEndpoint }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'not-pending'; readonly endpoint: DeploymentEndpoint }
  >;
  /**
   * Suspends the deployment's pack (or restores it): it lists to retire as
   * `pack-suspended`, its endpoint can't be set, and its calls fail closed.
   * Setting the same state twice keeps the first time.
   */
  setSuspended(
    input: DeploymentRef & { readonly suspended: boolean; readonly reason?: string },
  ): Promise<
    | { readonly kind: 'ok'; readonly suspended: boolean; readonly since: string }
    | { readonly kind: 'not-found' }
  >;
  /**
   * Across tenants, oldest `activatedAt` first: deployments with a `ready`
   * pack service whose pack declares an environment, each with what its
   * service runs. Nothing about them is closing or suspended. A binding
   * without it doesn't keep what a pack service runs, and the pack env
   * routes answer `501 pack-env-unsupported`.
   */
  listServingPackEnv?(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<SystemDeploymentPage<SystemPackEnvServed>>;
  /**
   * Records what a `ready` deployment's pack service runs: `revision`, once
   * its service was given those values; or, with `held`, the revision it
   * wasn't given, or didn't start, and why (its endpoint's
   * `packEnvProblem`). Recording a revision without `held` clears the
   * problem. The same body twice records it once, and the same code for the
   * same revision keeps the time it was first recorded. Any other endpoint
   * is `not-ready`.
   *
   * Compare-and-set: `appliedRevision` is the revision the caller found its
   * service running (absent: none). Another one recorded since is
   * `conflict`, and nothing is written, so a late round never records over
   * a newer one.
   */
  recordPackEnv?(
    input: PackEnvRecordInput,
  ): Promise<
    | { readonly kind: 'ok'; readonly endpoint: DeploymentEndpoint }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'not-ready'; readonly endpoint: DeploymentEndpoint }
    | { readonly kind: 'conflict'; readonly appliedRevision?: string }
  >;
  /**
   * Claims the orchestrator's round for `claimant` until `holdUntil`, when
   * no live claim holds it (`held` when another does): one orchestrator
   * pass runs at a time, whatever starts them, though scheduled runs can
   * overlap. A claim isn't renewed: a pass ends within its hold, or its
   * claim lapses and the next pass takes the round over. A binding without
   * it answers `501 orchestrator-round-unsupported`.
   */
  claimRound?(input: {
    readonly claimant: string;
    readonly now: Date;
    readonly holdUntil: Date;
  }): Promise<{ readonly kind: 'ok' } | { readonly kind: 'held' }>;
  /** Ends `claimant`'s round: `not-held` when its claim lapsed and another holds the round. */
  endRound?(input: {
    readonly claimant: string;
    readonly now: Date;
  }): Promise<{ readonly kind: 'ok' } | { readonly kind: 'not-held' }>;
}

/**
 * What the pack env routes read: the deployments, the stores a pack's
 * declared names are looked for in (`pack-env.ts`), and the env the server
 * serves.
 */
export interface SystemPackEnvOptions {
  readonly deployments: Pick<DeploymentBinding, 'get'>;
  readonly stores: PackEnvDeps;
  readonly envName: EnvName;
  /**
   * Where each value given out is audited: `env-resolved` for a plain value,
   * `secret-resolved` (caller `pack-env`) for a secret's. Absent: no secret
   * value is given (`501 pack-env-secrets-unaudited`).
   */
  readonly auditEvents?: AuditEventBinding;
  readonly log?: Logger;
}

export interface SystemDeploymentsOptions {
  readonly binding: SystemDeploymentsBinding;
  /**
   * Check 2: whether an endpoint's host name is on the operator's allowlist
   * (`KINDGI_PACK_ENDPOINT_HOSTS`, read with `@kindgi/env-schema`'s
   * `packEndpointHostAllowed`). It's given the URL's `hostname`.
   */
  readonly endpointHostAllowed: (hostname: string) => boolean;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_ID_LENGTH = 128;
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 512;
const MAX_REASON_LENGTH = 500;
const MAX_REVISION_LENGTH = 128;
const MAX_CLAIMANT_LENGTH = 128;
/** A round's hold, in seconds: long enough for one pass, short enough that a dead one lets go. */
const MIN_HOLD_SECONDS = 30;
const MAX_HOLD_SECONDS = 3600;
const DEPLOYMENTS: SystemScope = 'system:deployments';
const PACK_ENV: SystemScope = 'system:pack-env';
const SUSPEND: SystemScope = 'system:suspend';

type WireError = { readonly code: string; readonly message: string } & Readonly<
  Record<string, unknown>
>;

/**
 * `/v1/system/deployments` and `/v1/system/tenants/{tenantId}/deployments/…`:
 * how whatever runs a pack service per deployment (an orchestrator) learns
 * which deployments need one or should lose theirs, and records where each
 * runs, one pass at a time (`/v1/system/deployments/round`). Under
 * `system:deployments`, except the pack suspend route, which takes
 * `system:suspend`, so the orchestrator's key can't suspend or restore a
 * pack, and the pack env routes (`/v1/system/pack-env` and
 * `…/deployments/{id}/pack-env`), which take `system:pack-env`, so the
 * deployments key can't read a value. A secret's value is given only to a
 * key holding `system:pack-env` itself, never `kindgi:system`, and only
 * when it's asked for. No tenant input ever names a pack's URL.
 */
export function systemDeploymentsRouter(
  options: SystemDeploymentsOptions & {
    /** The tenants a system route can name, and their states (`systemTenantDirectory`). */
    readonly directory: SystemTenantDirectory;
    readonly authorizer?: Authorizer;
    /** Absent: the pack env routes answer `501 pack-env-unsupported`. */
    readonly packEnv?: SystemPackEnvOptions;
  },
): Hono<AppEnv> {
  const { binding, directory: tenants, authorizer, packEnv } = options;
  const r = new Hono<AppEnv>();

  // ---------- GET /deployments?endpoint=missing|ready|retire ----------
  r.get('/deployments', async (c) => {
    const denied = systemReadAcrossTenants(c, DEPLOYMENTS, authorizer);
    if (denied !== undefined) return denied;
    const want = c.req.query('endpoint');
    if (want !== 'missing' && want !== 'ready' && want !== 'retire') {
      return fail(c, badInput('`endpoint` must be `missing`, `ready` or `retire`').error);
    }
    const limit = parseLimit(c.req.query('limit'));
    if (limit.kind === 'err') return fail(c, limit.error);
    const cursor = c.req.query('cursor');
    const page = {
      ...(cursor !== undefined && cursor !== '' && { cursor }),
      limit: limit.value,
    };
    const result = await listDeployments(binding, want, page);
    if (result.kind === 'cursor-unreadable') {
      return fail(c, badInput('`cursor` is not one this route gave: start again without it').error);
    }
    return c.json({
      data: result.data.map(listedToWire),
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
      hasMore: result.nextCursor !== undefined,
    });
  });

  // ---------- POST /deployments/round ----------
  // One orchestrator pass at a time: the pass claims the round first, and
  // a claim another holds is a 409, so the pass stops.
  r.post('/deployments/round', async (c) => {
    const denied = systemReadAcrossTenants(c, DEPLOYMENTS, authorizer);
    if (denied !== undefined) return denied;
    if (binding.claimRound === undefined) return roundUnsupported(c);
    const body = await readJsonBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const parsed = parseClaimBody(body.value);
    if (parsed.kind === 'err') return fail(c, parsed.error);
    const now = new Date();
    const holdUntil = new Date(now.getTime() + parsed.value.holdSeconds * 1000);
    const claimed = await binding.claimRound({
      claimant: parsed.value.claimant,
      now,
      holdUntil,
    });
    if (claimed.kind === 'held') {
      return fail(c, {
        code: 'orchestrator-round-held',
        message:
          'Another orchestrator pass holds the round: this one stops, and the next one claims it once that pass ends or its hold runs out.',
      });
    }
    return c.json({ claimant: parsed.value.claimant, heldUntil: holdUntil.toISOString() });
  });

  // ---------- POST /deployments/round/end ----------
  r.post('/deployments/round/end', async (c) => {
    const denied = systemReadAcrossTenants(c, DEPLOYMENTS, authorizer);
    if (denied !== undefined) return denied;
    if (binding.endRound === undefined) return roundUnsupported(c);
    const body = await readJsonBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const claimant = parseClaimant(body.value);
    if (claimant.kind === 'err') return fail(c, claimant.error);
    const ended = await binding.endRound({ claimant: claimant.value, now: new Date() });
    if (ended.kind === 'not-held') {
      return fail(c, {
        code: 'orchestrator-round-not-held',
        message: `"${claimant.value}" doesn't hold the round: its hold ran out, and another pass may hold it now.`,
      });
    }
    return c.body(null, 204);
  });

  const onDeployment = '/tenants/:tenantId/deployments/:deploymentId';

  // ---------- PUT …/endpoint ----------
  r.put(`${onDeployment}/endpoint`, requireSystemScope(DEPLOYMENTS, authorizer), async (c) => {
    const ref = deploymentRef(c);
    if (ref.kind === 'err') return fail(c, ref.error);
    const body = await readJsonBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const parsed = parseEndpoint(body.value);
    if (parsed.kind === 'err') return fail(c, parsed.error);
    return withSystemTenantContext(
      c,
      tenants,
      ref.value.tenantId,
      { scope: DEPLOYMENTS, refuse: ['closing', 'suspended'], ...(authorizer && { authorizer }) },
      async (tenant) => {
        const target = { tenantId: tenant.id, deploymentId: ref.value.deploymentId };
        const checked = checkEndpoint(parsed.value.url, target, options);
        if (checked.kind === 'err') {
          // On record, so a deploy waiting for `ready` can say why at once.
          const recorded = await binding.recordProblem({ ...target, code: checked.error.code });
          if (recorded.kind === 'not-found') return deploymentNotFound(c, target.deploymentId);
          return fail(c, checked.error);
        }
        const outcome = await binding.setEndpoint({
          ...target,
          ...parsed.value,
          url: checked.value.origin,
        });
        switch (outcome.kind) {
          case 'ok':
            return c.json(endpointToWire(outcome.endpoint));
          case 'not-found':
            return deploymentNotFound(c, target.deploymentId);
          case 'suspended':
            return fail(c, {
              code: outcome.reason,
              message: `Deployment ${target.deploymentId}'s ${outcome.reason === 'pack-suspended' ? 'pack' : 'project'} is suspended: its endpoint can't be set.`,
            });
          case 'refused':
            return fail(c, {
              code: outcome.code,
              message: REFUSED[outcome.code],
              ...(outcome.differs !== undefined && { differs: outcome.differs }),
            });
        }
      },
    );
  });

  // ---------- DELETE …/endpoint ----------
  // A closing or suspended tenant's endpoints are cleared too: that's how
  // its pack services are retired.
  r.delete(`${onDeployment}/endpoint`, requireSystemScope(DEPLOYMENTS, authorizer), async (c) => {
    const ref = deploymentRef(c);
    if (ref.kind === 'err') return fail(c, ref.error);
    return withSystemTenantContext(
      c,
      tenants,
      ref.value.tenantId,
      { scope: DEPLOYMENTS, ...(authorizer && { authorizer }) },
      async (tenant) => {
        const cleared = await binding.clearEndpoint({
          tenantId: tenant.id,
          deploymentId: ref.value.deploymentId,
        });
        if (cleared.kind === 'not-found') return deploymentNotFound(c, ref.value.deploymentId);
        return c.json(endpointToWire(cleared.endpoint));
      },
    );
  });

  // ---------- PUT …/endpoint/problem ----------
  r.put(
    `${onDeployment}/endpoint/problem`,
    requireSystemScope(DEPLOYMENTS, authorizer),
    async (c) => {
      const ref = deploymentRef(c);
      if (ref.kind === 'err') return fail(c, ref.error);
      const body = await readJsonBody(c);
      if (body.kind === 'err') return fail(c, body.error);
      const code = parseProblemBody(body.value);
      if (code.kind === 'err') return fail(c, code.error);
      return withSystemTenantContext(
        c,
        tenants,
        ref.value.tenantId,
        { scope: DEPLOYMENTS, ...(authorizer && { authorizer }) },
        async (tenant) => {
          const recorded = await binding.recordProblem({
            tenantId: tenant.id,
            deploymentId: ref.value.deploymentId,
            code: code.value,
          });
          switch (recorded.kind) {
            case 'ok':
              return c.json(endpointToWire(recorded.endpoint));
            case 'not-found':
              return deploymentNotFound(c, ref.value.deploymentId);
            case 'not-pending':
              return fail(c, {
                code: 'endpoint-not-pending',
                message: `Deployment ${ref.value.deploymentId}'s endpoint is ${recorded.endpoint.status} and not waiting for a pack service: a problem goes with a pending one, or a cleared one that lists as needing a pack service again (\`waiting\`).`,
                status: recorded.endpoint.status,
              });
          }
        },
      );
    },
  );

  // ---------- GET /pack-env ----------
  // The deployments whose pack service runs on values that have changed
  // since (and weren't held back at this revision, but for one that didn't
  // start, tried again for an hour, and one held for a cause the platform
  // fixes, every time, with its hold): ids, and the revision each runs, for
  // the compare-and-set.
  r.get('/pack-env', async (c) => {
    const denied = systemReadAcrossTenants(c, PACK_ENV, authorizer);
    if (denied !== undefined) return denied;
    if (packEnv === undefined || binding.listServingPackEnv === undefined) {
      return packEnvUnsupported(c);
    }
    const limit = parseLimit(c.req.query('limit'));
    if (limit.kind === 'err') return fail(c, limit.error);
    const cursor = c.req.query('cursor');
    const result = await binding.listServingPackEnv({
      ...(cursor !== undefined && cursor !== '' && { cursor }),
      limit: limit.value,
    });
    if (result.kind === 'cursor-unreadable') {
      return fail(c, badInput('`cursor` is not one this route gave: start again without it').error);
    }
    return c.json({
      data: (await changedPackEnv(packEnv, result.data)).map(({ entry, platformHold }) => ({
        ...entryToWire(entry),
        ...(entry.appliedRevision !== undefined && { appliedRevision: entry.appliedRevision }),
        ...(platformHold !== undefined && { held: platformHold }),
      })),
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
      hasMore: result.nextCursor !== undefined,
    });
  });

  // ---------- GET …/pack-env ----------
  // The values, for the deployment's pack service only: none while there's a
  // problem, and none for a retired deployment. Its secrets' values only
  // when asked (`?secrets=values`), by a key holding `system:pack-env`
  // itself, and each audited before any is answered. Its cloud secrets'
  // paths (`cloudSecrets`) always: a path is a name, which the pack
  // service's cloud reads as its own account.
  r.get(`${onDeployment}/pack-env`, requireSystemScope(PACK_ENV, authorizer), async (c) => {
    const ref = deploymentRef(c);
    if (ref.kind === 'err') return fail(c, ref.error);
    const secrets = secretsAsk(c, authorizer);
    if (secrets instanceof Response) return secrets;
    if (packEnv === undefined || binding.recordPackEnv === undefined) {
      return packEnvUnsupported(c);
    }
    if (secrets !== undefined && packEnv.auditEvents === undefined) return secretsUnaudited(c);
    return withSystemTenantContext(
      c,
      tenants,
      ref.value.tenantId,
      { scope: PACK_ENV, refuse: ['closing', 'suspended'], ...(authorizer && { authorizer }) },
      (tenant) =>
        packEnvAnswer(
          c,
          packEnv,
          { tenantId: tenant.id, deploymentId: ref.value.deploymentId },
          secrets,
        ),
    );
  });

  // ---------- PUT …/pack-env ----------
  r.put(`${onDeployment}/pack-env`, requireSystemScope(PACK_ENV, authorizer), async (c) => {
    const ref = deploymentRef(c);
    if (ref.kind === 'err') return fail(c, ref.error);
    const record = binding.recordPackEnv;
    if (packEnv === undefined || record === undefined) return packEnvUnsupported(c);
    const body = await readJsonBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const parsed = parsePackEnvBody(body.value);
    if (parsed.kind === 'err') return fail(c, parsed.error);
    return withSystemTenantContext(
      c,
      tenants,
      ref.value.tenantId,
      { scope: PACK_ENV, refuse: ['closing'], ...(authorizer && { authorizer }) },
      async (tenant) => {
        const recorded = await record.call(binding, {
          tenantId: tenant.id,
          deploymentId: ref.value.deploymentId,
          ...parsed.value,
        });
        switch (recorded.kind) {
          case 'ok':
            return c.json(endpointToWire(recorded.endpoint));
          case 'not-found':
            return deploymentNotFound(c, ref.value.deploymentId);
          case 'conflict':
            return fail(c, {
              code: 'pack-env-conflict',
              message: `Deployment ${ref.value.deploymentId}'s pack service was recorded as running another revision since: read it again.`,
              ...(recorded.appliedRevision !== undefined && {
                appliedRevision: recorded.appliedRevision,
              }),
            });
          case 'not-ready':
            return fail(c, {
              code: 'endpoint-not-ready',
              message: `Deployment ${ref.value.deploymentId}'s endpoint is ${recorded.endpoint.status}: what a pack service runs is recorded for a ready one (a new one's goes with its endpoint, \`packEnvRevision\`).`,
              status: recorded.endpoint.status,
            });
        }
      },
    );
  });

  // ---------- PUT …/suspended (the pack) ----------
  r.put(`${onDeployment}/suspended`, requireSystemScope(SUSPEND, authorizer), async (c) => {
    const ref = deploymentRef(c);
    if (ref.kind === 'err') return fail(c, ref.error);
    const body = await readJsonBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const parsed = parseSuspendBody(body.value);
    if (parsed.kind === 'err') return fail(c, parsed.error);
    return withSystemTenantContext(
      c,
      tenants,
      ref.value.tenantId,
      // Closing is one-way: its deployments already list to retire, and the
      // only system write that still reaches it is retiring them.
      { scope: SUSPEND, refuse: ['closing'], ...(authorizer && { authorizer }) },
      async (tenant) => {
        const result = await binding.setSuspended({
          tenantId: tenant.id,
          deploymentId: ref.value.deploymentId,
          ...parsed.value,
        });
        if (result.kind === 'not-found') return deploymentNotFound(c, ref.value.deploymentId);
        return c.json({ suspended: result.suspended, since: result.since });
      },
    );
  });

  return r;
}

/** What the orchestrator reads when the binding refuses an endpoint. */
const REFUSED: Readonly<
  Record<Extract<SetPackEndpointOutcome, { kind: 'refused' }>['code'], string>
> = {
  'endpoint-unreachable': "The pack service didn't answer /v1/info as this deployment's service.",
  'endpoint-info-mismatch':
    "The pack service answered as another pack or version: it doesn't serve this deployment's image.",
  'image-not-allowed': "The deployment's image is outside the tenant's repository.",
};

type EndpointRefusal = WireError & { readonly code: DeploymentEndpointProblemCode };

/**
 * Checks 1 to 3, which need nothing but the request: the URL's shape, its
 * host on the operator's allowlist, and the host naming the deployment's
 * own service. Check 4 (the pack's own answer) and the image are the
 * binding's.
 */
function checkEndpoint(
  raw: string,
  target: DeploymentRef,
  options: SystemDeploymentsOptions,
): { kind: 'ok'; value: URL } | { kind: 'err'; error: EndpointRefusal } {
  const url = parseEndpointUrl(raw);
  if (url.kind === 'err') return url;
  const host = url.value.hostname.toLowerCase();
  if (!options.endpointHostAllowed(host)) {
    return {
      kind: 'err',
      error: {
        code: 'endpoint-host-not-allowed',
        message: `${host} isn't on the operator's allowlist of pack hosts (KINDGI_PACK_ENDPOINT_HOSTS).`,
      },
    };
  }
  const name = packServiceName(target.tenantId, target.deploymentId);
  if (!hostNamesPackService(host, name)) {
    return {
      kind: 'err',
      error: {
        code: 'endpoint-name-mismatch',
        message: `${host} doesn't name this deployment's pack service, ${name}.`,
        expected: name,
      },
    };
  }
  return url;
}

/** The list `endpoint=` names. */
function listDeployments(
  binding: SystemDeploymentsBinding,
  want: 'missing' | 'ready' | 'retire',
  page: { readonly cursor?: string; readonly limit: number },
): Promise<
  SystemDeploymentPage<SystemDeploymentMissing | SystemDeploymentToServe | SystemDeploymentToRetire>
> {
  if (want === 'missing') return binding.listNeedingEndpoint(page);
  if (want === 'ready') return binding.listReady(page);
  return binding.listToRetire(page);
}

/**
 * A listed entry: `warm` from the `missing` and `ready` lists, when given;
 * `problem` from `missing`, when one was recorded; `reason` from `retire`.
 */
function listedToWire(
  entry: SystemDeploymentMissing | SystemDeploymentToServe | SystemDeploymentToRetire,
) {
  return {
    ...entryToWire(entry),
    ...('warm' in entry && entry.warm !== undefined && { warm: entry.warm }),
    ...('problem' in entry && entry.problem !== undefined && { problem: entry.problem }),
    ...('reason' in entry && { reason: entry.reason }),
  };
}

function entryToWire(entry: SystemDeploymentEntry) {
  return {
    tenantId: entry.tenantId as unknown as string,
    deploymentId: entry.deploymentId,
    packId: entry.packId,
    ...(entry.projectId !== undefined && { projectId: entry.projectId }),
    imageRef: entry.imageRef,
    imageDigest: entry.imageDigest,
    artifactVersion: entry.artifactVersion,
    activatedAt: entry.activatedAt,
  };
}

type Parsed<T> = { kind: 'ok'; value: T } | { kind: 'err'; error: WireError };

/** The path's deployment: the tenant id is checked by `withSystemTenantContext`. */
function deploymentRef(
  c: Context<AppEnv>,
): Parsed<{ readonly tenantId: string; readonly deploymentId: string }> {
  const tenantId = c.req.param('tenantId') ?? '';
  const deploymentId = c.req.param('deploymentId') ?? '';
  if (deploymentId === '' || deploymentId.length > MAX_ID_LENGTH) {
    return badInput(`\`deploymentId\` must be 1 to ${MAX_ID_LENGTH} characters`);
  }
  return { kind: 'ok', value: { tenantId, deploymentId } };
}

function parseLimit(raw: string | undefined): Parsed<number> {
  if (raw === undefined || raw === '') return { kind: 'ok', value: DEFAULT_LIMIT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return badInput(`\`limit\` must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return { kind: 'ok', value: n };
}

/** A listed entry, and its hold when it's held at this revision for a cause the platform fixes. */
interface PackEnvChange {
  readonly entry: SystemPackEnvServed;
  readonly platformHold?: { readonly code: PackEnvPlatformHold; readonly since: string };
}

/**
 * The entries whose pack service runs on values that changed since, and
 * weren't held back at this revision, or were held at it for a cause the
 * platform fixes.
 */
async function changedPackEnv(
  packEnv: SystemPackEnvOptions,
  served: readonly SystemPackEnvServed[],
): Promise<PackEnvChange[]> {
  const changed: PackEnvChange[] = [];
  const now = Date.now();
  for (const entry of served) {
    const { revision } = await packEnvCheck(packEnv.stores, {
      tenantId: entry.tenantId,
      ...(entry.projectId !== undefined && { projectId: entry.projectId as ProjectId }),
      envName: packEnv.envName,
      declaration: entry.packEnv,
    });
    if (revision === entry.appliedRevision) continue;
    const held = entry.held;
    if (held === undefined || held.revision !== revision) {
      changed.push({ entry });
      continue;
    }
    // Values the owner has to change wait for a change. Values that were
    // given and didn't start are tried again for a while, as their cause may
    // pass. A cause the platform fixes is listed every time: the revision
    // doesn't move when it's fixed.
    if (isPackEnvPlatformHold(held.code)) {
      changed.push({ entry, platformHold: { code: held.code, since: held.since } });
    } else if (
      held.code === 'pack-env-update-failed' &&
      now - Date.parse(held.since) < PACK_ENV_RETRY_MS
    ) {
      changed.push({ entry });
    }
  }
  return changed;
}

const UNAVAILABLE_BECAUSE = {
  store: 'its secret store is out',
  changed: 'a secret changed while it was read, twice',
  audit: "its secrets' audit rows weren't written",
} as const;

/**
 * `?secrets=`: left out (`undefined`), or `values`, asked by a key holding
 * `system:pack-env` itself: who asks, for each secret's row. Otherwise the
 * answer refusing it.
 */
function secretsAsk(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
): PackEnvSecretsAsk | undefined | Response {
  const raw = c.req.query('secrets');
  if (raw === undefined) return undefined;
  if (raw !== 'values') return fail(c, badInput('`secrets` must be `values`, or left out').error);
  const principal = ownSystemScope(
    c,
    PACK_ENV,
    "A deployment's secret values are given only to the pack env key",
    authorizer,
  );
  if (principal instanceof Response) return principal;
  return { requestId: c.get('requestId'), systemKeyId: principal.keyId };
}

/** GET …/pack-env, once the key and the tenant are let through. */
async function packEnvAnswer(
  c: Context<AppEnv>,
  packEnv: SystemPackEnvOptions,
  ref: DeploymentRef,
  secrets: PackEnvSecretsAsk | undefined,
): Promise<Response> {
  const deployment = await packEnv.deployments.get(ref);
  if (deployment === null) return deploymentNotFound(c, ref.deploymentId);
  const endpoint = deployment.endpoint;
  if (endpoint?.status === 'cleared' && endpoint.waiting !== true) {
    return fail(c, {
      code: 'endpoint-retired',
      message: `Deployment ${ref.deploymentId}'s pack service was retired: its env isn't given out.`,
      ...(endpoint.retired !== undefined && { retired: endpoint.retired }),
    });
  }
  const read = await packEnvValues(packEnv.stores, {
    tenantId: ref.tenantId,
    ...(deployment.projectId !== undefined && { projectId: deployment.projectId }),
    envName: packEnv.envName,
    declaration: deployment.packEnv ?? { required: [], optional: [] },
    deploymentId: deployment.deploymentId,
    ...(packEnv.auditEvents !== undefined && { auditEvents: packEnv.auditEvents }),
    ...(packEnv.log !== undefined && { log: packEnv.log }),
    ...(secrets !== undefined && { secrets }),
  });
  if (read.kind === 'unaudited') return secretsUnaudited(c);
  if (read.kind === 'unavailable') {
    return fail(c, {
      code: 'pack-env-unavailable',
      message: `Deployment ${ref.deploymentId}'s pack env can't be read just now (${UNAVAILABLE_BECAUSE[read.cause]}): try again.`,
    });
  }
  const { check, values } = read;
  return c.json({
    revision: check.revision,
    names: check.names,
    ...(check.problem !== undefined && { problem: check.problem }),
    ...(values !== undefined && { env: values }),
    ...(read.secrets !== undefined && { secrets: read.secrets }),
    ...(read.cloudSecrets !== undefined && { cloudSecrets: read.cloudSecrets }),
  });
}

interface ParsedEndpointBody {
  /** As sent: checks 1 to 3 run in the tenant's context, so a refusal is on record. */
  readonly url: string;
  readonly auth: PackEndpointAuth;
  readonly token: string;
  readonly packEnvRevision?: string;
}

function parseEndpoint(body: unknown): Parsed<ParsedEndpointBody> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.url !== 'string') return badInput('`url` must be a string');
  if (typeof b.auth !== 'string' || !(PACK_ENDPOINT_AUTHS as readonly string[]).includes(b.auth)) {
    return badInput('`auth` must be `google-id-token` or `token`');
  }
  const token = b.token;
  if (
    typeof token !== 'string' ||
    token.length < MIN_TOKEN_LENGTH ||
    token.length > MAX_TOKEN_LENGTH ||
    !/^[\x21-\x7e]+$/.test(token)
  ) {
    return badInput(
      `\`token\` must be ${MIN_TOKEN_LENGTH} to ${MAX_TOKEN_LENGTH} printable ASCII characters without spaces (it travels in a header)`,
    );
  }
  if (b.packEnvRevision !== undefined && !isRevision(b.packEnvRevision)) {
    return badInput(
      `\`packEnvRevision\` must be 1 to ${MAX_REVISION_LENGTH} printable ASCII characters, as \`GET …/pack-env\` gave it`,
    );
  }
  return {
    kind: 'ok',
    value: {
      url: b.url,
      auth: b.auth as PackEndpointAuth,
      token,
      ...(typeof b.packEnvRevision === 'string' && { packEnvRevision: b.packEnvRevision }),
    },
  };
}

function isRevision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_REVISION_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function parsePackEnvBody(body: unknown): Parsed<Omit<PackEnvRecordInput, keyof DeploymentRef>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  if (!isRevision(b.revision)) {
    return badInput(
      `\`revision\` must be 1 to ${MAX_REVISION_LENGTH} printable ASCII characters, as \`GET …/pack-env\` gave it`,
    );
  }
  if (b.appliedRevision !== undefined && !isRevision(b.appliedRevision)) {
    return badInput(
      `\`appliedRevision\` must be 1 to ${MAX_REVISION_LENGTH} printable ASCII characters: the revision the service was found running`,
    );
  }
  if (
    b.held !== undefined &&
    (typeof b.held !== 'string' || !(PACK_ENV_HELD_CODES as readonly string[]).includes(b.held))
  ) {
    return badInput(`\`held\` must be one of ${PACK_ENV_HELD_CODES.join(', ')}`);
  }
  return {
    kind: 'ok',
    value: {
      revision: b.revision,
      ...(b.held !== undefined && { held: b.held as PackEnvHeldCode }),
      ...(typeof b.appliedRevision === 'string' && { appliedRevision: b.appliedRevision }),
    },
  };
}

function secretsUnaudited(c: Context<AppEnv>): Response {
  return fail(c, {
    code: 'pack-env-secrets-unaudited',
    message:
      'This server has nowhere to audit a secret given out, so it gives none: a person has to set up its audit store.',
  });
}

function roundUnsupported(c: Context<AppEnv>): Response {
  return fail(c, {
    code: 'orchestrator-round-unsupported',
    message:
      'This server keeps no orchestrator round: whatever runs its pack services keeps one pass at a time itself.',
  });
}

function parseClaimant(body: unknown): Parsed<string> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be an object');
  }
  const claimant = (body as Record<string, unknown>).claimant;
  if (
    typeof claimant !== 'string' ||
    claimant.length === 0 ||
    claimant.length > MAX_CLAIMANT_LENGTH ||
    !/^[\x21-\x7e]+$/.test(claimant)
  ) {
    return badInput(
      `\`claimant\` must be 1 to ${MAX_CLAIMANT_LENGTH} printable characters with no spaces: the pass's own id`,
    );
  }
  return { kind: 'ok', value: claimant };
}

function parseClaimBody(
  body: unknown,
): Parsed<{ readonly claimant: string; readonly holdSeconds: number }> {
  const claimant = parseClaimant(body);
  if (claimant.kind === 'err') return claimant;
  const holdSeconds = (body as Record<string, unknown>).holdSeconds;
  if (
    typeof holdSeconds !== 'number' ||
    !Number.isInteger(holdSeconds) ||
    holdSeconds < MIN_HOLD_SECONDS ||
    holdSeconds > MAX_HOLD_SECONDS
  ) {
    return badInput(
      `\`holdSeconds\` must be a whole number from ${MIN_HOLD_SECONDS} to ${MAX_HOLD_SECONDS}: how long the pass holds the round`,
    );
  }
  return { kind: 'ok', value: { claimant: claimant.value, holdSeconds } };
}

function packEnvUnsupported(c: Context<AppEnv>): Response {
  return fail(c, {
    code: 'pack-env-unsupported',
    message:
      "This server doesn't give a pack service its declared env: its pack services take theirs from how they're run.",
  });
}

/**
 * Check 1: `https`, no user info, no path beyond `/`, no query or fragment.
 * Refused as `endpoint-url-invalid`, a 400 the caller fixes.
 */
function parseEndpointUrl(
  raw: string,
): { kind: 'ok'; value: URL } | { kind: 'err'; error: EndpointRefusal } {
  const invalid = (why: string): { kind: 'err'; error: EndpointRefusal } => ({
    kind: 'err',
    error: { code: 'endpoint-url-invalid', message: `\`url\` ${why}` },
  });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid('must be an absolute URL');
  }
  if (url.protocol !== 'https:') return invalid('must be https');
  if (url.username !== '' || url.password !== '') return invalid('must carry no user info');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(raw)) {
    return invalid('must have no path beyond /, and no query or fragment');
  }
  return { kind: 'ok', value: url };
}

function parseProblemBody(body: unknown): Parsed<DeploymentEndpointProblemCode> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be an object');
  }
  const code = (body as Record<string, unknown>).code;
  if (
    typeof code !== 'string' ||
    !(DEPLOYMENT_ENDPOINT_PROBLEM_CODES as readonly string[]).includes(code)
  ) {
    return badInput(`\`code\` must be one of ${DEPLOYMENT_ENDPOINT_PROBLEM_CODES.join(', ')}`);
  }
  return { kind: 'ok', value: code as DeploymentEndpointProblemCode };
}

function parseSuspendBody(
  body: unknown,
): Parsed<{ readonly suspended: boolean; readonly reason?: string }> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.suspended !== 'boolean') return badInput('`suspended` must be true or false');
  if (b.reason !== undefined) {
    if (
      typeof b.reason !== 'string' ||
      b.reason.trim() === '' ||
      b.reason.length > MAX_REASON_LENGTH
    ) {
      return badInput(
        `\`reason\` must be a non-empty string of at most ${MAX_REASON_LENGTH} characters`,
      );
    }
    return { kind: 'ok', value: { suspended: b.suspended, reason: b.reason } };
  }
  return { kind: 'ok', value: { suspended: b.suspended } };
}

async function readJsonBody(c: Context<AppEnv>): Promise<Parsed<unknown>> {
  try {
    return { kind: 'ok', value: JSON.parse(await c.req.text()) as unknown };
  } catch {
    return badInput('Request body must be JSON');
  }
}

function badInput(message: string): { kind: 'err'; error: WireError } {
  return { kind: 'err', error: { code: 'bad-input', message } };
}

function deploymentNotFound(c: Context<AppEnv>, deploymentId: string): Response {
  return fail(c, {
    code: 'deployment-not-found',
    message: `No deployment "${deploymentId}" in this tenant.`,
  });
}

function fail(c: Context<AppEnv>, error: WireError): Response {
  c.status(statusFor(error.code) as never);
  // `toWireError` puts every field besides code and message under `details`.
  return c.json(toWireError(error, c.get('requestId')));
}
