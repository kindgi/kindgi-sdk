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
 *    (`409 promotion-values-not-ready`, each one in `details.values`);
 * 6. with `pin`, a newer version of one of its blocks than the build's
 *    runs in the target now (`409 deploy-would-put-back-older-blocks`,
 *    each one in `details.blocks`), unless `replace` names the block
 *    (`deploy-check.ts`).
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
import type {
  AgentId,
  AgentPinScope,
  PinScope,
  ProjectId,
  Semver,
  TenantId,
  ToolId,
} from '@kindgi/types';

import type { Pin, PinStatus } from '../agent-pin-binding.js';
import { callerIdentity } from '../caller.js';
import {
  type CarriedVersions,
  type LeftBehindVersion,
  carriedVersions,
} from '../carried-versions.js';
import {
  type ReplaceBlock,
  type ReplacedBlock,
  checkAgainstRuns,
  parseReplace,
} from '../deploy-check.js';
import {
  type CarriedVersion,
  type DeployedPrimitive,
  type Deployment,
  type DeploymentKeptBuilds,
  type DeploymentReplacedBlock,
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
import type { GateCheck } from '../gate.js';
import { agentPinChangeRefusal, pinChangeRefusal } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import { limitedCaller } from '../middleware/key-project.js';
import type { PinnedVersionBinding } from '../pinned-version-binding.js';
import type { ReleaseGateRef } from '../release-gate-binding.js';
import { deploymentSecretScope, secretScopesFor, toolSecretRefs } from '../secret-scope.js';
import type { AppEnv } from '../types.js';
import {
  type PinRequestOutcome,
  actorOf,
  pinResponse,
  releaseGateFor,
  requestPin,
} from './agent-pins.js';
import { deniedBy, refused } from './denied.js';
import { deployCheckDeps, olderBlocksRefusal } from './deploy-check-deps.js';
import { type DeploymentsRouterBindings, makeDeployCards } from './deployments.js';
import { pinWriteFailure } from './pinned-versions.js';
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
 * The kept builds of the projects the caller reads ({@link readRef}), as
 * one count, so a list that names no project counts no build of a project
 * they can't read, as its page lists none. Without an authorizer, all of
 * them.
 */
export async function readableKeptBuilds(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  kept: readonly DeploymentKeptBuilds[],
): Promise<number> {
  const tenantId = c.get('tenantId') as TenantId;
  const readable =
    authorizer === undefined
      ? kept
      : await authorizer.filterByCan(c, 'read', kept, ({ projectId }) =>
          readRef(tenantId, projectId),
        );
  return readable.reduce((sum, { builds }) => sum + builds, 0);
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

/** The gate's say on a carried version's pin: there when it isn't pinned yet (an approval or a failed check), or ran checks. */
export interface DeploymentPinGate {
  readonly status: PinStatus;
  readonly changeId: string;
  readonly releaseGate?: ReleaseGateRef | null;
  readonly approvalId?: string;
  readonly checks?: readonly GateCheck[];
}

/** A carried agent version the promotion pinned, or tried to, in the target project. */
export interface DeploymentPinnedAgent {
  readonly id: string;
  readonly version: string;
  /** Pinned now (`true`), or waiting on a gate — an approval, or a check it failed (`false`). */
  readonly pinned: boolean;
  readonly gate?: DeploymentPinGate;
}

/** A carried flow version the promotion pinned in the target project. */
export interface DeploymentPinnedFlow {
  readonly id: string;
  readonly version: string;
}

/**
 * What a promotion did. The handler builds it once and answers it through
 * `promotionAnswer`, so what's added after the write (pinning versions)
 * has one place to go.
 */
export interface PromotionResult {
  /** The target's deployment: a new one, or the one it had already. */
  readonly deployment: Deployment;
  readonly moved: PromotionMoves;
  /** Edits of the build's agents and flows that stay behind: made from versions it doesn't ship. */
  readonly leftBehind: readonly LeftBehindVersion[];
  /** `true`: a new deployment (`201`); `false`: the target had it (`200`). */
  readonly created: boolean;
  /** Each carried agent's pin in the target, done or held by its gate; present only when `pin` was asked. */
  readonly pinned?: readonly DeploymentPinnedAgent[];
  /**
   * Each carried flow version pinned in the target, present only when
   * `pin` was asked of a runtime that pins flows.
   */
  readonly pinnedFlows?: readonly DeploymentPinnedFlow[];
  /** The build's blocks against what runs in the target; present only when `pin` was asked of a runtime that checks them. */
  readonly blockCheck?: PromotionBlockCheck;
}

/**
 * A promotion that pins, checked against what runs in the target
 * (`checkPinnedBlocks`): the blocks it puts back on purpose, and the ones
 * `replace` names that nothing newer runs for. `checked: false` for a
 * build deployed before deployments kept their blocks: nothing was
 * compared.
 */
export interface PromotionBlockCheck {
  readonly checked: boolean;
  readonly replaced: readonly ReplacedBlock[];
  readonly notNeeded: readonly string[];
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
    ...(result.pinned !== undefined && { pinned: result.pinned }),
    ...(result.pinnedFlows !== undefined && { pinnedFlows: result.pinnedFlows }),
    ...(result.blockCheck !== undefined && {
      blockCheck: {
        checked: result.blockCheck.checked,
        replaced: result.blockCheck.replaced.map(({ blockId, from, to }) => ({
          blockId,
          from,
          to,
        })),
        notNeeded: result.blockCheck.notNeeded,
      },
    }),
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
  /** Pin every agent version the promotion carries in the target project, each through its scope's release gate, and every flow version it carries. */
  readonly pin?: boolean;
  /** With `pin`: the blocks it puts back on purpose, each with why (`deploy-check.ts`). */
  readonly replace?: readonly ReplaceBlock[];
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
    const blockCheck = await checkPinnedBlocks(c, bindings, authorizer, plan, body);
    if (blockCheck instanceof Response) return blockCheck;
    const promote = bindings.deploymentRegistry.promote;
    if (promote === undefined) return unsupported(c);
    const tenantId = plan.source.tenantId;
    const outcome = await promote({
      tenantId,
      sourceDeploymentId: plan.source.deploymentId,
      ...(plan.storedProjectId !== undefined && { projectId: plan.storedProjectId }),
      carried: plan.carried.carried,
      toolSecretScopes: await targetSecretScopes(c, bindings, authorizer, plan),
      ...replacedBy(c, blockCheck),
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
      ...(blockCheck !== undefined && { blockCheck }),
    };
    return finishPromotion(c, bindings, authorizer, plan, result, outcome.carried, body);
  });
}

/**
 * A promotion that pins puts each of the build's blocks at its version in
 * the target. When a newer one runs there now (added from a suggested
 * change, or pinned by a person), it stops before anything moves, unless
 * `replace` names the block (`deploy-check.ts`). Only the target's runs
 * count: it's the only project the pins change. The blocks are the
 * build's `contents.blocks`; a build deployed before deployments kept
 * them isn't compared, and the answer says so. `undefined` without `pin`,
 * and on a runtime that doesn't check blocks, as a deploy there isn't
 * checked.
 */
async function checkPinnedBlocks(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  authorizer: Authorizer | undefined,
  plan: PromotionPlan,
  { pin, replace }: PromotionBody,
): Promise<PromotionBlockCheck | Response | undefined> {
  if (pin !== true) return undefined;
  const { contents } = plan.source;
  if (contents.blocks === undefined) {
    if (bindings.agentPins === undefined || bindings.deployCheck === undefined) return undefined;
    return { checked: false, replaced: [], notNeeded: [] };
  }
  const check = await checkAgainstRuns(deployCheckDeps(c, bindings, authorizer), {
    tenantId: plan.source.tenantId,
    agents: contents.agents.map(({ id }) => id),
    blocks: contents.blocks.flatMap(({ id, version }) =>
      version !== undefined ? [{ id, version }] : [],
    ),
    ...(replace !== undefined && { replace }),
    inProject: plan.toProjectId,
  });
  if (check.kind === 'skipped') return undefined;
  if (check.stops.length > 0) return olderBlocksRefusal(c, check.stops, 'promotion');
  return { checked: true, replaced: check.replaced, notNeeded: check.notNeeded };
}

/**
 * After the move commits: record it, and — when `pin` was asked — pin
 * every carried agent and every carried flow in the target
 * (`pinCarried`), adding `pinned` and `pinnedFlows` to the answer, and
 * record each block the pins put back on purpose. Then the
 * suggested-change cards the moved agent versions make in the target
 * (`makeDeployCards`): none where a pin was just made for them. Answers
 * the promotion either way.
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
  const moved = result.created || carried.length > 0;
  if (moved) await auditPromotion(c, bindings, plan, result, carried, body.reason);
  const made =
    body.pin === true ? await pinCarried(c, bindings, authorizer, plan, result, body.reason) : {};
  if (made instanceof Response) return made;
  for (const block of result.blockCheck?.replaced ?? []) {
    await auditReplacedBlock(c, bindings, plan, result, block);
  }
  if (moved) {
    await makeDeployCards(c, bindings, {
      tenantId: plan.source.tenantId,
      projectId: plan.toProjectId,
      deploymentId: result.deployment.deploymentId,
      imageDigest: plan.source.imageDigest,
      by: actorOf(c),
      agents: result.moved.agents
        .filter(versioned)
        .map((a) => ({ agentId: a.id as AgentId, version: a.version as Semver })),
    });
  }
  return promotionAnswer(c, { ...result, ...made });
}

/** A moved agent or flow with its version: the ones `pin` pins. */
const versioned = (v: MovedVersion): v is MovedVersion & { version: string } =>
  v.version !== undefined;

/**
 * Authorize pinning every carried flow in the target — a project scope at
 * `toProjectId`, `pinChangeRefusal`, the one the pin routes use — before
 * any pin, as `authorizeCarried` does for the agents. `undefined` when
 * every flow is cleared, there are none to pin, or the authorizer is off.
 */
async function authorizeCarriedFlows(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  rights: DeploymentsRouterBindings['itemRights'],
  flows: readonly (MovedVersion & { version: string })[],
  scope: PinScope,
): Promise<Response | undefined> {
  if (authorizer === undefined) return undefined;
  for (const flow of flows) {
    const denied = await pinChangeRefusal(c, {
      authorizer,
      rights,
      kind: 'flow',
      itemId: flow.id,
      scope,
    });
    if (denied !== undefined) return denied;
  }
  return undefined;
}

/**
 * Pin every carried flow version in the target project, after the agents,
 * so a run there that names no version takes it, as it would with no pin.
 * Rights were decided for every flow before any pin
 * (`authorizeCarriedFlows`). A write the binding refuses is answered with
 * the pins so far: the agents' in `error.details.pinned`, the flows' in
 * `error.details.pinnedFlows`.
 */
async function pinCarriedFlows(
  c: Context<AppEnv>,
  binding: PinnedVersionBinding,
  tenantId: TenantId,
  flows: readonly (MovedVersion & { version: string })[],
  scope: PinScope,
  reason: string | undefined,
  pinned: readonly DeploymentPinnedAgent[],
): Promise<readonly DeploymentPinnedFlow[] | Response> {
  const pinnedFlows: DeploymentPinnedFlow[] = [];
  for (const flow of flows) {
    const version = flow.version as unknown as Semver;
    const outcome = await binding.pin({
      tenantId,
      kind: 'flow',
      itemId: flow.id,
      scope,
      version,
      requestedBy: actorOf(c),
      ...(reason !== undefined && { reason }),
    });
    if (outcome.kind === 'err') {
      return pinWriteFailure(c, c.get('requestId'), 'flow', flow.id, outcome.error, version, {
        ...(pinned.length > 0 && { pinned }),
        ...(pinnedFlows.length > 0 && { pinnedFlows }),
      });
    }
    pinnedFlows.push({ id: flow.id, version: flow.version });
  }
  return pinnedFlows;
}

/**
 * `pin-gate-unsupported`, decidable before any pin: when this
 * deployment can't record a gated promotion, the first carried agent
 * whose scope a release gate applies to is answered here, so nothing is
 * pinned. `undefined` when every carried agent can promote without one.
 */
async function gateUnsupportedBefore(
  c: Context<AppEnv>,
  agentPins: NonNullable<DeploymentsRouterBindings['agentPins']>,
  tenantId: TenantId,
  pinnable: readonly (MovedVersion & { version: string })[],
  scope: AgentPinScope,
): Promise<Response | undefined> {
  if (agentPins.changes.request !== undefined) return undefined;
  for (const agent of pinnable) {
    const releaseGate = await releaseGateFor(agentPins, tenantId, agent.id, scope);
    if (releaseGate !== null) return pinResponse(c, { kind: 'gate-unsupported', releaseGate });
  }
  return undefined;
}

/**
 * Authorize pinning every carried agent in the target — a project scope at
 * `toProjectId`, `agentPinChangeRefusal`, the one the pin routes use — before
 * any pin, so a refusal is the 403 answered with nothing pinned. The 403 to
 * answer, or `undefined` when every agent is cleared (or the authorizer is
 * off, as it is in a plain composition).
 */
async function authorizeCarried(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  rights: DeploymentsRouterBindings['itemRights'],
  pinnable: readonly (MovedVersion & { version: string })[],
  scope: AgentPinScope,
): Promise<Response | undefined> {
  if (authorizer === undefined) return undefined;
  for (const agent of pinnable) {
    const denied = await agentPinChangeRefusal(c, {
      authorizer,
      rights,
      agentId: agent.id,
      scope,
      setsPin: true,
    });
    if (denied !== undefined) return denied;
  }
  return undefined;
}

/**
 * Pin every carried agent version in the target project, through the
 * same gate a pin route does (`requestPin`). The promotion is
 * already committed, so this runs after it. Everything decidable before a
 * pin is decided for every agent first, so a refusal is answered with
 * nothing pinned: each agent is authorized — a project scope at the
 * target, `agentPinChangeRefusal`, the one the pin routes use — and, when
 * this deployment can't record a gated promotion, any agent whose scope a
 * release gate applies to answers `pin-gate-unsupported` here (fix
 * the grant or the deployment and promote again: the move is idempotent,
 * and so is a pin in place). The width check in `agentPinChangeRefusal` never
 * fires here: the scope is one project. Then each version is requested
 * through its scope's gate: pinned now, waiting for an approval, or refused
 * by a check, each reported in `pinned`. (`requestPin`'s own
 * out-of-scope check — `reachable` for the agent by its id, not where its
 * versions run — passes here under a reach rule that reaches an item from
 * every project of its environment order: the target is the next
 * environment of the deployment's order. A reach rule that instead refused
 * a later carried agent is answered like a write error, with the pins so
 * far.) With a pin binding, every carried flow version is pinned in the
 * target after the agents (`pinCarriedFlows`), its rights decided with the
 * agents' before any pin; without one, nothing pins a flow, so the shipped
 * version is the one in use there already. Returns the pins, or the
 * response to answer instead (a 403, a gate this deployment can't record,
 * or a write error carrying the pins so far in `error.details.pinned` and
 * `error.details.pinnedFlows`).
 */
async function pinCarried(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  authorizer: Authorizer | undefined,
  plan: PromotionPlan,
  result: PromotionResult,
  reason: string | undefined,
): Promise<Pick<PromotionResult, 'pinned' | 'pinnedFlows'> | Response> {
  const { agentPins, agentRegistry, agentPinGateDeps, pinnedVersions } = bindings;
  if (agentPins === undefined || agentRegistry === undefined || agentPinGateDeps === undefined) {
    // The move has committed: say so, not "nothing was promoted".
    return refusal(c, 'promotions-unsupported', {
      message:
        "The build moved, but this runtime can't pin versions, so nothing was pinned in the target. Promote without `pin` here; the move is already done.",
    });
  }
  const tenantId = plan.source.tenantId;
  const scope: AgentPinScope = { kind: 'project', projectId: plan.toProjectId };
  const pinScope: PinScope = { kind: 'project', projectId: plan.toProjectId };
  const pinnable = result.moved.agents.filter(versioned);
  const flows = pinnedVersions === undefined ? [] : result.moved.flows.filter(versioned);
  const denied =
    (await authorizeCarried(c, authorizer, bindings.itemRights, pinnable, scope)) ??
    (await authorizeCarriedFlows(c, authorizer, bindings.itemRights, flows, pinScope));
  if (denied !== undefined) return denied;
  const gated = await gateUnsupportedBefore(c, agentPins, tenantId, pinnable, scope);
  if (gated !== undefined) return gated;
  const pinned: DeploymentPinnedAgent[] = [];
  for (const agent of pinnable) {
    const outcome = await requestPin(
      agentRegistry,
      agentPins,
      agentPinGateDeps,
      {
        tenantId,
        agentId: agent.id,
        version: agent.version as unknown as Semver,
        scope,
        requestedBy: actorOf(c),
        ...(reason !== undefined && { reason }),
      },
      // `--pin` is the ask: a project on Latest in the target goes off it
      // with no 409, and the pin records that it did.
      { log: c.get('log'), stopFollowingLatest: true },
    );
    // What the pre-checks leave is answered with the pins already made, so
    // the caller sees what was pinned.
    if (outcome.kind !== 'ok') {
      return pinResponse(c, carriedRefusal(outcome, agent), pinned.length > 0 ? { pinned } : {});
    }
    pinned.push(pinnedAgentOf(agent, outcome.pin, outcome.checks));
  }
  if (pinnedVersions === undefined) return { pinned };
  const pinnedFlows = await pinCarriedFlows(
    c,
    pinnedVersions,
    tenantId,
    flows,
    pinScope,
    reason,
    pinned,
  );
  return pinnedFlows instanceof Response ? pinnedFlows : { pinned, pinnedFlows };
}

/**
 * A carried agent's pin refused because no version of it runs in the
 * target yet (its first promotion there, carrying only a version made for
 * a project, which isn't Latest by being carried): said for this move,
 * which has committed. Any other refusal as the gate gave it.
 */
function carriedRefusal(
  outcome: Exclude<PinRequestOutcome, { kind: 'ok' }>,
  agent: MovedVersion & { version: string },
): Exclude<PinRequestOutcome, { kind: 'ok' }> {
  if (outcome.kind !== 'err' || outcome.error.code !== 'nothing-runs-in-scope') return outcome;
  return {
    ...outcome,
    error: {
      ...outcome.error,
      message: `The build moved, but agent "${agent.id}" ${agent.version} wasn't pinned: no version of it runs in the target project yet (no pin, and no Latest; a version made for a project isn't Latest by being carried). Promote a build that ships a version of it, then pin it. If this version came from a suggested change, and the project it was made in runs Latest, add it as Latest there from that change, then promote this build again: a promotion counts a carried version only when it was already Latest where it was made.`,
    },
  };
}

/** A carried agent's `pinned` entry from its pin change: pinned unless a gate holds it, with the gate's say when it does or ran checks. */
function pinnedAgentOf(
  agent: MovedVersion & { version: string },
  pin: Pin,
  outcomeChecks: readonly GateCheck[] | undefined,
): DeploymentPinnedAgent {
  const pinned = (pin.status ?? 'pinned') === 'pinned';
  const checks = pin.checks ?? outcomeChecks;
  const gate: DeploymentPinGate | undefined =
    !pinned || (checks !== undefined && checks.length > 0)
      ? {
          status: pin.status ?? 'pinned',
          changeId: pin.id,
          ...(pin.releaseGate !== undefined && { releaseGate: pin.releaseGate }),
          ...(pin.approvalId !== undefined && { approvalId: pin.approvalId }),
          ...(checks !== undefined && { checks }),
        }
      : undefined;
  return {
    id: agent.id,
    version: (pin.toVersion as unknown as string | null) ?? agent.version,
    pinned,
    ...(gate !== undefined && { gate }),
  };
}

/** The body: `toProjectId`, and `reason`, `pin` and `replace` where the route takes them; anything else is refused. */
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
  const allowed = takesReason ? ['toProjectId', 'reason', 'pin', 'replace'] : ['toProjectId'];
  const unknownKey = Object.keys(body).find((k) => !allowed.includes(k));
  if (unknownKey !== undefined) return badInput(c, `Unknown field \`${unknownKey}\`.`);
  const { toProjectId, reason, pin } = body;
  if (typeof toProjectId !== 'string' || toProjectId.length === 0) {
    return badInput(c, '`toProjectId` must name the project to promote the deployment to.');
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON)) {
    return badInput(c, `\`reason\` must be a string of at most ${MAX_REASON} characters.`);
  }
  if (pin !== undefined && typeof pin !== 'boolean') {
    return badInput(c, '`pin` must be `true` or `false`.');
  }
  const replace = promotionReplace(c, body.replace, pin);
  if (replace instanceof Response) return replace;
  return {
    toProjectId: toProjectId as ProjectId,
    ...(typeof reason === 'string' && { reason }),
    ...(typeof pin === 'boolean' && { pin }),
    ...replace,
  };
}

