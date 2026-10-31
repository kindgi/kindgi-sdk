// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { type AgentId, modelNamedTwice, modelSettingsIssues } from '@kindgi/agents';
import {
  type AuthzCheckBinding,
  REVIEWER_ROLE_RANK,
  type ResourceRef,
  type ReviewerRole,
  tuplesForCreate,
  userPrincipal,
} from '@kindgi/authz';
import type { Logger } from '@kindgi/log';
import type { ProjectBinding } from '@kindgi/platform';
import { canonicalize } from '@kindgi/schema';
import type {
  AgentPinScope,
  Cursor,
  ProjectId,
  RunId,
  Semver,
  SuggestedChangeId,
  TenantId,
  Timestamp,
  UserId,
} from '@kindgi/types';

import type { AgentRegistryBinding, AgentVersionRecord } from './agent-binding.js';
import type { AgentPinBindings, AgentPinnedVersion, Pin, PinActor } from './agent-pin-binding.js';
import { approvalResourceRef, projectOfScope } from './approval-resource.js';
import type { BlockRecord, BlockRegistryBinding } from './block-binding.js';
import { type BlockEdit, blockEditDefinition, publishBlockEdit } from './block-publish.js';
import { sameUserId } from './caller.js';
import { deriveAgentVersion } from './derive-agent-version.js';
import {
  type LaterEnvironment,
  environmentTakesPromotionsMessage,
  laterEnvironment,
} from './environment-entry.js';
import type { EnvironmentOrderBinding } from './environment-orders-binding.js';
import { rescoreRefusal, rescoreStart } from './eval-rescore.js';
import type { GateApproval } from './gate.js';
import {
  type ReferenceScopeBinding,
  agentPinScopeOutOfScope,
  referencesOutOfScope,
} from './reference-scope.js';
import { refusesCandidates, refusesScope } from './registry-read-only.js';
import type { ReviewerRegistryBinding } from './reviewer-binding.js';
import { agentPinScopeToWire } from './routes/agent-pin-scope-wire.js';
import {
  type AgentPinGateDeps,
  type PinRequestOutcome,
  pinStopsLatest,
  requestPin,
} from './routes/agent-pins.js';
import {
  SUGGESTED_CHANGE_ACTIONS,
  type SuggestedChangeAction,
  type SuggestedChangeEvaluationOutcome,
  type SuggestedChangeNote,
  type SuggestedChangeStatus,
  blockChangeOf,
  evaluationOutcome,
  suggestedChangeActionAllowed,
  suggestedChangeMaker,
  suggestedChangeNote,
  suggestedChangeStatus,
} from './suggested-change-status.js';
import type {
  CodeChange,
  CreateSuggestedChangeOutcome,
  ProposedChange,
  StoredSuggestedChange,
  SuggestedChangeDrafter,
  SuggestedChangeEvaluationRef,
  SuggestedChangeEvidence,
  SuggestedChangeMaker,
  SuggestedChangeObjective,
  SuggestedChangeRule,
  SuggestedChangeStep,
  SuggestedChangeTier,
  SupervisorBinding,
} from './supervisor-binding.js';
import type {
  TestRun,
  TestRunBinding,
  TestRunComparison,
  TestRunStartOutcome,
} from './test-run-binding.js';
import type { FrozenTestSet, TestSetFreezeBinding } from './test-set-binding.js';
import { type WhatRuns, projectsPinTakesOffLatest, whatRuns } from './what-runs.js';

/**
 * The suggested-change lifecycle, from the bindings it runs on: what
 * `/v1/suggested-changes` serves, and what a runtime's Improve run drafts
 * and evaluates its suggested change with. No authorization here: the route
 * checks the caller; an Improve run acts as the runtime. Each call answers an
 * outcome; an error carries the wire code the route answers with.
 */
export interface SuggestedChangeServiceDeps {
  readonly store: Pick<
    SupervisorBinding,
    | 'listSuggestedChanges'
    | 'getSuggestedChange'
    | 'createSuggestedChange'
    | 'recordSuggestedChange'
  >;
  readonly agents: AgentRegistryBinding;
  readonly blocks: BlockRegistryBinding;
  readonly testRuns: TestRunBinding;
  readonly agentPins: AgentPinBindings;
  readonly projects?: ProjectBinding;
  /** What the agent's project may reach (`reference-scope.ts`); absent → as named. */
  readonly referenceScope?: ReferenceScopeBinding;
  /** Whether a project is suspended, for a pin's gate (`AgentPinGateDeps`). Absent: no check. */
  readonly projectSuspended?: AgentPinGateDeps['projectSuspended'];
  /**
   * The tenant's environment orders: a candidate (its block version and
   * agent version) is made in the first environment of the agent's
   * project's order, whichever environment's runs the suggested change learned
   * from, and reaches the later ones only with a promoted build. Absent:
   * in the agent's project.
   */
  readonly orders?: Pick<EnvironmentOrderBinding, 'orderOf'>;
  /**
   * The tenant's reviewer roster, to decide whether a drafter's pin
   * needs a separate approver. Absent: a drafter's pin keeps
   * the legacy rule — any reviewer, the requester included, may approve.
   */
  readonly reviewers?: Pick<ReviewerRegistryBinding, 'list'>;
  /**
   * The PDP, to count only reviewers who could actually decide a drafter's
   * pin: one who can't read its resource is 404'd by the decide route
   * (routes/approvals.ts `mayRead`), so they can't separate it. Absent
   * (no authorizer): every roster reviewer may read, as `mayRead` allows.
   */
  readonly authz?: AuthzCheckBinding;
  /**
   * The project's test set, frozen for a check: a suggested change is
   * checked on it, its project's version against its own. Absent: a
   * suggested change can't be made or checked (`create`, `check`).
   */
  readonly testSets?: TestSetFreezeBinding;
  /**
   * What a pin's test runs need besides the test sets (`AgentPinGateDeps`):
   * the corrections the card's reused check changes, and the projects an
   * agent runs in. Absent `corrections`: a pin starts no test run.
   */
  readonly corrections?: AgentPinGateDeps['corrections'];
  readonly itemProjects?: AgentPinGateDeps['itemProjects'];
}

/** An error with the code the API answers it with (`statusFor`), and its details. */
export type SuggestedChangeServiceError = {
  readonly code: string;
  readonly message: string;
} & Readonly<Record<string, unknown>>;

export type SuggestedChangeOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly error: SuggestedChangeServiceError };

/** What a suggested change's ids resolve to now, and the status that follows. */
export interface SuggestedChangeFacts {
  readonly status: SuggestedChangeStatus;
  readonly evaluation?: SuggestedChangeEvaluationOutcome | null;
  readonly pin?: Pin | null;
  /** For a pinned suggested change: whether its version still serves the scope. */
  readonly pinnedNow?: boolean;
  /** For a `ready` one asked to be pinned: why its pin didn't go through. */
  readonly note?: SuggestedChangeNote;
}

export interface DraftSuggestedChangeInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly fromVersion: string;
  readonly scope: AgentPinScope;
  readonly tier: SuggestedChangeTier;
  readonly blockId: string;
  readonly content: ProposedChange['change']['content'];
  readonly why: string;
  readonly evidence?: SuggestedChangeEvidence;
  readonly drafter: SuggestedChangeDrafter;
  /** Who or what made it. Absent: read from `drafter` (`suggestedChangeMaker`). */
  readonly madeBy?: SuggestedChangeMaker;
}

/** Who makes a suggested change through `create`: a person, a service account, or a deploy. */
export type SuggestedChangeCreator = Extract<
  SuggestedChangeMaker,
  { readonly kind: 'person' | 'service' | 'deploy' }
>;

/** A suggested change for one project: one block changed in what the project runs. */
/** A deploy's agent versions, for the cards it makes in the project they reached (`fromDeploy`). */
export interface DeployCardsInput {
  readonly tenantId: TenantId;
  /** The project the versions reached: the deploy's own, or the one it's promoted into. */
  readonly projectId: ProjectId;
  readonly deploymentId: string;
  /** The deploy's image, when it named one by digest. */
  readonly imageDigest?: string;
  /** Who deployed or promoted it. */
  readonly by: PinActor;
  /** Each agent version the deploy registered. */
  readonly agents: readonly { readonly agentId: AgentId; readonly version: Semver }[];
}

/** The cards a deploy made, and the agents whose card couldn't be made, with why. */
export interface DeployCardsOutcome {
  readonly made: readonly StoredSuggestedChange[];
  readonly failed: readonly { readonly agentId: string; readonly message: string }[];
}

/** A deploy card's why: it has no author's. */
const DEPLOY_WHY = 'New code from a deploy';

/** How many of an agent's newest finished runs a deploy card's check looks through for the version it's built on. */
const NEWEST_RUNS = 100;

export interface NewSuggestedChangeInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly projectId: ProjectId;
  readonly blockId: string;
  /** New values for a settings block, or a new template for a prompt block. */
  readonly content: ProposedChange['change']['content'];
  readonly why: string;
  /** The corrections it fixes, by id. */
  readonly fixes?: readonly string[];
  readonly madeBy: SuggestedChangeCreator;
  /** Who it's done for: the publisher its block and agent versions record. */
  readonly actor: PinActor;
}

export interface CheckSuggestedChangeInput {
  readonly tenantId: TenantId;
  readonly suggestedChange: StoredSuggestedChange;
  /** Who it's done for: the publisher its versions record, when it has none yet. */
  readonly actor: PinActor;
}

