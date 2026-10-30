// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * suggested changes (`/v1/suggested-changes`): a hand-written change to one
 * data block the version a project runs pins, made a real (inert) agent
 * version and checked against what the project runs now on the project's
 * test set, frozen, then pinned for the project through the gate. The
 * status is derived from the check's test runs and the promotion. The
 * stores are in memory; promotions, test runs and the freeze are fakes that
 * record what they're asked.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { type Agent, createAgentRegistry, pinsDigest } from '@kindgi/agents';
import type {
  Action,
  AuthzCheckBinding,
  Decision,
  Principal,
  ResourceRef,
  TupleIntent,
} from '@kindgi/authz';
import { SELF_HOSTED_BOUNDS } from '@kindgi/bounds';
import { overrideTenantInputBounds } from '@kindgi/bounds/testing';
import type {
  Cursor,
  LiveScope,
  ProjectId,
  ReviewerId,
  RunId,
  Semver,
  TenantId,
  Timestamp,
  UserId,
} from '@kindgi/types';

import type {
  FreezeTestSetInput,
  TestSetFreezeBinding,
  TestSetRecord,
  TestSetRegistryBinding,
} from '../src/test-set-binding.js';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp, createSuggestedChangeService } from '../src/index.js';
import type {
  AgentMarkLatestInput,
  AgentRegistryBinding,
  AgentReleaseBindings,
  AgentVersionRecord,
  CheckImproveRunInput,
  CorrectedComparisonSummary,
  CorrectionRegistryBinding,
  GatePolicy,
  GatePolicySpec,
  ImproveRun,
  ImproveRunBinding,
  ImproveRunCheckBasis,
  LatestAnswer,
  LivePin,
  Promotion,
  ReferenceScopeBinding,
  ReviewerRegistryBinding,
  RunHandlerBinding,
  StartImproveRunInput,
  SuggestedChangeRule,
  TestRun,
  TestRunBinding,
  TestRunStartInput,
  TokenResolver,
} from '../src/index.js';
import { expectCompileBudgetRefused } from './support/compile-budget.js';
import { environmentOrders } from './support/environment-orders.js';
import { inMemoryBlocks } from './support/in-memory-blocks.js';
import { inMemoryCorrections } from './support/in-memory-corrections.js';
import { inMemorySuggestedChanges } from './support/in-memory-suggested-changes.js';
import { highestAsLatest } from './support/latest.js';
import { type ItemRow, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const TOKEN = 'suggested-changes-token';
const AGENT = 'acme.scorer';
const WEIGHTS = 'acme.scoring-weights';
const MODEL = 'acme.scorer-model';
/** A model-settings schema that lets an Improve run try another model. */
const MODEL_SCHEMA = {
  type: 'object',
  properties: {
    temperature: { type: 'number', minimum: 0, maximum: 1 },
    model: {
      type: 'string',
      enum: ['claude-sonnet-5-5', 'claude-haiku-4-5'],
      'x-kindgi-tunable': true,
    },
  },
};
const NOW = '2026-10-07T00:00:00.000Z' as Timestamp;
const SEGMENT: LiveScope = {
  kind: 'segment',
  projectId,
  path: [{ key: 'company', value: 'acme' }],
};
const SEGMENT_WIRE = { kind: 'segment', projectId, path: [{ key: 'company', value: 'acme' }] };
const PROJECT: LiveScope = { kind: 'project', projectId };
/** The project's test set, as a check freezes it. */
const FROZEN = { testSetId: 'acme.project-cases', testSetVersion: '1.0.7' };
const projectRef: ResourceRef = { type: 'project', id: projectId as unknown as string };

const ACCOUNT_TOKEN = 'suggested-changes-account-token';
const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId, userId: 'user-1' as UserId };
  if (token === ACCOUNT_TOKEN) return { tenantId, serviceAccountId: 'sa-ci' };
  return null;
};

/** The agent registry in memory, recording each version's project and the entries its publish wrote. */
function agentBinding(
  unregistered: ReadonlySet<string> = new Set(),
): AgentRegistryBinding & { written: TupleIntent[]; marked: AgentMarkLatestInput[] } {
  const registry = createAgentRegistry();
  const written: TupleIntent[] = [];
  const marked: AgentMarkLatestInput[] = [];
  // Where a version was made, when it's not the agent's project (an environment order's first).
  const madeIn = new Map<string, ProjectId>();
  return {
    written,
    marked,
    async list() {
      return { data: [] };
    },
    async get({ agentId }) {
      const got = registry.getLatest(agentId);
      return got.kind === 'ok' ? got.value : null;
    },
    async getVersion({ agentId, version }) {
      const got = registry.get(agentId, version as unknown as string);
      if (got.kind !== 'ok') return null;
      const made = madeIn.get(version as unknown as string);
      const record: AgentVersionRecord = {
        ...got.value,
        projectId,
        ...(made !== undefined && { madeInProjectId: made }),
        ...(unregistered.has(version as unknown as string) && { unregisteredAt: NOW }),
      };
      return record;
    },
    async headExists() {
      return false;
    },
    async listVersions({ agentId }) {
      return {
        data: registry.list().filter((a) => (a.id as unknown as string) === agentId),
      };
    },
    async publish({ agent, projectId: into, enqueueTuples }) {
      if (registry.get(agent.id, agent.version as unknown as string).kind === 'ok') {
        return { kind: 'already-registered', agentId: agent.id, version: agent.version };
      }
      registry.register(agent);
      written.push(...enqueueTuples(agent.id as unknown as string));
      if (into !== projectId) madeIn.set(agent.version as unknown as string, into);
      return { kind: 'ok', agentId: agent.id, version: agent.version };
    },
    async unregister() {
      return { unregistered: false };
    },
    async markLatest(input) {
      const { agentId, version } = input;
      const v = version as unknown as string;
      if (registry.get(agentId, v).kind !== 'ok' || unregistered.has(v)) {
        return { kind: 'not-found', agentId, version };
      }
      marked.push(input);
      return { kind: 'ok', agentId, version, latestAt: NOW };
    },
    async reinstateVersion({ agentId, version }) {
      return { kind: 'not-found', agentId, version };
    },
  };
}

function summary(
  candidate: { agentId: string; version: string; pinsDigest?: string },
  metric: { delta: number | null; spread?: number },
): CorrectedComparisonSummary {
  const m = {
    baseline: 0.6,
    candidate: metric.delta === null ? null : 0.6 + metric.delta,
    delta: metric.delta,
    n: 12,
    weight: 12,
    baselineN: 12,
    baselineWeight: 12,
    direction: 'higher' as const,
    ...(metric.spread !== undefined && { spread: metric.spread }),
  };
  return {
    testRunId: 'set later',
    status: 'completed',
    completedAt: NOW,
    testSet: { id: 'acme.scoring-judged', version: '1.0.0' },
    candidate: { kind: 'agent', ...candidate },
    baseline: { kind: 'recorded', versions: [{ agentId: AGENT, version: '1.0.0', cases: 12 }] },
    scope: { projectId },
    cases: 12,
    diverged: 0,
    refusedWrites: 0,
    errors: 0,
    stopped: 0,
    reads: 'recorded',
    sampling: { models: [] },
    repetitions: metric.spread === undefined ? 1 : 3,
    metrics: { weightedYesShare: m, judgedCoverage: m, weightedPrecisionAtK: { ...m, k: 10 } },
  };
}

/**
 * Test runs: `start` records its input, and refuses the start `fail.start`
 * counts to (the first is 1); `cancel` records the run; a test finishes a
 * run with `finish`.
 */
function testRunFake(agents: AgentRegistryBinding) {
  const runs = new Map<string, TestRun>();
  const started: TestRunStartInput[] = [];
  const cancelled: string[] = [];
  const fail: { start?: number | undefined } = {};
  const binding: TestRunBinding = {
    async start(input) {
      started.push(input);
      if (fail.start === started.length) {
        return { kind: 'test-set-not-found', testSetId: input.testSetId };
      }
      const runId = randomUUID() as RunId;
      runs.set(runId as unknown as string, {
        testRunId: runId,
        tenantId: input.tenantId,
        // The test run records the agent's project. A drafter's approval resolves
        // to the suggested change's SCOPE, not this — set equal to the segment's project
        // here, so only a tenant-scoped test tells the two apart.
        projectId,
        testSetId: input.testSetId,
        testSetVersion: input.testSetVersion ?? '1.0.0',
        kind: 'corrections',
        ...(input.agentRef !== undefined && { agentRef: input.agentRef }),
        ...(input.comparison !== undefined && { comparison: input.comparison }),
        status: 'running',
        dryRun: false,
        startedAt: NOW,
      });
      return { kind: 'ok', testRunId: runId };
    },
    async get({ testRunId }) {
      return runs.get(testRunId as unknown as string) ?? null;
    },
    async list() {
      return { data: [] };
    },
    async cancel({ testRunId }) {
      const run = runs.get(testRunId as unknown as string);
      if (run === undefined) return { kind: 'not-found' as const };
      cancelled.push(testRunId as unknown as string);
      runs.set(testRunId as unknown as string, { ...run, status: 'cancelled' });
      return { kind: 'ok' as const };
    },
  };
  /**
   * Finish a run: failed, or completed with the candidate's pins recorded,
   * as the dispatcher does; `more` adds to its summary.
   */
  const finish = async (
    runId: string,
    outcome:
      | { delta: number | null; spread?: number; more?: Partial<CorrectedComparisonSummary> }
      | 'failed',
  ): Promise<void> => {
    const run = runs.get(runId);
    if (run === undefined) throw new Error(`no run ${runId}`);
    if (outcome === 'failed') {
      runs.set(runId, { ...run, status: 'failed', error: 'replay crashed' });
      return;
    }
    const agentRef = run.agentRef as { agentId: string; version: string };
    const version = await agents.getVersion({
      tenantId,
      agentId: agentRef.agentId as never,
      version: agentRef.version as Semver,
    });
    const s = summary(
      {
        agentId: agentRef.agentId,
        version: agentRef.version,
        ...(version?.pinsDigest !== undefined && { pinsDigest: version.pinsDigest }),
      },
      outcome,
    );
    runs.set(runId, {
      ...run,
      status: 'completed',
      completedAt: NOW,
      result: {
        summary: {
          ...s,
          testSet: { id: run.testSetId, version: run.testSetVersion },
          ...outcome.more,
          testRunId: runId,
        },
      },
    });
  };
  return { binding, started, cancelled, fail, finish, runs };
}

/**
 * The project's test set, frozen for a check: records what it's asked, and
 * answers `state.cases` cases (3 unless given) at `state.version`. `wired`
 * is what the app gets: nothing when `freezes` is false.
 */
function freezeFake(opts: { cases?: number; freezes?: boolean }) {
  const calls: FreezeTestSetInput[] = [];
  const state = { cases: opts.cases ?? 3, version: FROZEN.testSetVersion };
  const binding: TestSetFreezeBinding = {
    async freezeTestSet(input) {
      calls.push(input);
      return {
        testSetId: FROZEN.testSetId,
        testSetVersion: state.version,
        cases: Array.from({ length: state.cases }, (_, i) => ({
          caseId: `case-${i + 1}`,
          correctionId: `j${i + 1}`,
        })),
      };
    },
  };
  const wired = opts.freezes === false ? {} : { testSetFreeze: binding };
  return { binding, calls, state, wired };
}

/** Live pins and promotions, kept as a store keeps them; the gate's outcome decides a request's status. */
function releasesFake(agents: AgentRegistryBinding) {
  const pins: LivePin[] = [];
  const promotions = new Map<string, Promotion>();
  /** `latest`: Latest in every scope, `null` for none; absent: the highest. */
  const state: { policy: GatePolicy | null; latest?: LatestAnswer | null } = { policy: null };
  const calls: { method: string; input: unknown }[] = [];
  const key = (scope: LiveScope) => JSON.stringify(scope);
  const highest = highestAsLatest(agents);
  const pinOf = (agentId: string, scope: LiveScope) =>
    pins.find((p) => p.agentId === agentId && key(p.scope) === key(scope));
  const setPin = (agentId: string, scope: LiveScope, version: string, promotionId: string) => {
    const at = pins.findIndex((p) => p.agentId === agentId && key(p.scope) === key(scope));
    if (at >= 0) pins.splice(at, 1);
    pins.push({ agentId, scope, version: version as Semver, promotionId, setAt: NOW });
  };
  const row = (p: Omit<Promotion, 'id' | 'createdAt'>): Promotion => {
    const promotion = { ...p, id: randomUUID(), createdAt: NOW };
    promotions.set(promotion.id, promotion);
    return promotion;
  };
  const releases: AgentReleaseBindings = {
    live: {
      async resolve({ agentId, projectId: pid, segments }) {
        const scopes: LiveScope[] = [
          ...(pid !== undefined && segments !== undefined
            ? [{ kind: 'segment' as const, projectId: pid, path: segments }]
            : []),
          ...(pid !== undefined ? [{ kind: 'project' as const, projectId: pid }] : []),
          { kind: 'tenant' },
        ];
        for (const scope of scopes) {
          const pin = pinOf(agentId, scope);
          if (pin !== undefined) return { version: pin.version, scope };
        }
        return null;
      },
      async list({ agentId }) {
        return pins.filter((p) => p.agentId === agentId);
      },
    },
    latest: {
      latest: async (q) => (state.latest === undefined ? highest.latest(q) : state.latest),
      byProject: async () => [],
    },
    promotions: {
      async promote(input) {
        calls.push({ method: 'promote', input });
        const before = pinOf(input.agentId, input.scope);
        const promotion = row({
          agentId: input.agentId,
          scope: input.scope,
          action: 'promote',
          fromVersion: before?.version ?? null,
          toVersion: input.version,
          requestedBy: input.requestedBy,
          status: 'promoted',
        });
        setPin(input.agentId, input.scope, input.version, promotion.id);
        return { kind: 'ok', value: promotion };
      },
      async request(input) {
        calls.push({ method: 'request', input });
        const version = await agents.getVersion({
          tenantId,
          agentId: input.agentId as never,
          version: input.version,
        });
        if (version === null) {
          return { kind: 'err', error: { code: 'agent-version-not-found', message: 'no' } };
        }
        const before = pinOf(input.agentId, input.scope);
        const status = !input.gate.passed
          ? 'refused'
          : input.gate.approval !== undefined
            ? 'pending-approval'
            : 'promoted';
        const promotion = row({
          agentId: input.agentId,
          scope: input.scope,
          action: 'promote',
          fromVersion: before?.version ?? null,
          toVersion: input.version,
          requestedBy: input.requestedBy,
          ...(input.testRunId !== undefined && { testRunId: input.testRunId }),
          status,
          policy: input.gate.policy,
          checks: input.gate.checks,
          ...(status === 'pending-approval' && { approvalId: 'appr-1' }),
        });
        if (status === 'promoted') {
          setPin(input.agentId, input.scope, input.version, promotion.id);
        }
        return { kind: 'ok', value: promotion };
      },
      async rollback(input) {
        calls.push({ method: 'rollback', input });
        const before = pinOf(input.agentId, input.scope);
        if (before === undefined || input.toVersion === undefined) {
          return { kind: 'err', error: { code: 'nothing-to-roll-back', message: 'nothing' } };
        }
        const promotion = row({
          agentId: input.agentId,
          scope: input.scope,
          action: 'rollback',
          fromVersion: before.version,
          toVersion: input.toVersion,
          requestedBy: input.requestedBy,
        });
        setPin(input.agentId, input.scope, input.toVersion, promotion.id);
        return { kind: 'ok', value: promotion };
      },
      async unpin(input) {
        calls.push({ method: 'unpin', input });
        const at = pins.findIndex(
          (p) => p.agentId === input.agentId && key(p.scope) === key(input.scope),
        );
        if (at < 0) return { kind: 'err', error: { code: 'not-pinned', message: 'none' } };
        const [gone] = pins.splice(at, 1);
        const promotion = row({
          agentId: input.agentId,
          scope: input.scope,
          action: 'unpin',
          fromVersion: gone?.version ?? null,
          toVersion: null,
          requestedBy: input.requestedBy,
        });
        return { kind: 'ok', value: promotion };
      },
      async list() {
        return { data: [...promotions.values()] };
      },
      async get(_tenant, id) {
        return promotions.get(id) ?? null;
      },
    },
    gatePolicies: {
      resolve: async () => state.policy,
      publish: async () => ({ kind: 'err', error: { code: 'persistence-error', message: 'x' } }),
      get: async () => null,
      getVersion: async () => null,
      listVersions: async () => [],
      list: async () => ({ data: [] }),
      unregister: async () => ({ kind: 'err', error: { code: 'persistence-error', message: 'x' } }),
      reinstate: async () => ({ kind: 'err', error: { code: 'persistence-error', message: 'x' } }),
    },
  };
  /** A pin set by hand (a promotion made before the test). */
  const pin = (scope: LiveScope, version: string) =>
    setPin(
      AGENT,
      scope,
      version,
      row({
        agentId: AGENT,
        scope,
        action: 'promote',
        fromVersion: null,
        toVersion: version as Semver,
        requestedBy: { kind: 'user', id: 'user-0' },
        status: 'promoted',
      }).id,
    );
  const decide = (promotionId: string, status: NonNullable<Promotion['status']>) => {
    const p = promotions.get(promotionId);
    if (p === undefined) throw new Error('no promotion');
    promotions.set(promotionId, { ...p, status });
    if (status === 'promoted' && p.toVersion !== null) {
      setPin(p.agentId, p.scope, p.toVersion, promotionId);
    }
  };
  return { releases, state, calls, pins, pin, decide, promotions };
}

