// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Promoting a deployment into the next environment of its order, and what
 * the routes that read a deployment's values share: the values check's
 * deps from the router's bindings (`valuesDepsFor`), and the versions
 * that move with a deployment (`carriedFor`).
 *
 * `POST /v1/deployments/:deploymentId/promotions { toProjectId, reason? }`
 * moves the exact build a deployment runs into the next environment: the
 * same image, signature and contents, in a new deployment of the target
 * project. Nothing is built again and no registry is written; the edits
 * of the build's agents and flows move with it (`carried-versions.ts`).
 * It's refused, before anything is written, when:
 *
 * 1. the caller is a key or session limited to a project (`403
 *    key-project-mismatch`: a promotion reads one project and writes
 *    another), the deployment isn't the caller's to read (`404
 *    deployment-not-found`), or the target isn't theirs to administer
 *    (`403`);
 * 2. the target isn't the next environment of the deployment's order
 *    (`409 promotion-not-next-environment`);
 * 3. the deployment doesn't serve its environment any more, or the copy
 *    the target has doesn't (`409 deployment-superseded`, or the
 *    suspension's own code);
 * 4. its signer is no longer trusted, or its signature doesn't verify over
 *    the fields it keeps (the deploy's own codes);
 * 5. a value it needs isn't ready in the target
 *    (`409 promotion-values-not-ready`, each one in `details.values`).
 *
 * `POST …/promotions/check { toProjectId }` runs the same checks and
 * writes nothing: it answers what would move and every value with a
 * problem, where a promotion would refuse on them.
 *
 * Both check rights on the projects themselves, not the tenant's: read on
 * the deployment's environment, admin on the target (`isPromotionRoute`).
 */

import type { Context, Hono } from 'hono';

import { ref } from '@kindgi/authz';
import { emitAuditEvent } from '@kindgi/compliance';
import { verifyEd25519 } from '@kindgi/crypto';
import type { Scope } from '@kindgi/platform';
import type { LiveScope, ProjectId, Semver, TenantId, ToolId } from '@kindgi/types';

import { callerIdentity } from '../caller.js';
import {
  type CarriedVersions,
  type LeftBehindVersion,
  carriedVersions,
} from '../carried-versions.js';
import {
  type CarriedVersion,
  type DeployedPrimitive,
  type Deployment,
  type PromotedToolSecretScopes,
  type SystemDeploymentRetireReason,
  serializeDeployment,
} from '../deployment-binding.js';
import { canonicalizeEnvelope } from '../deployment-envelope.js';
import {
  type DeploymentValue,
  type DeploymentValuesDeps,
  deploymentValues,
} from '../deployment-values.js';
import { statusFor, toWireError } from '../errors.js';
import type { GatePolicyRef } from '../gate-policy-binding.js';
import type { GateCheck } from '../gate.js';
import { liveChangeRefusal } from '../item-rights.js';
import type { Promotion, PromotionStatus } from '../live-version-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import { limitedCaller } from '../middleware/key-project.js';
import { deploymentSecretScope, secretScopesFor, toolSecretRefs } from '../secret-scope.js';
import type { AppEnv } from '../types.js';
import { actorOf, policyFor, promotionResponse, requestPromotion } from './agent-releases.js';
import { deniedBy, refused } from './denied.js';
import type { DeploymentsRouterBindings } from './deployments.js';
import { scopeResourceRef } from './scope-params.js';

/**
 * The values check's deps (`deploymentValues`), from the router's
 * bindings: the env it serves, secrets, projects, tools and agents, with
 * `values` for the rest. `administers`: whether the caller administers a
 * scope, where a tool's secret is recorded only at one they do (as at a
 * promotion's target); absent, every scope (where a run finds it).
 */
export function valuesDepsFor(
  bindings: DeploymentsRouterBindings,
  administers?: (scope: Scope) => Promise<boolean>,
): DeploymentValuesDeps {
  return {
    ...bindings.values,
    ...(bindings.envName !== undefined && { envName: bindings.envName }),
    ...(bindings.secretsBinding !== undefined && { secrets: bindings.secretsBinding }),
    ...(bindings.projectBinding !== undefined && { projects: bindings.projectBinding }),
    ...(bindings.toolRegistry !== undefined && { tools: bindings.toolRegistry }),
    ...(bindings.agentRegistry !== undefined && { agents: bindings.agentRegistry }),
    ...(administers !== undefined && { administers }),
  };
}

/**
 * The project a deployment serves: the one it names, else the tenant's
 * Default (where a deploy naming none lands). `undefined` without a
 * project binding to find the Default.
 */
export async function servingProjectOf(
  bindings: Pick<DeploymentsRouterBindings, 'projectBinding'>,
  deployment: Deployment,
): Promise<ProjectId | undefined> {
  return (await servingProjectsOf(bindings, [deployment]))[0];
}

/** {@link servingProjectOf} for each of one tenant's `deployments`, in their order: the Default read once. */
async function servingProjectsOf(
  bindings: Pick<DeploymentsRouterBindings, 'projectBinding'>,
  deployments: readonly Deployment[],
): Promise<(ProjectId | undefined)[]> {
  const unnamed = deployments.find((d) => d.projectId === undefined);
  const defaultId =
    unnamed === undefined
      ? undefined
      : (await bindings.projectBinding?.getDefault(unnamed.tenantId))?.id;
  return deployments.map((d) => d.projectId ?? defaultId);
}

/**
 * What reading a deployment asks: `read` on the project it serves, or on
 * the tenant without a project binding to find the Default.
 */
function readRef(tenantId: TenantId, projectId: ProjectId | undefined) {
  return projectId === undefined
    ? ref('tenant', tenantId as unknown as string)
    : ref('project', projectId as unknown as string);
}

/**
 * The deployment `:deploymentId` names and the project it serves, when the
 * caller reads that project ({@link readRef}). `undefined` for one that
 * isn't there and for one they don't read alike, so a route answers both
 * with its one `404`. Without an authorizer, every caller in the tenant
 * reads it.
 */
export async function readableDeployment(
  c: Context<AppEnv>,
  bindings: Pick<DeploymentsRouterBindings, 'deploymentRegistry' | 'projectBinding'>,
  authorizer: Authorizer | undefined,
): Promise<
  { readonly deployment: Deployment; readonly projectId: ProjectId | undefined } | undefined
> {
  const tenantId = c.get('tenantId') as TenantId;
  const deploymentId = c.req.param('deploymentId') ?? '';
  const deployment = await bindings.deploymentRegistry.get({ tenantId, deploymentId });
  if (deployment === null) return undefined;
  const projectId = await servingProjectOf(bindings, deployment);
  if (
    authorizer !== undefined &&
    !(await authorizer.can(c, 'read', readRef(tenantId, projectId)))
  ) {
    return undefined;
  }
  return { deployment, projectId };
}

/** The ones of `deployments` the caller reads, as {@link readableDeployment} decides one, in their order. */
export async function readableDeployments(
  c: Context<AppEnv>,
  bindings: Pick<DeploymentsRouterBindings, 'projectBinding'>,
  authorizer: Authorizer | undefined,
  deployments: readonly Deployment[],
): Promise<Deployment[]> {
  if (authorizer === undefined) return [...deployments];
  const tenantId = c.get('tenantId') as TenantId;
  const projects = await servingProjectsOf(bindings, deployments);
  const readable = await authorizer.filterByCan(
    c,
    'read',
    deployments.map((deployment, i) => ({ deployment, projectId: projects[i] })),
    ({ projectId }) => readRef(tenantId, projectId),
  );
  return readable.map(({ deployment }) => deployment);
}

/**
 * The versions that move with `deployment` to the next environment, and
 * the edits of its agents and flows that stay behind (`carriedVersions`),
 * as a run in the project it serves reaches them. Nothing, when that
 * project can't be found.
 */
export async function carriedFor(
  bindings: DeploymentsRouterBindings,
  deployment: Deployment,
): Promise<CarriedVersions> {
  const fromProjectId = await servingProjectOf(bindings, deployment);
  if (fromProjectId === undefined) return { carried: [], leftBehind: [] };
  return carriedVersions(
    {
      ...(bindings.agentRegistry !== undefined && { agents: bindings.agentRegistry }),
      ...(bindings.flowRegistry !== undefined && { flows: bindings.flowRegistry }),
      ...(bindings.referenceScope !== undefined && { reach: bindings.referenceScope }),
    },
    { tenantId: deployment.tenantId, fromProjectId, contents: deployment.contents },
  );
}

// ------------------------------------------------------------
// What a promotion moves, and its answer
// ------------------------------------------------------------

/** An agent or flow version a promotion moves: one the build ships, or one carried with it. */
export interface MovedVersion {
  readonly id: string;
  readonly version?: string;
  /** Carried with the build: an edit of a version it ships. */
  readonly carried?: true;
}

/** What a promotion moves into the next environment. */
export interface PromotionMoves {
  readonly packId?: string;
  readonly imageDigest: string;
  readonly agents: readonly MovedVersion[];
  readonly flows: readonly MovedVersion[];
  readonly tools: readonly DeployedPrimitive[];
  readonly guardrails: readonly DeployedPrimitive[];
}

/** The gate's say on a carried version's pin: there when it isn't live yet (an approval or a failed check), or ran checks. */
export interface DeploymentLivePinGate {
  readonly status: PromotionStatus;
  readonly promotionId: string;
  readonly policy?: GatePolicyRef | null;
  readonly approvalId?: string;
  readonly checks?: readonly GateCheck[];
}

/** A carried agent version the make-live pinned, or tried to, in the target project. */
export interface DeploymentLivePin {
  readonly id: string;
  readonly version: string;
  /** Live now (`true`), or waiting on a gate — an approval, or a check it failed (`false`). */
  readonly pinned: boolean;
  readonly gate?: DeploymentLivePinGate;
}

/**
 * What a promotion did. The handler builds it once and answers it through
 * `promotionAnswer`, so what's added after the write (making versions
 * live) has one place to go.
 */
export interface PromotionResult {
  /** The target's deployment: a new one, or the one it had already. */
  readonly deployment: Deployment;
  readonly moved: PromotionMoves;
  /** Edits of the build's agents and flows that stay behind: made from versions it doesn't ship. */
  readonly leftBehind: readonly LeftBehindVersion[];
  /** `true`: a new deployment (`201`); `false`: the target had it (`200`). */
  readonly created: boolean;
  /** Each carried agent pinned live in the target, present only when `makeLive` was asked. */
  readonly live?: readonly DeploymentLivePin[];
}

/** The moves of `deployment` with the versions carried with it: each list as shipped, then carried. */
export function promotionMoves(
  deployment: Deployment,
  carried: readonly CarriedVersion[],
): PromotionMoves {
  const moved = (
    shipped: readonly DeployedPrimitive[],
    kind: CarriedVersion['kind'],
  ): MovedVersion[] => [
    ...shipped.map(({ id, version }) => ({ id, ...(version !== undefined && { version }) })),
    ...carried
      .filter((v) => v.kind === kind)
      .map(({ id, version }) => ({ id, version, carried: true as const })),
  ];
  return {
    ...(deployment.packId !== undefined && { packId: deployment.packId }),
    imageDigest: deployment.imageDigest,
    agents: moved(deployment.contents.agents, 'agent'),
    flows: moved(deployment.contents.flows, 'flow'),
    tools: deployment.contents.tools.map(({ id, version }) => ({
      id,
      ...(version !== undefined && { version }),
    })),
    guardrails: deployment.contents.guardrails.map(({ id }) => ({ id })),
  };
}

/** A promotion's answer: `201` with a new deployment, `200` with the one the target had. */
export function promotionAnswer(c: Context<AppEnv>, result: PromotionResult): Response {
  c.status(result.created ? 201 : 200);
  return c.json({
    deployment: serializeDeployment(result.deployment),
    created: result.created,
    moved: result.moved,
    ...(result.leftBehind.length > 0 && { leftBehind: result.leftBehind }),
    ...(result.live !== undefined && { live: result.live }),
  });
}

// ------------------------------------------------------------
// The routes
// ------------------------------------------------------------

const PROMOTION_PATH = /\/deployments\/[^/]+\/promotions(?:\/check)?\/?$/;

/**
 * Whether a request is one of the promotion routes, which check rights on
 * the projects themselves (read on the deployment's, admin on the
 * target), not the tenant's as the router's other routes do.
 */
export function isPromotionRoute(method: string, path: string): boolean {
  return method === 'POST' && PROMOTION_PATH.test(path);
}

/** Everything a promotion checked, for its write or its check's answer. */
interface PromotionPlan {
  readonly source: Deployment;
  readonly fromProjectId: ProjectId;
  readonly toProjectId: ProjectId;
  /** The target as a deployment is stored there: absent for the tenant's Default. */
  readonly storedProjectId: ProjectId | undefined;
  /** The target's place in the order, from 0. */
  readonly position: number;
  readonly carried: CarriedVersions;
  /** The values with a problem in the target. */
  readonly problems: readonly DeploymentValue[];
}

interface PromotionBody {
  readonly toProjectId: ProjectId;
  readonly reason?: string;
  /** Make every agent version the promotion carries live in the target project. */
  readonly makeLive?: boolean;
}

const MAX_REASON = 1000;

/** Mounts the two promotion routes on the deployments router. */
export function mountDeploymentPromotions(
  r: Hono<AppEnv>,
  bindings: DeploymentsRouterBindings,
  authorizer: Authorizer | undefined,
): void {
  r.post('/:deploymentId/promotions/check', async (c) => {
    const body = await promotionBody(c, false);
    if (body instanceof Response) return body;
    const plan = await planPromotion(c, bindings, authorizer, body.toProjectId, false);
    if (plan instanceof Response) return plan;
    return c.json({
      moves: promotionMoves(plan.source, plan.carried.carried),
      values: plan.problems,
      nextEnvironment: {
        projectId: plan.toProjectId as unknown as string,
        position: plan.position,
      },
      ...(bindings.envName !== undefined && { envName: bindings.envName }),
      ...(plan.carried.leftBehind.length > 0 && { leftBehind: plan.carried.leftBehind }),
    });
  });

  r.post('/:deploymentId/promotions', async (c) => {
    const body = await promotionBody(c, true);
    if (body instanceof Response) return body;
    const plan = await planPromotion(c, bindings, authorizer, body.toProjectId, true);
    if (plan instanceof Response) return plan;
    if (plan.problems.length > 0) {
      return refusal(c, 'promotion-values-not-ready', {
        message:
          "Values this build needs aren't ready in the target environment: set each one in `details.values` there, then promote again. Nothing was promoted.",
        values: plan.problems,
      });
    }
    const promote = bindings.deploymentRegistry.promote;
    if (promote === undefined) return unsupported(c);
    const tenantId = plan.source.tenantId;
    const outcome = await promote({
      tenantId,
      sourceDeploymentId: plan.source.deploymentId,
      ...(plan.storedProjectId !== undefined && { projectId: plan.storedProjectId }),
      carried: plan.carried.carried,
      toolSecretScopes: await targetSecretScopes(c, bindings, authorizer, plan),
    });
    if (outcome.kind === 'error') {
      // To the central error handler: a 500 with no raw text; the outcome's
      // code and message go to the log.
      throw new Error(`Promotion failed (${outcome.code}): ${outcome.message}`);
    }
    const result: PromotionResult = {
      deployment: outcome.deployment,
      moved: promotionMoves(plan.source, plan.carried.carried),
      leftBehind: plan.carried.leftBehind,
      created: outcome.kind === 'ok',
    };
    return finishPromotion(c, bindings, authorizer, plan, result, outcome.carried, body);
  });
}

/**
 * After the move commits: record it, and — when `makeLive` was asked — pin
 * every carried agent live in the target (`makeCarriedLive`), adding `live`
 * to the answer. Answers the promotion either way.
 */
async function finishPromotion(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  authorizer: Authorizer | undefined,
  plan: PromotionPlan,
  result: PromotionResult,
  carried: readonly CarriedVersion[],
  body: PromotionBody,
): Promise<Response> {
  if (result.created || carried.length > 0) {
    await auditPromotion(c, bindings, plan, result, carried, body.reason);
  }
  if (body.makeLive !== true) return promotionAnswer(c, result);
  const live = await makeCarriedLive(c, bindings, authorizer, plan, result, body.reason);
  return live instanceof Response ? live : promotionAnswer(c, { ...result, live });
}

/**
 * `promotion-gate-unsupported`, decidable before any pin: when this
 * deployment can't record a gated promotion, the first carried agent
 * whose scope a gate policy applies to is answered here, so nothing is
 * pinned. `undefined` when every carried agent can promote without one.
 */
async function gateUnsupportedBefore(
  c: Context<AppEnv>,
  agentReleases: NonNullable<DeploymentsRouterBindings['agentReleases']>,
  tenantId: TenantId,
  pinnable: readonly (MovedVersion & { version: string })[],
  scope: LiveScope,
): Promise<Response | undefined> {
  if (agentReleases.promotions.request !== undefined) return undefined;
  for (const agent of pinnable) {
    const policy = await policyFor(agentReleases, tenantId, agent.id, scope);
    if (policy !== null) return promotionResponse(c, { kind: 'gate-unsupported', policy });
  }
  return undefined;
}

/**
 * Authorize making every carried agent live in the target — a project scope
 * at `toProjectId`, `liveChangeRefusal`, the one the live routes use — before
 * any pin, so a refusal is the 403 answered with nothing pinned. The 403 to
 * answer, or `undefined` when every agent is cleared (or the authorizer is
 * off, as it is in a plain composition).
 */
async function authorizeCarried(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  rights: DeploymentsRouterBindings['itemRights'],
  pinnable: readonly (MovedVersion & { version: string })[],
  scope: LiveScope,
): Promise<Response | undefined> {
  if (authorizer === undefined) return undefined;
  for (const agent of pinnable) {
    const denied = await liveChangeRefusal(c, {
      authorizer,
      rights,
      agentId: agent.id,
      scope,
      setsLive: true,
    });
    if (denied !== undefined) return denied;
  }
  return undefined;
}

/**
 * Pin every carried agent version live in the target project, through the
 * same gate a live route does (`requestPromotion`). The promotion is
 * already committed, so this runs after it. Everything decidable before a
 * pin is decided for every agent first, so a refusal is answered with
 * nothing pinned: each agent is authorized — a project scope at the
 * target, `liveChangeRefusal`, the one the live routes use — and, when
 * this deployment can't record a gated promotion, any agent whose scope a
 * gate policy applies to answers `promotion-gate-unsupported` here (fix
 * the grant or the deployment and promote again: the move is idempotent,
 * and so is a pin in place). The width check in `liveChangeRefusal` never
 * fires here: the scope is one project. Then each version is requested
 * through its scope's gate: live now, waiting for an approval, or refused
 * by a check, each reported in `live`. (`requestPromotion`'s own
 * out-of-scope check — `reachable` for the agent by its id, not where its
 * versions run — passes here under a reach rule that reaches an item from
 * every project of its environment order: the target is the next
 * environment of the deployment's order. A reach rule that instead refused
 * a later carried agent is answered like a write error, with the pins so
 * far.) Returns the pins, or the response to answer instead (a 403, a gate
 * this deployment can't record, or a write error carrying the pins so far
 * in `error.details.live`).
 */
async function makeCarriedLive(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  authorizer: Authorizer | undefined,
  plan: PromotionPlan,
  result: PromotionResult,
  reason: string | undefined,
): Promise<readonly DeploymentLivePin[] | Response> {
  const { agentReleases, agentRegistry, releaseGateDeps } = bindings;
  if (agentReleases === undefined || agentRegistry === undefined || releaseGateDeps === undefined) {
    return unsupported(c);
  }
  const tenantId = plan.source.tenantId;
  const scope: LiveScope = { kind: 'project', projectId: plan.toProjectId };
  const pinnable = result.moved.agents.filter(
    (a): a is MovedVersion & { version: string } => a.version !== undefined,
  );
  const denied = await authorizeCarried(c, authorizer, bindings.itemRights, pinnable, scope);
  if (denied !== undefined) return denied;
  const gated = await gateUnsupportedBefore(c, agentReleases, tenantId, pinnable, scope);
  if (gated !== undefined) return gated;
  const live: DeploymentLivePin[] = [];
  for (const agent of pinnable) {
    const outcome = await requestPromotion(agentRegistry, agentReleases, releaseGateDeps, {
      tenantId,
      agentId: agent.id,
      version: agent.version as unknown as Semver,
      scope,
      requestedBy: actorOf(c),
      ...(reason !== undefined && { reason }),
    });
    // What the pre-checks leave is answered with the pins already made, so
    // the caller sees what went live.
    if (outcome.kind !== 'ok') {
      return promotionResponse(c, outcome, live.length > 0 ? { live } : {});
    }
    live.push(livePinOf(agent, outcome.promotion, outcome.checks));
  }
  return live;
}

/** A carried agent's `live` entry from its promotion: pinned unless a gate holds it, with the gate's say when it does or ran checks. */
function livePinOf(
  agent: MovedVersion & { version: string },
  promotion: Promotion,
  outcomeChecks: readonly GateCheck[] | undefined,
): DeploymentLivePin {
  const pinned = (promotion.status ?? 'promoted') === 'promoted';
  const checks = promotion.checks ?? outcomeChecks;
  const gate: DeploymentLivePinGate | undefined =
    !pinned || (checks !== undefined && checks.length > 0)
      ? {
          status: promotion.status ?? 'promoted',
          promotionId: promotion.id,
          ...(promotion.policy !== undefined && { policy: promotion.policy }),
          ...(promotion.approvalId !== undefined && { approvalId: promotion.approvalId }),
          ...(checks !== undefined && { checks }),
        }
      : undefined;
  return {
    id: agent.id,
    version: (promotion.toVersion as unknown as string | null) ?? agent.version,
    pinned,
    ...(gate !== undefined && { gate }),
  };
}

/** The body: `toProjectId`, and `reason` where the route takes one; anything else is refused. */
async function promotionBody(
  c: Context<AppEnv>,
  takesReason: boolean,
): Promise<PromotionBody | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return badInput(c, 'The body must be a JSON object.');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return badInput(c, 'The body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  const allowed = takesReason ? ['toProjectId', 'reason', 'makeLive'] : ['toProjectId'];
  const unknownKey = Object.keys(body).find((k) => !allowed.includes(k));
  if (unknownKey !== undefined) return badInput(c, `Unknown field \`${unknownKey}\`.`);
  const { toProjectId, reason, makeLive } = body;
  if (typeof toProjectId !== 'string' || toProjectId.length === 0) {
    return badInput(c, '`toProjectId` must name the project to promote the deployment to.');
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON)) {
    return badInput(c, `\`reason\` must be a string of at most ${MAX_REASON} characters.`);
  }
  if (makeLive !== undefined && typeof makeLive !== 'boolean') {
    return badInput(c, '`makeLive` must be `true` or `false`.');
  }
  return {
    toProjectId: toProjectId as ProjectId,
    ...(typeof reason === 'string' && { reason }),
    ...(typeof makeLive === 'boolean' && { makeLive }),
  };
}