export interface EvaluateSuggestedChangeInput {
  readonly tenantId: TenantId;
  readonly suggestedChange: StoredSuggestedChange;
  readonly testSetId: string;
  readonly objective: SuggestedChangeObjective;
  readonly comparison?: TestRunComparison;
  /**
   * The current version replayed on the same cases (an Improve run's
   * model-settings change): no correction it passes may fail on the
   * candidate, and under `rule: 'cheaper'` the candidate is kept for
   * being no worse and costing less. Absent: beat the recorded outputs.
   */
  readonly against?: {
    readonly rule: SuggestedChangeRule;
    readonly reference: { readonly testRunId: string };
  };
  /** Who it's done for: what the derived version records as `by`. */
  readonly actor: PinActor;
}

export interface RescoreSuggestedChangeInput {
  readonly tenantId: TenantId;
  readonly suggestedChange: StoredSuggestedChange;
}

/**
 * What a pin that a drafter (not a person) asks for needs even when
 * the scope's release gate asks for none: a reviewer (K2). Any reviewer may
 * approve: the drafter, not a person, requested it.
 */
export const DRAFTED_SUGGESTED_CHANGE_APPROVAL: GateApproval = {
  role: 'standard',
  count: 1,
  separateApprover: false,
};

/**
 * Whether the tenant has a reviewer who could actually approve a drafter's
 * pin other than whoever requested it — the test the `separateApprover`
 * flag enforces (the decide call blocks an `approve` by the requester
 * themselves, `user:<id>` against `user:<id>`). A reviewer counts when all of
 * these hold: active (not deactivated); ranked at or above the rule's role;
 * not the requester; and, with an authorizer wired, able to read the
 * approval's `resource` — the decide route 404s a reviewer who can't
 * (routes/approvals.ts `mayRead`), so a count that ignored it could leave the
 * pin stuck. A service requester (an Improve run) is no
 * `user:<id>`, so every eligible reviewer counts; a human requester who is the
 * only one who counts counts as none, so they may approve their own request
 * rather than being deadlocked.
 *
 * The rank filter is future-proofing: `DRAFTED_SUGGESTED_CHANGE_APPROVAL.role` is
 * `standard`, the lowest rank, so it never excludes anyone today.
 */
async function hasOtherEligibleReviewer(
  reviewers: Pick<ReviewerRegistryBinding, 'list'>,
  tenantId: TenantId,
  requiredRole: ReviewerRole,
  requesterUserId: UserId | undefined,
  resource: ResourceRef,
  authz: AuthzCheckBinding | undefined,
): Promise<boolean> {
  const required = REVIEWER_ROLE_RANK[requiredRole];
  let cursor: Cursor | undefined;
  // The roster is small (dozens at most), so a page or two answers it; the
  // cap bounds a pathologically large one, which surely has a second person.
  for (let page = 0; page < 50; page += 1) {
    const { data, nextCursor } = await reviewers.list({
      tenantId,
      limit: 100,
      ...(cursor !== undefined && { cursor }),
    });
    for (const reviewer of data) {
      if (reviewer.deactivatedAt !== undefined) continue;
      if (REVIEWER_ROLE_RANK[reviewer.role] < required) continue;
      if (requesterUserId !== undefined && sameUserId(reviewer.userId, requesterUserId)) continue;
      if (
        authz !== undefined &&
        !(await authz.check(userPrincipal(reviewer.userId, tenantId), 'read', resource)).allowed
      ) {
        continue;
      }
      return true;
    }
    if (nextCursor === undefined) return false;
    cursor = nextCursor;
  }
  return true;
}