function decision(grants: readonly string[], action: Action, resource: ResourceRef): Decision {
  const allowed = grants.includes(`${action} ${resource.type}:${resource.id}`);
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

function inMemoryImproveRuns() {
  const rows = new Map<string, ImproveRun>();
  const started: StartImproveRunInput[] = [];
  const binding: ImproveRunBinding = {
    async start(input) {
      started.push(input);
      const improveRun: ImproveRun = {
        id: randomUUID(),
        tenantId: input.tenantId,
        agentId: input.agentId,
        fromVersion: input.fromVersion,
        scope: input.scope,
        testSetId: input.testSetId,
        tiers: input.tiers,
        objective: input.objective,
        groupWeights: input.groupWeights,
        ...(input.model !== undefined && { model: input.model }),
        ...(input.candidates !== undefined && { candidates: input.candidates }),
        budget: input.budget,
        requestedBy: `${input.requestedBy.kind}:${input.requestedBy.id}`,
        status: 'running',
        candidatesEvaluated: 0,
        costUsd: '0',
        createdAt: NOW,
        updatedAt: NOW,
      };
      rows.set(improveRun.id, improveRun);
      return improveRun;
    },
    async get({ improveRunId }) {
      return rows.get(improveRunId) ?? null;
    },
    async list({ agentId }) {
      return {
        data: [...rows.values()].filter((p) => agentId === undefined || p.agentId === agentId),
      };
    },
    async cancel({ improveRunId }) {
      const improveRun = rows.get(improveRunId);
      if (improveRun === undefined) return { kind: 'not-found' };
      if (improveRun.status !== 'running') return { kind: 'finished', improveRun };
      const cancelled = { ...improveRun, status: 'cancelled' as const, finishedAt: NOW };
      rows.set(improveRunId, cancelled);
      return { kind: 'ok', improveRun: cancelled };
    },
  };
  return { binding, started, rows };
}

async function harness(
  opts: {
    grants?: readonly string[];
    /** Read-only (kindgi dev), or read-only but taking Improve's candidates. */
    readOnly?: boolean | 'takes-candidates';
    tunable?: boolean;
    /** Versions `getVersion` returns as unregistered (an inactive version). */
    unregisteredVersions?: readonly string[];
    improveRuns?: ImproveRunBinding;
    /** Instructions inline, not from a pinned prompt block. */
    inlineInstructions?: boolean;
    /** The agent takes its model settings from block `MODEL`. */
    modelSettings?: boolean;
    /** `MODEL`'s schema. */
    modelSchema?: Record<string, unknown>;
    /** The agent version's `preferredModel`. */
    preferredModel?: string;
    referenceScope?: ReferenceScopeBinding;
    projectSuspended?: (tenantId: TenantId, projectId: ProjectId) => Promise<boolean>;
    /** The tenant's environment orders; the agent's project is in them or not. */
    orders?: readonly (readonly ProjectId[])[];
    /** The projects that serve each item (an order carries it); absent: one each. */
    items?: ItemRow[];
    correctionRegistry?: CorrectionRegistryBinding;
    /** The project the Improve run's test set reads corrections from. Default: the agent's project. */
    testSetProjectId?: ProjectId;
    /** A full suite record `testSets.get` returns (or `null` for a missing suite), overriding the default corrections stub. */
    testSetRecord?: TestSetRecord | null;
    /** When true, `testSets.get` throws — the route must not read the test set. */
    testSetGetThrows?: boolean;
    /** The key every call is made with: the person's unless given. */
    token?: string;
    /** The cases the project's test set freezes to; 3 unless given. */
    cases?: number;
    /** `false`: the runtime freezes no test set, so it checks no suggested change. */
    freezes?: boolean;
  } = {},
) {
  const agents = agentBinding(new Set(opts.unregisteredVersions ?? []));
  const blocks = inMemoryBlocks([projectId, ...(opts.orders ?? []).flat()], {}, opts.orders);
  await blocks.publish({
    publishedBy: { kind: 'user', id: 'user-1' },
    source: { kind: 'api' },
    tenantId,
    projectId,
    block: {
      id: WEIGHTS,
      version: '1.0.0',
      kind: 'settings',
      content: {
        values: { recency: 0.3, fit: 0.7 },
        schema: {
          type: 'object',
          properties: {
            recency: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              ...(opts.tunable === true && { 'x-kindgi-tunable': true }),
            },
            fit: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              ...(opts.tunable === true && { 'x-kindgi-tunable': true }),
            },
          },
          required: ['recency', 'fit'],
        },
      },
    },
  });
  await blocks.publish({
    publishedBy: { kind: 'user', id: 'user-1' },
    source: { kind: 'api' },
    tenantId,
    projectId,
    block: {
      id: 'acme.scorer-prompt',
      version: '1.0.0',
      kind: 'prompt',
      content: { template: 'Score it.' },
    },
  });
  if (opts.modelSettings === true) {
    await blocks.publish({
      publishedBy: { kind: 'user', id: 'user-1' },
      source: { kind: 'api' },
      tenantId,
      projectId,
      block: {
        id: MODEL,
        version: '1.0.0',
        kind: 'settings',
        content: {
          values: { temperature: 0.2 },
          ...(opts.modelSchema !== undefined && { schema: opts.modelSchema }),
        },
      },
    });
  }
  const pinned = {
    tools: {},
    prompts: opts.inlineInstructions === true ? {} : { 'acme.scorer-prompt': '1.0.0' },
    settings: { [WEIGHTS]: '1.0.0', ...(opts.modelSettings === true && { [MODEL]: '1.0.0' }) },
  };
  await agents.publish({
    tenantId,
    projectId,
    agent: {
      id: AGENT,
      version: '1.0.0',
      name: 'Scorer',
      instructions:
        opts.inlineInstructions === true
          ? 'Score it.'
          : { prompt: 'acme.scorer-prompt', version: '^1.0.0' },
      settings: [{ id: WEIGHTS, version: '^1.0.0' }],
      ...(opts.modelSettings === true && { modelSettings: { id: MODEL, version: '^1.0.0' } }),
      ...(opts.preferredModel !== undefined && { preferredModel: opts.preferredModel }),
      capabilities: [],
      tools: [],
      retrieval: [],
      guardrails: [],
      pins: pinned,
      pinsDigest: pinsDigest(pinned),
    } as unknown as Agent,
    madeFor: 'latest',
    enqueueTuples: () => [],
  });
  const testRuns = testRunFake(agents);
  const freeze = freezeFake(opts);
  const releases = releasesFake(agents);
  const suggestedChanges = inMemorySuggestedChanges();
  const grants = opts.grants;
  // The improve route resolves the `groupWeights` default against the test set's
  // project. The stub makes every test set a corrections one in `testSetProjectId`
  // (default: the agent's project), so an Improve run reads from there.
  const testSetProject = opts.testSetProjectId ?? projectId;
  const testSets = {
    get: async (input: { tenantId: TenantId; testSetId: string }) => {
      if (opts.testSetGetThrows === true)
        throw new Error('the route must not read the test set here');
      if (opts.testSetRecord !== undefined) return opts.testSetRecord;
      return {
        id: input.testSetId,
        tenantId: input.tenantId,
        version: '1.0.0',
        kind: 'corrections',
        spec: { projectId: testSetProject },
      } as unknown as TestSetRecord;
    },
  } as unknown as TestSetRegistryBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    agentRegistry:
      opts.readOnly === true
        ? { ...agents, readOnly: { reason: 'The pack files are the source: change them instead.' } }
        : opts.readOnly === 'takes-candidates'
          ? { ...agents, readOnly: TAKES_CANDIDATES }
          : agents,
    blockRegistry: blocks,
    testRunBinding: testRuns.binding,
    agentReleases: releases.releases,
    supervisor: suggestedChanges,
    ...(opts.improveRuns !== undefined && { improveRuns: opts.improveRuns }),
    ...(opts.referenceScope !== undefined && { referenceScope: opts.referenceScope }),
    ...(opts.projectSuspended !== undefined && { projectSuspended: opts.projectSuspended }),
    ...(opts.orders !== undefined && { environmentOrders: environmentOrders(opts.orders) }),
    ...(opts.items !== undefined && { itemProjects: itemProjects(opts.items) }),
    ...(opts.correctionRegistry !== undefined && { correctionRegistry: opts.correctionRegistry }),
    testSetRegistry: testSets,
    ...freeze.wired,
    ...(grants !== undefined && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_p, action, resource) => decision(grants, action, resource),
          checkBatch: async (_p, action, resources) =>
            resources.map((resource) => decision(grants, action, resource)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  /** A call with the harness's key, or `token`. */
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token ?? opts.token ?? TOKEN}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      headers: res.headers,
      body: (await res.json()) as Record<string, any>,
    };
  };
  return { call, agents, blocks, testRuns, freeze, releases, suggestedChanges };
}

type Harness = Awaited<ReturnType<typeof harness>>;

type HarnessOpts = NonNullable<Parameters<typeof harness>[0]>;

/** A suggested change for the project, as a person sends it. */
const CARD = {
  agentId: AGENT,
  projectId,
  block: WEIGHTS,
  values: { recency: 0.5, fit: 0.5 },
  why: 'Recent filings matter more for acme',
};

/** An agent registry that's read-only but takes Improve's candidates, as kindgi dev's. */
const TAKES_CANDIDATES = {
  reason: 'The pack files are the source: change them instead.',
  takesCandidates: {
    undoReason: "The pack's files are what's live: undo it with git.",
    scopeReason: "The pack's files serve every scope: improve the whole tenant.",
  },
};

/**
 * A suggested change made for the project, which runs its pin of 1.0.0;
 * `card` changes what's sent. Its check started: both runs are running.
 */
async function made(opts: HarnessOpts & { card?: Record<string, unknown> } = {}) {
  const h = await harness(opts);
  h.releases.pin(PROJECT, '1.0.0');
  const res = await h.call('POST', '/v1/suggested-changes', { ...CARD, ...opts.card });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    ...h,
    id: res.body.id as string,
    withRun: res.body.check.with.testRunId as string,
    nowRun: res.body.check.now.testRunId as string,
  };
}

/** A suggested change whose check finished, the change `delta` above what the project runs now: ready. */
async function checked(delta = 0.1, opts: HarnessOpts = {}) {
  const h = await made(opts);
  await h.testRuns.finish(h.withRun, { delta });
  await h.testRuns.finish(h.nowRun, { delta: 0 });
  return h;
}

type Correction = readonly [correctionId: string, pass: boolean];
/** What a finished run adds: whether each correction passed, and its cost. */
function more(
  corrections: readonly Correction[],
  costUsd?: { candidate: number; spread?: number; cases: number },
): Partial<CorrectedComparisonSummary> {
  return {
    corrections: {
      checked: corrections.length,
      passed: corrections.filter(([, pass]) => pass).length,
      results: corrections.map(([correctionId, pass]) => ({ correctionId, pass })),
    },
    ...(costUsd !== undefined && { costUsd }),
  };
}

/** The suggested-change service on the harness's bindings, as an Improve run drafts with it. */
function serviceOf(h: Harness) {
  return createSuggestedChangeService({
    store: h.suggestedChanges,
    agents: h.agents,
    blocks: h.blocks,
    testRuns: h.testRuns.binding,
    releases: h.releases.releases,
  });
}

/**
 * A suggested change made for `scope` before they were for a project, as
 * the service drafted it then; `checked`: evaluated on a test set, and ready.
 */
async function oldRow(h: Harness, scope: LiveScope, opts: { checked?: boolean } = {}) {
  const service = serviceOf(h);
  const drafted = await service.draft({
    tenantId,
    agentId: AGENT,
    fromVersion: '1.0.0',
    scope,
    tier: 'settings-block',
    blockId: WEIGHTS,
    content: { values: { recency: 0.2, fit: 0.8 } },
    why: 'Fit matters more for acme',
    drafter: { kind: 'person', by: 'user:user-1' },
  });
  if (drafted.kind !== 'ok') throw new Error(JSON.stringify(drafted.error));
  const id = drafted.value.suggestedChange.id as unknown as string;
  if (opts.checked !== true) return id;
  h.releases.pin({ kind: 'tenant' }, '1.0.0');
  const evaluated = await service.evaluate({
    tenantId,
    suggestedChange: drafted.value.suggestedChange,
    testSetId: 'acme.scoring-judged',
    objective: 'weightedYesShare',
    actor: { kind: 'user', id: 'user-1' },
  });
  if (evaluated.kind !== 'ok') throw new Error(JSON.stringify(evaluated.error));
  await h.testRuns.finish(evaluated.value.evaluation?.testRunId as string, { delta: 0.1 });
  return id;
}

const ORG_SCOPE = { kind: 'org', orgId: randomUUID() } as LiveScope;