/**
 * A key or session limited to a project never promotes, nor reads what a
 * promotion would: a promotion reads one project and writes another. The
 * key-project middleware doesn't see either (the body names
 * `toProjectId`), and without an authorizer nothing else would hold the
 * key, so it's refused here, whatever the authorizer.
 */
function limitedToProject(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  toProjectId: ProjectId,
  write: boolean,
): Response | undefined {
  const keyProject = c.get('tokenProjectId');
  if (keyProject === undefined) return undefined;
  return refused(c, authorizer, {
    action: write ? 'write' : 'read',
    resource: ref('project', toProjectId as string),
    message: `${limitedCaller(c)} is limited to project ${keyProject}; a promotion reads one project and writes another, so a caller limited to one project can't promote`,
    failing: 'scope',
    code: 'key-project-mismatch',
    details: { keyProjectId: keyProject, projectId: toProjectId },
  });
}

/**
 * Every check a promotion makes before it writes, in order (the module
 * comment); the first refusal, as the route answers it. `write`: for the
 * promotion itself, which a runtime that can't promote refuses once the
 * caller's rights are known.
 */
async function planPromotion(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  authorizer: Authorizer | undefined,
  toProjectId: ProjectId,
  write: boolean,
): Promise<PromotionPlan | Response> {
  const limited = limitedToProject(c, authorizer, toProjectId, write);
  if (limited !== undefined) return limited;
  const located = await sourceFor(c, bindings, authorizer);
  if (located instanceof Response) return located;
  const { source, fromProjectId } = located;
  const denied = await deniedBy(authorizer, c, 'admin', ref('project', toProjectId as string));
  if (denied !== undefined) return denied;
  if (write && bindings.deploymentRegistry.promote === undefined) return unsupported(c);
  const position = await nextPosition(c, bindings, authorizer, fromProjectId, toProjectId);
  if (position instanceof Response) return position;
  const stopped =
    (await targetSuspended(c, bindings, source.tenantId, toProjectId)) ??
    (await unserved(c, bindings, source, 'source', fromProjectId)) ??
    (await signerRefusal(c, bindings, source));
  if (stopped !== undefined) return stopped;
  const defaultId = (await bindings.projectBinding?.getDefault(source.tenantId))?.id;
  const storedProjectId = toProjectId === defaultId ? undefined : toProjectId;
  // The binding finds the Default's copy in either stored form, with no
  // project or with its id (`DeploymentGetByImageDigestInput.projectId`).
  const there = await bindings.deploymentRegistry.getByImageDigest({
    tenantId: source.tenantId,
    imageDigest: source.imageDigest,
    ...(storedProjectId !== undefined && { projectId: storedProjectId }),
  });
  if (there !== null) {
    const thereRefused = await unserved(c, bindings, there, 'target', toProjectId);
    if (thereRefused !== undefined) return thereRefused;
  }
  const carried = await carriedFor(bindings, source);
  const administers =
    authorizer === undefined
      ? undefined
      : (scope: Scope) => authorizer.can(c, 'admin', scopeResourceRef(scope, source.tenantId));
  const values = await deploymentValues(valuesDepsFor(bindings, administers), {
    deployment: source,
    carried: carried.carried,
    projectId: toProjectId,
  });
  return {
    source,
    fromProjectId,
    toProjectId,
    storedProjectId,
    position,
    carried,
    problems: values.filter((v) => v.problem !== undefined),
  };
}