export function createSuggestedChangeService(deps: SuggestedChangeServiceDeps) {
  const err = (error: SuggestedChangeServiceError) => ({ kind: 'err' as const, error });

  /**
   * The approval a drafter's pin needs (K2), with `separateApprover`
   * decided from the tenant roster. No reviewer registry wired keeps the
   * legacy rule (any reviewer, the requester included, may approve).
   *
   * Returns both the approval (its `separateApprover` settled at the drafter's
   * own `standard` rank, which is what a pin with no release gate waits
   * for) and `eligibleAtRole`, the same roster test at an arbitrary role: a
   * release gate that sets `separateApprover: false` asks it again at the
   * gate's (higher) role, so a lower-ranked reviewer doesn't deadlock a
   * requester the gate would let decide alone.
   */
  async function draftedApproval(
    tenantId: TenantId,
    actor: PinActor,
    suggestedChange: StoredSuggestedChange,
  ): Promise<{
    readonly approval: GateApproval;
    readonly eligibleAtRole: (role: ReviewerRole) => Promise<boolean>;
  }> {
    if (deps.reviewers === undefined) {
      return {
        approval: DRAFTED_SUGGESTED_CHANGE_APPROVAL,
        eligibleAtRole: () => Promise.resolve(false),
      };
    }
    const reviewers = deps.reviewers;
    const requesterUserId = actor.kind === 'user' ? (actor.id as UserId) : undefined;
    const resource = await approvalResourceRef(tenantId, {
      projectId: projectOfScope(suggestedChange.scope),
    });
    const eligibleAtRole = (role: ReviewerRole): Promise<boolean> =>
      hasOtherEligibleReviewer(reviewers, tenantId, role, requesterUserId, resource, deps.authz);
    const second = await eligibleAtRole(DRAFTED_SUGGESTED_CHANGE_APPROVAL.role);
    return {
      approval: { ...DRAFTED_SUGGESTED_CHANGE_APPROVAL, separateApprover: second },
      eligibleAtRole,
    };
  }

  /** A reader of suggested change facts for one call: each agent's pins are read once. */
  function facts(tenantId: TenantId): (p: StoredSuggestedChange) => Promise<SuggestedChangeFacts> {
    const pins = new Map<string, Promise<readonly AgentPinnedVersion[]>>();
    const pinsOf = (agentId: string): Promise<readonly AgentPinnedVersion[]> => {
      const known = pins.get(agentId);
      if (known !== undefined) return known;
      const found = deps.agentPins.pinned.list({ tenantId, agentId });
      pins.set(agentId, found);
      return found;
    };
    return async (p) => {
      const change =
        p.pinChangeId === undefined
          ? undefined
          : await deps.agentPins.changes.get(tenantId, p.pinChangeId);
      let evaluation: SuggestedChangeEvaluationOutcome | null | undefined;
      if (p.evaluation !== undefined) evaluation = await evaluationOf(tenantId, p.evaluation);
      const status = suggestedChangeStatus(p, change, evaluation);
      let pinnedNow: boolean | undefined;
      if (status === 'pinned' && change !== undefined && change !== null) {
        const all = await pinsOf(p.agentId as unknown as string);
        pinnedNow = all.some((pin) => pin.changeId === change.id);
      }
      const note = noteOf(status, change, p);
      return {
        status,
        ...(evaluation !== undefined && { evaluation }),
        ...(change !== undefined && { pin: change }),
        ...(pinnedNow !== undefined && { pinnedNow }),
        ...(note !== undefined && { note }),
      };
    };
  }

  /**
   * A suggested change's evaluation, read off its test run (and its reference's,
   * when it has one); `null` when either can't be read.
   */
  async function evaluationOf(
    tenantId: TenantId,
    stored: SuggestedChangeEvaluationRef,
  ): Promise<SuggestedChangeEvaluationOutcome | null> {
    const run = await deps.testRuns.get({ tenantId, testRunId: stored.testRunId as RunId });
    if (run === null) return null;
    if (stored.reference === undefined) return evaluationOutcome(stored.objective, run);
    const reference = await deps.testRuns.get({
      tenantId,
      testRunId: stored.reference.testRunId as RunId,
    });
    if (reference === null) return null;
    return evaluationOutcome(stored.objective, run, {
      rule: stored.rule ?? 'better',
      reference,
    });
  }

  /**
   * The test runs a rescore scores again, each a completed comparison of a
   * test set: the latest evaluation's, then the current version's replays
   * it's held to, if any, so both sides count the same corrections.
   */
  async function rescorable(
    tenantId: TenantId,
    latest: SuggestedChangeEvaluationRef,
  ): Promise<SuggestedChangeOutcome<TestRun[]>> {
    const runs: TestRun[] = [];
    for (const testRunId of [latest.testRunId, latest.reference?.testRunId]) {
      if (testRunId === undefined) continue;
      const run = await deps.testRuns.get({ tenantId, testRunId: testRunId as RunId });
      if (run === null) {
        return err({
          code: 'test-run-not-found',
          message: `No test run with id ${testRunId}`,
          testRunId,
        });
      }
      const notRescorable = rescoreRefusal(run);
      if (notRescorable !== undefined) {
        return err({ code: 'test-run-not-rescorable', message: notRescorable, testRunId });
      }
      runs.push(run);
    }
    return { kind: 'ok', value: runs };
  }

  /**
   * Start a rescore of each run, in order: their ids. Not half a rescore:
   * when one can't start, the ones started are cancelled.
   */
  async function startRescores(
    tenantId: TenantId,
    runs: readonly TestRun[],
    projectId: ProjectId,
    correlationId: string,
  ): Promise<SuggestedChangeOutcome<string[]>> {
    const started: RunId[] = [];
    for (const run of runs) {
      // A runtime that doesn't record the run's project: the candidate's, as evaluate starts it.
      const again = await deps.testRuns.start(
        rescoreStart(run, run.projectId ?? projectId, correlationId),
      );
      if (again.kind !== 'ok') {
        for (const testRunId of started) await deps.testRuns.cancel({ tenantId, testRunId });
        return err(startError(again));
      }
      started.push(again.testRunId);
    }
    return { kind: 'ok', value: started.map((id) => id as unknown as string) };
  }

  /** The 409 when the suggested change's status doesn't allow `action`. */
  async function refuseStatus(
    action: SuggestedChangeAction,
    suggestedChange: StoredSuggestedChange,
    seen?: SuggestedChangeFacts,
  ): Promise<SuggestedChangeServiceError | undefined> {
    const f = seen ?? (await facts(suggestedChange.tenantId)(suggestedChange));
    if (suggestedChangeActionAllowed(action, f.status)) return undefined;
    return invalidTransition(
      suggestedChange,
      f.status,
      `it's ${f.status}, and ${action} needs one of: ${SUGGESTED_CHANGE_ACTIONS[action].join(', ')}.`,
    );
  }

  /** Record a step; the 409 when another call recorded one first. */
  async function record(
    suggestedChange: StoredSuggestedChange,
    step: SuggestedChangeStep,
  ): Promise<SuggestedChangeOutcome<StoredSuggestedChange>> {
    const outcome = await deps.store.recordSuggestedChange({
      tenantId: suggestedChange.tenantId,
      suggestedChangeId: suggestedChange.id,
      expectRevision: suggestedChange.revision,
      step,
    });
    if (outcome.kind === 'ok') return { kind: 'ok', value: outcome.suggestedChange };
    if (outcome.kind === 'not-found')
      return err(suggestedChangeNotFound(suggestedChange.id as unknown as string));
    return err({
      code: 'suggested-change-invalid-state-transition',
      message: `Suggested change ${suggestedChange.id as unknown as string} changed while this ran: read it again`,
      suggestedChangeId: suggestedChange.id as unknown as string,
    });
  }

  /**
   * The project the candidate version runs in: the one it was made in (the
   * first environment of its agent's order), else its agent's;
   * `undefined` when it's unregistered.
   */
  async function candidateProject(
    suggestedChange: StoredSuggestedChange,
  ): Promise<ProjectId | undefined> {
    if (suggestedChange.candidate === undefined) return undefined;
    const version = await deps.agents.getVersion({
      tenantId: suggestedChange.tenantId,
      agentId: suggestedChange.agentId,
      version: suggestedChange.candidate.agentVersion as Semver,
    });
    return version === null || version.unregisteredAt !== undefined
      ? undefined
      : (version.madeInProjectId ?? version.projectId);
  }

  /**
   * Publish the block version and derive the agent version a suggested
   * change is checked as: in `projectId`, its project, when the agent
   * store records none on its versions.
   */
  async function makeCandidate(
    suggestedChange: StoredSuggestedChange,
    actor: PinActor,
    projectId?: ProjectId,
  ): Promise<SuggestedChangeOutcome<NonNullable<StoredSuggestedChange['candidate']>>> {
    const { tenantId } = suggestedChange;
    const block = blockChangeOf(suggestedChange);
    if (block === undefined) {
      return err(
        validationFailed(
          "A deploy's suggested change is checked as the version the deploy registered, never a new one",
          [],
        ),
      );
    }
    const { blockId, fromVersion } = block.change;
    const base = builtOn(suggestedChange);
    // A new version of the block is written only for a block in the
    // agent's project's reach (a suggested change drafted before that was checked).
    const agentVersion = await deps.agents.getVersion({
      tenantId,
      agentId: suggestedChange.agentId,
      version: base as Semver,
    });
    if (agentVersion?.projectId !== undefined) {
      const outOfScope = await referencesOutOfScope(
        deps.referenceScope,
        tenantId,
        agentVersion.projectId,
        [{ path: '/change/blockId', kind: 'block', id: blockId }],
      );
      if (outOfScope !== undefined) return err({ ...outOfScope });
    }
    const from = await deps.blocks.getVersion({ tenantId, blockId, version: fromVersion });
    if (from === null) {
      return err(validationFailed(`Block "${blockId}" version ${fromVersion} is gone`, []));
    }
    const edit = editOf(block.tier, block.change.content);
    // Deriving the agent version checks model settings, after the block
    // version is written: checked here first, so a refusal leaves
    // nothing stored.
    if (edit.kind === 'settings') {
      const agent = await deps.agents.getVersion({
        tenantId,
        agentId: suggestedChange.agentId,
        version: base as Semver,
      });
      const refused =
        agent !== null && agent.modelSettings?.id === blockId
          ? modelSettingsRefusal(agent, blockId, edit.values)
          : undefined;
      if (refused !== undefined) return err(refused);
    }
    const published = await publishBlockEdit({
      blocks: deps.blocks,
      tenantId,
      from,
      edit,
      ...(deps.orders !== undefined && { orders: deps.orders }),
      publishedBy: actor,
      source: { kind: 'suggested-change', id: suggestedChange.id },
    });
    if (published.kind === 'invalid') {
      return err(
        validationFailed(
          `The suggested change's content can't be published as block "${blockId}"`,
          published.issues,
        ),
      );
    }
    const pinKind = suggestedChange.tier === 'settings-block' ? 'settings' : 'prompts';
    const userId = actor.kind === 'user' ? (actor.id as UserId) : undefined;
    const derived = await deriveAgentVersion({
      agents: deps.agents,
      blocks: deps.blocks,
      tenantId,
      agentId: suggestedChange.agentId,
      from: base,
      swaps: { [pinKind]: { [blockId]: published.version } },
      label: `suggested change ${suggestedChange.id as unknown as string}`,
      by: `${actor.kind}:${actor.id}`,
      suggestedChangeId: suggestedChange.id as unknown as string,
      ...(projectId !== undefined && { projectId }),
      ...(deps.orders !== undefined && { orders: deps.orders }),
      tuplesFor: (landsIn) => (id) =>
        tuplesForCreate({ kind: 'agent', id: id as AgentId, tenantId, projectId: landsIn }, userId),
    });
    if (derived.kind === 'environment-takes-promotions') {
      return err(environmentTakesPromotions(derived.later));
    }
    if (derived.kind !== 'ok' && derived.kind !== 'reused') {
      return err(
        validationFailed(
          derived.kind === 'invalid'
            ? `Can't derive a version from ${base}`
            : `Can't derive a version from ${base} (${derived.kind})`,
          derived.kind === 'invalid' ? derived.issues : [],
        ),
      );
    }
    const { agent } = derived;
    if (agent.pinsDigest === undefined) throw new Error('a derived version is pinned');
    return {
      kind: 'ok',
      value: {
        agentVersion: agent.version as unknown as string,
        blockVersion: published.version,
        pinsDigest: agent.pinsDigest,
      },
    };
  }

  /**
   * A registry that takes no writes makes no suggested change, nor checks
   * one: under `kindgi dev`, the pack's files serve every project, and a
   * suggested change is for one. Even one that takes Improve's candidates.
   */
  function cardReadOnly(): SuggestedChangeServiceError | undefined {
    const readOnly = deps.agents.readOnly;
    return readOnly === undefined
      ? undefined
      : { code: 'registry-read-only', message: readOnly.reason };
  }

  /** Why the registry takes no candidate for the suggested change; `undefined` when it does. */
  function readOnlyRefusal(scope: AgentPinScope): SuggestedChangeServiceError | undefined {
    // Checking derives an agent version: not into a registry that takes
    // no writes, unless it takes Improve's candidates.
    if (deps.agents.readOnly !== undefined && refusesCandidates(deps.agents.readOnly)) {
      return { code: 'registry-read-only', message: deps.agents.readOnly.reason };
    }
    const narrower = refusesScope(deps.agents.readOnly, scope);
    return narrower === undefined ? undefined : { code: 'registry-read-only', message: narrower };
  }

  /** The project's test set, frozen for a check; the 409 when it has no cases. */
  async function frozenSet(
    testSets: TestSetFreezeBinding,
    tenantId: TenantId,
    agentId: AgentId,
    projectId: ProjectId,
  ): Promise<SuggestedChangeOutcome<FrozenTestSet>> {
    const frozen = await testSets.freezeTestSet({ tenantId, agentId, projectId });
    if (frozen.cases.length > 0) return { kind: 'ok', value: frozen };
    return err({
      code: 'suggested-change-nothing-to-check',
      message: `Project ${projectId as unknown as string} has no corrections of ${agentId as unknown as string} to check a change on: correct some of its conversations first`,
      projectId: projectId as unknown as string,
    });
  }

  /**
   * Check a suggested change on a frozen test set: its candidate (made
   * first, when it has none) and what it's built on run the same cases in
   * its project. The candidate's run is its evaluation, held to the other
   * (`reference`). Not half a check: when the second run can't start, the
   * first is cancelled.
   */
  async function checkOn(
    stored: StoredSuggestedChange,
    actor: PinActor,
    projectId: ProjectId,
    frozen: FrozenTestSet,
  ): Promise<SuggestedChangeOutcome<StoredSuggestedChange>> {
    const { tenantId } = stored;
    let suggestedChange = stored;
    if (suggestedChange.candidate === undefined) {
      const made = await makeCandidate(suggestedChange, actor, projectId);
      if (made.kind === 'err') return made;
      const recorded = await record(suggestedChange, { kind: 'candidate', candidate: made.value });
      if (recorded.kind === 'err') return recorded;
      suggestedChange = recorded.value;
    }
    const candidate = suggestedChange.candidate;
    if (candidate === undefined) throw new Error('a recorded candidate is on the suggested change');
    if ((await candidateProject(suggestedChange)) === undefined) {
      return err({
        code: 'agent-version-not-found',
        message: `The candidate ${suggestedChange.agentId as unknown as string} ${candidate.agentVersion} is unregistered: withdraw this suggested change and suggest it again`,
      });
    }
    const correlationId = `suggested-change:${suggestedChange.id as unknown as string}`;
    const start = (version: string) =>
      deps.testRuns.start({
        tenantId,
        projectId,
        testSetId: frozen.testSetId,
        testSetVersion: frozen.testSetVersion,
        agentRef: { agentId: suggestedChange.agentId, version: version as Semver },
        correlationId,
      });
    const withIt = await start(candidate.agentVersion);
    if (withIt.kind !== 'ok') return err(startError(withIt));
    if (blockChangeOf(suggestedChange) === undefined) {
      // A deploy's image runs only its own code, so what the project runs
      // can't run now: it's held to that version's newest finished run on
      // the same frozen cases, when there is one.
      const reused = await newestRunOn(suggestedChange, projectId, frozen);
      return record(suggestedChange, {
        kind: 'evaluation',
        evaluation: {
          testRunId: withIt.testRunId as unknown as string,
          testSetId: frozen.testSetId,
          objective: 'passRate',
          startedAt: new Date().toISOString() as Timestamp,
          rule: 'better',
          ...(reused !== undefined && { reference: { testRunId: reused } }),
        },
      });
    }
    const now = await start(builtOn(suggestedChange));
    if (now.kind !== 'ok') {
      await deps.testRuns.cancel({ tenantId, testRunId: withIt.testRunId });
      return err(startError(now));
    }
    return record(suggestedChange, {
      kind: 'evaluation',
      evaluation: {
        testRunId: withIt.testRunId as unknown as string,
        testSetId: frozen.testSetId,
        objective: 'passRate',
        startedAt: new Date().toISOString() as Timestamp,
        rule: 'better',
        reference: { testRunId: now.testRunId as unknown as string },
      },
    });
  }

  /**
   * Its block change carried onto `base`, the version its project runs
   * now: the block version `base` pins, and the content. A prompt's
   * wording is the change itself. A settings change keeps the values it
   * changed, and takes every other value from the version `base` pins.
   * The 409 when `base` doesn't use the block, or already has the change.
   */
  async function carriedOnto(
    suggestedChange: StoredSuggestedChange,
    base: AgentVersionRecord,
  ): Promise<SuggestedChangeOutcome<ProposedChange['change']>> {
    const { tenantId } = suggestedChange;
    const runs = base.version as unknown as string;
    const block = blockChangeOf(suggestedChange);
    if (block === undefined) {
      return err(
        outOfDate(suggestedChange, runs, "a deploy's version is never rebuilt on another"),
      );
    }
    const { change, tier } = block;
    const { blockId } = change;
    const pins = tier === 'settings-block' ? base.pins?.settings : base.pins?.prompts;
    const pinned = pins?.[blockId];
    if (pinned === undefined) {
      return err(outOfDate(suggestedChange, runs, `${runs} doesn't use block "${blockId}"`));
    }
    const now = await deps.blocks.getVersion({ tenantId, blockId, version: pinned });
    if (now === null) {
      return err(validationFailed(`Block "${blockId}" version ${pinned} is gone`, []));
    }
    const content = await contentOn(tenantId, change, now, pinned);
    if (content.kind === 'err') return content;
    if (sameContent(now, editOf(tier, content.value))) {
      return err(outOfDate(suggestedChange, runs, `${runs} already has this change`));
    }
    const carried = {
      ...change,
      fromVersion: pinned,
      content: content.value,
    } as ProposedChange['change'];
    return { kind: 'ok', value: carried };
  }

  /**
   * A change's content on the block version `pinned` (`now`): a settings
   * change keeps the values it changed from its old `from`, set or
   * removed, and takes every other value from `now`. A prompt's wording,
   * or a block that didn't move, is as it is.
   */
  async function contentOn(
    tenantId: TenantId,
    change: ProposedChange['change'],
    now: BlockRecord,
    pinned: string,
  ): Promise<SuggestedChangeOutcome<ProposedChange['change']['content']>> {
    const { blockId, content } = change;
    if (now.kind !== 'settings' || pinned === change.fromVersion) {
      return { kind: 'ok', value: content };
    }
    const was = await deps.blocks.getVersion({ tenantId, blockId, version: change.fromVersion });
    if (was?.kind !== 'settings') {
      return err(validationFailed(`Block "${blockId}" version ${change.fromVersion} is gone`, []));
    }
    const values = (content as { values: Record<string, unknown> }).values;
    return {
      kind: 'ok',
      value: {
        ...content,
        values: carrySettings(was.content.values, values, now.content.values),
      } as ProposedChange['change']['content'],
    };
  }

  /**
   * Rebuild it on what its project runs now (`runs`), when that moved
   * since it was built: its block change carried onto that version
   * (`carriedOnto`), a new candidate, and a new check on the project's
   * test set, frozen now. `undefined` when it's built on what runs, or
   * its project runs its own version.
   */
  async function rebuildIfMoved(
    suggestedChange: StoredSuggestedChange,
    actor: PinActor,
    projectId: ProjectId,
    runs: WhatRuns | null,
  ): Promise<SuggestedChangeOutcome<StoredSuggestedChange> | undefined> {
    if (runs === null || !moved(suggestedChange, runs)) return undefined;
    const now = runs.version as unknown as string;
    const readOnly = cardReadOnly();
    if (readOnly !== undefined) return err(readOnly);
    if (deps.testSets === undefined) return err(checkUnsupported());
    const { tenantId, agentId } = suggestedChange;
    const base = await activeVersion(tenantId, agentId, runs.version, projectId);
    if (base.kind === 'err') return base;
    const change = await carriedOnto(suggestedChange, base.value);
    if (change.kind === 'err') return change;
    // Frozen first: a project with nothing to check leaves it as it was.
    const frozen = await frozenSet(deps.testSets, tenantId, agentId, projectId);
    if (frozen.kind === 'err') return frozen;
    const rebuilt = await record(suggestedChange, {
      kind: 'rebuilt',
      builtOnVersion: now,
      rebuiltAt: new Date().toISOString() as Timestamp,
      change: change.value,
    });
    if (rebuilt.kind === 'err') return rebuilt;
    return checkOn(rebuilt.value, actor, projectId, frozen.value);
  }

  /** The version its project runs (`version`), when it's active; else the 404. */
  async function activeVersion(
    tenantId: TenantId,
    agentId: AgentId,
    version: Semver,
    projectId: ProjectId,
  ): Promise<SuggestedChangeOutcome<AgentVersionRecord>> {
    const found = await deps.agents.getVersion({ tenantId, agentId, version });
    if (found !== null && found.unregisteredAt === undefined) return { kind: 'ok', value: found };
    return err({
      code: 'agent-version-not-found',
      message: `${agentId as unknown as string} has no active version ${version as unknown as string}, which project ${projectId as unknown as string} runs`,
    });
  }

  /**
   * Rebuild one of the project's suggested changes in `rebuildOthers`:
   * `true` when it was rebuilt, `false` when it needn't be, or why it
   * couldn't be.
   */
  async function rebuildOne(
    card: StoredSuggestedChange,
    actor: PinActor,
    projectId: ProjectId,
    runs: WhatRuns,
  ): Promise<boolean | string> {
    if (card.withdrawn !== undefined || card.addedAsLatest !== undefined) return false;
    try {
      const { status } = await facts(card.tenantId)(card);
      if (!suggestedChangeActionAllowed('check', status)) return false;
      const outcome = await rebuildIfMoved(card, actor, projectId, runs);
      if (outcome === undefined) return false;
      return outcome.kind === 'ok' ? true : outcome.error.message;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * `undefined` when it's built on what its project runs (`runs`); else
   * the 409 a pin or an add as Latest answers, once its rebuild started,
   * or why it couldn't be rebuilt.
   */
  async function refuseMoved(
    suggestedChange: StoredSuggestedChange,
    actor: PinActor,
    projectId: ProjectId,
    runs: WhatRuns | null,
  ): Promise<SuggestedChangeServiceError | undefined> {
    const moved = await rebuildIfMoved(suggestedChange, actor, projectId, runs);
    if (moved === undefined || runs === null) return undefined;
    if (moved.kind === 'err') {
      if (moved.error.code === 'suggested-change-out-of-date') return moved.error;
      return {
        ...moved.error,
        message: `Project ${projectId as unknown as string} now runs ${runs.version as unknown as string}, and rebuilding suggested change ${suggestedChange.id as unknown as string} on it failed: ${moved.error.message}`,
      };
    }
    return outOfDate(suggestedChange, runs.version as unknown as string);
  }

  /**
   * The newest finished run, in its project, of the version a suggested
   * change is built on, on the same frozen version of the test set: among
   * the newest `NEWEST_RUNS` finished runs of the agent there. `undefined`
   * when there's none.
   */
  async function newestRunOn(
    suggestedChange: StoredSuggestedChange,
    projectId: ProjectId,
    frozen: FrozenTestSet,
  ): Promise<string | undefined> {
    const page = await deps.testRuns.list({
      tenantId: suggestedChange.tenantId,
      limit: NEWEST_RUNS,
      filter: {
        testSetId: frozen.testSetId,
        status: 'completed',
        agentId: suggestedChange.agentId,
      },
      scope: { kind: 'project', tenantId: suggestedChange.tenantId, projectId },
    });
    const version = builtOn(suggestedChange);
    const run = page.data.find(
      (r) => r.testSetVersion === frozen.testSetVersion && r.agentRef?.version === version,
    );
    return run?.testRunId as unknown as string | undefined;
  }

  /**
   * The card a deploy makes for one agent version it registered, in the
   * project it reached, when a pin decides what the project runs there and
   * it's another version. `undefined` when it makes none: the project
   * follows Latest (it runs the new version at once) or runs it already.
   * Checked at once, unless the project's test set has no cases yet.
   */
  async function deployCard(
    input: DeployCardsInput,
    agent: DeployCardsInput['agents'][number],
  ): Promise<SuggestedChangeOutcome<StoredSuggestedChange> | undefined> {
    const { tenantId, projectId } = input;
    const { agentId } = agent;
    const runs = await whatRuns(deps.agentPins, { tenantId, agentId, projectId });
    if (runs === null || runs.follows !== 'pin' || runs.version === agent.version) return undefined;
    const version = await deps.agents.getVersion({ tenantId, agentId, version: agent.version });
    if (version === null || version.unregisteredAt !== undefined) {
      return err({
        code: 'agent-version-not-found',
        message: `${agentId as unknown as string} has no active version ${agent.version as unknown as string}`,
      });
    }
    const created = await storeDeployCard(input, agent, runs.version);
    if (created.kind === 'dedup') return { kind: 'ok', value: created.suggestedChange };
    const withVersion = await record(created.suggestedChange, {
      kind: 'candidate',
      candidate: {
        agentVersion: agent.version as unknown as string,
        pinsDigest: version.pinsDigest ?? '',
      },
    });
    if (withVersion.kind === 'err' || deps.testSets === undefined) return withVersion;
    const frozen = await deps.testSets.freezeTestSet({ tenantId, agentId, projectId });
    if (frozen.cases.length === 0) return withVersion;
    return checkOn(withVersion.value, input.by, projectId, frozen);
  }

  /** Store a deploy card built on `fromVersion`, what its project runs; or find the same one open. */
  async function storeDeployCard(
    input: DeployCardsInput,
    agent: DeployCardsInput['agents'][number],
    fromVersion: Semver,
  ): Promise<CreateSuggestedChangeOutcome> {
    const { tenantId, projectId } = input;
    const { agentId } = agent;
    const from = await deps.agents.getVersion({ tenantId, agentId, version: fromVersion });
    const madeBy: SuggestedChangeMaker = {
      kind: 'deploy',
      deploymentId: input.deploymentId,
      by: input.by,
    };
    const change: CodeChange = {
      deploymentId: input.deploymentId,
      ...(input.imageDigest !== undefined && { imageDigest: input.imageDigest }),
    };
    const built = fromVersion as unknown as string;
    return deps.store.createSuggestedChange({
      tenantId,
      ...(from?.projectId !== undefined && { projectId: from.projectId }),
      agentId,
      fromVersion: built,
      scope: { kind: 'project', projectId },
      tier: 'code',
      change,
      why: DEPLOY_WHY,
      drafter: drafterOf(madeBy),
      madeBy,
      fingerprint: codeFingerprint(agentId, built, projectId, agent.version),
    });
  }

  /** One agent's deploy card (`deployCard`), or why it wasn't made; neither when it makes none. */
  async function deployCardOf(
    input: DeployCardsInput,
    agent: DeployCardsInput['agents'][number],
  ): Promise<{ readonly made?: StoredSuggestedChange; readonly failed?: string }> {
    try {
      const outcome = await deployCard(input, agent);
      if (outcome === undefined) return {};
      return outcome.kind === 'ok' ? { made: outcome.value } : { failed: outcome.error.message };
    } catch (cause) {
      return { failed: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  const service = {
    facts,

    /**
     * Store a suggested change: new content for a block `fromVersion` pins, checked
     * as publishing that block version would be. `deduped` when the same
     * change from the same version for the same scope is open already.
     */
    async draft(
      input: DraftSuggestedChangeInput,
    ): Promise<
      SuggestedChangeOutcome<{ suggestedChange: StoredSuggestedChange; deduped: boolean }>
    > {
      const { tenantId } = input;
      // A registry that takes Improve's candidates improves the whole tenant only.
      const narrower = refusesScope(deps.agents.readOnly, input.scope);
      if (narrower !== undefined) return err({ code: 'registry-read-only', message: narrower });
      const from = await deps.agents.getVersion({
        tenantId,
        agentId: input.agentId as AgentId,
        version: input.fromVersion as Semver,
      });
      if (from === null || from.unregisteredAt !== undefined) {
        return err({
          code: 'agent-version-not-found',
          message: `${input.agentId} has no active version ${input.fromVersion}`,
        });
      }
      // Its scope must reach the agent, and the block it edits must be in
      // the agent's project's reach (`reference-scope.ts`).
      const outOfScope =
        (await agentPinScopeOutOfScope(
          deps.referenceScope,
          tenantId,
          input.agentId,
          input.scope,
        )) ??
        (from.projectId === undefined
          ? undefined
          : await referencesOutOfScope(deps.referenceScope, tenantId, from.projectId, [
              { path: '/change/blockId', kind: 'block', id: input.blockId },
            ]));
      if (outOfScope !== undefined) return err({ ...outOfScope });
      const pinned = await pinnedBlock(deps.blocks, tenantId, from, input.tier, input.blockId);
      if (pinned.kind === 'invalid') return err(validationFailed(pinned.message, pinned.issues));
      const edit = editOf(input.tier, input.content);
      const checked = await blockEditDefinition(
        { blocks: deps.blocks, tenantId, from: pinned.block, edit },
        pinned.block.version,
      );
      if (checked.kind === 'invalid') {
        return err(
          validationFailed(
            `The new content isn't a valid version of block "${input.blockId}"`,
            checked.issues,
          ),
        );
      }
      if (sameContent(pinned.block, edit)) {
        return err(
          validationFailed(`The suggested change doesn't change block "${input.blockId}"`, [
            {
              path: '/change/content',
              message: `equals version ${pinned.block.version}, which ${input.fromVersion} pins`,
            },
          ]),
        );
      }
      // New values for the version's model-settings block are model
      // settings, and don't name its model twice: checked before it's stored.
      if (edit.kind === 'settings' && from.modelSettings?.id === input.blockId) {
        const refused = modelSettingsRefusal(from, input.blockId, edit.values);
        if (refused !== undefined) return err(refused);
      }
      const change = {
        blockId: input.blockId,
        fromVersion: pinned.block.version,
        content: input.content,
      } as ProposedChange['change'];
      const outcome = await deps.store.createSuggestedChange({
        tenantId,
        ...(from.projectId !== undefined && { projectId: from.projectId }),
        agentId: input.agentId as AgentId,
        fromVersion: input.fromVersion,
        scope: input.scope,
        tier: input.tier,
        change,
        why: input.why,
        ...(input.evidence !== undefined && { evidence: input.evidence }),
        drafter: input.drafter,
        madeBy: input.madeBy ?? suggestedChangeMaker({ drafter: input.drafter }),
        fingerprint: fingerprintOf(input, change),
      });
      return {
        kind: 'ok',
        value: { suggestedChange: outcome.suggestedChange, deduped: outcome.kind === 'dedup' },
      };
    },

    /**
     * A suggested change for a project, built on what the project runs (its
     * pin, or Latest), then checked on the project's test set. Everything
     * that can refuse it is asked before anything is stored. `deduped`
     * when the same change on the same version is open already: that one,
     * unchecked again.
     */
    async create(
      input: NewSuggestedChangeInput,
    ): Promise<
      SuggestedChangeOutcome<{ suggestedChange: StoredSuggestedChange; deduped: boolean }>
    > {
      const { tenantId, projectId } = input;
      const agentId = input.agentId as AgentId;
      const scope: AgentPinScope = { kind: 'project', projectId };
      const readOnly = cardReadOnly();
      if (readOnly !== undefined) return err(readOnly);
      if (deps.testSets === undefined) return err(checkUnsupported());
      const later = await laterEnvironment(deps.orders, tenantId, projectId);
      if (later !== undefined) return err(environmentTakesPromotions(later));
      const runs = await whatRuns(deps.agentPins, { tenantId, agentId: input.agentId, projectId });
      if (runs === null) {
        return err({
          code: 'nothing-runs-in-scope',
          message: `${input.agentId} runs nothing in project ${projectId as unknown as string}: a suggested change is built on what the project runs, so publish a version of the agent first`,
          agentId: input.agentId,
        });
      }
      const fromVersion = runs.version as unknown as string;
      const from = await deps.agents.getVersion({ tenantId, agentId, version: runs.version });
      if (from === null || from.unregisteredAt !== undefined) {
        return err({
          code: 'agent-version-not-found',
          message: `${input.agentId} has no active version ${fromVersion}, which project ${projectId as unknown as string} runs`,
        });
      }
      const tier = tierFor(from, input.blockId, input.content);
      if (typeof tier !== 'string') return err(tier);
      const frozen = await frozenSet(deps.testSets, tenantId, agentId, projectId);
      if (frozen.kind === 'err') return frozen;
      const drafted = await service.draft({
        tenantId,
        agentId: input.agentId,
        fromVersion,
        scope,
        tier,
        blockId: input.blockId,
        content: input.content,
        why: input.why,
        ...(input.fixes !== undefined && { evidence: { fixes: input.fixes } }),
        drafter: drafterOf(input.madeBy),
        madeBy: input.madeBy,
      });
      if (drafted.kind === 'err' || drafted.value.deduped) return drafted;
      const made = drafted.value.suggestedChange;
      const checked = await checkOn(made, input.actor, projectId, frozen.value);
      if (checked.kind === 'ok')
        return { kind: 'ok', value: { suggestedChange: checked.value, deduped: false } };
      const id = made.id as unknown as string;
      return err({
        ...checked.error,
        message: `Suggested change ${id} was made, but its check didn't start: ${checked.error.message}. Check it again with POST /v1/suggested-changes/${id}/check.`,
        suggestedChangeId: id,
      });
    },

    /**
     * Check a suggested change again on its project's test set, frozen now:
     * after its check failed, or for new scores. One made before
     * suggested changes were for a project can't be checked.
     */
    async check(
      input: CheckSuggestedChangeInput,
    ): Promise<SuggestedChangeOutcome<StoredSuggestedChange>> {
      const { tenantId, suggestedChange } = input;
      const refused = await refuseStatus('check', suggestedChange);
      if (refused !== undefined) return err(refused);
      const projectId = projectOfCard(suggestedChange);
      if (projectId === undefined) return err(notForAProject(suggestedChange, 'check'));
      const readOnly = cardReadOnly();
      if (readOnly !== undefined) return err(readOnly);
      if (deps.testSets === undefined) return err(checkUnsupported());
      // Its project moved first: checked again means rebuilt on what runs.
      const runs = await whatRuns(deps.agentPins, {
        tenantId,
        agentId: suggestedChange.agentId as unknown as string,
        projectId,
      });
      const moved = await rebuildIfMoved(suggestedChange, input.actor, projectId, runs);
      if (moved !== undefined) return moved;
      const frozen = await frozenSet(deps.testSets, tenantId, suggestedChange.agentId, projectId);
      if (frozen.kind === 'err') return frozen;
      return checkOn(suggestedChange, input.actor, projectId, frozen.value);
    },

    /**
     * Publish the suggested change's block version and derive its agent version
     * (once: an evaluation again reuses them), then start the comparison.
     * Needs a writable agent registry and a tenant-wide pinned version.
     */
    async evaluate(
      input: EvaluateSuggestedChangeInput,
    ): Promise<SuggestedChangeOutcome<StoredSuggestedChange>> {
      const { tenantId } = input;
      let suggestedChange = input.suggestedChange;
      const agentId = suggestedChange.agentId as unknown as string;
      const refused = await refuseStatus('check', suggestedChange);
      if (refused !== undefined) return err(refused);
      const readOnly = readOnlyRefusal(suggestedChange.scope);
      if (readOnly !== undefined) return err(readOnly);
      // A version pinned nowhere is still the agent's latest, and the
      // latest serves every scope nothing is pinned for.
      if ((await deps.agentPins.pinned.resolve({ tenantId, agentId })) === null) {
        return err({
          code: 'suggested-change-needs-pin',
          message: `${agentId} has no pinned version for the whole tenant, so a new version of it would serve every scope nothing is pinned for. Pin its current version for the tenant first (scope { "kind": "tenant" }), then evaluate.`,
        });
      }
      if (suggestedChange.candidate === undefined) {
        const made = await makeCandidate(suggestedChange, input.actor);
        if (made.kind === 'err') return made;
        const recorded = await record(suggestedChange, {
          kind: 'candidate',
          candidate: made.value,
        });
        if (recorded.kind === 'err') return recorded;
        suggestedChange = recorded.value;
      }
      const candidate = suggestedChange.candidate;
      if (candidate === undefined)
        throw new Error('a recorded candidate is on the suggested change');
      const version = await deps.agents.getVersion({
        tenantId,
        agentId: suggestedChange.agentId,
        version: candidate.agentVersion as Semver,
      });
      if (
        version === null ||
        version.unregisteredAt !== undefined ||
        version.projectId === undefined
      ) {
        return err({
          code: 'agent-version-not-found',
          message: `The candidate ${agentId} ${candidate.agentVersion} is unregistered: withdraw this suggested change and draft it again`,
        });
      }
      // It runs where it was made (in an environment order, the first
      // environment), and the test set must be that project's to reach
      // (`reference-scope.ts`).
      const runIn = version.madeInProjectId ?? version.projectId;
      const testSetOutOfScope = await referencesOutOfScope(deps.referenceScope, tenantId, runIn, [
        { path: '/testSetId', kind: 'test-set', id: input.testSetId },
      ]);
      if (testSetOutOfScope !== undefined) return err({ ...testSetOutOfScope });
      const started = await deps.testRuns.start({
        tenantId,
        projectId: runIn,
        testSetId: input.testSetId,
        agentRef: { agentId: suggestedChange.agentId, version: candidate.agentVersion as Semver },
        correlationId: `suggested-change:${suggestedChange.id as unknown as string}`,
        ...(input.comparison !== undefined && { comparison: input.comparison }),
      });
      if (started.kind !== 'ok') return err(startError(started));
      return record(suggestedChange, {
        kind: 'evaluation',
        evaluation: {
          testRunId: started.testRunId as unknown as string,
          testSetId: input.testSetId,
          objective: input.objective,
          startedAt: new Date().toISOString() as Timestamp,
          ...(input.against !== undefined && {
            rule: input.against.rule,
            reference: { testRunId: input.against.reference.testRunId },
          }),
        },
      });
    },

    /**
     * Rescore the suggested change's latest evaluation: its replays scored again,
     * with what people corrected on them since. The new run is the suggested change's
     * evaluation, so its status follows; the run rescored stays as it was.
     */
    async rescore(
      input: RescoreSuggestedChangeInput,
    ): Promise<SuggestedChangeOutcome<StoredSuggestedChange>> {
      const { tenantId, suggestedChange } = input;
      const refused = await refuseStatus('check', suggestedChange);
      if (refused !== undefined) return err(refused);
      const latest = suggestedChange.evaluation;
      if (latest === undefined) {
        return err(
          invalidTransition(
            suggestedChange,
            'check-failed',
            'it has no check to score again: check it instead.',
          ),
        );
      }
      const runs = await rescorable(tenantId, latest);
      if (runs.kind === 'err') return runs;
      // As evaluate: not for a candidate unregistered since.
      const candidateIn = await candidateProject(suggestedChange);
      if (candidateIn === undefined) {
        return err({
          code: 'agent-version-not-found',
          message: `The candidate ${suggestedChange.agentId as unknown as string} ${suggestedChange.candidate?.agentVersion} is unregistered: withdraw this suggested change and draft it again`,
        });
      }
      const started = await startRescores(
        tenantId,
        runs.value,
        candidateIn,
        `suggested-change:${suggestedChange.id as unknown as string}`,
      );
      if (started.kind === 'err') return started;
      const [testRunId, referenceId] = started.value;
      return record(suggestedChange, {
        kind: 'evaluation',
        evaluation: {
          testRunId: testRunId as string,
          testSetId: latest.testSetId,
          objective: latest.objective,
          startedAt: new Date().toISOString() as Timestamp,
          ...(latest.rule !== undefined && { rule: latest.rule }),
          ...(referenceId !== undefined && { reference: { testRunId: referenceId } }),
        },
      });
    },

    /**
     * A gated pin of the candidate for the suggested change's scope, with its
     * evaluation's comparison. A drafter's suggested change always waits for a
     * reviewer (K2). `pin` is the request's outcome, as the pin routes
     * answer it; the suggested change records its pin change once one is recorded.
     */
    async pin(input: {
      readonly tenantId: TenantId;
      readonly suggestedChange: StoredSuggestedChange;
      readonly actor: PinActor;
      readonly reason?: string;
      /** Where a project whose test run didn't start or apply is logged. */
      readonly log?: Pick<Logger, 'warn'>;
      /** The caller asks to take a project that follows Latest off it (`requestPin`). */
      readonly stopFollowingLatest?: boolean;
    }): Promise<
      SuggestedChangeOutcome<{
        suggestedChange: StoredSuggestedChange;
        pin: PinRequestOutcome;
      }>
    > {
      const { tenantId, suggestedChange } = input;
      const refused = await refuseStatus('pin', suggestedChange);
      if (refused !== undefined) return err(refused);
      const projectId = projectOfCard(suggestedChange);
      if (projectId === undefined) return err(notForAProject(suggestedChange, 'pin'));
      // A project on Latest is pinned only when the caller asks to take it
      // off Latest; else it takes the change as its Latest (`add-as-latest`).
      // Asked before a rebuild, so a refused pin changes nothing.
      if (input.stopFollowingLatest !== true) {
        const offLatest = await projectsPinTakesOffLatest(deps.agentPins, deps.projects, {
          tenantId,
          agentId: suggestedChange.agentId as unknown as string,
          scope: suggestedChange.scope,
        });
        if (offLatest.length > 0) {
          return err({
            ...pinStopsLatest(offLatest),
            suggestedChangeId: suggestedChange.id as unknown as string,
          });
        }
      }
      const runs = await whatRuns(deps.agentPins, {
        tenantId,
        agentId: suggestedChange.agentId as unknown as string,
        projectId,
      });
      const moved = await refuseMoved(suggestedChange, input.actor, projectId, runs);
      if (moved !== undefined) return err(moved);
      const { candidate, evaluation } = suggestedChange;
      if (candidate === undefined || evaluation === undefined) {
        throw new Error('an evaluated suggested change has a candidate and an evaluation');
      }
      // A drafter's pin always waits for a reviewer (K2). Whether that
      // reviewer must differ from whoever asked is the tenant roster's to say:
      // a second eligible reviewer → a separate approver; a lone reviewer →
      // the requester may approve their own, so they aren't stuck. A release
      // gate's approval is the floor; the drafter's rule only tightens it.
      const drafted =
        suggestedChange.drafter.kind === 'person'
          ? undefined
          : await draftedApproval(tenantId, input.actor, suggestedChange);
      const drafterApproval =
        drafted === undefined
          ? {}
          : { requireApproval: drafted.approval, draftedEligibleAtRole: drafted.eligibleAtRole };
      const outcome = await requestPin(
        deps.agents,
        deps.agentPins,
        {
          testRuns: deps.testRuns,
          ...(deps.projects !== undefined && { projects: deps.projects }),
          ...(deps.referenceScope !== undefined && { referenceScope: deps.referenceScope }),
          ...(deps.projectSuspended !== undefined && { projectSuspended: deps.projectSuspended }),
          ...(deps.testSets !== undefined && { testSets: deps.testSets }),
          ...(deps.corrections !== undefined && { corrections: deps.corrections }),
          ...(deps.itemProjects !== undefined && { itemProjects: deps.itemProjects }),
        },
        {
          tenantId,
          agentId: suggestedChange.agentId as unknown as string,
          version: candidate.agentVersion as Semver,
          scope: suggestedChange.scope,
          requestedBy: input.actor,
          reason: input.reason ?? `Suggested change ${suggestedChange.id as unknown as string}`,
          testRunId: evaluation.testRunId,
        },
        {
          ...drafterApproval,
          ...(input.log !== undefined && { log: input.log }),
          ...(input.stopFollowingLatest === true && { stopFollowingLatest: true }),
        },
      );
      if (outcome.kind !== 'ok') return { kind: 'ok', value: { suggestedChange, pin: outcome } };
      const recorded = await record(suggestedChange, {
        kind: 'pin',
        pinChangeId: outcome.pin.id,
      });
      if (recorded.kind === 'err') return recorded;
      return { kind: 'ok', value: { suggestedChange: recorded.value, pin: outcome } };
    },

    /**
     * Add its version as its project's Latest, for a project on Latest:
     * the version is marked Latest in the project it was made in (the
     * card's), now, by the caller (`markLatest`). No gate: a project on
     * Latest takes each new Latest as it comes. A pinned project takes a
     * pin instead (`409 suggested-change-project-pinned`).
     */
    async addAsLatest(input: {
      readonly tenantId: TenantId;
      readonly suggestedChange: StoredSuggestedChange;
      readonly actor: PinActor;
      readonly reason?: string;
    }): Promise<SuggestedChangeOutcome<StoredSuggestedChange>> {
      const { tenantId, suggestedChange } = input;
      const refused = await refuseStatus('add-as-latest', suggestedChange);
      if (refused !== undefined) return err(refused);
      const projectId = projectOfCard(suggestedChange);
      if (projectId === undefined) return err(notForAProject(suggestedChange, 'add-as-latest'));
      const readOnly = cardReadOnly();
      if (readOnly !== undefined) return err(readOnly);
      const id = suggestedChange.id as unknown as string;
      const agentId = suggestedChange.agentId as unknown as string;
      const runs = await whatRuns(deps.agentPins, { tenantId, agentId, projectId });
      if (runs?.follows === 'pin') {
        return err({
          code: 'suggested-change-project-pinned',
          message: `Project ${projectId as unknown as string} runs a pin of ${agentId}, not its Latest: pin the change instead`,
          suggestedChangeId: id,
        });
      }
      const moved = await refuseMoved(suggestedChange, input.actor, projectId, runs);
      if (moved !== undefined) return err(moved);
      const version = suggestedChange.candidate?.agentVersion;
      if (version === undefined) throw new Error('a ready suggested change has its version');
      const marked = await deps.agents.markLatest({
        tenantId,
        agentId: suggestedChange.agentId,
        version: version as Semver,
        by: input.actor,
      });
      if (marked.kind === 'not-found') {
        return err({
          code: 'agent-version-not-found',
          message: `${agentId} has no active version ${version}, which suggested change ${id} made`,
        });
      }
      return record(suggestedChange, {
        kind: 'added-as-latest',
        addedAsLatest: {
          at: marked.latestAt as Timestamp,
          by: `${input.actor.kind}:${input.actor.id}`,
          ...(input.reason !== undefined && { reason: input.reason }),
        },
      });
    },

    /**
     * After its project's version moved (a pin, or an added Latest),
     * rebuild every suggested change for the agent and project that's
     * ready or whose check failed, other than `except`, on what the
     * project runs now. Each one on its own: one that can't be rebuilt
     * stays as it was, and is rebuilt when it's checked again, pinned or
     * added as Latest.
     */
    async rebuildOthers(input: {
      readonly tenantId: TenantId;
      readonly agentId: AgentId;
      readonly projectId: ProjectId;
      readonly actor: PinActor;
      readonly except: SuggestedChangeId;
    }): Promise<{
      readonly rebuilt: readonly SuggestedChangeId[];
      readonly failed: readonly {
        readonly suggestedChangeId: SuggestedChangeId;
        readonly message: string;
      }[];
    }> {
      const { tenantId, agentId, projectId } = input;
      const rebuilt: SuggestedChangeId[] = [];
      const failed: { suggestedChangeId: SuggestedChangeId; message: string }[] = [];
      const runs = await whatRuns(deps.agentPins, {
        tenantId,
        agentId: agentId as unknown as string,
        projectId,
      });
      if (runs === null) return { rebuilt, failed };
      let cursor: Cursor | undefined;
      do {
        const page = await deps.store.listSuggestedChanges({
          tenantId,
          limit: 100,
          agentId,
          pinnedScope: { kind: 'project', projectId },
          ...(cursor !== undefined && { cursor }),
        });
        for (const card of page.data) {
          if (card.id === input.except) continue;
          const done = await rebuildOne(card, input.actor, projectId, runs);
          if (done === true) rebuilt.push(card.id);
          if (typeof done === 'string') failed.push({ suggestedChangeId: card.id, message: done });
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return { rebuilt, failed };
    },

    /**
     * The cards a deploy makes in the project its versions reached: the
     * deploy's own, or the one it's promoted into. One for each agent
     * version it registered whose project runs a pinned other version
     * (`madeBy: deploy`). A project on Latest runs the new version at once,
     * and gets none. Each is made on its own: one that can't be made is in
     * `failed`, and never refuses the deploy. None where cards can't be
     * checked (no test set freeze) or made (a read-only registry).
     */
    async fromDeploy(input: DeployCardsInput): Promise<DeployCardsOutcome> {
      if (deps.testSets === undefined || cardReadOnly() !== undefined) {
        return { made: [], failed: [] };
      }
      const made: StoredSuggestedChange[] = [];
      const failed: { agentId: string; message: string }[] = [];
      for (const agent of input.agents) {
        const card = await deployCardOf(input, agent);
        if (card.made !== undefined) made.push(card.made);
        if (card.failed !== undefined) {
          failed.push({ agentId: agent.agentId as unknown as string, message: card.failed });
        }
      }
      return { made, failed };
    },

    async withdraw(input: {
      readonly tenantId: TenantId;
      readonly suggestedChange: StoredSuggestedChange;
      readonly actor: PinActor;
      readonly reason: string;
    }): Promise<SuggestedChangeOutcome<StoredSuggestedChange>> {
      const refused = await refuseStatus('withdraw', input.suggestedChange);
      if (refused !== undefined) return err(refused);
      return record(input.suggestedChange, {
        kind: 'withdrawn',
        withdrawn: {
          at: new Date().toISOString() as Timestamp,
          by: `${input.actor.kind}:${input.actor.id}`,
          reason: input.reason,
        },
      });
    },
  };
  return service;
}

export type SuggestedChangeService = ReturnType<typeof createSuggestedChangeService>;

// ---------- helpers ----------

/** The version a suggested change is built on: where a rebuild moved it, else where it was made. */
function builtOn(suggestedChange: StoredSuggestedChange): string {
  return suggestedChange.builtOnVersion ?? suggestedChange.fromVersion;
}

/**
 * A settings change carried onto newer values: each value it changed
 * from `was` (set, or removed) as it has it; every other value as `now`
 * has it.
 */
function carrySettings(
  was: Readonly<Record<string, unknown>>,
  changed: Readonly<Record<string, unknown>>,
  now: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...now };
  for (const key of new Set([...Object.keys(was), ...Object.keys(changed)])) {
    const inWas = Object.hasOwn(was, key);
    const inChanged = Object.hasOwn(changed, key);
    const same =
      inWas === inChanged && (!inChanged || canonicalize(was[key]) === canonicalize(changed[key]));
    if (same) continue;
    if (inChanged) out[key] = changed[key];
    else delete out[key];
  }
  return out;
}

/**
 * The 409 for one built on a version its project no longer runs: being
 * rebuilt on what it runs, or, with `why`, one that can't be.
 */
function outOfDate(
  suggestedChange: StoredSuggestedChange,
  runs: string,
  why?: string,
): SuggestedChangeServiceError {
  const id = suggestedChange.id as unknown as string;
  const built = builtOn(suggestedChange);
  return {
    code: 'suggested-change-out-of-date',
    message:
      why === undefined
        ? `Suggested change ${id} is built on ${built}, and its project now runs ${runs}: it's being rebuilt on ${runs} and checked again. Try again once its check is ready`
        : `Suggested change ${id} is built on ${built}, and its project now runs ${runs}, which it can't be rebuilt on: ${why}. Withdraw it`,
    suggestedChangeId: id,
    builtOn: built,
    runs,
    rebuilding: why === undefined,
  };
}

/**
 * Whether its project's version (`runs`) moved since it was built: it runs
 * neither the version it's built on nor its own.
 */
function moved(suggestedChange: StoredSuggestedChange, runs: WhatRuns): boolean {
  const now = runs.version as unknown as string;
  return now !== builtOn(suggestedChange) && now !== suggestedChange.candidate?.agentVersion;
}

/** The project a suggested change is for; `undefined` for one made for a wider scope. */
function projectOfCard(suggestedChange: StoredSuggestedChange): ProjectId | undefined {
  return suggestedChange.scope.kind === 'project' ? suggestedChange.scope.projectId : undefined;
}

/** The 409 for one made before suggested changes were for a project. */
function notForAProject(
  suggestedChange: StoredSuggestedChange,
  action: SuggestedChangeAction,
): SuggestedChangeServiceError {
  const id = suggestedChange.id as unknown as string;
  return {
    code: 'suggested-change-not-for-a-project',
    message: `Suggested change ${id} is for a ${suggestedChange.scope.kind}, not a project, so it can't ${action}: withdraw it, and suggest the change for a project`,
    suggestedChangeId: id,
  };
}

function checkUnsupported(): SuggestedChangeServiceError {
  return {
    code: 'suggested-change-check-unsupported',
    message: "This runtime can't check a suggested change: it doesn't freeze a project's test set",
  };
}

/** The 409 for a project that's a later environment of its order. */
function environmentTakesPromotions(later: LaterEnvironment): SuggestedChangeServiceError {
  return {
    code: 'environment-takes-promotions',
    message: environmentTakesPromotionsMessage({ kind: 'suggested-change' }, later),
    firstProjectId: later.firstProjectId as unknown as string,
    position: later.position,
  };
}

/** What a suggested change made through `create` records as its drafter: who asked. */
function drafterOf(madeBy: SuggestedChangeCreator): SuggestedChangeDrafter {
  switch (madeBy.kind) {
    case 'person':
      return { kind: 'person', by: `user:${madeBy.userId}` };
    case 'service':
      return { kind: 'person', by: `service:${madeBy.id}` };
    case 'deploy':
      return { kind: 'person', by: `${madeBy.by.kind}:${madeBy.by.id}` };
  }
}

/**
 * The tier of the block the version pins as `blockId`, when the content
 * fits it: values for a settings block, a template for a prompt block.
 * Else the 400.
 */
function tierFor(
  from: AgentVersionRecord,
  blockId: string,
  content: ProposedChange['change']['content'],
): SuggestedChangeTier | SuggestedChangeServiceError {
  const named = `${from.id as unknown as string} ${from.version as unknown as string}`;
  const settings = from.pins?.settings[blockId] !== undefined;
  const prompt = from.pins?.prompts[blockId] !== undefined;
  if (!settings && !prompt) {
    return validationFailed(`${named} doesn't use block "${blockId}"`, [
      {
        path: '/block',
        message: 'not a block this version pins; adding a block is a code change',
      },
    ]);
  }
  const values = 'values' in content;
  if (settings === values) return settings ? 'settings-block' : 'prompt-block';
  return validationFailed(
    settings
      ? `Block "${blockId}" is a settings block: send \`values\``
      : `Block "${blockId}" is a prompt block: send \`template\``,
    [
      {
        path: values ? '/values' : '/template',
        message: `not for a ${settings ? 'settings' : 'prompt'} block`,
      },
    ],
  );
}

export function suggestedChangeNotFound(suggestedChangeId: string): SuggestedChangeServiceError {
  return {
    code: 'suggested-change-not-found',
    message: `No suggested change ${suggestedChangeId}`,
    suggestedChangeId,
  };
}

function invalidTransition(
  suggestedChange: StoredSuggestedChange,
  status: SuggestedChangeStatus,
  why: string,
): SuggestedChangeServiceError {
  return {
    code: 'suggested-change-invalid-state-transition',
    message: `Suggested change ${suggestedChange.id as unknown as string}: ${why}`,
    suggestedChangeId: suggestedChange.id as unknown as string,
    status,
  };
}

function validationFailed(
  message: string,
  issues: readonly { readonly path: string; readonly message: string }[],
): SuggestedChangeServiceError {
  return {
    code: 'validation-failed',
    message,
    issues: issues as unknown as Record<string, unknown>[],
  };
}

/**
 * Why new values for the agent version's model-settings block are refused:
 * they aren't model settings, or they name the model the version names too.
 */
function modelSettingsRefusal(
  agent: AgentVersionRecord,
  blockId: string,
  values: unknown,
): SuggestedChangeServiceError | undefined {
  const issues = modelSettingsIssues(values);
  if (issues.length > 0) {
    return validationFailed(
      `The suggested change's content isn't model settings, which block "${blockId}" is`,
      issues,
    );
  }
  const twice = modelNamedTwice(agent, values);
  return twice === undefined
    ? undefined
    : validationFailed(`The suggested change's model settings name the model twice`, [
        { path: '/content/values', message: `model-settings block "${blockId}": ${twice}` },
      ]);
}

function startError(
  outcome: Exclude<TestRunStartOutcome, { kind: 'ok' }>,
): SuggestedChangeServiceError {
  switch (outcome.kind) {
    case 'test-set-not-found':
      return {
        code: 'test-set-not-found',
        message: `No test set registered with id "${outcome.testSetId}"`,
        testSetId: outcome.testSetId,
      };
    case 'dispatcher-not-registered':
      return {
        code: 'dispatcher-not-registered',
        message: `No test-run dispatcher registered for kind "${outcome.evalKind}"`,
      };
    case 'dispatcher-input-invalid':
      return { code: 'dispatcher-input-invalid', message: outcome.message };
    case 'project-not-found':
      return {
        code: 'bad-input',
        message: `The candidate's project "${outcome.projectId as unknown as string}" isn't in this tenant`,
      };
  }
}

function editOf(
  tier: SuggestedChangeTier,
  content: ProposedChange['change']['content'],
): BlockEdit {
  return tier === 'settings-block'
    ? { kind: 'settings', values: (content as { values: Record<string, unknown> }).values }
    : { kind: 'prompt', template: (content as { template: string }).template };
}

function sameContent(pinned: BlockRecord, edit: BlockEdit): boolean {
  if (pinned.kind === 'settings' && edit.kind === 'settings') {
    return canonicalize(pinned.content.values) === canonicalize(edit.values);
  }
  return pinned.kind === 'prompt' && edit.kind === 'prompt'
    ? pinned.content.template === edit.template
    : false;
}

type PinnedBlock =
  | { readonly kind: 'ok'; readonly block: BlockRecord }
  | {
      readonly kind: 'invalid';
      readonly message: string;
      readonly issues: readonly { readonly path: string; readonly message: string }[];
    };

/** The block version `from` pins for the tier, or why there's none to change. */
async function pinnedBlock(
  blocks: BlockRegistryBinding,
  tenantId: TenantId,
  from: AgentVersionRecord,
  tier: SuggestedChangeTier,
  blockId: string,
): Promise<PinnedBlock> {
  const kind = tier === 'settings-block' ? 'settings' : 'prompts';
  const what = tier === 'settings-block' ? 'settings' : 'prompt';
  const named = `${from.id as unknown as string} ${from.version as unknown as string}`;
  if (from.pins === undefined) {
    return {
      kind: 'invalid',
      message: `${named} has no pins (it was published before pins); publish it again to pin it`,
      issues: [],
    };
  }
  const version = from.pins[kind][blockId];
  if (version === undefined) {
    return {
      kind: 'invalid',
      message: `${named} doesn't use ${what} block "${blockId}"`,
      issues: [
        {
          path: '/change/blockId',
          message: `not a ${what} block this version pins; adding a block is a code change`,
        },
      ],
    };
  }
  const block = await blocks.getVersion({ tenantId, blockId, version });
  if (block === null) {
    return {
      kind: 'invalid',
      message: `Block "${blockId}" version ${version}, which ${named} pins, isn't in the block store`,
      issues: [],
    };
  }
  return { kind: 'ok', block };
}

/** Its note: why a `ready` one's pin didn't go through, else a deploy card's `not-running`. */
function noteOf(
  status: SuggestedChangeStatus,
  pin: Pin | null | undefined,
  suggestedChange: StoredSuggestedChange,
): SuggestedChangeNote | undefined {
  return (status === 'ready' ? suggestedChangeNote(pin) : undefined) ?? notRunning(suggestedChange);
}

/**
 * The note on a deploy's suggested change checked with no `now`: the
 * version its project runs wasn't running, and had no finished run on the
 * same cases.
 */
function notRunning(suggestedChange: StoredSuggestedChange): SuggestedChangeNote | undefined {
  const { evaluation } = suggestedChange;
  if (blockChangeOf(suggestedChange) !== undefined || evaluation === undefined) return undefined;
  if (evaluation.reference !== undefined) return undefined;
  return { kind: 'not-running', version: builtOn(suggestedChange) };
}

/** A deploy card's fingerprint: the same deploy of the same version onto the same one is one card. */
function codeFingerprint(
  agentId: AgentId,
  fromVersion: string,
  projectId: ProjectId,
  version: Semver,
): string {
  const canonical = canonicalize({ agentId, fromVersion, projectId, tier: 'code', version });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** The same change, from the same version, for the same scope, is one suggested change. */
function fingerprintOf(input: DraftSuggestedChangeInput, change: ProposedChange['change']): string {
  const canonical = canonicalize({
    agentId: input.agentId,
    fromVersion: input.fromVersion,
    scope: agentPinScopeToWire(input.scope),
    tier: input.tier,
    change,
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