describe('POST /v1/suggested-changes', () => {
  test('a suggested change is built on what its project runs, and its check starts (201 checking)', async () => {
    const { call, releases, freeze, suggestedChanges } = await harness();
    releases.pin(PROJECT, '1.0.0');
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      agentId: AGENT,
      projectId,
      title: `Recent filings matter more for acme: ${WEIGHTS} v1.0.0 → v1.0.1`,
      madeBy: { kind: 'person', userId: 'user-1' },
      builtOn: { version: '1.0.0' },
      version: '1.0.1',
      changes: [{ kind: 'block', blockId: WEIGHTS, from: '1.0.0', to: '1.0.1' }],
      why: CARD.why,
      fixes: [],
      check: { status: 'running', testSetId: FROZEN.testSetId },
      status: 'checking',
    });
    // The content before and after is one suggested change's (GET), not an answer's.
    expect(res.body.changes[0]).not.toHaveProperty('before');
    expect(freeze.calls).toEqual([{ tenantId, agentId: AGENT, projectId }]);
    expect(suggestedChanges.rows.get(res.body.id)?.scope).toEqual(PROJECT);
  });

  test('its check runs the change and what the project runs now on the same frozen cases, in the project', async () => {
    const { id, withRun, nowRun, testRuns } = await made();
    const run = { projectId, testSetId: FROZEN.testSetId, testSetVersion: FROZEN.testSetVersion };
    expect(testRuns.started).toEqual([
      expect.objectContaining({
        ...run,
        agentRef: { agentId: AGENT, version: '1.0.1' },
        correlationId: `suggested-change:${id}`,
      }),
      expect.objectContaining({
        ...run,
        agentRef: { agentId: AGENT, version: '1.0.0' },
        correlationId: `suggested-change:${id}`,
      }),
    ]);
    expect([...testRuns.runs.keys()]).toEqual([withRun, nowRun]);
  });

  test('it publishes the block version and derives an agent version, pinned nowhere', async () => {
    const { id, blocks, agents, releases } = await made();
    const block = blocks.rows.get(`${WEIGHTS}@1.0.1`);
    expect(block?.content).toMatchObject({ values: CARD.values });
    // The schema carried over from the pinned version.
    expect(block?.content).toHaveProperty('schema');
    // Who published it, and from where: the caller, from this suggested change.
    expect(block?.publishedBy).toEqual({ kind: 'user', id: 'user-1' });
    expect(block?.source).toEqual({ kind: 'suggested-change', id });
    const derived = await agents.getVersion({
      tenantId,
      agentId: AGENT as never,
      version: '1.0.1' as Semver,
    });
    expect(derived?.pins?.settings[WEIGHTS]).toBe('1.0.1');
    expect(derived?.derivedFrom).toMatchObject({
      version: '1.0.0',
      reason: 'edited',
      suggestedChangeId: id,
    });
    expect(releases.calls).toEqual([]);
    expect(releases.pins.map((p) => p.version)).toEqual(['1.0.0']);
  });

  test("its title is the first line of why, without the stop that ends it, then the block's change", async () => {
    const short = await made({ card: { why: 'Fit first.\nRecent filings matter less than fit.' } });
    expect((await short.call('GET', `/v1/suggested-changes/${short.id}`)).body.title).toBe(
      `Fit first: ${WEIGHTS} v1.0.0 → v1.0.1`,
    );
    const long = await made({
      card: { why: `${'Recent filings matter more '.repeat(3)}for acme` },
    });
    expect((await long.call('GET', `/v1/suggested-changes/${long.id}`)).body.title).toBe(
      `${'Recent filings matter more '.repeat(3).slice(0, 60).trimEnd()}…: ${WEIGHTS} v1.0.0 → v1.0.1`,
    );
  });

  test('in an environment order, one for the first environment is made and checked there', async () => {
    const staging1 = randomUUID() as ProjectId;
    const staging2 = randomUUID() as ProjectId;
    const { call, releases, blocks, agents, testRuns, freeze } = await harness({
      orders: [[staging1, staging2, projectId]],
    });
    releases.pin({ kind: 'project', projectId: staging1 }, '1.0.0');
    const res = await call('POST', '/v1/suggested-changes', { ...CARD, projectId: staging1 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(blocks.rows.get(`${WEIGHTS}@1.0.1`)?.projectId).toBe(staging1);
    const derived = await agents.getVersion({
      tenantId,
      agentId: AGENT as never,
      version: '1.0.1' as Semver,
    });
    expect(derived?.projectId).toBe(projectId);
    expect(derived?.madeInProjectId).toBe(staging1);
    expect(freeze.calls).toEqual([{ tenantId, agentId: AGENT, projectId: staging1 }]);
    expect(testRuns.started).toEqual([
      expect.objectContaining({ projectId: staging1 }),
      expect.objectContaining({ projectId: staging1 }),
    ]);
  });

  test("one for a later environment of an order is refused (409 environment-takes-promotions): the order's first takes the change", async () => {
    const staging1 = randomUUID() as ProjectId;
    const { call, releases, suggestedChanges, freeze } = await harness({
      orders: [[staging1, projectId]],
    });
    releases.pin(PROJECT, '1.0.0');
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('environment-takes-promotions');
    expect(suggestedChanges.rows.size).toBe(0);
    expect(freeze.calls).toEqual([]);
  });

  test('the same change again is the same suggested change, marked deduped, and not checked again', async () => {
    const { call, id, testRuns } = await made();
    const again = await call('POST', '/v1/suggested-changes', CARD);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.headers.get('x-suggested-change-deduped')).toBe('true');
    expect(again.body.id).toBe(id);
    expect(testRuns.started).toHaveLength(2);
  });

  test.each([
    [
      'a block the version does not pin',
      { block: 'acme.other', values: { x: 1 } },
      'adding a block is a code change',
    ],
    ['values the schema refuses', { values: { recency: 2, fit: 0.5 } }, 'recency'],
    [
      'the content the version already pins',
      { values: { fit: 0.7, recency: 0.3 } },
      "doesn't change",
    ],
    ['a template for a settings block', { values: undefined, template: 'x' }, 'send `values`'],
    ['values for a prompt block', { block: 'acme.scorer-prompt' }, 'send `template`'],
  ])(
    'refuses %s (400 validation-failed), and stores and checks nothing',
    async (_name, patch, words) => {
      const { call, releases, suggestedChanges, testRuns } = await harness();
      releases.pin(PROJECT, '1.0.0');
      const res = await call('POST', '/v1/suggested-changes', { ...CARD, ...patch });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.code).toBe('validation-failed');
      expect(JSON.stringify(res.body.error)).toContain(words);
      expect(suggestedChanges.rows.size).toBe(0);
      expect(testRuns.started).toEqual([]);
    },
  );

  test.each([
    ['no why', { why: '' }],
    ['no project', { projectId: undefined }],
    ['both values and a template', { template: 'x' }],
    ['neither values nor a template', { values: undefined }],
    ['fixes that are no correction ids', { fixes: [1] }],
    ['a tier, which the block decides', { tier: 'settings-block' }],
    ['a scope, which is the project', { scope: { kind: 'tenant' } }],
    ['a version to build on, which is what the project runs', { fromVersion: '1.0.0' }],
    ['evidence, which is `fixes`', { evidence: { fixes: ['j-1'] } }],
  ])('refuses %s (400 bad-input)', async (_name, patch) => {
    const { call, suggestedChanges } = await harness();
    const res = await call('POST', '/v1/suggested-changes', { ...CARD, ...patch });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
    expect(suggestedChanges.rows.size).toBe(0);
  });

  test('an unknown field is named', async () => {
    const { call } = await harness();
    const res = await call('POST', '/v1/suggested-changes', { ...CARD, tier: 'settings-block' });
    expect(res.body.error.message).toContain("`tier` isn't a field of a suggested change");
  });

  test('a project that runs nothing is refused (409 nothing-runs-in-scope)', async () => {
    const { call, releases, suggestedChanges, freeze } = await harness();
    releases.state.latest = null;
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('nothing-runs-in-scope');
    expect(suggestedChanges.rows.size).toBe(0);
    expect(freeze.calls).toEqual([]);
  });

  test('a project on Latest gets one built on its Latest', async () => {
    const { call } = await harness();
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.builtOn).toEqual({ version: '1.0.0' });
  });

  test('a version the project runs that the registry lacks, or has unregistered, is 404 agent-version-not-found', async () => {
    const gone = await harness();
    gone.releases.pin(PROJECT, '9.9.9');
    const unregistered = await harness({ unregisteredVersions: ['1.0.0'] });
    unregistered.releases.pin(PROJECT, '1.0.0');
    for (const h of [gone, unregistered]) {
      const res = await h.call('POST', '/v1/suggested-changes', CARD);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error.code).toBe('agent-version-not-found');
      expect(h.suggestedChanges.rows.size).toBe(0);
    }
  });

  test('a project with no corrections to check on is refused (409 suggested-change-nothing-to-check), and nothing is made', async () => {
    const { call, releases, suggestedChanges, blocks, testRuns } = await harness({ cases: 0 });
    releases.pin(PROJECT, '1.0.0');
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'suggested-change-nothing-to-check',
      details: { projectId },
    });
    expect(suggestedChanges.rows.size).toBe(0);
    expect([...blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toEqual([
      `${WEIGHTS}@1.0.0`,
    ]);
    expect(testRuns.started).toEqual([]);
  });

  test("a runtime that freezes no test set can't check one (501), so it makes none", async () => {
    const { call, releases, suggestedChanges } = await harness({ freezes: false });
    releases.pin(PROJECT, '1.0.0');
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(501);
    expect(res.body.error.code).toBe('suggested-change-check-unsupported');
    expect(suggestedChanges.rows.size).toBe(0);
  });

  test.each([
    [true, true],
    [true, false],
    ['takes-candidates', true],
    ['takes-candidates', false],
  ] as const)(
    'a read-only agent registry (%s; freezes a test set: %s) refuses it first (409 registry-read-only), with its reason, and publishes nothing',
    async (readOnly, freezes) => {
      const { call, releases, blocks, suggestedChanges, testRuns } = await harness({
        readOnly,
        freezes,
      });
      releases.pin(PROJECT, '1.0.0');
      const res = await call('POST', '/v1/suggested-changes', CARD);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'registry-read-only',
        message: TAKES_CANDIDATES.reason,
      });
      expect([...blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toHaveLength(1);
      expect(suggestedChanges.rows.size).toBe(0);
      expect(testRuns.started).toEqual([]);
    },
  );

  test("model settings that aren't are refused (400), before anything is stored", async () => {
    const { call, releases, blocks, agents, suggestedChanges, testRuns } = await harness({
      modelSettings: true,
    });
    releases.pin(PROJECT, '1.0.0');
    const res = await call('POST', '/v1/suggested-changes', {
      ...CARD,
      block: MODEL,
      values: { temperature: 5 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'validation-failed',
      message: `The suggested change's content isn't model settings, which block "${MODEL}" is`,
    });
    expect([...blocks.rows.keys()].filter((k) => k.startsWith(MODEL))).toEqual([`${MODEL}@1.0.0`]);
    expect(
      await agents.getVersion({ tenantId, agentId: AGENT as never, version: '1.0.1' as Semver }),
    ).toBeNull();
    expect(suggestedChanges.rows.size).toBe(0);
    expect(testRuns.started).toHaveLength(0);
  });

  test('model settings that name the model the agent version names too are refused (400), before anything is stored', async () => {
    const { call, releases, blocks, agents, suggestedChanges, testRuns } = await harness({
      modelSettings: true,
      preferredModel: 'claude-sonnet-5-5',
    });
    releases.pin(PROJECT, '1.0.0');
    const res = await call('POST', '/v1/suggested-changes', {
      ...CARD,
      block: MODEL,
      values: { temperature: 0.2, model: 'claude-haiku-4-5' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'validation-failed',
      message: "The suggested change's model settings name the model twice",
      details: {
        issues: [
          {
            path: '/content/values',
            message: `model-settings block "${MODEL}": it sets model, and the agent version sets preferredModel: name the model in one place, the block or the agent version`,
          },
        ],
      },
    });
    expect([...blocks.rows.keys()].filter((k) => k.startsWith(MODEL))).toEqual([`${MODEL}@1.0.0`]);
    expect(
      await agents.getVersion({ tenantId, agentId: AGENT as never, version: '1.0.1' as Semver }),
    ).toBeNull();
    expect(suggestedChanges.rows.size).toBe(0);
    expect(testRuns.started).toHaveLength(0);
  });

  test("its schemas' compiles count against the tenant's budget, first ones included: refused, nothing is stored", async () => {
    const { call, releases, blocks, agents, suggestedChanges, testRuns } = await harness();
    releases.pin(PROJECT, '1.0.0');
    const create = () => call('POST', '/v1/suggested-changes', CARD);
    const restore = overrideTenantInputBounds({ ...SELF_HOSTED_BOUNDS, schemaCompileBudgetMs: 0 });
    try {
      await expectCompileBudgetRefused(await create());
      expect([...blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toEqual([
        `${WEIGHTS}@1.0.0`,
      ]);
      expect(
        await agents.getVersion({ tenantId, agentId: AGENT as never, version: '1.0.1' as Semver }),
      ).toBeNull();
      expect(suggestedChanges.rows.size).toBe(0);
      expect(testRuns.started).toHaveLength(0);
    } finally {
      restore();
    }
    expect((await create()).status).toBe(201);
  });

  test('a step recorded meanwhile is 409, not a lost write: the suggested change is made, and checked again later', async () => {
    const { call, releases, suggestedChanges } = await harness();
    releases.pin(PROJECT, '1.0.0');
    suggestedChanges.before = () => {
      suggestedChanges.before = undefined;
      for (const [id, row] of suggestedChanges.rows) {
        suggestedChanges.rows.set(id, { ...row, revision: row.revision + 1 });
      }
    };
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.message).toContain("was made, but its check didn't start");
    expect(res.body.error.message).toContain('changed while this ran');
    const id = res.body.error.details.suggestedChangeId as string;
    expect(suggestedChanges.rows.has(id)).toBe(true);
    const again = await call('POST', `/v1/suggested-changes/${id}/check`);
    expect(again.status, JSON.stringify(again.body)).toBe(202);
  });

  test("when what the project runs now can't start, the change's run is cancelled: made, check-failed, and checked again later", async () => {
    const { call, releases, testRuns } = await harness();
    releases.pin(PROJECT, '1.0.0');
    testRuns.fail.start = 2;
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error.code).toBe('test-set-not-found');
    expect(res.body.error.message).toContain("was made, but its check didn't start");
    const id = res.body.error.details.suggestedChangeId as string;
    expect(testRuns.cancelled).toEqual([...testRuns.runs.keys()]);
    expect(testRuns.cancelled).toHaveLength(1);
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body).toMatchObject({
      status: 'check-failed',
      version: '1.0.1',
      check: { status: 'not-started' },
    });
    testRuns.fail.start = undefined;
    const again = await call('POST', `/v1/suggested-changes/${id}/check`);
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    expect(again.body.status).toBe('checking');
  });
});

describe("a suggested change's check", () => {
  test('is ready once both runs finish, and shows how each did and what newly fails', async () => {
    const { call, id, withRun, nowRun, testRuns } = await made();
    await testRuns.finish(withRun, {
      delta: 0.1,
      more: more(
        [
          ['j1', true],
          ['j2', false],
          ['j3', true],
        ],
        { candidate: 0.26, cases: 12 },
      ),
    });
    // The change's run finished; what the project runs now is still running.
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body).toMatchObject({
      status: 'checking',
      check: { status: 'running' },
    });
    await testRuns.finish(nowRun, {
      delta: 0,
      more: more(
        [
          ['j1', true],
          ['j2', true],
          ['j3', false],
        ],
        { candidate: 0.42, cases: 12 },
      ),
    });
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body).toMatchObject({
      status: 'ready',
      check: {
        status: 'done',
        testSetId: FROZEN.testSetId,
        testSetVersion: FROZEN.testSetVersion,
        with: { testRunId: withRun, passing: 2, of: 3, costPerConversation: '0.0217' },
        now: { testRunId: nowRun, passing: 2, of: 3, costPerConversation: '0.035' },
        newlyFailing: ['j2'],
      },
    });
  });

  test('a run that failed is check-failed', async () => {
    const { call, id, withRun, nowRun, testRuns } = await made();
    await testRuns.finish(withRun, { delta: 0.1 });
    await testRuns.finish(nowRun, 'failed');
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body).toMatchObject({
      status: 'check-failed',
      check: { status: 'failed' },
    });
  });
});

describe('POST /v1/suggested-changes/:id/check', () => {
  test('after a failed check it checks again on the test set as frozen now, with the version already made', async () => {
    const { call, id, withRun, testRuns, freeze, blocks } = await made();
    await testRuns.finish(withRun, 'failed');
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body.status).toBe('check-failed');
    freeze.state.version = '1.0.8';
    const res = await call('POST', `/v1/suggested-changes/${id}/check`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({
      status: 'checking',
      version: '1.0.1',
      check: { status: 'running' },
    });
    expect(res.body.check.with.testRunId).not.toBe(withRun);
    expect([...blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toHaveLength(2);
    expect(testRuns.started.slice(2)).toEqual([
      expect.objectContaining({
        testSetVersion: '1.0.8',
        agentRef: { agentId: AGENT, version: '1.0.1' },
      }),
      expect.objectContaining({
        testSetVersion: '1.0.8',
        agentRef: { agentId: AGENT, version: '1.0.0' },
      }),
    ]);
  });

  test('a ready one can be checked again, for new scores', async () => {
    const { call, id } = await checked();
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body.status).toBe('ready');
    const res = await call('POST', `/v1/suggested-changes/${id}/check`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.status).toBe('checking');
  });

  test('while checking, check again is 409 suggested-change-invalid-state-transition', async () => {
    const { call, id, testRuns } = await made();
    const res = await call('POST', `/v1/suggested-changes/${id}/check`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'suggested-change-invalid-state-transition',
      details: { status: 'checking' },
    });
    expect(testRuns.started).toHaveLength(2);
  });

  test("it takes no fields: it runs on the project's test set (400 naming the field)", async () => {
    const { call, id, withRun, testRuns } = await made();
    await testRuns.finish(withRun, 'failed');
    const res = await call('POST', `/v1/suggested-changes/${id}/check`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('`testSetId`');
    expect(testRuns.started).toHaveLength(2);
  });

  test('a project with no corrections left to check on is refused (409 suggested-change-nothing-to-check)', async () => {
    const { call, id, withRun, testRuns, freeze } = await made();
    await testRuns.finish(withRun, 'failed');
    freeze.state.cases = 0;
    const res = await call('POST', `/v1/suggested-changes/${id}/check`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('suggested-change-nothing-to-check');
    expect(testRuns.started).toHaveLength(2);
  });

  test.each([true, 'takes-candidates'] as const)(
    'a read-only agent registry (%s) refuses it (409 registry-read-only), with its reason, and starts nothing',
    async (readOnly) => {
      const h = await harness({ readOnly });
      const id = await oldRow(h, PROJECT);
      const res = await h.call('POST', `/v1/suggested-changes/${id}/check`);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'registry-read-only',
        message: TAKES_CANDIDATES.reason,
      });
      expect(h.testRuns.started).toEqual([]);
    },
  );

  test.each([
    ['the whole tenant', { kind: 'tenant' } as LiveScope],
    ['an org', ORG_SCOPE],
    ['a segment', SEGMENT],
  ])(
    'one made for %s before suggested changes were for a project can only be withdrawn (409 suggested-change-not-for-a-project)',
    async (_name, scope) => {
      const h = await harness();
      const id = await oldRow(h, scope);
      const res = await h.call('POST', `/v1/suggested-changes/${id}/check`);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'suggested-change-not-for-a-project',
        details: { suggestedChangeId: id },
      });
      expect(h.testRuns.started).toEqual([]);
      const withdrawn = await h.call('POST', `/v1/suggested-changes/${id}/withdraw`, {
        reason: 'made before suggested changes were for a project',
      });
      expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
      expect(withdrawn.body.status).toBe('withdrawn');
    },
  );
});