/**
 * The deployment and the environment it serves, when the caller reads it.
 * One they don't read answers as a missing one does: `404`.
 */
async function sourceFor(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  authorizer: Authorizer | undefined,
): Promise<{ readonly source: Deployment; readonly fromProjectId: ProjectId } | Response> {
  const located = await readableDeployment(c, bindings, authorizer);
  if (located === undefined) {
    const deploymentId = c.req.param('deploymentId') ?? '';
    return refusal(c, 'deployment-not-found', {
      message: `Deployment "${deploymentId}" not found`,
      deploymentId,
    });
  }
  const { deployment: source, projectId: fromProjectId } = located;
  if (fromProjectId === undefined) {
    // No project binding to find the Default: no order places it.
    return notNext(c, undefined, undefined);
  }
  return { source, fromProjectId };
}

/** The target's place in the order when it's the source's next environment; else the refusal. */
async function nextPosition(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  authorizer: Authorizer | undefined,
  fromProjectId: ProjectId,
  toProjectId: ProjectId,
): Promise<number | Response> {
  const tenantId = c.get('tenantId') as TenantId;
  const order = await bindings.environmentOrders?.orderOf({ tenantId, projectId: fromProjectId });
  const position = order === undefined ? undefined : order.position + 1;
  const next = position === undefined ? undefined : order?.projects[position];
  if (position !== undefined && next !== undefined && next === toProjectId) return position;
  const named =
    next !== undefined &&
    (authorizer === undefined ||
      (await authorizer.can(c, 'read', ref('project', next as unknown as string))));
  return notNext(
    c,
    order === undefined ? undefined : { position: position ?? 0, last: next === undefined },
    named ? next : undefined,
  );
}

