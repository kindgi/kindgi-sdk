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
import type { ProjectBinding } from '@kindgi/platform';
import { canonicalize } from '@kindgi/schema';
import type {
  AgentPinScope,
  Cursor,
  ProjectId,
  RunId,
  Semver,
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
import { type PinRequestOutcome, requestPin } from './routes/agent-pins.js';
import {
  SUGGESTED_CHANGE_ACTIONS,
  type SuggestedChangeAction,
  type SuggestedChangeEvaluationOutcome,
  type SuggestedChangeStatus,
  evaluationOutcome,
  suggestedChangeActionAllowed,
  suggestedChangeStatus,
} from './suggested-change-status.js';
import type {
  ProposedChange,
  StoredSuggestedChange,
  SuggestedChangeDrafter,
  SuggestedChangeEvaluationRef,
  SuggestedChangeEvidence,
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
 * the scope's policy asks for none: a reviewer (K2). Any reviewer may
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
   * own `standard` rank, which is what a pin with no scope policy waits
   * for) and `eligibleAtRole`, the same roster test at an arbitrary role: a
   * scope policy that sets `separateApprover: false` asks it again at the
   * policy's (higher) role, so a lower-ranked reviewer doesn't deadlock a
   * requester the policy would let decide alone.
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
      return {
        status,
        ...(evaluation !== undefined && { evaluation }),
        ...(change !== undefined && { pin: change }),
        ...(pinnedNow !== undefined && { pinnedNow }),
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

  /** Publish the block version and derive the agent version a suggested change is evaluated as. */
  async function makeCandidate(
    suggestedChange: StoredSuggestedChange,
    actor: PinActor,
  ): Promise<SuggestedChangeOutcome<NonNullable<StoredSuggestedChange['candidate']>>> {
    const { tenantId } = suggestedChange;
    const { blockId, fromVersion } = suggestedChange.change;
    // A new version of the block is written only for a block in the
    // agent's project's reach (a suggested change drafted before that was checked).
    const agentVersion = await deps.agents.getVersion({
      tenantId,
      agentId: suggestedChange.agentId,
      version: suggestedChange.fromVersion as Semver,
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
    const edit = editOf(suggestedChange.tier, suggestedChange.change.content);
    // Deriving the agent version checks model settings, after the block
    // version is written: checked here first, so a refusal leaves
    // nothing stored.
    if (edit.kind === 'settings') {
      const agent = await deps.agents.getVersion({
        tenantId,
        agentId: suggestedChange.agentId,
        version: suggestedChange.fromVersion as Semver,
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
      from: suggestedChange.fromVersion,
      swaps: { [pinKind]: { [blockId]: published.version } },
      label: `suggested change ${suggestedChange.id as unknown as string}`,
      by: `${actor.kind}:${actor.id}`,
      suggestedChangeId: suggestedChange.id as unknown as string,
      ...(deps.orders !== undefined && { orders: deps.orders }),
      tuplesFor: (projectId) => (id) =>
        tuplesForCreate({ kind: 'agent', id: id as AgentId, tenantId, projectId }, userId),
    });
    if (derived.kind !== 'ok' && derived.kind !== 'reused') {
      return err(
        validationFailed(
          derived.kind === 'invalid'
            ? `Can't derive a version from ${suggestedChange.fromVersion}`
            : `Can't derive a version from ${suggestedChange.fromVersion} (${derived.kind})`,
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

  return {
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
        fingerprint: fingerprintOf(input, change),
      });
      return {
        kind: 'ok',
        value: { suggestedChange: outcome.suggestedChange, deduped: outcome.kind === 'dedup' },
      };
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
      const refused = await refuseStatus('evaluate', suggestedChange);
      if (refused !== undefined) return err(refused);
      // Evaluating derives an agent version: not into a registry that takes
      // no writes, unless it takes Improve's candidates.
      if (deps.agents.readOnly !== undefined && refusesCandidates(deps.agents.readOnly)) {
        return err({ code: 'registry-read-only', message: deps.agents.readOnly.reason });
      }
      const narrower = refusesScope(deps.agents.readOnly, suggestedChange.scope);
      if (narrower !== undefined) return err({ code: 'registry-read-only', message: narrower });
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
      const refused = await refuseStatus('rescore', suggestedChange);
      if (refused !== undefined) return err(refused);
      const latest = suggestedChange.evaluation;
      if (latest === undefined) throw new Error('an evaluated suggested change has an evaluation');
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
    }): Promise<
      SuggestedChangeOutcome<{
        suggestedChange: StoredSuggestedChange;
        pin: PinRequestOutcome;
      }>
    > {
      const { tenantId, suggestedChange } = input;
      const refused = await refuseStatus('pin', suggestedChange);
      if (refused !== undefined) return err(refused);
      const { candidate, evaluation } = suggestedChange;
      if (candidate === undefined || evaluation === undefined) {
        throw new Error('an evaluated suggested change has a candidate and an evaluation');
      }
      // A drafter's pin always waits for a reviewer (K2). Whether that
      // reviewer must differ from whoever asked is the tenant roster's to say:
      // a second eligible reviewer → a separate approver; a lone reviewer →
      // the requester may approve their own, so they aren't stuck. A scope
      // policy's approval is the floor; the drafter's rule only tightens it.
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
        drafterApproval,
      );
      if (outcome.kind !== 'ok') return { kind: 'ok', value: { suggestedChange, pin: outcome } };
      const recorded = await record(suggestedChange, {
        kind: 'pin',
        pinChangeId: outcome.pin.id,
      });
      if (recorded.kind === 'err') return recorded;
      return { kind: 'ok', value: { suggestedChange: recorded.value, pin: outcome } };
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
}

export type SuggestedChangeService = ReturnType<typeof createSuggestedChangeService>;

// ---------- helpers ----------

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