/** The body's `replace` (`parseReplace`), which goes only with `pin`; `{}` without it. */
function promotionReplace(
  c: Context<AppEnv>,
  raw: unknown,
  pin: unknown,
): { readonly replace?: readonly ReplaceBlock[] } | Response {
  const issues: { path: string; message: string }[] = [];
  const replace = parseReplace(raw, issues);
  if (issues.length > 0) return badInput(c, `${issues.map((i) => i.message).join('; ')}.`);
  if (replace === undefined) return {};
  if (pin !== true) {
    return badInput(
      c,
      '`replace` goes with `pin`: only the pins put a block back to an older version.',
    );
  }
  return { replace };
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

/**
 * The target's new deployment's `replaced`: each block the promotion's pins
 * put back on purpose, by who promoted. From its own check against the
 * target, never the source's.
 */
function replacedBy(
  c: Context<AppEnv>,
  blockCheck: PromotionBlockCheck | undefined,
): { replaced?: DeploymentReplacedBlock[] } {
  const replaced = blockCheck?.replaced ?? [];
  if (replaced.length === 0) return {};
  const by = actorOf(c);
  return { replaced: replaced.map((block) => ({ ...block, by })) };
}

/** One `deployment-replaced-block` event: a block the promotion's pins put back on purpose. */
async function auditReplacedBlock(
  c: Context<AppEnv>,
  bindings: DeploymentsRouterBindings,
  plan: PromotionPlan,
  result: PromotionResult,
  block: ReplacedBlock,
): Promise<void> {
  await emitAuditEvent({
    auditEvents: bindings.auditEvents,
    tenantId: plan.source.tenantId,
    projectId: plan.toProjectId,
    kind: 'deployment-replaced-block',
    actor: callerIdentity(c),
    outcome: 'succeeded',
    correlationId: c.get('requestId'),
    doc: {
      deploymentId: result.deployment.deploymentId,
      blockId: block.blockId,
      from: block.from,
      to: block.to,
      reason: block.reason,
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