/** `409 promotion-not-next-environment`: the source is in no order, last in it, or another project is next. */
function notNext(
  c: Context<AppEnv>,
  order: { readonly position: number; readonly last: boolean } | undefined,
  nextProjectId: ProjectId | undefined,
): Response {
  const message =
    order === undefined
      ? "This deployment's environment is in no environment order, so it has no next environment to be promoted to. Nothing was promoted."
      : order.last
        ? 'This deployment is in the last environment of its order, so it has no next environment to be promoted to. Nothing was promoted.'
        : `A deployment is promoted only to the next environment of its order (position ${order.position}), one environment at a time, and the project named isn't it. Nothing was promoted.`;
  return refusal(c, 'promotion-not-next-environment', {
    message,
    ...(order !== undefined && !order.last && { position: order.position }),
    ...(nextProjectId !== undefined && { nextProjectId: nextProjectId as unknown as string }),
  });
}

/** `409 project-suspended` for a suspended target, as a deploy into it is refused. */
async function targetSuspended(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  tenantId: TenantId,
  toProjectId: ProjectId,
): Promise<Response | undefined> {
  if (bindings.projectSuspended === undefined) return undefined;
  if (!(await bindings.projectSuspended(tenantId, toProjectId))) return undefined;
  return suspendedRefusal(c, 'project-suspended', 'target');
}