describe('POST /v1/suggested-changes/:id/pin', () => {
  test('one still checking, or whose check failed, cannot be pinned (409)', async () => {
    const { call, id, withRun, testRuns } = await made();
    const checking = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(checking.status).toBe(409);
    expect(checking.body.error.details.status).toBe('checking');
    await testRuns.finish(withRun, 'failed');
    const failed = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(failed.status).toBe(409);
    expect(failed.body.error.details.status).toBe('check-failed');
  });

  test('a ready one no better than now can still be pinned: the gate decides', async () => {
    const { call, id } = await checked(0);
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body.status).toBe('ready');
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      status: 'pinned',
      pinned: { version: '1.0.1', by: { kind: 'user', id: 'user-1' } },
    });
  });

  test('with no gate policy it pins the version for the project (201)', async () => {
    const { call, id, releases } = await checked();
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {
      reason: 'acme wants recency',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('pinned');
    const request = releases.calls.find((c) => c.method === 'request')?.input as Record<
      string,
      unknown
    >;
    expect(request).toMatchObject({
      agentId: AGENT,
      version: '1.0.1',
      scope: PROJECT,
      reason: 'acme wants recency',
      gate: { policy: null, passed: true, servingVersion: '1.0.0' },
    });
    expect(releases.pins.map((p) => [p.scope, p.version])).toEqual([[PROJECT, '1.0.1']]);
  });

  test('a policy that wants an approval waits for a second person (202), then is pinned once approved', async () => {
    const { call, id, releases, suggestedChanges } = await checked();
    const spec: GatePolicySpec = { approvals: { role: 'standard' } };
    releases.state.policy = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: PROJECT,
      spec,
      createdAt: NOW,
    };
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ status: 'waiting-for-second-person', approvalId: 'appr-1' });
    expect(
      (await call('POST', `/v1/suggested-changes/${id}/withdraw`, { reason: 'x' })).status,
    ).toBe(409);

    releases.decide(suggestedChanges.rows.get(id)?.promotionId as string, 'promoted');
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body).toMatchObject({
      status: 'pinned',
      pinned: { version: '1.0.1' },
    });
  });

  test("a gate refusal is 422 gate-failed with the suggested change's id; it stays ready, noted, and can be checked again", async () => {
    const { call, id, releases } = await checked();
    releases.state.policy = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: PROJECT,
      spec: { metrics: [{ name: 'weightedYesShare', minCandidate: 0.99 }] },
      createdAt: NOW,
    };
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'gate-failed',
      details: { suggestedChangeId: id },
    });
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body).toMatchObject({
      status: 'ready',
      note: { kind: 'gate-refused' },
    });

    const again = await call('POST', `/v1/suggested-changes/${id}/check`);
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    expect(again.body.status).toBe('checking');
    expect(again.body.note).toBeUndefined();
  });

  test('a project on Latest takes no pin (409 suggested-change-project-on-latest), and nothing is requested', async () => {
    const { call, testRuns, releases } = await harness();
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await testRuns.finish(res.body.check.with.testRunId, { delta: 0.1 });
    await testRuns.finish(res.body.check.now.testRunId, { delta: 0 });
    const pin = await call('POST', `/v1/suggested-changes/${res.body.id}/pin`, {});
    expect(pin.status, JSON.stringify(pin.body)).toBe(409);
    expect(pin.body.error).toMatchObject({
      code: 'suggested-change-project-on-latest',
      details: { suggestedChangeId: res.body.id },
    });
    expect(releases.calls).toEqual([]);
  });

  test('one made for the whole tenant before suggested changes were for a project is not pinned (409 suggested-change-not-for-a-project)', async () => {
    const h = await harness();
    const id = await oldRow(h, { kind: 'tenant' }, { checked: true });
    expect((await h.call('GET', `/v1/suggested-changes/${id}`)).body.status).toBe('ready');
    const res = await h.call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('suggested-change-not-for-a-project');
    expect(h.releases.calls).toEqual([]);
  });
});

describe('POST /v1/suggested-changes/:id/add-as-latest', () => {
  /** A ready suggested change for a project on Latest (nothing pinned). */
  async function readyOnLatest(opts: HarnessOpts = {}) {
    const h = await harness(opts);
    const res = await h.call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await h.testRuns.finish(res.body.check.with.testRunId, { delta: 0.1 });
    await h.testRuns.finish(res.body.check.now.testRunId, { delta: 0 });
    return { ...h, id: res.body.id as string, version: res.body.version as string };
  }

  test('a ready one for a project on Latest is added as its Latest (200), with no gate, and keeps its reason', async () => {
    const h = await readyOnLatest();
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/add-as-latest`, {
      reason: 'Fit first for acme',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: 'added-as-latest',
      addedAsLatest: {
        version: h.version,
        by: { kind: 'user', id: 'user-1' },
        at: NOW,
        reason: 'Fit first for acme',
      },
    });
    expect(h.agents.marked).toEqual([
      { tenantId, agentId: AGENT, version: h.version, by: { kind: 'user', id: 'user-1' } },
    ]);
    expect(h.releases.calls).toEqual([]);
    const got = await h.call('GET', `/v1/suggested-changes/${h.id}`);
    expect(got.body.status).toBe('added-as-latest');
    // Done: it's neither added again, pinned, nor withdrawn.
    for (const action of ['add-as-latest', 'pin']) {
      const again = await h.call('POST', `/v1/suggested-changes/${h.id}/${action}`, {});
      expect(again.status, action).toBe(409);
      expect(again.body.error.details.status).toBe('added-as-latest');
    }
    const withdraw = await h.call('POST', `/v1/suggested-changes/${h.id}/withdraw`, {
      reason: 'too late',
    });
    expect(withdraw.status).toBe(409);
    expect(h.agents.marked).toHaveLength(1);
  });

  test('without a reason, none is kept', async () => {
    const h = await readyOnLatest();
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/add-as-latest`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.addedAsLatest).not.toHaveProperty('reason');
  });

  test('one still checking is refused (409), and nothing is marked', async () => {
    const h = await harness();
    const made = await h.call('POST', '/v1/suggested-changes', CARD);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const res = await h.call('POST', `/v1/suggested-changes/${made.body.id}/add-as-latest`, {});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'suggested-change-invalid-state-transition',
      details: { status: 'checking' },
    });
    expect(h.agents.marked).toEqual([]);
  });

  test('a pinned project takes a pin instead (409 suggested-change-project-pinned), and nothing is marked', async () => {
    const h = await checked(0.1);
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/add-as-latest`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'suggested-change-project-pinned',
      details: { suggestedChangeId: h.id },
    });
    expect(h.agents.marked).toEqual([]);
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('ready');
  });

  test('a version unregistered since is not added (404 agent-version-not-found), and it stays ready', async () => {
    const h = await readyOnLatest();
    // Unregistered after its check: the registry no longer finds it.
    h.agents.markLatest = async ({ agentId, version }) => ({ kind: 'not-found', agentId, version });
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/add-as-latest`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error.code).toBe('agent-version-not-found');
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('ready');
  });

  test('one made for a whole tenant before suggested changes were for a project is not added (409 suggested-change-not-for-a-project)', async () => {
    const h = await harness();
    const id = await oldRow(h, { kind: 'tenant' }, { checked: true });
    const res = await h.call('POST', `/v1/suggested-changes/${id}/add-as-latest`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('suggested-change-not-for-a-project');
    expect(h.agents.marked).toEqual([]);
  });

  test('adding as Latest needs promote, as pinning does', async () => {
    const h = await readyOnLatest({ grants: [`read agent:${AGENT}`, `publish agent:${AGENT}`] });
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/add-as-latest`, {});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('promote');
    expect(h.agents.marked).toEqual([]);
  });
});

describe('POST /v1/suggested-changes/:id/withdraw', () => {
  test('withdraw needs a reason, closes one still checking, and a withdrawn one can no longer be checked', async () => {
    const { call, id } = await made();
    expect((await call('POST', `/v1/suggested-changes/${id}/withdraw`, {})).status).toBe(400);
    const res = await call('POST', `/v1/suggested-changes/${id}/withdraw`, {
      reason: 'wrong block',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: 'withdrawn',
      withdrawn: { reason: 'wrong block', by: { kind: 'user', id: 'user-1' } },
    });
    const check = await call('POST', `/v1/suggested-changes/${id}/check`);
    expect(check.status).toBe(409);
    expect(check.body.error.details.status).toBe('withdrawn');
  });

  test('one whose check failed, or that is ready, can be withdrawn', async () => {
    const failed = await made();
    await failed.testRuns.finish(failed.withRun, 'failed');
    const ready = await checked();
    for (const h of [failed, ready]) {
      const res = await h.call('POST', `/v1/suggested-changes/${h.id}/withdraw`, { reason: 'x' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe('withdrawn');
    }
  });
});

describe('an agent an environment order carries: a tenant- or org-wide change spans the order (409)', () => {
  const PROD = randomUUID() as ProjectId;
  // The caller administers both environments, so the authorization passes and
  // the width — not a missing right — is what refuses the change.
  const wide = {
    orders: [[projectId, PROD]],
    items: [{ kind: 'agent' as const, id: AGENT, projects: [projectId, PROD] }],
    grants: [
      `read project:${projectId}`,
      `write project:${projectId}`,
      `admin project:${projectId}`,
      `read project:${PROD}`,
      `write project:${PROD}`,
      `admin project:${PROD}`,
    ],
  };

  const spans = (scope: LiveScope) => async () => {
    const h = await harness(wide);
    const id = await oldRow(h, scope);
    const res = await h.call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('live-scope-spans-environments');
  };

  test('a tenant-wide pin from before is refused', spans({ kind: 'tenant' }));
  test('an org-wide pin from before is refused', spans(ORG_SCOPE));

  test('one for the first environment is not a width refusal', async () => {
    const h = await harness(wide);
    h.releases.pin(PROJECT, '1.0.0');
    const made = await h.call('POST', '/v1/suggested-changes', CARD);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // One project stays within one environment: past the width check, on to
    // the service (where it's still checking).
    const res = await h.call('POST', `/v1/suggested-changes/${made.body.id}/pin`, {});
    expect(res.body.error?.code).not.toBe('live-scope-spans-environments');
  });

  // M1: the refusal is keyed on order membership, not project count. One
  // project serves this agent, and it is the order's first environment, so a
  // tenant-wide request still spans the order (its authz is today's promote
  // on the agent, since one project serves it).
  test('one project serves the agent, and it is the order’s first environment: a tenant-wide request still spans it (409)', async () => {
    const one: ItemRow[] = [{ kind: 'agent', id: AGENT, projects: [projectId] }];
    const h = await harness({
      orders: [[projectId, PROD]],
      items: one,
      grants: [`publish agent:${AGENT}`, `promote agent:${AGENT}`, `read agent:${AGENT}`],
    });
    const id = await oldRow(h, { kind: 'tenant' });
    const res = await h.call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('live-scope-spans-environments');
  });
});

describe('GET /v1/suggested-changes', () => {
  type Row = { id: string; status: string };
  const ids = (res: { body: Record<string, any> }) => res.body.data.map((p: Row) => p.id);

  test('lists newest first with derived statuses; filters by status and agent', async () => {
    const h = await made();
    const { call, id, testRuns } = h;
    const second = await call('POST', '/v1/suggested-changes', {
      ...CARD,
      values: { recency: 0.4, fit: 0.6 },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    await testRuns.finish(second.body.check.with.testRunId, { delta: 0.2 });
    await testRuns.finish(second.body.check.now.testRunId, { delta: 0 });
    const old = await oldRow(h, SEGMENT);

    const all = await call('GET', '/v1/suggested-changes');
    expect(ids(all)).toEqual([old, second.body.id, id]);
    expect(all.body.data.map((p: Row) => p.status)).toEqual(['check-failed', 'ready', 'checking']);
    expect(ids(await call('GET', '/v1/suggested-changes?status=ready'))).toEqual([second.body.id]);
    expect((await call('GET', '/v1/suggested-changes?agentId=acme.other')).body.data).toEqual([]);
    expect((await call('GET', '/v1/suggested-changes?status=applied')).status).toBe(400);
  });

  test('filters by the project a suggested change is for', async () => {
    const h = await made();
    await oldRow(h, SEGMENT);
    expect(ids(await h.call('GET', `/v1/suggested-changes?projectId=${projectId}`))).toEqual([
      h.id,
    ]);
    expect(
      (await h.call('GET', `/v1/suggested-changes?projectId=${randomUUID()}`)).body.data,
    ).toEqual([]);
  });

  test('filters by who made it', async () => {
    const h = await made();
    const byAccount = await h.call(
      'POST',
      '/v1/suggested-changes',
      { ...CARD, values: { recency: 0.4, fit: 0.6 } },
      ACCOUNT_TOKEN,
    );
    expect(byAccount.status, JSON.stringify(byAccount.body)).toBe(201);
    expect(byAccount.body.madeBy).toEqual({ kind: 'service', id: 'sa-ci' });
    const madeBy = async (kind: string) =>
      ids(await h.call('GET', `/v1/suggested-changes?madeBy=${kind}`));
    expect(await madeBy('person')).toEqual([h.id]);
    expect(await madeBy('service')).toEqual([byAccount.body.id]);
    expect(await madeBy('improve-run')).toEqual([]);
    expect((await h.call('GET', '/v1/suggested-changes?madeBy=robot')).status).toBe(400);
  });

  test("one suggested change shows its block's content before and after; the list doesn't", async () => {
    const { call, id } = await made();
    const res = await call('GET', `/v1/suggested-changes/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.changes).toEqual([
      {
        kind: 'block',
        blockId: WEIGHTS,
        from: '1.0.0',
        to: '1.0.1',
        before: { values: { recency: 0.3, fit: 0.7 } },
        after: { values: CARD.values },
      },
    ]);
    expect((await call('GET', '/v1/suggested-changes')).body.data[0].changes[0]).not.toHaveProperty(
      'before',
    );

    const prompt = await call('POST', '/v1/suggested-changes', {
      agentId: AGENT,
      projectId,
      block: 'acme.scorer-prompt',
      template: 'Score it, recent filings first.',
      why: 'Recent filings matter more for acme',
    });
    expect(prompt.status, JSON.stringify(prompt.body)).toBe(201);
    expect(
      (await call('GET', `/v1/suggested-changes/${prompt.body.id}`)).body.changes[0],
    ).toMatchObject({
      before: { template: 'Score it.' },
      after: { template: 'Score it, recent filings first.' },
    });
  });
});

