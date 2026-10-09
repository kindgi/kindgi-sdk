// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import type { AgentId } from '@kindgi/agents';
import { tuplesForCreate } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import { canonicalize } from '@kindgi/schema';
import type { LiveScope, RunId, Semver, TenantId, Timestamp, UserId } from '@kindgi/types';

import type { AgentRegistryBinding, AgentVersionRecord } from './agent-binding.js';
import type { BlockRecord, BlockRegistryBinding } from './block-binding.js';
import { type BlockEdit, blockEditDefinition, publishBlockEdit } from './block-publish.js';
import { deriveAgentVersion } from './derive-agent-version.js';
import type { EvalComparison, EvalRunBinding, EvalRunStartOutcome } from './eval-run-binding.js';
import type { GateApproval } from './gate.js';
import type {
  AgentReleaseBindings,
  LivePin,
  Promotion,
  PromotionActor,
} from './live-version-binding.js';
import {
  type FixProposalStatus,
  PROPOSAL_ACTIONS,
  type ProposalAction,
  type ProposalEvaluationOutcome,
  evaluationOutcome,
  proposalActionAllowed,
  proposalStatus,
} from './proposal-status.js';
import { type PromotionRequestOutcome, requestPromotion } from './routes/agent-releases.js';
import { liveScopeToWire } from './routes/live-scope-wire.js';
import type {
  ProposalDrafter,
  ProposalEvidence,
  ProposalObjective,
  ProposalStep,
  ProposalTier,
  ProposedChange,
  StoredProposal,
  SupervisorBinding,
} from './supervisor-binding.js';

/**
 * The improvement-proposal lifecycle, from the bindings it runs on: what
 * `/v1/proposals` serves, and what a runtime's improvement pass drafts
 * and evaluates its proposal with. No authorization here: the route
 * checks the caller; a pass acts as the runtime. Each call answers an
 * outcome; an error carries the wire code the route answers with.
 */
export interface ProposalServiceDeps {
  readonly store: Pick<
    SupervisorBinding,
    'listProposals' | 'getProposal' | 'createProposal' | 'recordProposal'
  >;
  readonly agents: AgentRegistryBinding;
  readonly blocks: BlockRegistryBinding;
  readonly evalRuns: EvalRunBinding;
  readonly releases: AgentReleaseBindings;
  readonly projects?: ProjectBinding;
}

/** An error with the code the API answers it with (`statusFor`), and its details. */
export type ProposalServiceError = { readonly code: string; readonly message: string } & Readonly<
  Record<string, unknown>
>;

export type ProposalOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly error: ProposalServiceError };

/** What a proposal's ids resolve to now, and the status that follows. */
export interface ProposalFacts {
  readonly status: FixProposalStatus;
  readonly evaluation?: ProposalEvaluationOutcome | null;
  readonly promotion?: Promotion | null;
  /** For a promoted proposal: whether its version still serves the scope. */
  readonly liveNow?: boolean;
}

export interface DraftProposalInput {
  readonly tenantId: TenantId;
  readonly agentId: string;
  readonly fromVersion: string;
  readonly scope: LiveScope;
  readonly tier: ProposalTier;
  readonly blockId: string;
  readonly content: ProposedChange['change']['content'];
  readonly hypothesis: string;
  readonly evidence?: ProposalEvidence;
  readonly drafter: ProposalDrafter;
}

export interface EvaluateProposalInput {
  readonly tenantId: TenantId;
  readonly proposal: StoredProposal;
  readonly suiteId: string;
  readonly objective: ProposalObjective;
  readonly comparison?: EvalComparison;
  /** Who it's done for: what the derived version records as `by`. */
  readonly actor: PromotionActor;
}

/**
 * What a promotion that a drafter (not a person) asks for needs even when
 * the scope's policy asks for none: a reviewer (K2). Any reviewer may
 * approve: the drafter, not a person, requested it.
 */
export const DRAFTED_PROPOSAL_APPROVAL: GateApproval = {
  role: 'standard',
  count: 1,
  separateApprover: false,
};