/**
 * The refusal for a deployment that no longer serves its environment: the
 * source, or the copy the target has. Superseded: `409
 * deployment-superseded`, naming the newer deployment there that serves
 * its tool versions. Retired for a suspension: the suspension's own code.
 * One with no endpoint status (one pack service for every deployment)
 * serves.
 */
async function unserved(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  deployment: Deployment,
  environment: 'source' | 'target',
  projectId: ProjectId,
): Promise<Response | undefined> {
  const endpoint = deployment.endpoint;
  if (endpoint?.status !== 'cleared' || endpoint.waiting === true) return undefined;
  const retired = endpoint.retired;
  if (retired === undefined) return undefined;
  if (retired !== 'superseded') return suspendedRefusal(c, retired, environment);
  const newer = await newerServing(bindings, deployment, projectId);
  return refusal(c, 'deployment-superseded', {
    message:
      environment === 'source'
        ? 'This deployment is superseded: newer deployments in its environment serve every tool version it ships, so it no longer serves there. Promote the newer one instead. Nothing was promoted.'
        : 'The target environment has this build already, and it is superseded there: newer deployments serve every tool version it ships. Promote the newer build from the environment before it instead. Nothing was promoted.',
    environment,
    ...(newer !== undefined && { newerDeploymentId: newer }),
  });
}