describe('authorization on the agent', () => {
  test("a suggested change of an agent the caller can't read is 404, and isn't listed", async () => {
    const grants = [`publish agent:${AGENT}`, `read agent:${AGENT}`];
    const { call, id } = await made({ grants });
    expect((await call('GET', `/v1/suggested-changes/${id}`)).status).toBe(200);
    grants.splice(0, grants.length);
    expect((await call('GET', `/v1/suggested-changes/${id}`)).status).toBe(404);
    expect((await call('GET', '/v1/suggested-changes')).body.data).toEqual([]);
  });

  test('making one needs publish; pinning needs promote', async () => {
    const reader = await harness({ grants: [`read agent:${AGENT}`] });
    reader.releases.pin(PROJECT, '1.0.0');
    const res = await reader.call('POST', '/v1/suggested-changes', CARD);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('publish');
    expect(reader.suggestedChanges.rows.size).toBe(0);

    const h = await checked(0.1, { grants: [`read agent:${AGENT}`, `publish agent:${AGENT}`] });
    const pin = await h.call('POST', `/v1/suggested-changes/${h.id}/pin`, {});
    expect(pin.status).toBe(403);
    expect(pin.body.error.message).toContain('promote');
  });

  test('checking needs publish, as making does', async () => {
    const grants = [`read agent:${AGENT}`, `publish agent:${AGENT}`];
    const h = await checked(0, { grants });
    grants.pop(); // read only, from here on
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/check`);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('publish');
    expect(h.testRuns.started).toHaveLength(2);
  });

  test('withdrawing needs publish, as making does', async () => {
    const grants = [`read agent:${AGENT}`, `publish agent:${AGENT}`];
    const h = await made({ grants });
    grants.pop(); // read only, from here on
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/withdraw`, { reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('publish');
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('checking');
  });
});

describe('a suggested change a drafter wrote (not a person)', () => {
  test('it answers with the corrections it fixes, and that a service made it', async () => {
    const h = await harness();
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      releases: h.releases.releases,
    });
    const drafted = await service.draft({
      tenantId,
      agentId: AGENT,
      fromVersion: '1.0.0',
      scope: PROJECT,
      tier: 'settings-block',
      blockId: WEIGHTS,
      content: { values: { recency: 0.6, fit: 0.4 } },
      why: 'The search found these weights',
      evidence: { fixes: ['j-1', 'j-2'], correctionCount: 140 },
      drafter: { kind: 'settings-optimizer', version: '1' },
    });
    if (drafted.kind !== 'ok') throw new Error(JSON.stringify(drafted.error));
    const res = await h.call('GET', `/v1/suggested-changes/${drafted.value.suggestedChange.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      fixes: ['j-1', 'j-2'],
      madeBy: { kind: 'service', id: 'settings-optimizer' },
    });
  });

  test('its request waits for a reviewer even where no gate policy asks for one (K2)', async () => {
    const h = await harness();
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      releases: h.releases.releases,
    });
    const actor = { kind: 'service' as const, id: 'improve-run' };
    const drafted = await service.draft({
      tenantId,
      agentId: AGENT,
      fromVersion: '1.0.0',
      scope: PROJECT,
      tier: 'settings-block',
      blockId: WEIGHTS,
      content: { values: { recency: 0.6, fit: 0.4 } },
      why: 'The search found these weights',
      drafter: { kind: 'settings-optimizer', version: '1' },
    });
    if (drafted.kind !== 'ok') throw new Error(JSON.stringify(drafted.error));
    const evaluated = await service.evaluate({
      tenantId,
      suggestedChange: drafted.value.suggestedChange,
      testSetId: 'acme.scoring-judged',
      objective: 'weightedYesShare',
      actor,
    });
    if (evaluated.kind !== 'ok') throw new Error(JSON.stringify(evaluated.error));
    const runId = evaluated.value.evaluation?.testRunId as string;
    await h.testRuns.finish(runId, { delta: 0.2 });
    const requested = await service.pin({ tenantId, suggestedChange: evaluated.value, actor });
    if (requested.kind !== 'ok') throw new Error(JSON.stringify(requested.error));
    expect(requested.value.promotion).toMatchObject({
      kind: 'ok',
      promotion: { status: 'pending-approval' },
    });
    const request = h.releases.calls.find((c) => c.method === 'request')?.input as {
      gate: unknown;
      requestedBy: unknown;
    };
    expect(request.gate).toMatchObject({
      policy: null,
      passed: true,
      approval: { role: 'standard', count: 1, separateApprover: false },
    });
    expect(request.requestedBy).toEqual(actor);
    const derived = await h.agents.getVersion({
      tenantId,
      agentId: AGENT as never,
      version: '1.0.1' as Semver,
    });
    expect(derived?.derivedFrom).toMatchObject({ by: 'service:improve-run' });
  });

  function roster(
    ...people: readonly {
      userId: string;
      role?: 'standard' | 'senior' | 'admin';
      deactivated?: boolean;
    }[]
  ): Pick<ReviewerRegistryBinding, 'list'> {
    return {
      async list() {
        return {
          data: people.map((p, i) => ({
            id: `reviewer-${i}` as ReviewerId,
            tenantId,
            userId: p.userId as UserId,
            role: p.role ?? 'standard',
            createdAt: '2026-01-01T00:00:00.000Z' as Timestamp,
            ...(p.deactivated === true && {
              deactivatedAt: '2026-02-01T00:00:00.000Z' as Timestamp,
            }),
          })),
        };
      },
    };
  }

  /**
   * An authorizer that allows `read` only for the given `userId → resources`
   * grants, and records the checks it was asked — so a test can assert the
   * count asked whether each reviewer may read the approval's resource, and
   * that it asked about the RIGHT one (the scope's, not the test run's).
   */
  function authzReads(grants: Record<string, readonly ResourceRef[]>): {
    binding: AuthzCheckBinding;
    checks: { userId: string; action: Action; resource: ResourceRef }[];
  } {
    const checks: { userId: string; action: Action; resource: ResourceRef }[] = [];
    const keyOf = (r: ResourceRef) => `${r.type}:${r.id}`;
    const allowed = new Map<string, Set<string>>(
      Object.entries(grants).map(([u, rs]) => [u, new Set(rs.map(keyOf))]),
    );
    const decide = (p: Principal, action: Action, resource: ResourceRef): Decision => {
      checks.push({ userId: p.actor.id, action, resource });
      const ok = allowed.get(p.actor.id)?.has(keyOf(resource)) ?? false;
      return {
        allowed: ok,
        reason: ok ? 'test: reader' : 'test: not a reader',
        evidence: {
          action,
          relation: '',
          resource: `${resource.type}:${resource.id}`,
          actorSubject: `user:${p.actor.id}`,
        },
      };
    };
    return {
      binding: {
        check: async (p, action, resource) => decide(p, action, resource),
        checkBatch: async (p, action, resources) =>
          resources.map((resource) => decide(p, action, resource)),
      },
      checks,
    };
  }

  async function draftedApprovalFor(
    reviewers: Pick<ReviewerRegistryBinding, 'list'>,
    actor: { kind: 'user' | 'service'; id: string },
    authz?: AuthzCheckBinding,
    scope: LiveScope = PROJECT,
  ): Promise<{ role: string; count: number; separateApprover: boolean } | undefined> {
    const h = await harness();
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      releases: h.releases.releases,
      reviewers,
      ...(authz !== undefined && { authz }),
    });
    const drafted = await service.draft({
      tenantId,
      agentId: AGENT,
      fromVersion: '1.0.0',
      scope,
      tier: 'settings-block',
      blockId: WEIGHTS,
      content: { values: { recency: 0.6, fit: 0.4 } },
      why: 'The search found these weights',
      drafter: { kind: 'settings-optimizer', version: '1' },
    });
    if (drafted.kind !== 'ok') throw new Error(JSON.stringify(drafted.error));
    const evaluated = await service.evaluate({
      tenantId,
      suggestedChange: drafted.value.suggestedChange,
      testSetId: 'acme.scoring-judged',
      objective: 'weightedYesShare',
      actor,
    });
    if (evaluated.kind !== 'ok') throw new Error(JSON.stringify(evaluated.error));
    const runId = evaluated.value.evaluation?.testRunId as string;
    await h.testRuns.finish(runId, { delta: 0.2 });
    const requested = await service.pin({ tenantId, suggestedChange: evaluated.value, actor });
    if (requested.kind !== 'ok') throw new Error(JSON.stringify(requested.error));
    const request = h.releases.calls.find((c) => c.method === 'request')?.input as {
      gate: { approval?: { role: string; count: number; separateApprover: boolean } };
    };
    return request.gate.approval;
  }

  test('a drafter must ask a separate approver when a second reviewer could approve', async () => {
    const approval = await draftedApprovalFor(
      roster({ userId: 'u-alice' }, { userId: 'u-bob', role: 'senior' }),
      { kind: 'service', id: 'improve-run' },
    );
    expect(approval).toMatchObject({ role: 'standard', count: 1, separateApprover: true });
  });

  test('the only reviewer, who asked, may approve their own drafted promotion', async () => {
    const approval = await draftedApprovalFor(roster({ userId: 'u-solo' }), {
      kind: 'user',
      id: 'u-solo',
    });
    expect(approval).toMatchObject({ separateApprover: false });
  });

  test('the only reviewer, who asked with their id in upper case, is still the one who asked', async () => {
    // A seed user id an older version kept in upper case; the roster's id is a uuid's, in lower case.
    const id = 'abcdef00-0000-4000-8000-0000000000ab';
    const approval = await draftedApprovalFor(roster({ userId: id }), {
      kind: 'user',
      id: id.toUpperCase(),
    });
    expect(approval).toMatchObject({ separateApprover: false });
  });

  test('a second reviewer besides the person who asked requires a separate approver', async () => {
    const approval = await draftedApprovalFor(roster({ userId: 'u-solo' }, { userId: 'u-two' }), {
      kind: 'user',
      id: 'u-solo',
    });
    expect(approval).toMatchObject({ separateApprover: true });
  });

  test('a deactivated second reviewer does not count, so the lone active one self-approves', async () => {
    const approval = await draftedApprovalFor(
      roster({ userId: 'u-solo' }, { userId: 'u-gone', deactivated: true }),
      { kind: 'user', id: 'u-solo' },
    );
    expect(approval).toMatchObject({ separateApprover: false });
  });

  test('an empty roster leaves nothing to separate', async () => {
    const approval = await draftedApprovalFor(roster(), {
      kind: 'service',
      id: 'improve-run',
    });
    expect(approval).toMatchObject({ separateApprover: false });
  });

  test('a reviewer who cannot read the project does not count, so the requester approves alone', async () => {
    const authz = authzReads({ 'u-alice': [projectRef] });
    const approval = await draftedApprovalFor(
      roster({ userId: 'u-alice' }, { userId: 'u-bob' }),
      { kind: 'user', id: 'u-alice' },
      authz.binding,
    );
    expect(approval).toMatchObject({ separateApprover: false });
    // The count asked whether the other reviewer may read the run's project —
    // the same resource the decide route would 404 them on.
    expect(authz.checks).toContainEqual({
      userId: 'u-bob',
      action: 'read',
      resource: { type: 'project', id: projectId as unknown as string },
    });
  });

  test('a reviewer who can read the project counts, so a separate approver is required', async () => {
    const authz = authzReads({ 'u-alice': [projectRef], 'u-bob': [projectRef] });
    const approval = await draftedApprovalFor(
      roster({ userId: 'u-alice' }, { userId: 'u-bob' }),
      { kind: 'user', id: 'u-alice' },
      authz.binding,
    );
    expect(approval).toMatchObject({ separateApprover: true });
  });

  test('a second reviewer on a later roster page still counts', async () => {
    const row = (userId: string, i: number) => ({
      id: `reviewer-${i}` as ReviewerId,
      tenantId,
      userId: userId as UserId,
      role: 'standard' as const,
      createdAt: '2026-01-01T00:00:00.000Z' as Timestamp,
    });
    const paged: Pick<ReviewerRegistryBinding, 'list'> = {
      async list({ cursor }) {
        return cursor === undefined
          ? { data: [row('u-solo', 0)], nextCursor: 'page-2' as Cursor }
          : { data: [row('u-two', 1)] };
      },
    };
    const approval = await draftedApprovalFor(paged, { kind: 'user', id: 'u-solo' });
    expect(approval).toMatchObject({ separateApprover: true });
  });

  test("a drafter's suggested change asks its own project, not the test run's", async () => {
    // u-bob may read the test run's project but not the suggested change's.
    // Resolving the count to the run's project (the bug) would admit u-bob;
    // resolving to the promotion's own project does not.
    const other = randomUUID() as ProjectId;
    const otherRef: ResourceRef = { type: 'project', id: other as unknown as string };
    const authz = authzReads({ 'u-alice': [otherRef], 'u-bob': [projectRef] });
    const approval = await draftedApprovalFor(
      roster({ userId: 'u-alice' }, { userId: 'u-bob' }),
      { kind: 'user', id: 'u-alice' },
      authz.binding,
      { kind: 'project', projectId: other },
    );
    expect(approval).toMatchObject({ separateApprover: false });
    expect(authz.checks).toContainEqual({ userId: 'u-bob', action: 'read', resource: otherRef });
    expect(authz.checks).not.toContainEqual({
      userId: 'u-bob',
      action: 'read',
      resource: projectRef,
    });
  });

  /**
   * Like `draftedApprovalFor`, but with a scope policy in force — so the
   * promotion's approval is `resolveApproval`'s combination of the policy's own
   * approval and the drafter's separate-approver rule. `approvals` is the
   * policy's approvals block; `undefined` is a policy with none (only a metric
   * bar the candidate clears), where the drafter's own approval applies.
   */
  async function underPolicy(
    approvals: NonNullable<GatePolicySpec['approvals']> | undefined,
    reviewers: Pick<ReviewerRegistryBinding, 'list'>,
    actor: { kind: 'user' | 'service'; id: string },
  ): Promise<{ role: string; count: number; separateApprover: boolean } | undefined> {
    const h = await harness();
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    h.releases.state.policy = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: PROJECT,
      spec:
        approvals === undefined
          ? { metrics: [{ name: 'weightedYesShare', minCandidate: 0.1 }] }
          : { approvals },
      createdAt: NOW,
    };
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      releases: h.releases.releases,
      reviewers,
    });
    const drafted = await service.draft({
      tenantId,
      agentId: AGENT,
      fromVersion: '1.0.0',
      scope: PROJECT,
      tier: 'settings-block',
      blockId: WEIGHTS,
      content: { values: { recency: 0.6, fit: 0.4 } },
      why: 'The search found these weights',
      drafter: { kind: 'settings-optimizer', version: '1' },
    });
    if (drafted.kind !== 'ok') throw new Error(JSON.stringify(drafted.error));
    const evaluated = await service.evaluate({
      tenantId,
      suggestedChange: drafted.value.suggestedChange,
      testSetId: 'acme.scoring-judged',
      objective: 'weightedYesShare',
      actor,
    });
    if (evaluated.kind !== 'ok') throw new Error(JSON.stringify(evaluated.error));
    const runId = evaluated.value.evaluation?.testRunId as string;
    await h.testRuns.finish(runId, { delta: 0.2 });
    const requested = await service.pin({ tenantId, suggestedChange: evaluated.value, actor });
    if (requested.kind !== 'ok') throw new Error(JSON.stringify(requested.error));
    const request = h.releases.calls.find((c) => c.method === 'request')?.input as {
      gate: { approval?: { role: string; count: number; separateApprover: boolean } };
    };
    return request.gate.approval;
  }

  test('a policy that asks for a separate approver is a floor the drafter cannot loosen', async () => {
    // Explicit true, with a lone roster the drafter's own rule would let self-approve.
    const approval = await underPolicy(
      { role: 'standard', separateApprover: true },
      roster({ userId: 'u-solo' }),
      {
        kind: 'user',
        id: 'u-solo',
      },
    );
    expect(approval).toMatchObject({ role: 'standard', separateApprover: true });
  });

  test("a policy's separate-approver default (unset) is true, so a lone drafter still cannot self-approve", async () => {
    const approval = await underPolicy({ role: 'standard' }, roster({ userId: 'u-solo' }), {
      kind: 'user',
      id: 'u-solo',
    });
    expect(approval).toMatchObject({ role: 'standard', separateApprover: true });
  });

  test('a policy that sets separateApprover false still gets one when a second reviewer could decide', async () => {
    const approval = await underPolicy(
      { role: 'standard', separateApprover: false },
      roster({ userId: 'u-solo' }, { userId: 'u-two' }),
      { kind: 'user', id: 'u-solo' },
    );
    expect(approval).toMatchObject({ role: 'standard', separateApprover: true });
  });

  test('a policy that sets separateApprover false lets a lone reviewer approve their own drafted promotion', async () => {
    const approval = await underPolicy(
      { role: 'standard', separateApprover: false },
      roster({ userId: 'u-solo' }),
      { kind: 'user', id: 'u-solo' },
    );
    expect(approval).toMatchObject({ role: 'standard', separateApprover: false });
  });

  test("a false policy's rule is re-checked at the policy's role, so a junior second reviewer does not count", async () => {
    // Policy role senior; the only other reviewer is standard — below senior, so
    // no separate approver. Ranking the re-check at the drafter's own 'standard'
    // (the bug) would count u-two and demand one.
    const approval = await underPolicy(
      { role: 'senior', separateApprover: false },
      roster({ userId: 'u-solo' }, { userId: 'u-two', role: 'standard' }),
      { kind: 'user', id: 'u-solo' },
    );
    expect(approval).toMatchObject({ role: 'senior', separateApprover: false });
  });

  test("a false policy's rule counts a second reviewer ranked at the policy's role", async () => {
    const approval = await underPolicy(
      { role: 'senior', separateApprover: false },
      roster({ userId: 'u-solo' }, { userId: 'u-sr', role: 'senior' }),
      { kind: 'user', id: 'u-solo' },
    );
    expect(approval).toMatchObject({ role: 'senior', separateApprover: true });
  });

  test("a policy with no approvals block leaves the drafter's own approval to apply", async () => {
    // Only a metric bar: the gate improveRuns, names no approval, so the drafter's
    // approval (its own separate-approver rule, at standard) is what waits.
    const approval = await underPolicy(
      undefined,
      roster({ userId: 'u-solo' }, { userId: 'u-two' }),
      {
        kind: 'user',
        id: 'u-solo',
      },
    );
    expect(approval).toMatchObject({ role: 'standard', count: 1, separateApprover: true });
  });
});

describe("a change held to the current version's replays (an Improve run's model settings)", () => {
  /** The current version: right on j1 and j2, wrong on j3; $0.42 ± 0.02 over 12 cases. */
  const CURRENT = more(
    [
      ['j1', true],
      ['j2', true],
      ['j3', false],
    ],
    { candidate: 0.42, spread: 0.02, cases: 12 },
  );

  /** A draft evaluated against a reference run of the current version, both still running. */
  async function held(rule: SuggestedChangeRule) {
    const h = await harness();
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      releases: h.releases.releases,
    });
    const drafted = await service.draft({
      tenantId,
      agentId: AGENT,
      fromVersion: '1.0.0',
      scope: PROJECT,
      tier: 'settings-block',
      blockId: WEIGHTS,
      content: { values: { recency: 0.6, fit: 0.4 } },
      why: 'The search found these weights',
      drafter: { kind: 'settings-optimizer', version: '1' },
    });
    if (drafted.kind !== 'ok') throw new Error(JSON.stringify(drafted.error));
    const reference = await h.testRuns.binding.start({
      tenantId,
      projectId,
      testSetId: 'acme.scoring-judged',
      agentRef: { agentId: AGENT as never, version: '1.0.0' as Semver },
    });
    if (reference.kind !== 'ok') throw new Error(reference.kind);
    const referenceId = reference.testRunId as unknown as string;
    const evaluated = await service.evaluate({
      tenantId,
      suggestedChange: drafted.value.suggestedChange,
      testSetId: 'acme.scoring-judged',
      objective: 'weightedYesShare',
      actor: { kind: 'service', id: 'improve-run' },
      against: { rule, reference: { testRunId: referenceId } },
    });
    if (evaluated.kind !== 'ok') throw new Error(JSON.stringify(evaluated.error));
    const id = evaluated.value.id as unknown as string;
    const runId = evaluated.value.evaluation?.testRunId as string;
    /** What the service makes of it now. */
    const seen = async () => {
      const stored = h.suggestedChanges.rows.get(id);
      if (stored === undefined) throw new Error(`no suggested change ${id}`);
      return service.facts(tenantId)(stored);
    };
    return { ...h, service, id, runId, referenceId, seen };
  }

  test('no worse on the same cases, cheaper beyond the spread, every decision kept: ready, and kept', async () => {
    const h = await held('cheaper');
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('checking');
    await h.testRuns.finish(h.runId, {
      delta: 0,
      more: more(
        [
          ['j1', true],
          ['j2', true],
          ['j3', true],
        ],
        { candidate: 0.26, spread: 0.01, cases: 12 },
      ),
    });
    // The candidate finished; the current version's replays it's held to haven't.
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('checking');
    await h.testRuns.finish(h.referenceId, { delta: 0, more: CURRENT });
    const res = await h.call('GET', `/v1/suggested-changes/${h.id}`);
    expect(res.body.status).toBe('ready');
    expect(res.body.check).toMatchObject({
      status: 'done',
      with: { testRunId: h.runId, passing: 3, of: 3, costPerConversation: '0.0217' },
      now: { testRunId: h.referenceId, passing: 2, of: 3, costPerConversation: '0.035' },
      newlyFailing: [],
    });
    expect((await h.seen()).evaluation).toMatchObject({
      kept: true,
      rule: 'cheaper',
      costUsd: { current: 0.42, candidate: 0.26 },
      decisions: { checked: 3, held: 2, broken: 0, stillWrong: 0 },
    });
  });

  test.each([
    [
      'no correction checked',
      { delta: 0, more: more([], { candidate: 0.26, cases: 12 }) },
      { delta: 0, more: more([], { candidate: 0.42, cases: 12 }) },
      'no-decisions',
    ],
    [
      'a decision the current version gets right, broken',
      {
        delta: 0,
        more: more(
          [
            ['j1', true],
            ['j2', false],
            ['j3', true],
          ],
          { candidate: 0.26, cases: 12 },
        ),
      },
      { delta: 0, more: CURRENT },
      'decisions-broken',
    ],
    [
      'a decision the current version gets right, unchecked',
      {
        delta: 0,
        more: more([['j1', true]], { candidate: 0.26, cases: 12 }),
      },
      { delta: 0, more: CURRENT },
      'decisions-broken',
    ],
    [
      'an errored case',
      {
        delta: 0,
        more: {
          ...more(
            [
              ['j1', true],
              ['j2', true],
            ],
            { candidate: 0.26, cases: 12 },
          ),
          errors: 1,
        },
      },
      { delta: 0, more: CURRENT },
      'other-cases',
    ],
    [
      'costs counted over other cases',
      {
        delta: 0,
        more: more(
          [
            ['j1', true],
            ['j2', true],
          ],
          { candidate: 0.26, cases: 11 },
        ),
      },
      { delta: 0, more: CURRENT },
      'other-cases',
    ],
    [
      'no cost reported',
      {
        delta: 0,
        more: more([
          ['j1', true],
          ['j2', true],
        ]),
      },
      { delta: 0, more: CURRENT },
      'other-cases',
    ],
    [
      'worse beyond the current version’s spread',
      {
        delta: -0.06,
        more: more(
          [
            ['j1', true],
            ['j2', true],
          ],
          { candidate: 0.26, cases: 12 },
        ),
      },
      { delta: 0, spread: 0.05, more: CURRENT },
      'worse',
    ],
    [
      'cheaper only within the cost’s spread',
      {
        delta: 0,
        more: more(
          [
            ['j1', true],
            ['j2', true],
          ],
          { candidate: 0.41, cases: 12 },
        ),
      },
      { delta: 0, more: CURRENT },
      'not-cheaper',
    ],
  ] as const)('%s: ready, not kept (%s)', async (_what, candidate, reference, notKept) => {
    const h = await held('cheaper');
    await h.testRuns.finish(h.runId, candidate);
    await h.testRuns.finish(h.referenceId, reference);
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('ready');
    expect((await h.seen()).evaluation).toMatchObject({ kept: false, notKept });
  });

  test('worse within the spread is no worse', async () => {
    const h = await held('cheaper');
    await h.testRuns.finish(h.runId, {
      delta: -0.04,
      more: more(
        [
          ['j1', true],
          ['j2', true],
        ],
        { candidate: 0.26, cases: 12 },
      ),
    });
    await h.testRuns.finish(h.referenceId, { delta: 0, spread: 0.05, more: CURRENT });
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('ready');
    expect((await h.seen()).evaluation).toMatchObject({ kept: true });
  });

  test('under `better` it must beat the recorded outputs as well as keep every decision', async () => {
    const kept = await held('better');
    await kept.testRuns.finish(kept.runId, {
      delta: 0.1,
      more: more([
        ['j1', true],
        ['j2', true],
      ]),
    });
    await kept.testRuns.finish(kept.referenceId, { delta: 0, more: CURRENT });
    expect((await kept.call('GET', `/v1/suggested-changes/${kept.id}`)).body.status).toBe('ready');
    expect((await kept.seen()).evaluation).toMatchObject({
      kept: true,
      rule: 'better',
      decisions: { checked: 3, held: 2, broken: 0, stillWrong: 1 },
    });

    const same = await held('better');
    await same.testRuns.finish(same.runId, {
      delta: 0,
      more: more(
        [
          ['j1', true],
          ['j2', true],
        ],
        { candidate: 0.1, cases: 12 },
      ),
    });
    await same.testRuns.finish(same.referenceId, { delta: 0, more: CURRENT });
    expect((await same.call('GET', `/v1/suggested-changes/${same.id}`)).body.status).toBe('ready');
    expect((await same.seen()).evaluation).toMatchObject({ notKept: 'not-better' });
  });

  test('a reference run that failed, or that is gone, is check-failed', async () => {
    const failed = await held('cheaper');
    await failed.testRuns.finish(failed.runId, { delta: 0, more: CURRENT });
    await failed.testRuns.finish(failed.referenceId, 'failed');
    expect((await failed.call('GET', `/v1/suggested-changes/${failed.id}`)).body.status).toBe(
      'check-failed',
    );

    const gone = await held('cheaper');
    await gone.testRuns.finish(gone.runId, { delta: 0, more: CURRENT });
    gone.testRuns.runs.delete(gone.referenceId);
    expect((await gone.call('GET', `/v1/suggested-changes/${gone.id}`)).body.status).toBe(
      'check-failed',
    );
  });
});

/**
 * The agent's project reaches its own items, but for the ids in `out`;
 * another project reaches none of them.
 */
function reach(out: Set<string>): ReferenceScopeBinding {
  return {
    async reachable({ fromProjectId, ref }) {
      return fromProjectId === projectId && !out.has(ref.id);
    },
  };
}

const OTHER_SEGMENT = {
  kind: 'segment',
  projectId: randomUUID(),
  path: [{ key: 'company', value: 'acme' }],
};

/** The `reference-out-of-scope` refusal's issues, as `path kind id`. */
function refused(res: { status: number; body: Record<string, any> }): string[] {
  expect(res.status, JSON.stringify(res.body)).toBe(400);
  expect(res.body.error.code).toBe('reference-out-of-scope');
  return (res.body.error.details.issues as { path: string; kind: string; id: string }[]).map(
    (i) => `${i.path} ${i.kind} ${i.id}`,
  );
}

describe("what a suggested change names must be in its agent's project's reach", () => {
  test("one for a project out of the agent's reach is refused, and nothing is stored or started", async () => {
    const { call, suggestedChanges, testRuns } = await harness({
      referenceScope: reach(new Set()),
    });
    const res = await call('POST', '/v1/suggested-changes', {
      ...CARD,
      projectId: OTHER_SEGMENT.projectId,
    });
    expect(refused(res)).toEqual([`/scope agent ${AGENT}`]);
    expect(suggestedChanges.rows.size).toBe(0);
    expect(testRuns.started).toEqual([]);
  });

  test('one editing a block out of reach is refused, before the block is read', async () => {
    const { call, releases, suggestedChanges } = await harness({
      referenceScope: reach(new Set([WEIGHTS])),
    });
    releases.pin(PROJECT, '1.0.0');
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(refused(res)).toEqual([`/change/blockId block ${WEIGHTS}`]);
    expect(suggestedChanges.rows.size).toBe(0);
  });

  test("pinning asks it too: a project that no longer reaches the agent isn't pinned", async () => {
    const out = new Set<string>();
    const { call, id, releases } = await checked(0.1, { referenceScope: reach(out) });
    out.add(AGENT);
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(refused(res)).toEqual([`/scope agent ${AGENT}`]);
    expect(releases.calls.filter((c) => c.method === 'request')).toEqual([]);
  });

  test('improve on a test set out of reach, or for a scope in another project, starts no Improve run', async () => {
    for (const [out, body, issue] of [
      [
        new Set(['acme.scoring-judged']),
        { agentId: AGENT, scope: SEGMENT_WIRE, testSetId: 'acme.scoring-judged' },
        '/testSetId test-set acme.scoring-judged',
      ],
      [
        new Set<string>(),
        {
          agentId: AGENT,
          scope: OTHER_SEGMENT,
          fromVersion: '1.0.0',
          testSetId: 'acme.scoring-judged',
        },
        `/scope agent ${AGENT}`,
      ],
    ] as const) {
      const improveRuns = inMemoryImproveRuns();
      const h = await harness({
        tunable: true,
        improveRuns: improveRuns.binding,
        referenceScope: reach(out),
      });
      h.releases.pin({ kind: 'tenant' }, '1.0.0');
      const res = await h.call('POST', '/v1/improve-runs', body);
      expect(refused(res)).toEqual([issue]);
      expect(improveRuns.started).toEqual([]);
    }
  });
});

describe('Improve runs', () => {
  const IMPROVE = { agentId: AGENT, scope: SEGMENT_WIRE, testSetId: 'acme.scoring-judged' };

  test('no version runs in the scope (no pin, no Latest): 404, saying so, and nothing starts', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ tunable: true, improveRuns: improveRuns.binding });
    h.releases.state.latest = null;
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect([res.status, res.body.error.code]).toEqual([404, 'agent-version-not-found']);
    expect(res.body.error.message).toContain('runs in this scope');
    expect(res.body.error.message).toContain('`fromVersion`');
    expect(improveRuns.started).toEqual([]);
  });

  test('improve starts an Improve run for the version serving the scope, with the default budget (202)', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ tunable: true, improveRuns: improveRuns.binding });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({
      agentId: AGENT,
      fromVersion: '1.0.0',
      scope: SEGMENT_WIRE,
      tiers: ['settings'],
      objective: 'weightedYesShare',
      budget: { maxCostUsd: 5, maxCandidates: 30 },
      status: 'running',
      requestedBy: 'user:user-1',
    });
    expect(improveRuns.started[0]).toMatchObject({
      projectId,
      fromVersion: '1.0.0',
      // With no corrector-group registry wired, the default stays experts-only (K4).
      groupWeights: 'experts-only',
    });
    expect(res.body.groupWeights).toBe('experts-only');
    const read = await h.call('GET', `/v1/improve-runs/${res.body.id}`);
    expect(read.body.id).toBe(res.body.id);
    const listed = await h.call('GET', `/v1/improve-runs?agentId=${AGENT}`);
    expect(listed.body.data.map((p: { id: string }) => p.id)).toEqual([res.body.id]);
    const cancelled = await h.call('POST', `/v1/improve-runs/${res.body.id}/cancel`, {});
    expect(cancelled.body.status).toBe('cancelled');
    const again = await h.call('POST', `/v1/improve-runs/${res.body.id}/cancel`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('improve-run-finished');
  });

  test("counts everyone's corrections until the project names an expert group", async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    // No expert (restricted) corrector group is named, so every correction counts.
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'as-recorded' });
    expect(res.body.groupWeights).toBe('as-recorded');
  });

  test('switches to trusted corrections once the project names an expert group', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'project', projectId },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
    expect(res.body.groupWeights).toBe('experts-only');
  });

  test('a tenant-wide expert group names experts for every project', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'tenant' },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
  });

  test('an expert group on the agent being improved switches to trusted', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'agent', projectId, agentId: AGENT },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
  });

  test("an expert group on another agent doesn't count: still counts everyone", async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'agent', projectId, agentId: 'acme.other' },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'as-recorded' });
  });

  test("an expert group in another project doesn't count: still counts everyone", async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'project', projectId: randomUUID() as ProjectId },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'as-recorded' });
  });

  test("an expert group on this agent in another project doesn't count: still counts everyone", async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    // Same agent id, but scoped to another project: the agent clause must match
    // the Improve run's own project, so this must not flip the Improve run to trusted.
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'agent', projectId: randomUUID() as ProjectId, agentId: AGENT },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'as-recorded' });
  });

  test('finds an expert group past the first page of its scope', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    // The expert group is the oldest, so it falls on the second page once 100
    // newer open groups are listed ahead of it: the resolver must read on.
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'project', projectId },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    for (let i = 0; i < 100; i++) {
      await corrections.createGroup({
        tenantId,
        scope: { kind: 'project', projectId },
        name: `open-${i}`,
        weight: 1,
      });
    }
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
  });

  test("resolves against the test set's project, not where the agent is made", async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    const testSetProjectId = randomUUID() as ProjectId;
    // The agent is made in `projectId`, but its test set reads corrections from
    // another environment's project, where the expert group lives: the Improve run
    // counts trusted only, keying off the test set's project.
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'project', projectId: testSetProjectId },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
      testSetProjectId,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
  });

  test("an expert group only where the agent is made, not in the test set's project, doesn't count", async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    const testSetProjectId = randomUUID() as ProjectId;
    // The inverse: the expert group is in the agent's own project, but the
    // test set reads from another, so the default must NOT flip — the Improve run
    // counts the test set project's corrections, not `from.projectId`'s.
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'project', projectId },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
      testSetProjectId,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'as-recorded' });
  });

  test('a non-corrections test set keys off its row project, not its spec project', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    const rowProjectId = randomUUID() as ProjectId;
    const specProjectId = randomUUID() as ProjectId;
    // A non-corrections test set records its project on the row, not in `spec`. The
    // expert group is in the row project, so the default flips. Reading
    // `spec.projectId` regardless of kind would miss it; dropping the
    // `?? row project` fallback would read the agent's project instead.
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'project', projectId: rowProjectId },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
      testSetRecord: {
        id: 'acme.scoring-judged',
        tenantId,
        version: '1.0.0',
        kind: 'accuracy',
        projectId: rowProjectId,
        spec: { projectId: specProjectId },
      } as unknown as TestSetRecord,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
  });

  test('a missing test set falls back to the project the agent is made in', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    // The test set binding finds no record; the default then keys off the agent
    // version's project, where this expert group lives. Dropping the
    // `?? from.projectId` fallback would ask only the tenant scope.
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'project', projectId },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
      testSetRecord: null,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
  });

  test("an expert group on the agent in the test set's project flips the default", async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    const testSetProjectId = randomUUID() as ProjectId;
    // The agent-scope expert group is in the TEST_SET's project, not the agent's
    // own. Keying off the test set's project, the agent clause finds it; keying
    // off `from.projectId` would miss it.
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'agent', projectId: testSetProjectId, agentId: AGENT },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
      testSetProjectId,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
  });

  test('an explicit groupWeights skips the test set read', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    // With `groupWeights` set, the default isn't resolved, so the route must
    // not read the test set at all — the stub throws if it does.
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
      testSetGetThrows: true,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', {
      ...IMPROVE,
      groupWeights: 'as-recorded',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'as-recorded' });
  });

  test('with no corrector-group registry wired, the test set read is skipped', async () => {
    const improveRuns = inMemoryImproveRuns();
    // No correctionRegistry, so there are no corrector groups to resolve a default
    // from: the route must not read the test set — the stub throws if it does.
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      testSetGetThrows: true,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
    expect(res.body.groupWeights).toBe('experts-only');
  });

  test('an unrestricted group is not an expert group: still counts everyone', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'project', projectId },
      name: 'user',
      weight: 1,
    });
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'as-recorded' });
  });

  test('an explicit groupWeights always wins over the project default', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    // No expert group named, but the caller asks for experts-only outright.
    const res = await h.call('POST', '/v1/improve-runs', {
      ...IMPROVE,
      groupWeights: 'experts-only',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
    expect(res.body.groupWeights).toBe('experts-only');
  });

  test('no Improve run starts for an agent whose project is suspended: 409 project-suspended; restored, it starts', async () => {
    const improveRuns = inMemoryImproveRuns();
    let suspended = true;
    const asked: string[] = [];
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      projectSuspended: async (_tenantId, pid) => {
        asked.push(pid as unknown as string);
        return suspended;
      },
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const refused = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('project-suspended');
    expect(asked).toEqual([projectId]);
    expect(improveRuns.started).toEqual([]);
    suspended = false;
    const started = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(improveRuns.started).toHaveLength(1);
  });

  test("an Improve run's comparisons show a refused template's issues and each drafted template's why", async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ improveRuns: improveRuns.binding });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const started = await h.call('POST', '/v1/improve-runs', {
      ...IMPROVE,
      tiers: ['prompt'],
      model: { providerId: 'acme-llm', model: 'm-1' },
    });
    const refused = [
      { path: '/template', message: 'it names "acme.export", which the agent doesn\'t use' },
    ];
    const comparisons = [
      { role: 'reference', part: 'search', testRunId: randomUUID(), score: 0.5 },
      {
        role: 'candidate',
        part: 'search',
        blockId: 'acme.scorer-prompt',
        changed: { template: 'Score it, then call acme.export.' },
        failed: 'The drafted template was refused: it names "acme.export".',
        refused,
        why: 'As the reviewer asked.',
      },
    ];
    const id = started.body.id as string;
    const trigger = { triggerId: randomUUID(), fireId: randomUUID() };
    improveRuns.rows.set(id, {
      ...(improveRuns.rows.get(id) as ImproveRun),
      comparisons,
      trigger,
    } as ImproveRun);
    const read = await h.call('GET', `/v1/improve-runs/${id}`);
    expect(read.body.comparisons[1]).toMatchObject({
      refused,
      why: 'As the reviewer asked.',
    });
    // An Improve run an improve schedule started names the schedule and the fire.
    expect(read.body.trigger).toEqual(trigger);
  });

  test('a prompt Improve run needs a model, drafts 3 templates by default, and needs a prompt block', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ improveRuns: improveRuns.binding });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const noModel = await h.call('POST', '/v1/improve-runs', {
      ...IMPROVE,
      tiers: ['prompt'],
    });
    expect(noModel.status).toBe(400);
    expect(noModel.body.error.message).toContain('`model` is required for a prompt Improve run');
    const model = { providerId: 'acme-llm', model: 'm-1' };
    const res = await h.call('POST', '/v1/improve-runs', {
      ...IMPROVE,
      tiers: ['prompt'],
      model,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ tiers: ['prompt'], model, candidates: 3 });
    expect(improveRuns.started[0]).toMatchObject({ tiers: ['prompt'], model, candidates: 3 });
    const settingsWithModel = await h.call('POST', '/v1/improve-runs', { ...IMPROVE, model });
    expect(settingsWithModel.status).toBe(400);
    expect(
      (
        await h.call('POST', '/v1/improve-runs', {
          ...IMPROVE,
          tiers: ['prompt'],
          model,
          candidates: 9,
        })
      ).status,
    ).toBe(400);
  });

  test('a prompt Improve run on a version with inline instructions is refused (400), with reason no-pinned-prompt-block', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ improveRuns: improveRuns.binding, inlineInstructions: true });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', {
      ...IMPROVE,
      tiers: ['prompt'],
      model: { providerId: 'acme-llm', model: 'm-1' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation-failed');
    expect(res.body.error.details).toEqual({ reason: 'no-pinned-prompt-block', issues: [] });
    expect(res.body.error.message).toContain('pinned prompt block');
    expect(improveRuns.started).toHaveLength(0);
  });

  test('a version that pins nothing tunable is refused (400), with reason no-tunable-keys, saying how to mark keys', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ improveRuns: improveRuns.binding });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation-failed');
    expect(res.body.error.details).toEqual({ reason: 'no-tunable-keys', issues: [] });
    expect(res.body.error.message).toContain('x-kindgi-tunable');
    expect(improveRuns.started).toHaveLength(0);
  });

  test("a model-settings block's tunable keys are something to tune: the Improve run starts", async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({
      improveRuns: improveRuns.binding,
      modelSettings: true,
      modelSchema: MODEL_SCHEMA,
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started).toHaveLength(1);
  });

  test("an agent version that names its model leaves the block's model untried, and says so when nothing else is tunable (400)", async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({
      improveRuns: improveRuns.binding,
      modelSettings: true,
      modelSchema: MODEL_SCHEMA,
      preferredModel: 'claude-sonnet-5-5',
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('no-tunable-keys');
    expect(res.body.error.message).toBe(
      `${AGENT} 1.0.0 pins no settings block with keys marked "x-kindgi-tunable": there's nothing for an Improve run to tune. Mark the keys it may tune in the block's schema (a number or integer with a minimum and maximum, or an enum) and publish it. In its model-settings block, "model" can't be tried: the agent version names its model (preferredProvider or preferredModel), and a model-settings block that named one too would name it twice.`,
    );
    expect(improveRuns.started).toHaveLength(0);
  });

  test('without a tenant-wide live version: 409 suggested-change-needs-pin', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ tunable: true, improveRuns: improveRuns.binding });
    const res = await h.call('POST', '/v1/improve-runs', { ...IMPROVE, fromVersion: '1.0.0' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('suggested-change-needs-pin');
  });

  test.each([
    [{ tiers: ['prompt'] }],
    [{ budget: { maxCostUsd: 500 } }],
    [{ budget: { maxCandidates: 0 } }],
    [{ objective: 'speed' }],
    [{ extra: 1 }],
  ])('a malformed request is bad input: %j', async (patch) => {
    const h = await harness({ tunable: true, improveRuns: inMemoryImproveRuns().binding });
    const res = await h.call('POST', '/v1/improve-runs', { ...IMPROVE, ...patch });
    expect(res.status).toBe(400);
  });

  test('without Improve runs in the runtime: 501 improve-unsupported, for reads too', async () => {
    const h = await harness({ tunable: true });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('improve-unsupported');
    expect((await h.call('GET', '/v1/improve-runs')).status).toBe(501);
  });

  test('improve needs publish on the agent; an Improve run of an agent the caller cannot read is 404', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      grants: [`read agent:${AGENT}`],
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    expect((await h.call('POST', '/v1/improve-runs', IMPROVE)).status).toBe(403);
    const improveRun = await improveRuns.binding.start({
      tenantId,
      agentId: 'acme.secret',
      fromVersion: '1.0.0',
      scope: { kind: 'tenant' },
      testSetId: 's',
      tiers: ['settings'],
      objective: 'weightedYesShare',
      groupWeights: 'experts-only',
      budget: { maxCostUsd: 1, maxCandidates: 1 },
      requestedBy: { kind: 'user', id: 'u' },
    });
    expect((await h.call('GET', `/v1/improve-runs/${improveRun.id}`)).status).toBe(404);
    expect((await h.call('GET', '/v1/improve-runs')).body.data).toEqual([]);
  });
});