export function createProposalService(deps: ProposalServiceDeps) {
  const err = (error: ProposalServiceError) => ({ kind: 'err' as const, error });

  /** A reader of proposal facts for one call: each agent's pins are read once. */
  function facts(tenantId: TenantId): (p: StoredProposal) => Promise<ProposalFacts> {
    const pins = new Map<string, Promise<readonly LivePin[]>>();
    const pinsOf = (agentId: string): Promise<readonly LivePin[]> => {
      const known = pins.get(agentId);
      if (known !== undefined) return known;
      const found = deps.releases.live.list({ tenantId, agentId });
      pins.set(agentId, found);
      return found;
    };
    return async (p) => {
      const promotion =
        p.promotionId === undefined
          ? undefined
          : await deps.releases.promotions.get(tenantId, p.promotionId);
      let evaluation: ProposalEvaluationOutcome | null | undefined;
      if (p.evaluation !== undefined) {
        const run = await deps.evalRuns.get({ tenantId, runId: p.evaluation.evalRunId as RunId });
        evaluation = run === null ? null : evaluationOutcome(p.evaluation.objective, run);
      }
      const status = proposalStatus(p, promotion, evaluation);
      let liveNow: boolean | undefined;
      if (status === 'promoted' && promotion !== undefined && promotion !== null) {
        const all = await pinsOf(p.agentId as unknown as string);
        liveNow = all.some((pin) => pin.promotionId === promotion.id);
      }
      return {
        status,
        ...(evaluation !== undefined && { evaluation }),
        ...(promotion !== undefined && { promotion }),
        ...(liveNow !== undefined && { liveNow }),
      };
    };
  }

  /** The 409 when the proposal's status doesn't allow `action`. */
  async function refuseStatus(
    action: ProposalAction,
    proposal: StoredProposal,
    seen?: ProposalFacts,
  ): Promise<ProposalServiceError | undefined> {
    const f = seen ?? (await facts(proposal.tenantId)(proposal));
    if (proposalActionAllowed(action, f.status)) return undefined;
    return invalidTransition(
      proposal,
      f.status,
      `it's ${f.status}, and ${action} needs one of: ${PROPOSAL_ACTIONS[action].join(', ')}.`,
    );
  }

  /** Record a step; the 409 when another call recorded one first. */
  async function record(
    proposal: StoredProposal,
    step: ProposalStep,
  ): Promise<ProposalOutcome<StoredProposal>> {
    const outcome = await deps.store.recordProposal({
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      expectRevision: proposal.revision,
      step,
    });
    if (outcome.kind === 'ok') return { kind: 'ok', value: outcome.proposal };
    if (outcome.kind === 'not-found')
      return err(proposalNotFound(proposal.id as unknown as string));
    return err({
      code: 'proposal-invalid-state-transition',
      message: `Proposal ${proposal.id as unknown as string} changed while this ran: read it again`,
      proposalId: proposal.id as unknown as string,
    });
  }

  /** Publish the block version and derive the agent version a proposal is evaluated as. */
  async function makeCandidate(
    proposal: StoredProposal,
    actor: PromotionActor,
  ): Promise<ProposalOutcome<NonNullable<StoredProposal['candidate']>>> {
    const { tenantId } = proposal;
    const { blockId, fromVersion } = proposal.change;
    const from = await deps.blocks.getVersion({ tenantId, blockId, version: fromVersion });
    if (from === null) {
      return err(validationFailed(`Block "${blockId}" version ${fromVersion} is gone`, []));
    }
    const published = await publishBlockEdit({
      blocks: deps.blocks,
      tenantId,
      from,
      edit: editOf(proposal.tier, proposal.change.content),
    });
    if (published.kind === 'invalid') {
      return err(
        validationFailed(
          `The proposal's content can't be published as block "${blockId}"`,
          published.issues,
        ),
      );
    }
    const pinKind = proposal.tier === 'settings-block' ? 'settings' : 'prompts';
    const userId = actor.kind === 'user' ? (actor.id as UserId) : undefined;
    const derived = await deriveAgentVersion({
      agents: deps.agents,
      blocks: deps.blocks,
      tenantId,
      agentId: proposal.agentId,
      from: proposal.fromVersion,
      swaps: { [pinKind]: { [blockId]: published.version } },
      label: `proposal ${proposal.id as unknown as string}`,
      by: `${actor.kind}:${actor.id}`,
      proposalId: proposal.id as unknown as string,
      tuplesFor: (projectId) => (id) =>
        tuplesForCreate(
          { kind: 'agent', id: id as AgentId, tenantId, projectId },
          userId ?? ('00000000-0000-0000-0000-000000000000' as UserId),
        ),
    });
    if (derived.kind !== 'ok' && derived.kind !== 'reused') {
      return err(
        validationFailed(
          derived.kind === 'invalid'
            ? `Can't derive a version from ${proposal.fromVersion}`
            : `Can't derive a version from ${proposal.fromVersion} (${derived.kind})`,
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
     * Store a proposal: new content for a block `fromVersion` pins, checked
     * as publishing that block version would be. `deduped` when the same
     * change from the same version for the same scope is open already.
     */
    async draft(
      input: DraftProposalInput,
    ): Promise<ProposalOutcome<{ proposal: StoredProposal; deduped: boolean }>> {
      const { tenantId } = input;
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
          validationFailed(`The proposal doesn't change block "${input.blockId}"`, [
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
      const outcome = await deps.store.createProposal({
        tenantId,
        ...(from.projectId !== undefined && { projectId: from.projectId }),
        agentId: input.agentId as AgentId,
        fromVersion: input.fromVersion,
        scope: input.scope,
        tier: input.tier,
        change,
        hypothesis: input.hypothesis,
        ...(input.evidence !== undefined && { evidence: input.evidence }),
        drafter: input.drafter,
        fingerprint: fingerprintOf(input, change),
      });
      return {
        kind: 'ok',
        value: { proposal: outcome.proposal, deduped: outcome.kind === 'dedup' },
      };
    },

    /**
     * Publish the proposal's block version and derive its agent version
     * (once: an evaluation again reuses them), then start the comparison.
     * Needs a writable agent registry and a tenant-wide live version.
     */
    async evaluate(input: EvaluateProposalInput): Promise<ProposalOutcome<StoredProposal>> {
      const { tenantId } = input;
      let proposal = input.proposal;
      const agentId = proposal.agentId as unknown as string;
      const refused = await refuseStatus('evaluate', proposal);
      if (refused !== undefined) return err(refused);
      // Evaluating derives an agent version: not into a registry that takes no writes.
      if (deps.agents.readOnly !== undefined) {
        return err({ code: 'registry-read-only', message: deps.agents.readOnly.reason });
      }
      // A version promoted nowhere is still the agent's latest, and the
      // latest serves every scope nothing is pinned for.
      if ((await deps.releases.live.resolve({ tenantId, agentId })) === null) {
        return err({
          code: 'proposal-needs-pin',
          message: `${agentId} has no live version for the whole tenant, so a new version of it would serve every scope nothing is pinned for. Promote its current version for the tenant first (scope { "kind": "tenant" }), then evaluate.`,
        });
      }
      if (proposal.candidate === undefined) {
        const made = await makeCandidate(proposal, input.actor);
        if (made.kind === 'err') return made;
        const recorded = await record(proposal, { kind: 'candidate', candidate: made.value });
        if (recorded.kind === 'err') return recorded;
        proposal = recorded.value;
      }
      const candidate = proposal.candidate;
      if (candidate === undefined) throw new Error('a recorded candidate is on the proposal');
      const version = await deps.agents.getVersion({
        tenantId,
        agentId: proposal.agentId,
        version: candidate.agentVersion as Semver,
      });
      if (
        version === null ||
        version.unregisteredAt !== undefined ||
        version.projectId === undefined
      ) {
        return err({
          code: 'agent-version-not-found',
          message: `The candidate ${agentId} ${candidate.agentVersion} is unregistered: withdraw this proposal and draft it again`,
        });
      }
      const started = await deps.evalRuns.start({
        tenantId,
        projectId: version.projectId,
        suiteId: input.suiteId,
        agentRef: { agentId: proposal.agentId, version: candidate.agentVersion as Semver },
        correlationId: `proposal:${proposal.id as unknown as string}`,
        ...(input.comparison !== undefined && { comparison: input.comparison }),
      });
      if (started.kind !== 'ok') return err(startError(started));
      return record(proposal, {
        kind: 'evaluation',
        evaluation: {
          evalRunId: started.runId as unknown as string,
          suiteId: input.suiteId,
          objective: input.objective,
          startedAt: new Date().toISOString() as Timestamp,
        },
      });
    },

    /**
     * A gated promotion of the candidate for the proposal's scope, with its
     * evaluation's comparison. A drafter's proposal always waits for a
     * reviewer (K2). `promotion` is the request's outcome, as promotions
     * answer it; the proposal records its promotion once one is recorded.
     */
    async request(input: {
      readonly tenantId: TenantId;
      readonly proposal: StoredProposal;
      readonly actor: PromotionActor;
      readonly reason?: string;
    }): Promise<ProposalOutcome<{ proposal: StoredProposal; promotion: PromotionRequestOutcome }>> {
      const { tenantId, proposal } = input;
      const refused = await refuseStatus('request', proposal);
      if (refused !== undefined) return err(refused);
      const { candidate, evaluation } = proposal;
      if (candidate === undefined || evaluation === undefined) {
        throw new Error('an evaluated proposal has a candidate and an evaluation');
      }
      const promotion = await requestPromotion(
        deps.agents,
        deps.releases,
        {
          evalRuns: deps.evalRuns,
          ...(deps.projects !== undefined && { projects: deps.projects }),
        },
        {
          tenantId,
          agentId: proposal.agentId as unknown as string,
          version: candidate.agentVersion as Semver,
          scope: proposal.scope,
          requestedBy: input.actor,
          reason: input.reason ?? `Improvement proposal ${proposal.id as unknown as string}`,
          evalRunId: evaluation.evalRunId,
        },
        proposal.drafter.kind === 'person' ? {} : { requireApproval: DRAFTED_PROPOSAL_APPROVAL },
      );
      if (promotion.kind !== 'ok') return { kind: 'ok', value: { proposal, promotion } };
      const recorded = await record(proposal, {
        kind: 'promotion',
        promotionId: promotion.promotion.id,
      });
      if (recorded.kind === 'err') return recorded;
      return { kind: 'ok', value: { proposal: recorded.value, promotion } };
    },

    /** The scope back on its own pin before the proposal's promotion (or unpinned). */
    async rollback(input: {
      readonly tenantId: TenantId;
      readonly proposal: StoredProposal;
      readonly actor: PromotionActor;
      readonly reason?: string;
    }): Promise<ProposalOutcome<StoredProposal>> {
      const { tenantId, proposal } = input;
      const seen = await facts(tenantId)(proposal);
      const refused = await refuseStatus('rollback', proposal, seen);
      if (refused !== undefined) return err(refused);
      const promotion = seen.promotion;
      if (promotion === null || promotion === undefined || seen.liveNow !== true) {
        return err(
          invalidTransition(
            proposal,
            seen.status,
            "its version doesn't serve the scope anymore (the scope was promoted, rolled back or unpinned since), so there's nothing of it to roll back.",
          ),
        );
      }
      const request = {
        tenantId,
        agentId: proposal.agentId as unknown as string,
        scope: proposal.scope,
        requestedBy: input.actor,
        reason:
          input.reason ?? `Rolled back improvement proposal ${proposal.id as unknown as string}`,
      };
      // Back to the scope's own pin before; with none, it falls back to the scope above.
      const outcome =
        promotion.fromVersion === null
          ? await deps.releases.promotions.unpin(request)
          : await deps.releases.promotions.rollback({
              ...request,
              toVersion: promotion.fromVersion,
            });
      if (outcome.kind === 'err') return err({ ...outcome.error });
      return record(proposal, {
        kind: 'rolled-back',
        rolledBack: {
          at: new Date().toISOString() as Timestamp,
          promotionId: outcome.value.id,
          by: `${input.actor.kind}:${input.actor.id}`,
          ...(input.reason !== undefined && { reason: input.reason }),
        },
      });
    },

    async withdraw(input: {
      readonly tenantId: TenantId;
      readonly proposal: StoredProposal;
      readonly actor: PromotionActor;
      readonly reason: string;
    }): Promise<ProposalOutcome<StoredProposal>> {
      const refused = await refuseStatus('withdraw', input.proposal);
      if (refused !== undefined) return err(refused);
      return record(input.proposal, {
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

export type ProposalService = ReturnType<typeof createProposalService>;

// ---------- helpers ----------

export function proposalNotFound(proposalId: string): ProposalServiceError {
  return { code: 'proposal-not-found', message: `No proposal ${proposalId}`, proposalId };
}

function invalidTransition(
  proposal: StoredProposal,
  status: FixProposalStatus,
  why: string,
): ProposalServiceError {
  return {
    code: 'proposal-invalid-state-transition',
    message: `Proposal ${proposal.id as unknown as string}: ${why}`,
    proposalId: proposal.id as unknown as string,
    status,
  };
}

function validationFailed(
  message: string,
  issues: readonly { readonly path: string; readonly message: string }[],
): ProposalServiceError {
  return {
    code: 'validation-failed',
    message,
    issues: issues as unknown as Record<string, unknown>[],
  };
}

function startError(outcome: Exclude<EvalRunStartOutcome, { kind: 'ok' }>): ProposalServiceError {
  switch (outcome.kind) {
    case 'suite-not-found':
      return {
        code: 'eval-suite-not-found',
        message: `No eval suite registered with id "${outcome.suiteId}"`,
        suiteId: outcome.suiteId,
      };
    case 'dispatcher-not-registered':
      return {
        code: 'dispatcher-not-registered',
        message: `No eval-run dispatcher registered for kind "${outcome.evalKind}"`,
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

function editOf(tier: ProposalTier, content: ProposedChange['change']['content']): BlockEdit {
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
  tier: ProposalTier,
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

/** The same change, from the same version, for the same scope, is one proposal. */
function fingerprintOf(input: DraftProposalInput, change: ProposedChange['change']): string {
  const canonical = canonicalize({
    agentId: input.agentId,
    fromVersion: input.fromVersion,
    scope: liveScopeToWire(input.scope),
    tier: input.tier,
    change,
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