/** The suspension's own code, for a promotion from or into what it suspends. */
function suspendedRefusal(
  c: Context<AppEnv>,
  reason: Exclude<SystemDeploymentRetireReason, 'superseded'>,
  environment: 'source' | 'target',
): Response {
  const side = environment === 'source' ? "the deployment's environment" : 'the target environment';
  const message = {
    'tenant-closing': 'The tenant is closing, so nothing is promoted. Nothing was promoted.',
    'tenant-suspended':
      "The tenant is suspended, so nothing is promoted until it's restored. Nothing was promoted.",
    'project-suspended': `${side[0]?.toUpperCase()}${side.slice(1)} is suspended, so nothing is promoted until it's restored. Nothing was promoted.`,
    'pack-suspended': `The pack is suspended in ${side}, so its builds aren't promoted until it's restored. Nothing was promoted.`,
  }[reason];
  return refusal(c, reason, { message, environment });
}

const PAGE = 100;

/**
 * The newest deployment in `projectId`, newer than `deployment`, of its
 * pack, that serves and ships every tool version it ships; `undefined`
 * when none does (the list is newest first, so it stops at `deployment`).
 */
async function newerServing(
  bindings: DeploymentsRouterBindings,
  deployment: Deployment,
  projectId: ProjectId,
): Promise<string | undefined> {
  const shipped = deployment.contents.tools.map((t) => `${t.id}@${t.version ?? ''}`);
  let cursor: Parameters<DeploymentsRouterBindings['deploymentRegistry']['list']>[0]['cursor'];
  for (;;) {
    const page = await bindings.deploymentRegistry.list({
      tenantId: deployment.tenantId,
      limit: PAGE,
      projectId,
      ...(deployment.packId !== undefined && { packId: deployment.packId }),
      ...(cursor !== undefined && { cursor }),
    });
    for (const d of page.data) {
      if (d.activatedAt <= deployment.activatedAt) return undefined;
      const serves = d.endpoint?.status !== 'cleared';
      const ships = new Set(d.contents.tools.map((t) => `${t.id}@${t.version ?? ''}`));
      if (serves && shipped.every((t) => ships.has(t))) return d.deploymentId;
    }
    if (page.nextCursor === undefined) return undefined;
    cursor = page.nextCursor;
  }
}