describe("POST /v1/suggested-changes: who is made the derived version's owner", () => {
  const owners = async (token?: string) => {
    const h = await made(token === undefined ? {} : { token });
    return h.agents.written.filter((t) => t.relation === 'owner').map((t) => t.user);
  };

  test("a person's key makes them its owner", async () => {
    expect(await owners()).toEqual(['user:user-1']);
  });

  test("a service account's key makes no one its owner", async () => {
    expect(await owners(ACCOUNT_TOKEN)).toEqual([]);
  });
});

describe('POST /v1/improve-runs/check', () => {
  const IMPROVE = { agentId: AGENT, scope: SEGMENT_WIRE, testSetId: 'acme.scoring-judged' };

  /** The in-memory Improve runs binding plus an `checkBasis` stub, and the inputs it saw. */
  function withEstimate(basis: ImproveRunCheckBasis) {
    const improveRuns = inMemoryImproveRuns();
    const seen: CheckImproveRunInput[] = [];
    const binding: ImproveRunBinding = {
      ...improveRuns.binding,
      async checkBasis(input) {
        seen.push(input);
        return basis;
      },
    };
    return { binding, seen };
  }

  test("no pin covers the scope: the version is the scope's Latest, not the highest", async () => {
    const { binding, seen } = withEstimate({ replays: 10, meanRunCostUsd: '0.2' });
    const h = await harness({ tunable: true, improveRuns: binding });
    // 1.1.0 is higher, made for a project's card: never Latest by itself.
    const base = await h.agents.getVersion({
      tenantId,
      agentId: AGENT as never,
      version: '1.0.0' as Semver,
    });
    if (base === null) throw new Error('no 1.0.0');
    await h.agents.publish({
      tenantId,
      projectId,
      agent: { ...base, version: '1.1.0' } as unknown as Agent,
      madeFor: 'project',
      enqueueTuples: () => [],
    });
    h.releases.state.latest = { version: '1.0.0' as Semver, deploymentId: 'dep-1' };
    const res = await h.call('POST', '/v1/improve-runs/check', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(seen[0]?.fromVersion).toBe('1.0.0');
  });

  test('estimates min(cap, replays × the version mean) and reports the basis', async () => {
    const { binding, seen } = withEstimate({ replays: 10, meanRunCostUsd: '0.2' });
    const h = await harness({ tunable: true, improveRuns: binding });
    // No tenant-wide pin: a cost preview is lighter than a start.
    const res = await h.call('POST', '/v1/improve-runs/check', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // 10 × $0.20 = $2.00, under the default $5 cap.
    expect(res.body).toEqual({
      estimatedCostUsd: '2',
      maxCostUsd: '5',
      basis: { replays: 10, meanRunCostUsd: '0.2' },
    });
    expect(seen).toHaveLength(1);
    const got = seen[0];
    if (got === undefined) throw new Error('no estimate input captured');
    expect(got).toMatchObject({
      tenantId,
      agentId: AGENT,
      testSetId: 'acme.scoring-judged',
      tiers: ['settings'],
    });
    expect(got.scope).toBeDefined();
    // No fromVersion given: the route resolves the serving version (here the
    // agent's latest, 1.0.0) and forwards it, so the basis always gets a real version.
    expect(got.fromVersion).toBe('1.0.0');
  });

  test('clamps the estimate to the budget cap: it never exceeds maxCostUsd', async () => {
    const { binding } = withEstimate({ replays: 1000, meanRunCostUsd: '1' });
    const h = await harness({ tunable: true, improveRuns: binding });
    const res = await h.call('POST', '/v1/improve-runs/check', {
      ...IMPROVE,
      budget: { maxCostUsd: 20 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // 1000 × $1 = $1000, clamped to the $20 cap.
    expect(res.body.estimatedCostUsd).toBe('20');
    expect(res.body.maxCostUsd).toBe('20');
  });

  test('leaves estimatedCostUsd absent when the version has no cost history', async () => {
    const { binding } = withEstimate({ replays: 10 });
    const h = await harness({ tunable: true, improveRuns: binding });
    const res = await h.call('POST', '/v1/improve-runs/check', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ maxCostUsd: '5', basis: { replays: 10 } });
    expect('estimatedCostUsd' in res.body).toBe(false);
  });

  test('forwards the prompt options (model, candidates) to the basis', async () => {
    const { binding, seen } = withEstimate({ replays: 4, meanRunCostUsd: '0.5' });
    const h = await harness({ improveRuns: binding });
    const model = { providerId: 'acme-llm', model: 'm-1' };
    const res = await h.call('POST', '/v1/improve-runs/check', {
      ...IMPROVE,
      tiers: ['prompt'],
      model,
      candidates: 4,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(seen[0]).toMatchObject({ tiers: ['prompt'], model, candidates: 4 });
  });

  test('a malformed body is bad input (400) and asks the basis for nothing', async () => {
    const { binding, seen } = withEstimate({ replays: 1, meanRunCostUsd: '1' });
    const h = await harness({ tunable: true, improveRuns: binding });
    const res = await h.call('POST', '/v1/improve-runs/check', { ...IMPROVE, extra: 1 });
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });

  test('needs publish on the agent: a read-only caller is 403', async () => {
    const { binding } = withEstimate({ replays: 1, meanRunCostUsd: '1' });
    const h = await harness({
      tunable: true,
      improveRuns: binding,
      grants: [`read agent:${AGENT}`],
    });
    expect((await h.call('POST', '/v1/improve-runs/check', IMPROVE)).status).toBe(403);
  });

  test('without an estimate basis in the runtime: 501 improve-unsupported', async () => {
    // The Improve runs binding has no `checkBasis`.
    const withImproveRuns = await harness({
      tunable: true,
      improveRuns: inMemoryImproveRuns().binding,
    });
    const res = await withImproveRuns.call('POST', '/v1/improve-runs/check', IMPROVE);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('improve-unsupported');
    // And with no improve-runs binding at all.
    const none = await harness({ tunable: true });
    expect((await none.call('POST', '/v1/improve-runs/check', IMPROVE)).status).toBe(501);
  });

  // An Improve run can work in a project other than its version's: an order carries
  // the agent from its project to prod, and prod reaches the agent, its own
  // test set and the versions shipped to it.
  const PROD = randomUUID() as ProjectId;
  const PROD_SEGMENT = { ...SEGMENT_WIRE, projectId: PROD };
  const PROD_SET = 'acme.scoring-prod-judged';
  function inProd(shipped: string[], grants?: string[]): Parameters<typeof harness>[0] {
    const reached = new Map<string, Set<string>>([
      [projectId, new Set([AGENT, `${AGENT}@1.0.0`, IMPROVE.testSetId])],
      [PROD, new Set([AGENT, ...shipped.map((v) => `${AGENT}@${v}`), PROD_SET])],
    ]);
    return {
      orders: [[projectId, PROD]],
      items: [
        {
          kind: 'agent',
          id: AGENT,
          projects: [projectId, PROD],
          versions: [{ version: '1.0.0', projects: [projectId, PROD] }],
        },
      ],
      referenceScope: {
        async reachable({ fromProjectId, ref }) {
          const key = ref.version === undefined ? ref.id : `${ref.id}@${ref.version}`;
          return reached.get(fromProjectId)?.has(key) === true;
        },
      },
      ...(grants !== undefined && { grants }),
    };
  }

  // `/improve` and `/improve/estimate` take the same body and resolve +
  // reach-check it through the one shared helper (`resolveImproveTarget`), so
  // a bad body is refused identically. One case per branch of that helper,
  // each asserting the absolute (status, code) on both routes: a mutation in
  // the shared check breaks both and is caught here.
  const parity: {
    readonly label: string;
    readonly opts: Parameters<typeof harness>[0];
    readonly body: Record<string, unknown>;
    readonly status: number;
    readonly code: string;
  }[] = [
    {
      label: 'an unknown fromVersion',
      opts: {},
      body: { ...IMPROVE, fromVersion: '9.9.9' },
      status: 404,
      code: 'agent-version-not-found',
    },
    {
      label: 'an inactive fromVersion',
      opts: { unregisteredVersions: ['1.0.0'] },
      body: { ...IMPROVE, fromVersion: '1.0.0' },
      status: 404,
      code: 'agent-version-not-found',
    },
    {
      label: 'a missing testSetId',
      opts: {},
      body: { agentId: AGENT, scope: SEGMENT_WIRE },
      status: 400,
      code: 'bad-input',
    },
    {
      label: 'a test set the project does not reach',
      opts: { referenceScope: reach(new Set(['acme.scoring-judged'])) },
      body: { ...IMPROVE, fromVersion: '1.0.0' },
      status: 400,
      code: 'reference-out-of-scope',
    },
    {
      label: 'a scope in another project',
      opts: { referenceScope: reach(new Set()) },
      body: { ...IMPROVE, scope: OTHER_SEGMENT, fromVersion: '1.0.0' },
      status: 400,
      code: 'reference-out-of-scope',
    },
    {
      label: 'a scope outside `projectId`',
      opts: inProd(['1.0.0']),
      body: { ...IMPROVE, projectId: PROD, fromVersion: '1.0.0' },
      status: 400,
      code: 'bad-input',
    },
    {
      label: 'another project, without write there',
      opts: inProd(['1.0.0'], [`read project:${projectId}`, `write project:${projectId}`]),
      body: { ...IMPROVE, scope: PROD_SEGMENT, testSetId: PROD_SET, fromVersion: '1.0.0' },
      status: 403,
      code: 'permission-denied',
    },
    {
      label: "a version its project doesn't reach",
      opts: inProd([]),
      body: { ...IMPROVE, scope: PROD_SEGMENT, testSetId: PROD_SET, fromVersion: '1.0.0' },
      status: 400,
      code: 'reference-out-of-scope',
    },
  ];

  test.each(parity)(
    'refuses $label identically on /improve and /improve/estimate ($status $code)',
    async ({ opts, body, status, code }) => {
      const binding = withEstimate({ replays: 1, meanRunCostUsd: '1' }).binding;
      const h = await harness({ tunable: true, improveRuns: binding, ...opts });
      for (const path of ['/v1/improve-runs', '/v1/improve-runs/check'] as const) {
        const res = await h.call('POST', path, body);
        expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(status);
        expect(res.body.error.code, path).toBe(code);
      }
    },
  );
});

describe('an agent an order carries from its project to prod', () => {
  const PROD = randomUUID() as ProjectId;
  const orders = [[projectId, PROD]] as const;
  const items = (): ItemRow[] => [
    {
      kind: 'agent',
      id: AGENT,
      projects: [projectId, PROD],
      versions: [{ version: '1.0.0', projects: [projectId, PROD] }],
    },
  ];
  /** Runs the order's first environment (where the agent's versions are made). */
  const maker = [`read project:${projectId}`, `write project:${projectId}`];
  const IMPROVE = { agentId: AGENT, scope: SEGMENT_WIRE, testSetId: 'acme.scoring-judged' };

  const checkedBy = (grants: string[]) => checked(0.1, { grants, orders, items: items() });

  test('making and checking are write where its versions are made, not publish on the agent', async () => {
    const h = await checkedBy([...maker]);
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('ready');
    expect((await h.call('POST', `/v1/suggested-changes/${h.id}/check`)).status).toBe(202);

    const prodOnly = await harness({
      grants: [`read project:${PROD}`, `write project:${PROD}`, `publish agent:${AGENT}`],
      orders,
      items: items(),
    });
    prodOnly.releases.pin(PROJECT, '1.0.0');
    const res = await prodOnly.call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.message).toContain(
      `changing a suggested change for agent "${AGENT}" needs write on project ${projectId}`,
    );
  });

  test('checking and withdrawing are write where its versions are made, not publish on the agent', async () => {
    const grants = [...maker];
    const h = await checkedBy(grants);
    grants.splice(
      0,
      grants.length,
      `read project:${PROD}`,
      `write project:${PROD}`,
      `publish agent:${AGENT}`,
    );
    for (const [verb, body] of [
      ['check', undefined],
      ['withdraw', { reason: 'x' }],
    ] as const) {
      const res = await h.call('POST', `/v1/suggested-changes/${h.id}/${verb}`, body);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error.message).toContain(
        `changing a suggested change for agent "${AGENT}" needs write on project ${projectId}`,
      );
    }
    grants.splice(0, grants.length, ...maker);
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/withdraw`, { reason: 'x' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('withdrawn');
  });

  test("pinning is admin in the suggested change's project, with no promote on the agent", async () => {
    const grants = [...maker];
    const h = await checkedBy(grants);
    const refused = await h.call('POST', `/v1/suggested-changes/${h.id}/pin`, {});
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.message).toContain('needs admin on each project it changes');
    grants.push(`admin project:${PROD}`); // prod's admin doesn't reach the agent's project
    expect((await h.call('POST', `/v1/suggested-changes/${h.id}/pin`, {})).status).toBe(403);
    grants.push(`admin project:${projectId}`);
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('pinned');
  });

  test('a prod member reads its suggested changes; someone in neither project gets 404', async () => {
    const grants = [...maker];
    const h = await made({ grants, orders, items: items() });
    grants.splice(0, grants.length, `read project:${PROD}`);
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).status).toBe(200);
    expect((await h.call('GET', `/v1/suggested-changes?agentId=${AGENT}`)).body.data).toHaveLength(
      1,
    );
    grants.splice(0, grants.length);
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).status).toBe(404);
    expect((await h.call('GET', `/v1/suggested-changes?agentId=${AGENT}`)).body.data).toEqual([]);
  });

  test('an Improve run starts and cancels with write where versions are made', async () => {
    const improveRuns = inMemoryImproveRuns();
    const grants = [`read project:${PROD}`, `write project:${PROD}`, `publish agent:${AGENT}`];
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      grants,
      orders,
      items: items(),
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const refused = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.message).toContain(
      `improving agent "${AGENT}" needs write on project ${projectId}`,
    );
    grants.push(...maker);
    const started = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    grants.splice(0, grants.length, `read project:${PROD}`);
    // A prod reader reads the Improve run (any of the agent's projects) but can't cancel it.
    expect((await h.call('GET', `/v1/improve-runs/${started.body.id}`)).status).toBe(200);
    expect(
      (await h.call('GET', '/v1/improve-runs')).body.data.map((p: { id: string }) => p.id),
    ).toEqual([started.body.id]);
    const cancel = await h.call('POST', `/v1/improve-runs/${started.body.id}/cancel`, {});
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(403);
    grants.push(...maker);
    expect(
      (await h.call('POST', `/v1/improve-runs/${started.body.id}/cancel`, {})).body.status,
    ).toBe('cancelled');
  });

  test('an agent with one project: publish and promote on the agent, as before', async () => {
    const one: ItemRow[] = [{ kind: 'agent', id: AGENT, projects: [projectId] }];
    const h = await harness({ grants: [...maker, `read agent:${AGENT}`], orders, items: one });
    h.releases.pin(PROJECT, '1.0.0');
    const res = await h.call('POST', '/v1/suggested-changes', CARD);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain(`publish on agent "${AGENT}"`);
  });
});

describe("an agent registry that takes Improve's candidates (kindgi dev)", () => {
  const IMPROVE = { agentId: AGENT, scope: { kind: 'tenant' }, testSetId: 'acme.scoring-judged' };
  const NARROWER = {
    code: 'registry-read-only',
    message: TAKES_CANDIDATES.takesCandidates.scopeReason,
  };

  test('an Improve run starts (202)', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      readOnly: 'takes-candidates',
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started).toHaveLength(1);
  });

  test('a read-only one refuses an Improve run (409 registry-read-only) and starts none', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ tunable: true, improveRuns: improveRuns.binding, readOnly: true });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'registry-read-only',
      message: TAKES_CANDIDATES.reason,
    });
    expect(improveRuns.started).toEqual([]);
  });

  test('an Improve run for a scope narrower than the tenant is refused with the scope reason, and none starts', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      readOnly: 'takes-candidates',
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', { ...IMPROVE, scope: SEGMENT_WIRE });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject(NARROWER);
    expect(improveRuns.started).toEqual([]);
  });

  test("a suggested change is refused with the registry's reason, not the scope's (409 registry-read-only), and none is kept", async () => {
    const h = await harness({ readOnly: 'takes-candidates', freezes: false });
    h.releases.pin(PROJECT, '1.0.0');
    const res = await h.call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'registry-read-only',
      message: TAKES_CANDIDATES.reason,
    });
    expect(res.body.error.message).not.toBe(NARROWER.message);
    expect(h.suggestedChanges.rows.size).toBe(0);
  });

  test('one for a project from before is not checked: nothing published or started', async () => {
    const h = await harness({ readOnly: 'takes-candidates', freezes: false });
    const id = await oldRow(h, PROJECT);
    const res = await h.call('POST', `/v1/suggested-changes/${id}/check`);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'registry-read-only',
      message: TAKES_CANDIDATES.reason,
    });
    expect(h.testRuns.started).toEqual([]);
    expect([...h.blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toEqual([
      `${WEIGHTS}@1.0.0`,
    ]);
  });

  test('one for the whole tenant from before can only be withdrawn (409 suggested-change-not-for-a-project)', async () => {
    const h = await harness({ readOnly: 'takes-candidates', freezes: false });
    const id = await oldRow(h, { kind: 'tenant' });
    const res = await h.call('POST', `/v1/suggested-changes/${id}/check`);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('suggested-change-not-for-a-project');
  });
});

describe("an Improve run started by hand works in one project: the one named, else its scope's, else its version's", () => {
  const PROD = randomUUID() as ProjectId;
  const orders = [[projectId, PROD]] as const;
  const items = (): ItemRow[] => [
    {
      kind: 'agent',
      id: AGENT,
      projects: [projectId, PROD],
      versions: [{ version: '1.0.0', projects: [projectId, PROD] }],
    },
  ];
  const PROD_SEGMENT = { ...SEGMENT_WIRE, projectId: PROD };
  /** A test set built from prod's corrected runs: made in prod, so only prod reaches it. */
  const PROD_SET = 'acme.scoring-prod-judged';
  const DEV_SET = 'acme.scoring-judged';

  /**
   * What each project reaches: the agent's first environment its own
   * items; prod the agent, the versions shipped to it, its own test set
   * and the earlier environment's (test data moves forward). A version is
   * asked as `id@version`.
   */
  function reachByProject(shipped = ['1.0.0']): ReferenceScopeBinding {
    const reached = new Map<string, Set<string>>([
      [projectId, new Set([AGENT, `${AGENT}@1.0.0`, DEV_SET])],
      [PROD, new Set([AGENT, ...shipped.map((v) => `${AGENT}@${v}`), PROD_SET, DEV_SET])],
    ]);
    return {
      async reachable({ fromProjectId, ref }) {
        const key = ref.version === undefined ? ref.id : `${ref.id}@${ref.version}`;
        return reached.get(fromProjectId)?.has(key) === true;
      },
    };
  }

  async function improver(opts: { grants?: string[]; shipped?: string[] } = {}) {
    const improveRuns = inMemoryImproveRuns();
    const asked: string[] = [];
    const h = await harness({
      tunable: true,
      improveRuns: improveRuns.binding,
      orders,
      items: items(),
      referenceScope: reachByProject(opts.shipped),
      projectSuspended: async (_tenantId, pid) => {
        asked.push(pid as unknown as string);
        return false;
      },
      ...(opts.grants !== undefined && { grants: opts.grants }),
    });
    h.releases.pin({ kind: 'tenant' }, '1.0.0');
    const improve = (body: Record<string, unknown>) =>
      h.call('POST', '/v1/improve-runs', { agentId: AGENT, ...body });
    return { ...h, improveRuns, asked, improve };
  }

  test("a scope in prod: the Improve run works in prod, on prod's test set, and asks whether prod is suspended", async () => {
    const h = await improver();
    const res = await h.improve({ scope: PROD_SEGMENT, testSetId: PROD_SET });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(h.improveRuns.started.map((p) => p.projectId)).toEqual([PROD]);
    expect(h.asked).toEqual([PROD]);
    // In the first environment, prod's test set is out of reach, as before.
    expect(refused(await h.improve({ scope: SEGMENT_WIRE, testSetId: PROD_SET }))).toEqual([
      `/testSetId test-set ${PROD_SET}`,
    ]);
    expect(h.improveRuns.started).toHaveLength(1);
  });

  test("a tenant scope: the version's project, unless `projectId` names another", async () => {
    const h = await improver();
    const own = await h.improve({ scope: { kind: 'tenant' }, testSetId: DEV_SET });
    expect(own.status, JSON.stringify(own.body)).toBe(202);
    expect(refused(await h.improve({ scope: { kind: 'tenant' }, testSetId: PROD_SET }))).toEqual([
      `/testSetId test-set ${PROD_SET}`,
    ]);
    const prod = await h.improve({
      scope: { kind: 'tenant' },
      projectId: PROD,
      testSetId: PROD_SET,
    });
    expect(prod.status, JSON.stringify(prod.body)).toBe(202);
    expect(h.improveRuns.started.map((p) => p.projectId)).toEqual([projectId, PROD]);
  });

  test('a project or segment scope must be in `projectId`: 400, naming no project, and no Improve run', async () => {
    const h = await improver();
    for (const body of [
      { scope: SEGMENT_WIRE, projectId: PROD, testSetId: PROD_SET },
      { scope: PROD_SEGMENT, projectId, testSetId: DEV_SET },
      { scope: { kind: 'project', projectId: PROD }, projectId, testSetId: DEV_SET },
    ]) {
      const res = await h.improve(body);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.code).toBe('bad-input');
      expect(res.body.error.message).toBe(
        "An Improve run's scope must be in its project (`projectId`): it learns from that project's runs",
      );
    }
    expect(h.improveRuns.started).toEqual([]);
  });

  test('a version prod never got: refused at /fromVersion, naming no project, and no Improve run', async () => {
    const h = await improver({ shipped: [] });
    for (const body of [
      { scope: PROD_SEGMENT, testSetId: PROD_SET },
      { scope: PROD_SEGMENT, fromVersion: '1.0.0', testSetId: PROD_SET },
      { scope: { kind: 'tenant' }, projectId: PROD, testSetId: PROD_SET },
    ]) {
      const res = await h.improve(body);
      expect(refused(res)).toEqual([`/fromVersion agent ${AGENT}`]);
      expect(res.body.error.message).not.toContain(PROD);
      expect(res.body.error.message).not.toContain(projectId);
    }
    // Its own project reaches the version it was made in: not asked again there.
    const own = await h.improve({ scope: SEGMENT_WIRE, testSetId: DEV_SET });
    expect(own.status, JSON.stringify(own.body)).toBe(202);
    expect(h.improveRuns.started.map((p) => p.projectId)).toEqual([projectId]);
  });

  test("a project other than the version's needs write there, as the Improve run's test runs do", async () => {
    const grants = [`read project:${projectId}`, `write project:${projectId}`];
    const h = await improver({ grants });
    const denied = await h.improve({ scope: PROD_SEGMENT, testSetId: PROD_SET });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.error.code).toBe('permission-denied');
    // The version's own project needs nothing more than before.
    const own = await h.improve({ scope: SEGMENT_WIRE, testSetId: DEV_SET });
    expect(own.status, JSON.stringify(own.body)).toBe(202);
    grants.push(`write project:${PROD}`);
    const prod = await h.improve({ scope: PROD_SEGMENT, testSetId: PROD_SET });
    expect(prod.status, JSON.stringify(prod.body)).toBe(202);
    expect(h.improveRuns.started.map((p) => p.projectId)).toEqual([projectId, PROD]);
  });

  test('`projectId` must be a project id when given', async () => {
    const h = await improver();
    for (const projectIdValue of ['', 7, null]) {
      const res = await h.improve({
        scope: { kind: 'tenant' },
        projectId: projectIdValue,
        testSetId: DEV_SET,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'bad-input',
        message: '`projectId` must be a project id (a UUID)',
      });
    }
    expect(h.improveRuns.started).toEqual([]);
  });
});