/**
 * A signer no longer trusted, or a signature that doesn't verify over the
 * fields the deployment keeps: the deploy's own codes. A build moves only
 * while its signature holds.
 */
async function signerRefusal(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  source: Deployment,
): Promise<Response | undefined> {
  const trusted = await bindings.signingKeyRegistry.isTrusted({
    tenantId: source.tenantId,
    keyId: source.signerKeyId,
    publicKey: source.signerPublicKey,
  });
  if (trusted.kind === 'err') {
    // To the central error handler: a 500 with no raw text; the trust-check
    // error is logged via the cause, which keeps its code.
    throw new Error('Trust check failed', { cause: trusted.error });
  }
  if (!trusted.value) {
    return refusal(c, 'signer-not-trusted', {
      message: `Signer key "${source.signerKeyId as unknown as string}" is no longer on this tenant's trust list, so the builds it signed aren't promoted. Nothing was promoted.`,
      signerKeyId: source.signerKeyId as unknown as string,
    });
  }
  const verified = verifyEd25519(
    new Uint8Array(Buffer.from(source.signerPublicKey, 'base64')),
    canonicalizeEnvelope({
      imageDigest: source.imageDigest,
      artifactVersion: source.artifactVersion,
      indexHash: source.indexHash,
      tenantId: source.tenantId as unknown as string,
      publishedAt: source.publishedAt,
    }),
    new Uint8Array(Buffer.from(source.signature, 'base64')),
  );
  if (verified.kind === 'ok' && verified.value) return undefined;
  return refusal(c, 'signature-invalid', {
    message:
      "The deployment's signature doesn't verify over the fields it keeps { imageDigest, artifactVersion, indexHash, tenantId, publishedAt }, so it isn't promoted. Nothing was promoted.",
  });
}

/**
 * Where each secret of each tool version the build ships is read in the
 * target, decided now as the promoter may read them: a deploy's own rule
 * (`secretScopesFor`), at the target project. One set nowhere yet is read
 * where the promoted deployment's secrets sync writes
 * (`deploymentSecretScope`): the target project, or the tenant for the
 * Default project, which stores no `projectId`.
 */
async function targetSecretScopes(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  authorizer: Authorizer | undefined,
  plan: PromotionPlan,
): Promise<PromotedToolSecretScopes[]> {
  const out: PromotedToolSecretScopes[] = [];
  const tenantId = plan.source.tenantId;
  for (const { id, version } of plan.source.contents.tools) {
    if (version === undefined || bindings.toolRegistry === undefined) continue;
    const tool = await bindings.toolRegistry.getVersion({
      tenantId,
      toolId: id as ToolId,
      version: version as Semver,
    });
    if (tool === null) continue;
    const secretScopes = await secretScopesFor(
      c,
      { secrets: bindings.secretsBinding, projects: bindings.projectBinding, authorizer },
      { kind: 'project', tenantId, projectId: plan.toProjectId },
      toolSecretRefs(tool, bindings.envName),
      deploymentSecretScope(tenantId, plan.storedProjectId),
    );
    if (secretScopes !== undefined) out.push({ toolId: id, version, secretScopes });
  }
  return out;
}

/**
 * The signed, exportable record of a promotion that wrote something: a
 * new deployment, or versions carried onto the one the target had.
 */
async function auditPromotion(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  plan: PromotionPlan,
  result: PromotionResult,
  carried: readonly CarriedVersion[],
  reason: string | undefined,
): Promise<void> {
  await emitAuditEvent({
    auditEvents: bindings.auditEvents,
    tenantId: plan.source.tenantId,
    projectId: plan.toProjectId,
    kind: 'deployment-promoted',
    actor: callerIdentity(c),
    outcome: 'succeeded',
    correlationId: c.get('requestId'),
    doc: {
      sourceDeploymentId: plan.source.deploymentId,
      deploymentId: result.deployment.deploymentId,
      fromProjectId: plan.fromProjectId as unknown as string,
      toProjectId: plan.toProjectId as unknown as string,
      imageDigest: plan.source.imageDigest,
      created: result.created,
      carried: carried.map(({ kind, id, version }) => ({ kind, id, version })),
      ...(reason !== undefined && { reason }),
    },
    log: c.get('log').child({ subsystem: 'audit' }),
  });
}

function unsupported(c: Context<AppEnv>): Response {
  return refusal(c, 'promotions-unsupported', {
    message: "This runtime can't promote deployments. Nothing was promoted.",
  });
}

function badInput(c: Context<AppEnv>, message: string): Response {
  return refusal(c, 'bad-input', { message });
}

/** An error answer with the code's own status. */
function refusal(
  c: Context<AppEnv>,
  code: string,
  err: { readonly message: string } & Readonly<Record<string, unknown>>,
): Response {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, ...err }, c.get('requestId')));
}
