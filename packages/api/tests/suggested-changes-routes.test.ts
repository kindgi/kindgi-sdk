// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * suggested changes (`/v1/suggested-changes`): a hand-written change to one
 * data block the version a project runs pins, made a real (inert) agent
 * version and checked against what the project runs now on the project's
 * test set, frozen, then pinned for the project through the gate. The
 * status is derived from the check's test runs and the pin. The stores
 * are in memory; pin changes, test runs and the freeze are fakes that
 * record what they're asked.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { type Agent, type AgentId, createAgentRegistry, pinsDigest } from '@kindgi/agents';
import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
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
import { highestVersion } from '@kindgi/tools';
import type {
  AgentPinScope,
  Cursor,
  ProjectId,
  ReviewerId,
  RunId,
  Semver,
  TenantId,
  Timestamp,
  UserId,
} from '@kindgi/types';

import type { FreezeTestSetInput, TestSetFreezeBinding } from '../src/test-set-binding.js';
import { createStubAppBindings } from '../src/testing/index.js';

import {
  agentTestSetId,
  createApp,
  createSuggestedChangeService,
  latestRunCorrelation,
} from '../src/index.js';
import type {
  AgentMarkLatestInput,
  AgentPinBindings,
  AgentPinnedVersion,
  AgentRegistryBinding,
  AgentVersionRecord,
  CheckImproveRunInput,
  CorrectedComparisonSummary,
  CorrectionRegistryBinding,
  ImproveRun,
  ImproveRunBinding,
  ImproveRunCheck,
  ImproveRunStart,
  LatestAnswer,
  ListImproveRunsInput,
  Pin,
  ReferenceScopeBinding,
  ReleaseGate,
  ReleaseGateSpec,
  ReviewerRegistryBinding,
  RunHandlerBinding,
  StartImproveRunInput,
  StoredSuggestedChange,
  SuggestedChangeRule,
  TestRun,
  TestRunBinding,
  TestRunJudging,
  TestRunStartInput,
  TokenResolver,
} from '../src/index.js';
import { SuggestedChangeSchema } from '../src/openapi/schemas.js';
import { expectCompileBudgetRefused } from './support/compile-budget.js';
import { environmentOrders } from './support/environment-orders.js';
import { inMemoryBlocks } from './support/in-memory-blocks.js';
import { inMemoryCorrections } from './support/in-memory-corrections.js';
import { inMemorySuggestedChanges } from './support/in-memory-suggested-changes.js';
import { type ItemRow, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const TOKEN = 'suggested-changes-token';
const AGENT = 'acme.scorer';
const WEIGHTS = 'acme.scoring-weights';
const MODEL = 'acme.scorer-model';
const NOW = '2026-10-07T00:00:00.000Z' as Timestamp;
const SEGMENT: AgentPinScope = {
  kind: 'segment',
  projectId,
  path: [{ key: 'company', value: 'acme' }],
};
const PROJECT: AgentPinScope = { kind: 'project', projectId };
/** The project's test set, as a check freezes it. */
const FROZEN = { testSetId: agentTestSetId(AGENT as AgentId, projectId), testSetVersion: '1.0.7' };
const projectRef: ResourceRef = { type: 'project', id: projectId as unknown as string };

const ACCOUNT_TOKEN = 'suggested-changes-account-token';
const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId, userId: 'user-1' as UserId };
  if (token === ACCOUNT_TOKEN) return { tenantId, serviceAccountId: 'sa-ci' };
  return null;
};

/**
 * The agent registry in memory, recording each version's project, the
 * entries its publish wrote, the versions made for a suggested change
 * (`forACard`), and the versions added as Latest (`marked`).
 */
function agentBinding(unregistered: ReadonlySet<string> = new Set()): AgentRegistryBinding & {
  written: TupleIntent[];
  marked: AgentMarkLatestInput[];
  forACard: Set<string>;
} {
  const registry = createAgentRegistry();
  const written: TupleIntent[] = [];
  const marked: AgentMarkLatestInput[] = [];
  const forACard = new Set<string>();
  // Where a version was made, when it's not the agent's project (an environment order's first).
  const madeIn = new Map<string, ProjectId>();
  return {
    written,
    marked,
    forACard,
    async list() {
      return { data: [] };
    },
    async get({ agentId }) {
      const got = registry.getLatest(agentId);
      // As a registry records it: in the project it was published in.
      return got.kind === 'ok' ? { ...got.value, projectId } : null;
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
    async publish({ agent, projectId: into, enqueueTuples, madeFor }) {
      if (registry.get(agent.id, agent.version as unknown as string).kind === 'ok') {
        return { kind: 'already-registered', agentId: agent.id, version: agent.version };
      }
      registry.register(agent);
      if (madeFor === 'project') forACard.add(agent.version as unknown as string);
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
    metrics: { passRate: m, caseCoverage: m, weightedPrecisionAtK: { ...m, k: 10 } },
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
    // Newest first, as the store lists them; every run is in the project.
    async list({ filter }) {
      const data = [...runs.values()]
        .reverse()
        .filter(
          (r) =>
            (filter?.testSetId === undefined || r.testSetId === filter.testSetId) &&
            (filter?.status === undefined || r.status === filter.status) &&
            (filter?.agentId === undefined || r.agentRef?.agentId === filter.agentId),
        );
      return { data };
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

/** Pinned versions and pin changes, kept as a store keeps them; the gate's outcome decides a request's status. */
function pinsFake(agents: ReturnType<typeof agentBinding>) {
  const pins: AgentPinnedVersion[] = [];
  const pinChanges = new Map<string, Pin>();
  /**
   * `latest`: Latest in every scope, `null` for none. Absent: the version
   * added as Latest last, else the highest one not made for a suggested
   * change (one made for a project serves nothing until it's pinned or
   * added).
   */
  const state: { releaseGate: ReleaseGate | null; latest?: LatestAnswer | null } = {
    releaseGate: null,
  };
  const calls: { method: string; input: unknown }[] = [];
  const key = (scope: AgentPinScope) => JSON.stringify(scope);
  const highest = async (q: { tenantId: TenantId; agentId: string }) => {
    const added = agents.marked.filter((m) => m.agentId === q.agentId).at(-1);
    if (added !== undefined) return { version: added.version, since: NOW };
    const { data } = await agents.listVersions({
      tenantId: q.tenantId,
      agentId: q.agentId as AgentId,
      limit: 100,
    });
    const version = highestVersion(
      data.map((a) => a.version as unknown as string).filter((v) => !agents.forACard.has(v)),
    );
    return version === undefined ? null : { version: version as Semver, since: NOW };
  };
  const pinOf = (agentId: string, scope: AgentPinScope) =>
    pins.find((p) => p.agentId === agentId && key(p.scope) === key(scope));
  const setPin = (agentId: string, scope: AgentPinScope, version: string, changeId: string) => {
    const at = pins.findIndex((p) => p.agentId === agentId && key(p.scope) === key(scope));
    if (at >= 0) pins.splice(at, 1);
    pins.push({ agentId, scope, version: version as Semver, changeId, setAt: NOW });
  };
  const row = (p: Omit<Pin, 'id' | 'createdAt'>): Pin => {
    const change = { ...p, id: randomUUID(), createdAt: NOW };
    pinChanges.set(change.id, change);
    return change;
  };
  const pinStore: AgentPinBindings = {
    pinned: {
      async resolve({ agentId, projectId: pid, segments }) {
        const scopes: AgentPinScope[] = [
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
      latest: async (q) => (state.latest === undefined ? highest(q) : state.latest),
      byProject: async () => [],
    },
    changes: {
      async pin(input) {
        calls.push({ method: 'pin', input });
        const before = pinOf(input.agentId, input.scope);
        const change = row({
          agentId: input.agentId,
          scope: input.scope,
          action: 'pin',
          fromVersion: before?.version ?? null,
          toVersion: input.version,
          requestedBy: input.requestedBy,
          status: 'pinned',
          ...(input.stoppedFollowingLatest !== undefined && {
            stoppedFollowingLatest: input.stoppedFollowingLatest,
          }),
        });
        setPin(input.agentId, input.scope, input.version, change.id);
        return { kind: 'ok', value: change };
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
            : 'pinned';
        const change = row({
          agentId: input.agentId,
          scope: input.scope,
          action: 'pin',
          fromVersion: before?.version ?? null,
          toVersion: input.version,
          requestedBy: input.requestedBy,
          ...(input.testRunId !== undefined && { testRunId: input.testRunId }),
          status,
          releaseGate: input.gate.releaseGate,
          checks: input.gate.checks,
          ...(status === 'pending-approval' && { approvalId: 'appr-1' }),
          ...(input.stoppedFollowingLatest !== undefined && {
            stoppedFollowingLatest: input.stoppedFollowingLatest,
          }),
        });
        if (status === 'pinned') {
          setPin(input.agentId, input.scope, input.version, change.id);
        }
        return { kind: 'ok', value: change };
      },
      async unpin(input) {
        calls.push({ method: 'unpin', input });
        const at = pins.findIndex(
          (p) => p.agentId === input.agentId && key(p.scope) === key(input.scope),
        );
        if (at < 0) return { kind: 'err', error: { code: 'not-pinned', message: 'none' } };
        const [gone] = pins.splice(at, 1);
        const change = row({
          agentId: input.agentId,
          scope: input.scope,
          action: 'unpin',
          fromVersion: gone?.version ?? null,
          toVersion: null,
          requestedBy: input.requestedBy,
        });
        return { kind: 'ok', value: change };
      },
      async list() {
        return { data: [...pinChanges.values()] };
      },
      async get(_tenant, id) {
        return pinChanges.get(id) ?? null;
      },
    },
    releaseGates: {
      resolve: async () => state.releaseGate,
      publish: async () => ({ kind: 'err', error: { code: 'persistence-error', message: 'x' } }),
      get: async () => null,
      getVersion: async () => null,
      listVersions: async () => [],
      list: async () => ({ data: [] }),
      unregister: async () => ({ kind: 'err', error: { code: 'persistence-error', message: 'x' } }),
      reinstate: async () => ({ kind: 'err', error: { code: 'persistence-error', message: 'x' } }),
    },
  };
  /** A pin set by hand (a pin made before the test). */
  const pin = (scope: AgentPinScope, version: string) =>
    setPin(
      AGENT,
      scope,
      version,
      row({
        agentId: AGENT,
        scope,
        action: 'pin',
        fromVersion: null,
        toVersion: version as Semver,
        requestedBy: { kind: 'user', id: 'user-0' },
        status: 'pinned',
      }).id,
    );
  const decide = (changeId: string, status: NonNullable<Pin['status']>) => {
    const p = pinChanges.get(changeId);
    if (p === undefined) throw new Error('no pin change');
    pinChanges.set(changeId, { ...p, status });
    if (status === 'pinned' && p.toVersion !== null) {
      setPin(p.agentId, p.scope, p.toVersion, changeId);
    }
  };
  return { bindings: pinStore, state, calls, pins, pin, decide, pinChanges };
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

/** What an Improve run starts from in these tests: the project's pin. */
const STARTS_FROM: ImproveRunStart = { version: '1.0.0', follows: 'pin' };

/**
 * Improve runs in memory, recording what reached each method. `check` answers
 * a ready agent unless `answer` says otherwise (`startsFrom: null`: no version
 * of the agent runs in the project); with `startsRunning`, `start` starts
 * nothing and answers that run as the running one.
 */
function inMemoryImproveRuns(
  answer: Partial<Omit<ImproveRunCheck, 'startsFrom'>> & {
    readonly startsFrom?: ImproveRunStart | null;
    readonly startsRunning?: string;
  } = {},
) {
  const rows = new Map<string, ImproveRun>();
  const started: StartImproveRunInput[] = [];
  const checked: CheckImproveRunInput[] = [];
  const listed: ListImproveRunsInput[] = [];
  const binding: ImproveRunBinding = {
    async start(input) {
      started.push(input);
      if (answer.startsRunning !== undefined) {
        return { kind: 'running', improveRunId: answer.startsRunning };
      }
      const improveRun: ImproveRun = {
        id: randomUUID(),
        tenantId: input.tenantId,
        agentId: input.agentId,
        projectId: input.projectId,
        startsFrom: STARTS_FROM,
        setAside: { cases: 2, of: 12 },
        tiers: input.tiers ?? ['prompt', 'settings'],
        objective: input.objective,
        groupWeights: input.groupWeights,
        ...(input.model !== undefined && { model: input.model }),
        ...(input.candidates !== undefined && { candidates: input.candidates }),
        budget: input.budget,
        requestedBy: `${input.requestedBy.kind}:${input.requestedBy.id}`,
        status: 'running',
        tried: 0,
        costUsd: '0',
        takes: [],
        createdAt: NOW,
        updatedAt: NOW,
      };
      rows.set(improveRun.id, improveRun);
      return { kind: 'started', improveRun };
    },
    async get({ improveRunId }) {
      return rows.get(improveRunId) ?? null;
    },
    async list(input) {
      listed.push(input);
      return {
        data: [...rows.values()].filter(
          (p) =>
            (input.agentId === undefined || p.agentId === input.agentId) &&
            (input.projectId === undefined || p.projectId === input.projectId) &&
            (input.status === undefined || p.status === input.status),
        ),
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
    async check(input) {
      checked.push(input);
      const startsFrom = answer.startsFrom === undefined ? STARTS_FROM : answer.startsFrom;
      return {
        ...(startsFrom !== null && { startsFrom }),
        wording: answer.wording ?? true,
        settings: answer.settings ?? true,
        testCases: answer.testCases ?? 12,
        ...(answer.runningId !== undefined && { runningId: answer.runningId }),
        basis: answer.basis ?? { replays: 10, meanRunCostUsd: '0.2' },
        ...(answer.month !== undefined && { month: answer.month }),
      };
    },
  };
  return { binding, started, checked, listed, rows };
}

/** A project binding that lists `ids`, and gets each. */
function projectsOf(ids: readonly ProjectId[]) {
  return {
    get: async (_tenant: TenantId, id: ProjectId) => (ids.includes(id) ? { id } : undefined),
    list: async () => ({ items: ids.map((id) => ({ id })) }),
  } as never;
}

async function harness(
  opts: {
    grants?: readonly string[];
    /** Read-only (kindgi dev), or read-only but taking Improve's candidates. */
    readOnly?: boolean | 'takes-candidates';
    /** Versions `getVersion` returns as unregistered (an inactive version). */
    unregisteredVersions?: readonly string[];
    improveRuns?: ImproveRunBinding;
    /** The agent takes its model settings from block `MODEL`. */
    modelSettings?: boolean;
    /** The agent version's `preferredModel`. */
    preferredModel?: string;
    referenceScope?: ReferenceScopeBinding;
    projectSuspended?: (tenantId: TenantId, projectId: ProjectId) => Promise<boolean>;
    /** The tenant's environment orders; the agent's project is in them or not. */
    orders?: readonly (readonly ProjectId[])[];
    /** The projects that serve each item (an order carries it); absent: one each. */
    items?: ItemRow[];
    correctionRegistry?: CorrectionRegistryBinding;
    /** The key every call is made with: the person's unless given. */
    token?: string;
    /** The cases the project's test set freezes to; 3 unless given. */
    cases?: number;
    /** `false`: the runtime freezes no test set, so it checks no suggested change. */
    freezes?: boolean;
    /** The tenant's projects, for a project binding; absent: none is wired. */
    projects?: readonly ProjectId[];
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
            },
            fit: {
              type: 'number',
              minimum: 0,
              maximum: 1,
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
        },
      },
    });
  }
  const pinned = {
    tools: {},
    prompts: { 'acme.scorer-prompt': '1.0.0' },
    settings: { [WEIGHTS]: '1.0.0', ...(opts.modelSettings === true && { [MODEL]: '1.0.0' }) },
  };
  await agents.publish({
    tenantId,
    projectId,
    agent: {
      id: AGENT,
      version: '1.0.0',
      name: 'Scorer',
      instructions: { prompt: 'acme.scorer-prompt', version: '^1.0.0' },
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
  const pinStore = pinsFake(agents);
  const suggestedChanges = inMemorySuggestedChanges();
  const grants = opts.grants;
  const audit = createInMemoryAuditEventBinding();
  const written: AuditEvent[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    auditEvents: {
      ...audit,
      append: async (events) => {
        written.push(...events);
        return audit.append(events);
      },
    },
    agentRegistry:
      opts.readOnly === true
        ? { ...agents, readOnly: { reason: 'The pack files are the source: change them instead.' } }
        : opts.readOnly === 'takes-candidates'
          ? { ...agents, readOnly: TAKES_CANDIDATES }
          : agents,
    blockRegistry: blocks,
    testRunBinding: testRuns.binding,
    agentPins: pinStore.bindings,
    supervisor: suggestedChanges,
    ...(opts.improveRuns !== undefined && { improveRuns: opts.improveRuns }),
    ...(opts.referenceScope !== undefined && { referenceScope: opts.referenceScope }),
    ...(opts.projectSuspended !== undefined && { projectSuspended: opts.projectSuspended }),
    ...(opts.orders !== undefined && { environmentOrders: environmentOrders(opts.orders) }),
    ...(opts.items !== undefined && { itemProjects: itemProjects(opts.items) }),
    ...(opts.correctionRegistry !== undefined && { correctionRegistry: opts.correctionRegistry }),
    ...(opts.projects !== undefined && { projectBinding: projectsOf(opts.projects) }),
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
  /** The audit events of `kind` recorded so far. */
  const events = (kind: string) => written.filter((e) => e.kind === kind);
  return { call, agents, blocks, testRuns, freeze, pinStore, suggestedChanges, events };
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
    byHandReason: 'Suggested changes come from Improve runs here: run Improve.',
    latestReason: "The pack's files are what runs: pin it for the whole tenant.",
  },
};

/** What a read-only agent registry refuses a suggested change by hand with: its reason, or its by-hand one. */
const byHand = (readOnly: true | 'takes-candidates') =>
  readOnly === true ? TAKES_CANDIDATES.reason : TAKES_CANDIDATES.takesCandidates.byHandReason;

/**
 * A suggested change made for the project, which runs its pin of 1.0.0;
 * `card` changes what's sent. Its check started: both runs are running.
 */
async function made(opts: HarnessOpts & { card?: Record<string, unknown> } = {}) {
  const h = await harness(opts);
  h.pinStore.pin(PROJECT, '1.0.0');
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
    agentPins: h.pinStore.bindings,
  });
}

/**
 * A suggested change made for `scope` before they were for a project, as
 * the service drafted it then; `checked`: evaluated on a test set, and ready.
 */
async function oldRow(h: Harness, scope: AgentPinScope, opts: { checked?: boolean } = {}) {
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
  h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
  const evaluated = await service.evaluate({
    tenantId,
    suggestedChange: drafted.value.suggestedChange,
    testSetId: 'acme.scoring-judged',
    objective: 'passRate',
    actor: { kind: 'user', id: 'user-1' },
  });
  if (evaluated.kind !== 'ok') throw new Error(JSON.stringify(evaluated.error));
  await h.testRuns.finish(evaluated.value.evaluation?.testRunId as string, { delta: 0.1 });
  return id;
}

const ORG_SCOPE = { kind: 'org', orgId: randomUUID() } as AgentPinScope;

describe('POST /v1/suggested-changes', () => {
  test('a suggested change is built on what its project runs, and its check starts (201 checking)', async () => {
    const { call, pinStore, freeze, suggestedChanges } = await harness();
    pinStore.pin(PROJECT, '1.0.0');
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
      correctionCount: 0,
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
    const { id, blocks, agents, pinStore } = await made();
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
    expect(pinStore.calls).toEqual([]);
    expect(pinStore.pins.map((p) => p.version)).toEqual(['1.0.0']);
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
    const { call, pinStore, blocks, agents, testRuns, freeze } = await harness({
      orders: [[staging1, staging2, projectId]],
    });
    pinStore.pin({ kind: 'project', projectId: staging1 }, '1.0.0');
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
    const { call, pinStore, suggestedChanges, freeze } = await harness({
      orders: [[staging1, projectId]],
    });
    pinStore.pin(PROJECT, '1.0.0');
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
      const { call, pinStore, suggestedChanges, testRuns } = await harness();
      pinStore.pin(PROJECT, '1.0.0');
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
    ['more than 100 fixes', { fixes: Array.from({ length: 101 }, (_, i) => `c-${i}`) }],
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

  /** A correction of the agent in `inProject` of `inTenant`, as a person records it. */
  async function correctionIn(
    corrections: CorrectionRegistryBinding,
    inProject: ProjectId,
    inTenant: TenantId = tenantId,
  ) {
    const { id } = await corrections.record({
      tenantId: inTenant,
      projectId: inProject,
      runId: randomUUID(),
      run: {
        subject: { kind: 'agent', id: AGENT, version: '1.0.0' },
        input: { ask: 'score the acme filing' },
        output: { text: '0.4' },
      },
      madeBy: { kind: 'user', id: 'user-1' },
      status: 'open',
      answer: 'wrong',
      shouldSay: '0.8',
    });
    return id;
  }

  test('its `fixes` are corrections in its own project, and the answer lists and counts them (201)', async () => {
    const corrections = inMemoryCorrections();
    const { call, pinStore } = await harness({ correctionRegistry: corrections });
    pinStore.pin(PROJECT, '1.0.0');
    const one = await correctionIn(corrections, projectId);
    const two = await correctionIn(corrections, projectId);
    const res = await call('POST', '/v1/suggested-changes', { ...CARD, fixes: [one, two] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.fixes).toEqual([one, two]);
    expect(res.body.correctionCount).toBe(2);
  });

  test("an id in `fixes` that's no correction in its project is refused (400 validation-failed), naming each, and nothing is made", async () => {
    const corrections = inMemoryCorrections();
    const { call, pinStore, freeze, suggestedChanges, testRuns } = await harness({
      correctionRegistry: corrections,
    });
    pinStore.pin(PROJECT, '1.0.0');
    const here = await correctionIn(corrections, projectId);
    const otherProject = await correctionIn(corrections, randomUUID() as ProjectId);
    const otherTenant = await correctionIn(corrections, projectId, randomUUID() as TenantId);
    const res = await call('POST', '/v1/suggested-changes', {
      ...CARD,
      fixes: [here, 'c-unknown', otherProject, otherTenant, 'c-unknown'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('validation-failed');
    expect(res.body.error.message).toContain(`no correction in project ${projectId}`);
    expect(res.body.error.details.fixes).toEqual(['c-unknown', otherProject, otherTenant]);
    expect(res.body.error.details.issues.map((i: { path: string }) => i.path)).toEqual([
      'fixes[1]',
      'fixes[2]',
      'fixes[3]',
      'fixes[4]',
    ]);
    // Asked before the freeze: nothing frozen, stored or run.
    expect(freeze.calls).toEqual([]);
    expect(suggestedChanges.rows.size).toBe(0);
    expect(testRuns.started).toEqual([]);
  });

  test('with no corrections at all, a card naming one is refused (400 validation-failed)', async () => {
    const { call, pinStore, suggestedChanges } = await harness();
    pinStore.pin(PROJECT, '1.0.0');
    const res = await call('POST', '/v1/suggested-changes', { ...CARD, fixes: ['c-1'] });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('validation-failed');
    expect(res.body.error.details.fixes).toEqual(['c-1']);
    expect(suggestedChanges.rows.size).toBe(0);
  });

  test('an unknown field is named', async () => {
    const { call } = await harness();
    const res = await call('POST', '/v1/suggested-changes', { ...CARD, tier: 'settings-block' });
    expect(res.body.error.message).toContain("`tier` isn't a field of a suggested change");
  });

  test('a project that runs nothing is refused (409 nothing-runs-in-scope)', async () => {
    const { call, pinStore, suggestedChanges, freeze } = await harness();
    pinStore.state.latest = null;
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
    gone.pinStore.pin(PROJECT, '9.9.9');
    const unregistered = await harness({ unregisteredVersions: ['1.0.0'] });
    unregistered.pinStore.pin(PROJECT, '1.0.0');
    for (const h of [gone, unregistered]) {
      const res = await h.call('POST', '/v1/suggested-changes', CARD);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error.code).toBe('agent-version-not-found');
      expect(h.suggestedChanges.rows.size).toBe(0);
    }
  });

  test('a project with no corrections to check on is refused (409 suggested-change-nothing-to-check), and nothing is made', async () => {
    const { call, pinStore, suggestedChanges, blocks, testRuns } = await harness({ cases: 0 });
    pinStore.pin(PROJECT, '1.0.0');
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

  test('with corrections, it reads the cases first: none in the project freezes nothing (409)', async () => {
    const { call, pinStore, suggestedChanges, freeze, testRuns } = await harness({
      correctionRegistry: {
        listCases: async () => ({ data: [], hasMore: false }),
      } as unknown as CorrectionRegistryBinding,
    });
    pinStore.pin(PROJECT, '1.0.0');
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'suggested-change-nothing-to-check',
      details: { projectId },
    });
    expect(freeze.calls).toEqual([]);
    expect(suggestedChanges.rows.size).toBe(0);
    expect(testRuns.started).toEqual([]);
  });

  test("a runtime that freezes no test set can't check one (501), so it makes none", async () => {
    const { call, pinStore, suggestedChanges } = await harness({ freezes: false });
    pinStore.pin(PROJECT, '1.0.0');
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
      const { call, pinStore, blocks, suggestedChanges, testRuns } = await harness({
        readOnly,
        freezes,
      });
      pinStore.pin(PROJECT, '1.0.0');
      const res = await call('POST', '/v1/suggested-changes', CARD);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'registry-read-only',
        message: byHand(readOnly),
      });
      expect([...blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toHaveLength(1);
      expect(suggestedChanges.rows.size).toBe(0);
      expect(testRuns.started).toEqual([]);
    },
  );

  test("model settings that aren't are refused (400), before anything is stored", async () => {
    const { call, pinStore, blocks, agents, suggestedChanges, testRuns } = await harness({
      modelSettings: true,
    });
    pinStore.pin(PROJECT, '1.0.0');
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
    const { call, pinStore, blocks, agents, suggestedChanges, testRuns } = await harness({
      modelSettings: true,
      preferredModel: 'claude-sonnet-5-5',
    });
    pinStore.pin(PROJECT, '1.0.0');
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
    const { call, pinStore, blocks, agents, suggestedChanges, testRuns } = await harness();
    pinStore.pin(PROJECT, '1.0.0');
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
    const { call, pinStore, suggestedChanges } = await harness();
    pinStore.pin(PROJECT, '1.0.0');
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
    const { call, pinStore, testRuns } = await harness();
    pinStore.pin(PROJECT, '1.0.0');
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
  test("is on the agent's test set in its project: agent.<agentId>.<projectId>, with no ':' (an authorization object's id can't hold one)", () => {
    const id = agentTestSetId(AGENT as AgentId, projectId);
    expect(id).toBe(`agent.${AGENT}.${projectId}`);
    expect(id).not.toContain(':');
  });

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

  test("both runs' answers are judged by the version it's built on, so one model judges both", async () => {
    const { testRuns } = await made();
    expect(testRuns.started).toEqual([
      expect.objectContaining({
        agentRef: { agentId: AGENT, version: '1.0.1' },
        judging: { version: '1.0.0' },
      }),
      expect.objectContaining({
        agentRef: { agentId: AGENT, version: '1.0.0' },
        judging: { version: '1.0.0' },
      }),
    ]);
  });

  test("a change to the model settings is judged by the version it's built on too, not the model it names", async () => {
    const { testRuns } = await made({
      modelSettings: true,
      card: { block: MODEL, values: { temperature: 0.5, model: 'claude-haiku-4-5' } },
    });
    expect(testRuns.started).toEqual([
      expect.objectContaining({
        agentRef: { agentId: AGENT, version: '1.0.1' },
        judging: { version: '1.0.0' },
      }),
      expect.objectContaining({
        agentRef: { agentId: AGENT, version: '1.0.0' },
        judging: { version: '1.0.0' },
      }),
    ]);
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

  test('with corrections, a check reads the cases first: none left freezes nothing (409)', async () => {
    const cases = { data: [{ id: 'j1' }] };
    const { call, id, withRun, testRuns, freeze } = await made({
      correctionRegistry: {
        listCases: async () => ({ data: cases.data, hasMore: false }),
      } as unknown as CorrectionRegistryBinding,
    });
    await testRuns.finish(withRun, 'failed');
    cases.data = [];
    const freezes = freeze.calls.length;
    const res = await call('POST', `/v1/suggested-changes/${id}/check`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('suggested-change-nothing-to-check');
    expect(freeze.calls).toHaveLength(freezes);
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
        message: byHand(readOnly),
      });
      expect(h.testRuns.started).toEqual([]);
    },
  );

  test.each([
    ['the whole tenant', { kind: 'tenant' } as AgentPinScope],
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
      pin: { status: 'pinned', toVersion: '1.0.1' },
      testRuns: [],
      fixed: [],
      reopened: [],
      suggestedChange: {
        status: 'pinned',
        pinned: { version: '1.0.1', by: { kind: 'user', id: 'user-1' } },
      },
    });
  });

  test('with no release gate it pins the version for the project (201)', async () => {
    const { call, id, pinStore } = await checked();
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {
      reason: 'acme wants recency',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.suggestedChange.status).toBe('pinned');
    const request = pinStore.calls.find((c) => c.method === 'request')?.input as Record<
      string,
      unknown
    >;
    expect(request).toMatchObject({
      agentId: AGENT,
      version: '1.0.1',
      scope: PROJECT,
      reason: 'acme wants recency',
      gate: { releaseGate: null, passed: true, servingVersion: '1.0.0' },
    });
    expect(pinStore.pins.map((p) => [p.scope, p.version])).toEqual([[PROJECT, '1.0.1']]);
  });

  test('a release gate that wants an approval waits for a second person (202), then is pinned once approved', async () => {
    const { call, id, pinStore, suggestedChanges } = await checked();
    const spec: ReleaseGateSpec = { approvals: { role: 'standard' } };
    pinStore.state.releaseGate = {
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
    expect(res.body).toMatchObject({
      pin: { status: 'pending-approval', approvalId: 'appr-1' },
      suggestedChange: { status: 'waiting-for-second-person', approvalId: 'appr-1' },
    });
    expect(
      (await call('POST', `/v1/suggested-changes/${id}/withdraw`, { reason: 'x' })).status,
    ).toBe(409);

    pinStore.decide(suggestedChanges.rows.get(id)?.pinChangeId as string, 'pinned');
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body).toMatchObject({
      status: 'pinned',
      pinned: { version: '1.0.1' },
    });
  });

  test("a gate refusal is 422 gate-failed with the suggested change's id; it stays ready, noted, and can be checked again", async () => {
    const { call, id, pinStore } = await checked();
    pinStore.state.releaseGate = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: PROJECT,
      spec: { metrics: [{ name: 'passRate', minCandidate: 0.99 }] },
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

  /** A ready suggested change for the project, which follows Latest (nothing pinned). */
  async function readyOnLatest() {
    const h = await harness();
    const res = await h.call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await h.testRuns.finish(res.body.check.with.testRunId, { delta: 0.1 });
    await h.testRuns.finish(res.body.check.now.testRunId, { delta: 0 });
    return { ...h, id: res.body.id as string, card: res.body };
  }

  test('a project on Latest takes no pin unless the body asks (409 pin-stops-latest, with what it runs), and nothing changes', async () => {
    const { call, pinStore, id, card } = await readyOnLatest();
    const pin = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(pin.status, JSON.stringify(pin.body)).toBe(409);
    expect(pin.body.error).toMatchObject({
      code: 'pin-stops-latest',
      details: {
        projects: [{ projectId, version: card.builtOn.version }],
        suggestedChangeId: id,
      },
    });
    expect(pinStore.calls).toEqual([]);
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body).toMatchObject({
      status: 'ready',
      builtOn: card.builtOn,
    });
  });

  test('with stopFollowingLatest it pins, and the pin records that the project stopped following Latest', async () => {
    const { call, pinStore, id } = await readyOnLatest();
    const pin = await call('POST', `/v1/suggested-changes/${id}/pin`, {
      stopFollowingLatest: true,
    });
    expect(pin.status, JSON.stringify(pin.body)).toBe(201);
    const requested = pinStore.calls.find((c) => c.method === 'request')?.input;
    expect(requested).toMatchObject({ stoppedFollowingLatest: true });
    expect(pin.body.pin).toMatchObject({
      toVersion: (requested as { version: string }).version,
      stoppedFollowingLatest: true,
    });
    expect(pin.body.suggestedChange.status).toBe('pinned');
  });

  test('a stopFollowingLatest that is not a boolean → 400, nothing requested', async () => {
    const { call, pinStore, id } = await readyOnLatest();
    const pin = await call('POST', `/v1/suggested-changes/${id}/pin`, {
      stopFollowingLatest: 'yes',
    });
    expect(pin.status, JSON.stringify(pin.body)).toBe(400);
    expect(pinStore.calls).toEqual([]);
  });

  test('a pinned project is pinned without stopFollowingLatest, and the pin records nothing about Latest', async () => {
    const { id, call, pinStore } = await checked();
    const pin = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(pin.status, JSON.stringify(pin.body)).toBe(201);
    expect(pin.body.pin.stoppedFollowingLatest).toBeUndefined();
    expect(pinStore.calls.find((c) => c.method === 'request')?.input).not.toHaveProperty(
      'stoppedFollowingLatest',
    );
  });

  test('one made for the whole tenant before suggested changes were for a project is not pinned (409 suggested-change-not-for-a-project)', async () => {
    const h = await harness();
    const id = await oldRow(h, { kind: 'tenant' }, { checked: true });
    expect((await h.call('GET', `/v1/suggested-changes/${id}`)).body.status).toBe('ready');
    const res = await h.call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('suggested-change-not-for-a-project');
    expect(h.pinStore.calls).toEqual([]);
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
    expect(h.pinStore.calls).toEqual([]);
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

  /** Latest in the card's project by project too, as `latest` answers it there. */
  function latestByProject(h: Awaited<ReturnType<typeof readyOnLatest>>): void {
    const { latest } = h.pinStore.bindings;
    latest.byProject = async (q) => {
      const answer = await latest.latest({ ...q, projectId });
      return answer === null ? [] : [{ projectId, ...answer }];
    };
  }

  /** Corrections where the card's project has one case: a Latest check reads that first. */
  const oneCase = {
    listCases: async () => ({ data: [{ id: 'j1' }], hasMore: false }),
  } as unknown as CorrectionRegistryBinding;

  test("it checks the new Latest in the card's project, with a latest: test run", async () => {
    const h = await readyOnLatest({ correctionRegistry: oneCase });
    latestByProject(h);
    h.testRuns.started.length = 0;
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/add-as-latest`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.testRuns.started).toEqual([
      expect.objectContaining({
        projectId,
        testSetId: FROZEN.testSetId,
        testSetVersion: FROZEN.testSetVersion,
        agentRef: { agentId: AGENT, version: h.version },
        correlationId: latestRunCorrelation(AGENT, projectId),
      }),
    ]);
  });

  test("with no case in the card's project, it freezes nothing and starts nothing", async () => {
    // A case when the card is made and checked; none left when it's added.
    const cases = { data: [{ id: 'j1' }] };
    const h = await readyOnLatest({
      correctionRegistry: {
        listCases: async () => ({ data: cases.data, hasMore: false }),
      } as unknown as CorrectionRegistryBinding,
    });
    cases.data = [];
    latestByProject(h);
    h.testRuns.started.length = 0;
    const freezes = h.freeze.calls.length;
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/add-as-latest`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(h.freeze.calls).toHaveLength(freezes);
    expect(h.testRuns.started).toEqual([]);
  });

  test('a Latest check that does not start leaves the add as it is', async () => {
    const h = await readyOnLatest({ correctionRegistry: oneCase });
    latestByProject(h);
    h.testRuns.started.length = 0;
    h.testRuns.fail.start = 1;
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/add-as-latest`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('added-as-latest');
    expect(h.testRuns.started).toHaveLength(1);
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

  test('adding as Latest needs pin, as pinning does', async () => {
    const h = await readyOnLatest({ grants: [`read agent:${AGENT}`, `publish agent:${AGENT}`] });
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/add-as-latest`, {});
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('pin');
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

describe('if the project moves first: a suggested change is rebuilt on what it runs', () => {
  /**
   * Two ready suggested changes to the weights (`{ recency: 0.3, fit: 0.7 }`
   * at 1.0.0), `a` then `b`, for the project: on its pin of 1.0.0, or on
   * Latest.
   */
  async function twoReady(
    a: Record<string, number>,
    b: Record<string, number>,
    opts: { onLatest?: boolean } = {},
  ) {
    const h = await harness();
    if (opts.onLatest !== true) h.pinStore.pin(PROJECT, '1.0.0');
    const ready = async (values: Record<string, number>) => {
      const res = await h.call('POST', '/v1/suggested-changes', { ...CARD, values });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await h.testRuns.finish(res.body.check.with.testRunId, { delta: 0.1 });
      await h.testRuns.finish(res.body.check.now.testRunId, { delta: 0 });
      return { id: res.body.id as string, version: res.body.version as string };
    };
    const first = await ready(a);
    return { ...h, a: first, b: await ready(b) };
  }

  test("pinning one rebuilds the project's other ready ones on its version, each keeping only its own change", async () => {
    const h = await twoReady({ recency: 0.5, fit: 0.7 }, { recency: 0.3, fit: 0.9 });
    expect((await h.call('POST', `/v1/suggested-changes/${h.a.id}/pin`, {})).status).toBe(201);
    const b = (await h.call('GET', `/v1/suggested-changes/${h.b.id}`)).body;
    expect(b).toMatchObject({
      status: 'checking',
      builtOn: { version: h.a.version, rebuiltAt: expect.any(String) },
      changes: [
        {
          blockId: WEIGHTS,
          before: { values: { recency: 0.5, fit: 0.7 } },
          // b changed fit only: recency comes from what the project runs now.
          after: { values: { recency: 0.5, fit: 0.9 } },
        },
      ],
    });
    expect(b.version).not.toBe(h.b.version);
    // What it changes now is kept with it, as a draft keeps it.
    expect(h.suggestedChanges.rows.get(h.b.id)?.change).toMatchObject({
      before: { values: { recency: 0.5, fit: 0.7 } },
    });
    // Its new check: its new version against the one it's built on now.
    const runs = h.testRuns.started.filter((r) => r.correlationId === `suggested-change:${h.b.id}`);
    expect(runs.slice(-2).map((r) => r.agentRef?.version)).toEqual([b.version, h.a.version]);
  });

  test('a pin that waits for a second person rebuilds nothing yet', async () => {
    const h = await twoReady({ recency: 0.5, fit: 0.7 }, { recency: 0.3, fit: 0.9 });
    h.pinStore.state.releaseGate = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: PROJECT,
      spec: { approvals: { role: 'standard' } },
      createdAt: NOW,
    };
    expect((await h.call('POST', `/v1/suggested-changes/${h.a.id}/pin`, {})).status).toBe(202);
    const b = (await h.call('GET', `/v1/suggested-changes/${h.b.id}`)).body;
    expect(b).toMatchObject({ status: 'ready', builtOn: { version: '1.0.0' } });
    expect(b.builtOn).not.toHaveProperty('rebuiltAt');
  });

  test('adding one as Latest rebuilds the others on its version', async () => {
    const h = await twoReady(
      { recency: 0.5, fit: 0.7 },
      { recency: 0.3, fit: 0.9 },
      { onLatest: true },
    );
    expect((await h.call('POST', `/v1/suggested-changes/${h.a.id}/add-as-latest`, {})).status).toBe(
      200,
    );
    expect((await h.call('GET', `/v1/suggested-changes/${h.b.id}`)).body).toMatchObject({
      status: 'checking',
      builtOn: { version: h.a.version, rebuiltAt: expect.any(String) },
    });
  });

  test('one whose project moved by another route is rebuilt instead of pinned (409 suggested-change-out-of-date), then pins once checked', async () => {
    const h = await twoReady({ recency: 0.5, fit: 0.7 }, { recency: 0.3, fit: 0.9 });
    h.pinStore.pin(PROJECT, h.a.version);
    const res = await h.call('POST', `/v1/suggested-changes/${h.b.id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'suggested-change-out-of-date',
      details: { builtOn: '1.0.0', runs: h.a.version, rebuilding: true },
    });
    const b = (await h.call('GET', `/v1/suggested-changes/${h.b.id}`)).body;
    expect(b).toMatchObject({ status: 'checking', builtOn: { version: h.a.version } });
    await h.testRuns.finish(b.check.with.testRunId, { delta: 0.1 });
    await h.testRuns.finish(b.check.now.testRunId, { delta: 0 });
    const pinned = await h.call('POST', `/v1/suggested-changes/${h.b.id}/pin`, {});
    expect(pinned.status, JSON.stringify(pinned.body)).toBe(201);
    expect(pinned.body.suggestedChange.pinned.version).toBe(b.version);
  });

  test('checking one again after its project moved rebuilds it on what runs (202)', async () => {
    const h = await twoReady({ recency: 0.5, fit: 0.7 }, { recency: 0.3, fit: 0.9 });
    h.pinStore.pin(PROJECT, h.a.version);
    const res = await h.call('POST', `/v1/suggested-changes/${h.b.id}/check`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({
      status: 'checking',
      builtOn: { version: h.a.version, rebuiltAt: expect.any(String) },
    });
  });

  test("one the project's version already has isn't rebuilt: it stays as it was, and a pin says to withdraw it", async () => {
    // b's change (recency) is in a's too.
    const h = await twoReady({ recency: 0.5, fit: 0.5 }, { recency: 0.5, fit: 0.7 });
    expect((await h.call('POST', `/v1/suggested-changes/${h.a.id}/pin`, {})).status).toBe(201);
    expect((await h.call('GET', `/v1/suggested-changes/${h.b.id}`)).body).toMatchObject({
      status: 'ready',
      builtOn: { version: '1.0.0' },
      version: h.b.version,
    });
    const res = await h.call('POST', `/v1/suggested-changes/${h.b.id}/pin`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('suggested-change-out-of-date');
    expect(res.body.error.details.rebuilding).toBe(false);
    expect(res.body.error.message).toContain('already has this change');
  });
});

describe('the cards a deploy makes (madeBy: deploy)', () => {
  const DEPLOYMENT = 'dep-0042';
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const BY = { kind: 'user', id: 'user-1' } as const;

  /** `version` of the agent, as a deploy registers it: 1.0.0's definition under the new number. */
  async function registered(h: Harness, version: string) {
    const got = await h.agents.getVersion({
      tenantId,
      agentId: AGENT as AgentId,
      version: '1.0.0' as Semver,
    });
    if (got === null) throw new Error('no 1.0.0');
    const { projectId: _in, ...agent } = got;
    await h.agents.publish({
      tenantId,
      projectId,
      agent: { ...agent, version } as unknown as Agent,
      madeFor: 'latest',
      enqueueTuples: () => [],
    });
  }

  /** The service a deploy makes its cards with, as the app wires it; `readOnly`: a pack's registry. */
  function cardsOf(
    h: Harness,
    opts: { readOnly?: boolean; freezes?: boolean; corrections?: CorrectionRegistryBinding } = {},
  ) {
    return createSuggestedChangeService({
      store: h.suggestedChanges,
      agents:
        opts.readOnly === true
          ? { ...h.agents, readOnly: { reason: 'The pack files are the source.' } }
          : h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      agentPins: h.pinStore.bindings,
      ...(opts.freezes !== false && { testSets: h.freeze.binding }),
      ...(opts.corrections !== undefined && { corrections: opts.corrections }),
    });
  }

  /** A deploy that registered `version`, in the agent's project. */
  const deploy = (h: Harness, version = '1.1.0', service = cardsOf(h)) =>
    service.fromDeploy({
      tenantId,
      projectId,
      deploymentId: DEPLOYMENT,
      imageDigest: DIGEST,
      by: BY,
      agents: [{ agentId: AGENT as AgentId, version: version as Semver }],
    });

  /** A finished run of what the project runs, on the frozen cases (`testSetVersion` unless given). */
  async function ranBefore(h: Harness, testSetVersion = FROZEN.testSetVersion) {
    const run = await h.testRuns.binding.start({
      tenantId,
      projectId,
      testSetId: FROZEN.testSetId,
      testSetVersion,
      agentRef: { agentId: AGENT as AgentId, version: '1.0.0' as Semver },
    });
    if (run.kind !== 'ok') throw new Error(run.kind);
    await h.testRuns.finish(run.testRunId as unknown as string, { delta: 0 });
    return run.testRunId as unknown as string;
  }

  /** A pinned project, a deploy of 1.1.0, and its card's check finished: ready. */
  async function readyCard(opts: { ranBefore?: boolean } = {}) {
    const h = await harness();
    h.pinStore.pin(PROJECT, '1.0.0');
    const now = opts.ranBefore === true ? await ranBefore(h) : undefined;
    await registered(h, '1.1.0');
    const out = await deploy(h);
    const id = out.made[0]?.id as unknown as string;
    const card = (await h.call('GET', `/v1/suggested-changes/${id}`)).body;
    await h.testRuns.finish(card.check.with.testRunId, { delta: 0.1 });
    return { ...h, id, now };
  }

  test("a pinned project gets a card for the deploy's version, checked as that version; with no run of what it runs, it says that version isn't running", async () => {
    const h = await harness();
    h.pinStore.pin(PROJECT, '1.0.0');
    // A run of what it runs on other cases isn't the same check.
    await ranBefore(h, '1.0.6');
    await registered(h, '1.1.0');
    const out = await deploy(h);
    expect(out.failed).toEqual([]);
    expect(out.made).toHaveLength(1);
    const id = out.made[0]?.id as unknown as string;
    // Only the deploy's version runs: what the project runs is 1.0.0, its own code.
    expect(h.testRuns.started.at(-1)).toMatchObject({
      testSetId: FROZEN.testSetId,
      testSetVersion: FROZEN.testSetVersion,
      agentRef: { agentId: AGENT, version: '1.1.0' },
    });
    expect(h.testRuns.started).toHaveLength(2);
    const card = (await h.call('GET', `/v1/suggested-changes/${id}`)).body;
    expect(card).toMatchObject({
      projectId,
      title: 'New code from a deploy: v1.0.0 → v1.1.0',
      madeBy: { kind: 'deploy', deploymentId: DEPLOYMENT },
      builtOn: { version: '1.0.0' },
      version: '1.1.0',
      changes: [{ kind: 'code', deploymentId: DEPLOYMENT, imageDigest: DIGEST }],
      why: 'New code from a deploy',
      fixes: [],
      status: 'checking',
    });
    expect(card.check.now).toBeUndefined();
    await h.testRuns.finish(card.check.with.testRunId, { delta: 0.1 });
    const ready = (await h.call('GET', `/v1/suggested-changes/${id}`)).body;
    expect(ready).toMatchObject({
      status: 'ready',
      note: { kind: 'not-running', version: '1.0.0' },
    });
  });

  test("with a finished run of what the project runs on the same cases, that run is the card's now", async () => {
    const h = await readyCard({ ranBefore: true });
    const card = (await h.call('GET', `/v1/suggested-changes/${h.id}`)).body;
    expect(card.status).toBe('ready');
    expect(card.note).toBeUndefined();
    expect(card.check.now.testRunId).toBe(h.now);
    // Nothing ran again for it.
    expect(h.testRuns.started).toHaveLength(2);
  });

  test('a project on Latest runs the new version at once, and gets none', async () => {
    const h = await harness();
    await registered(h, '1.1.0');
    expect(await deploy(h)).toEqual({ made: [], failed: [] });
    expect(h.suggestedChanges.rows.size).toBe(0);
    expect(h.testRuns.started).toHaveLength(0);
  });

  test('a project pinned to the version already gets none', async () => {
    const h = await harness();
    await registered(h, '1.1.0');
    h.pinStore.pin(PROJECT, '1.1.0');
    expect(await deploy(h)).toEqual({ made: [], failed: [] });
    expect(h.suggestedChanges.rows.size).toBe(0);
  });

  test('the same deploy again is the same card, and checks nothing more', async () => {
    const h = await harness();
    h.pinStore.pin(PROJECT, '1.0.0');
    await registered(h, '1.1.0');
    const first = await deploy(h);
    const again = await deploy(h);
    expect(again.made.map((c) => c.id)).toEqual(first.made.map((c) => c.id));
    expect(h.suggestedChanges.rows.size).toBe(1);
    expect(h.testRuns.started).toHaveLength(1);
  });

  test("with no cases in the project's test set yet, the card is made unchecked, and checking it waits for cases", async () => {
    const h = await harness({ cases: 0 });
    h.pinStore.pin(PROJECT, '1.0.0');
    await registered(h, '1.1.0');
    const out = await deploy(h);
    expect(out.made).toHaveLength(1);
    expect(h.testRuns.started).toHaveLength(0);
    const id = out.made[0]?.id as unknown as string;
    const card = (await h.call('GET', `/v1/suggested-changes/${id}`)).body;
    expect(card).toMatchObject({ status: 'check-failed', version: '1.1.0' });
    const check = await h.call('POST', `/v1/suggested-changes/${id}/check`, {});
    expect(check.status, JSON.stringify(check.body)).toBe(409);
    expect(check.body.error.code).toBe('suggested-change-nothing-to-check');
  });

  test('with corrections and no case in the project, the card is made unchecked with nothing frozen', async () => {
    const h = await harness();
    h.pinStore.pin(PROJECT, '1.0.0');
    await registered(h, '1.1.0');
    const noCase = {
      listCases: async () => ({ data: [], hasMore: false }),
    } as unknown as CorrectionRegistryBinding;
    const freezes = h.freeze.calls.length;
    const out = await deploy(h, '1.1.0', cardsOf(h, { corrections: noCase }));
    expect(out.made).toHaveLength(1);
    expect(h.freeze.calls).toHaveLength(freezes);
    expect(h.testRuns.started).toHaveLength(0);
    const id = out.made[0]?.id as unknown as string;
    const card = (await h.call('GET', `/v1/suggested-changes/${id}`)).body;
    expect(card).toMatchObject({ status: 'check-failed', version: '1.1.0' });
  });

  test("a version the deploy didn't leave active is named in failed, and the deploy's other cards are still made", async () => {
    const h = await harness({ unregisteredVersions: ['1.1.0'] });
    h.pinStore.pin(PROJECT, '1.0.0');
    await registered(h, '1.1.0');
    await registered(h, '1.2.0');
    const out = await cardsOf(h).fromDeploy({
      tenantId,
      projectId,
      deploymentId: DEPLOYMENT,
      by: BY,
      agents: [
        { agentId: AGENT as AgentId, version: '1.1.0' as Semver },
        { agentId: AGENT as AgentId, version: '1.2.0' as Semver },
      ],
    });
    expect(out.failed).toEqual([
      { agentId: AGENT, message: expect.stringContaining('no active version 1.1.0') },
    ]);
    expect(out.made.map((c) => c.candidate?.agentVersion)).toEqual(['1.2.0']);
    // Named by no digest: the change has none.
    expect(out.made[0]?.change).toEqual({ deploymentId: DEPLOYMENT });
  });

  test("none where cards can't be made or checked: a read-only registry, or a runtime that freezes no test set", async () => {
    const h = await harness();
    h.pinStore.pin(PROJECT, '1.0.0');
    await registered(h, '1.1.0');
    expect(await deploy(h, '1.1.0', cardsOf(h, { readOnly: true }))).toEqual({
      made: [],
      failed: [],
    });
    expect(await deploy(h, '1.1.0', cardsOf(h, { freezes: false }))).toEqual({
      made: [],
      failed: [],
    });
    expect(h.suggestedChanges.rows.size).toBe(0);
  });

  test("pinning a deploy's card pins the deploy's version for its project", async () => {
    const h = await readyCard();
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.suggestedChange).toMatchObject({
      status: 'pinned',
      pinned: { version: '1.1.0' },
    });
    expect(h.pinStore.pins.find((p) => p.agentId === AGENT)?.version).toBe('1.1.0');
  });

  test("a deploy's card is never rebuilt: once its project moves, pinning it is refused, with no rebuild", async () => {
    const h = await readyCard();
    await registered(h, '1.0.5');
    h.pinStore.pin(PROJECT, '1.0.5');
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'suggested-change-out-of-date',
      details: { builtOn: '1.0.0', runs: '1.0.5', rebuilding: false },
    });
    const card = (await h.call('GET', `/v1/suggested-changes/${h.id}`)).body;
    expect(card).toMatchObject({ status: 'ready', builtOn: { version: '1.0.0' } });
    expect(card.builtOn.rebuiltAt).toBeUndefined();
  });
});

describe('audit events: making one, pinning it, adding it as Latest and withdrawing it', () => {
  /** What every event names of the suggested change `id` made from `CARD` (its content never). */
  const named = (id: string) => ({
    suggestedChangeId: id,
    agentId: AGENT,
    builtOn: '1.0.0',
    version: '1.0.1',
    blockId: WEIGHTS,
    blockVersion: expect.any(String),
    madeBy: { kind: 'person', userId: 'user-1' },
  });

  test('making one is recorded in its project, with the caller as its actor, naming no content; the same one again is not', async () => {
    const h = await made();
    const [created, ...more] = h.events('suggested-change-created');
    expect(more).toEqual([]);
    expect(created?.actor).toBe('user:user-1');
    expect(created?.projectId).toBe(projectId);
    expect(created?.outcome).toBe('succeeded');
    expect((created?.payload as { doc: unknown }).doc).toEqual(named(h.id));
    const sent = JSON.stringify(created?.payload);
    for (const content of [CARD.why, 'recency']) expect(sent).not.toContain(content);

    const again = await h.call('POST', '/v1/suggested-changes', CARD);
    expect(again.headers.get('X-Suggested-Change-Deduped')).toBe('true');
    expect(h.events('suggested-change-created')).toHaveLength(1);
  });

  test('pinning one names its pin change, pinned or waiting for a second person; a pin the gate refuses is not recorded', async () => {
    const pinned = await checked();
    expect((await pinned.call('POST', `/v1/suggested-changes/${pinned.id}/pin`, {})).status).toBe(
      201,
    );
    const [now] = pinned.events('suggested-change-pinned');
    expect(now?.actor).toBe('user:user-1');
    expect(now?.projectId).toBe(projectId);
    expect((now?.payload as { doc: unknown }).doc).toEqual({
      ...named(pinned.id),
      pinChangeId: pinned.suggestedChanges.rows.get(pinned.id)?.pinChangeId,
      status: 'pinned',
    });

    const waits = await checked();
    waits.pinStore.state.releaseGate = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: PROJECT,
      spec: { approvals: { role: 'standard' } },
      createdAt: NOW,
    };
    expect((await waits.call('POST', `/v1/suggested-changes/${waits.id}/pin`, {})).status).toBe(
      202,
    );
    expect(waits.events('suggested-change-pinned').map((e) => e.payload)).toMatchObject([
      { doc: { suggestedChangeId: waits.id, status: 'waiting-for-second-person' } },
    ]);

    const refused = await checked();
    refused.pinStore.state.releaseGate = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: PROJECT,
      spec: { metrics: [{ name: 'passRate', minCandidate: 0.99 }] },
      createdAt: NOW,
    };
    expect((await refused.call('POST', `/v1/suggested-changes/${refused.id}/pin`, {})).status).toBe(
      422,
    );
    expect(refused.events('suggested-change-pinned')).toEqual([]);
  });

  test('adding one as Latest is recorded, its reason kept off the event', async () => {
    const h = await harness();
    const res = await h.call('POST', '/v1/suggested-changes', CARD);
    await h.testRuns.finish(res.body.check.with.testRunId, { delta: 0.1 });
    await h.testRuns.finish(res.body.check.now.testRunId, { delta: 0 });
    const added = await h.call('POST', `/v1/suggested-changes/${res.body.id}/add-as-latest`, {
      reason: 'Fit first for acme',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const [event, ...more] = h.events('suggested-change-added-as-latest');
    expect(more).toEqual([]);
    expect(event?.actor).toBe('user:user-1');
    expect(event?.projectId).toBe(projectId);
    expect((event?.payload as { doc: unknown }).doc).toEqual(named(res.body.id));
    expect(JSON.stringify(event?.payload)).not.toContain('Fit first');
  });

  test('withdrawing one is recorded, its reason kept off the event; a refused withdrawal is not', async () => {
    const h = await made();
    expect((await h.call('POST', `/v1/suggested-changes/${h.id}/withdraw`, {})).status).toBe(400);
    expect(h.events('suggested-change-withdrawn')).toEqual([]);
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/withdraw`, {
      reason: 'wrong block',
    });
    expect(res.status).toBe(200);
    const [event, ...more] = h.events('suggested-change-withdrawn');
    expect(more).toEqual([]);
    expect(event?.actor).toBe('user:user-1');
    expect(event?.projectId).toBe(projectId);
    // Withdrawn while still checking: its version was published when it was made.
    expect((event?.payload as { doc: unknown }).doc).toEqual(named(h.id));
    expect(JSON.stringify(event?.payload)).not.toContain('wrong block');
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

  const spans = (scope: AgentPinScope) => async () => {
    const h = await harness(wide);
    const id = await oldRow(h, scope);
    const res = await h.call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('pin-scope-spans-environments');
  };

  test('a tenant-wide pin from before is refused', spans({ kind: 'tenant' }));
  test('an org-wide pin from before is refused', spans(ORG_SCOPE));

  test('one for the first environment is not a width refusal', async () => {
    const h = await harness(wide);
    h.pinStore.pin(PROJECT, '1.0.0');
    const made = await h.call('POST', '/v1/suggested-changes', CARD);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // One project stays within one environment: past the width check, on to
    // the service (where it's still checking).
    const res = await h.call('POST', `/v1/suggested-changes/${made.body.id}/pin`, {});
    expect(res.body.error?.code).not.toBe('pin-scope-spans-environments');
  });

  // M1: the refusal is keyed on order membership, not project count. One
  // project serves this agent, and it is the order's first environment, so a
  // tenant-wide request still spans the order (its authz is today's pin
  // on the agent, since one project serves it).
  test('one project serves the agent, and it is the order’s first environment: a tenant-wide request still spans it (409)', async () => {
    const one: ItemRow[] = [{ kind: 'agent', id: AGENT, projects: [projectId] }];
    const h = await harness({
      orders: [[projectId, PROD]],
      items: one,
      grants: [`publish agent:${AGENT}`, `pin agent:${AGENT}`, `read agent:${AGENT}`],
    });
    const id = await oldRow(h, { kind: 'tenant' });
    const res = await h.call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('pin-scope-spans-environments');
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

  test("it's kept with what its block held as it was drafted, and read from there; one kept without it reads its block at `fromVersion`", async () => {
    const { call, id, suggestedChanges } = await made();
    const row = suggestedChanges.rows.get(id) as StoredSuggestedChange;
    const before = { values: { recency: 0.3, fit: 0.7 } };
    expect(row.change).toMatchObject({ fromVersion: '1.0.0', before });
    const changeOf = async () => (await call('GET', `/v1/suggested-changes/${id}`)).body.changes[0];
    // What was kept is what's read, not the block's version now.
    const kept = { values: { recency: 0.1, fit: 0.9 } };
    suggestedChanges.rows.set(id, {
      ...row,
      change: { ...row.change, before: kept },
    } as StoredSuggestedChange);
    expect(await changeOf()).toMatchObject({ before: kept });
    // One drafted before `before` was kept reads the same as it did then.
    const { before: _b, ...older } = row.change as typeof row.change & { before?: unknown };
    suggestedChanges.rows.set(id, { ...row, change: older } as StoredSuggestedChange);
    expect(await changeOf()).toMatchObject({ before, after: { values: CARD.values } });
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

  test('making one needs publish; pinning needs pin', async () => {
    const reader = await harness({ grants: [`read agent:${AGENT}`] });
    reader.pinStore.pin(PROJECT, '1.0.0');
    const res = await reader.call('POST', '/v1/suggested-changes', CARD);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('publish');
    expect(reader.suggestedChanges.rows.size).toBe(0);

    const h = await checked(0.1, { grants: [`read agent:${AGENT}`, `publish agent:${AGENT}`] });
    const pin = await h.call('POST', `/v1/suggested-changes/${h.id}/pin`, {});
    expect(pin.status).toBe(403);
    expect(pin.body.error.message).toContain('pin');
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
  test('it answers with the corrections it fixes, how many in all, and that a service made it', async () => {
    const h = await harness();
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      agentPins: h.pinStore.bindings,
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
    const id = drafted.value.suggestedChange.id;
    const res = await h.call('GET', `/v1/suggested-changes/${id}`);
    expect(res.status).toBe(200);
    // `fixes` names only the first ones; `correctionCount` counts them all.
    expect(res.body).toMatchObject({
      fixes: ['j-1', 'j-2'],
      correctionCount: 140,
      madeBy: { kind: 'service', id: 'settings-optimizer' },
    });
    // The spec's schema allows no other keys, so each one answered must be one it lists.
    expect(SuggestedChangeSchema.additionalProperties).toBe(false);
    const specKeys = Object.keys(SuggestedChangeSchema.properties as Record<string, unknown>);
    expect(Object.keys(res.body).filter((key) => !specKeys.includes(key))).toEqual([]);
    const listed = (await h.call('GET', '/v1/suggested-changes')).body.data;
    expect(listed.find((s: { id: string }) => s.id === id)).toMatchObject({
      fixes: ['j-1', 'j-2'],
      correctionCount: 140,
    });
  });

  test('its request waits for a reviewer even where no release gate asks for one (K2)', async () => {
    const h = await harness();
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      agentPins: h.pinStore.bindings,
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
      objective: 'passRate',
      actor,
    });
    if (evaluated.kind !== 'ok') throw new Error(JSON.stringify(evaluated.error));
    const runId = evaluated.value.evaluation?.testRunId as string;
    await h.testRuns.finish(runId, { delta: 0.2 });
    const requested = await service.pin({ tenantId, suggestedChange: evaluated.value, actor });
    if (requested.kind !== 'ok') throw new Error(JSON.stringify(requested.error));
    expect(requested.value.pin).toMatchObject({
      kind: 'ok',
      pin: { status: 'pending-approval' },
    });
    const request = h.pinStore.calls.find((c) => c.method === 'request')?.input as {
      gate: unknown;
      requestedBy: unknown;
    };
    expect(request.gate).toMatchObject({
      releaseGate: null,
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
    scope: AgentPinScope = PROJECT,
  ): Promise<{ role: string; count: number; separateApprover: boolean } | undefined> {
    const h = await harness();
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      agentPins: h.pinStore.bindings,
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
      objective: 'passRate',
      actor,
    });
    if (evaluated.kind !== 'ok') throw new Error(JSON.stringify(evaluated.error));
    const runId = evaluated.value.evaluation?.testRunId as string;
    await h.testRuns.finish(runId, { delta: 0.2 });
    const requested = await service.pin({ tenantId, suggestedChange: evaluated.value, actor });
    if (requested.kind !== 'ok') throw new Error(JSON.stringify(requested.error));
    const request = h.pinStore.calls.find((c) => c.method === 'request')?.input as {
      gate: { approval?: { role: string; count: number; separateApprover: boolean } };
    };
    return request.gate.approval;
  }

  test("an Improve run's proof starts with no pin for the whole tenant: the version it makes is Latest nowhere", async () => {
    const h = await harness();
    h.pinStore.pin(PROJECT, '1.0.0');
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      agentPins: h.pinStore.bindings,
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
      objective: 'passRate',
      actor: { kind: 'service', id: 'improve-run' },
    });
    if (evaluated.kind !== 'ok') throw new Error(JSON.stringify(evaluated.error));
    expect(evaluated.value.evaluation?.testRunId).toEqual(expect.any(String));
    expect(h.testRuns.started).toHaveLength(1);
  });

  test('a drafter must ask a separate approver when a second reviewer could approve', async () => {
    const approval = await draftedApprovalFor(
      roster({ userId: 'u-alice' }, { userId: 'u-bob', role: 'senior' }),
      { kind: 'service', id: 'improve-run' },
    );
    expect(approval).toMatchObject({ role: 'standard', count: 1, separateApprover: true });
  });

  test('the only reviewer, who asked, may approve their own drafted pin', async () => {
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
    // resolving to the pin's own project does not.
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
   * Like `draftedApprovalFor`, but with a scope's release gate in force — so the
   * pin's approval is `resolveApproval`'s combination of the gate's own
   * approval and the drafter's separate-approver rule. `approvals` is the
   * gate's approvals block; `undefined` is a gate with none (only a metric
   * bar the candidate clears), where the drafter's own approval applies.
   */
  async function underReleaseGate(
    approvals: NonNullable<ReleaseGateSpec['approvals']> | undefined,
    reviewers: Pick<ReviewerRegistryBinding, 'list'>,
    actor: { kind: 'user' | 'service'; id: string },
  ): Promise<{ role: string; count: number; separateApprover: boolean } | undefined> {
    const h = await harness();
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
    h.pinStore.state.releaseGate = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: PROJECT,
      spec:
        approvals === undefined
          ? { metrics: [{ name: 'passRate', minCandidate: 0.1 }] }
          : { approvals },
      createdAt: NOW,
    };
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      agentPins: h.pinStore.bindings,
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
      objective: 'passRate',
      actor,
    });
    if (evaluated.kind !== 'ok') throw new Error(JSON.stringify(evaluated.error));
    const runId = evaluated.value.evaluation?.testRunId as string;
    await h.testRuns.finish(runId, { delta: 0.2 });
    const requested = await service.pin({ tenantId, suggestedChange: evaluated.value, actor });
    if (requested.kind !== 'ok') throw new Error(JSON.stringify(requested.error));
    const request = h.pinStore.calls.find((c) => c.method === 'request')?.input as {
      gate: { approval?: { role: string; count: number; separateApprover: boolean } };
    };
    return request.gate.approval;
  }

  test('a release gate that asks for a separate approver is a floor the drafter cannot loosen', async () => {
    // Explicit true, with a lone roster the drafter's own rule would let self-approve.
    const approval = await underReleaseGate(
      { role: 'standard', separateApprover: true },
      roster({ userId: 'u-solo' }),
      {
        kind: 'user',
        id: 'u-solo',
      },
    );
    expect(approval).toMatchObject({ role: 'standard', separateApprover: true });
  });

  test("a release gate's separate-approver default (unset) is true, so a lone drafter still cannot self-approve", async () => {
    const approval = await underReleaseGate({ role: 'standard' }, roster({ userId: 'u-solo' }), {
      kind: 'user',
      id: 'u-solo',
    });
    expect(approval).toMatchObject({ role: 'standard', separateApprover: true });
  });

  test('a release gate that sets separateApprover false still gets one when a second reviewer could decide', async () => {
    const approval = await underReleaseGate(
      { role: 'standard', separateApprover: false },
      roster({ userId: 'u-solo' }, { userId: 'u-two' }),
      { kind: 'user', id: 'u-solo' },
    );
    expect(approval).toMatchObject({ role: 'standard', separateApprover: true });
  });

  test('a release gate that sets separateApprover false lets a lone reviewer approve their own drafted pin', async () => {
    const approval = await underReleaseGate(
      { role: 'standard', separateApprover: false },
      roster({ userId: 'u-solo' }),
      { kind: 'user', id: 'u-solo' },
    );
    expect(approval).toMatchObject({ role: 'standard', separateApprover: false });
  });

  test("a gate's separateApprover false is re-checked at the gate's role, so a junior second reviewer does not count", async () => {
    // Gate role senior; the only other reviewer is standard — below senior, so
    // no separate approver. Ranking the re-check at the drafter's own 'standard'
    // (the bug) would count u-two and demand one.
    const approval = await underReleaseGate(
      { role: 'senior', separateApprover: false },
      roster({ userId: 'u-solo' }, { userId: 'u-two', role: 'standard' }),
      { kind: 'user', id: 'u-solo' },
    );
    expect(approval).toMatchObject({ role: 'senior', separateApprover: false });
  });

  test("a gate's separateApprover false counts a second reviewer ranked at the gate's role", async () => {
    const approval = await underReleaseGate(
      { role: 'senior', separateApprover: false },
      roster({ userId: 'u-solo' }, { userId: 'u-sr', role: 'senior' }),
      { kind: 'user', id: 'u-solo' },
    );
    expect(approval).toMatchObject({ role: 'senior', separateApprover: true });
  });

  test("a release gate with no approvals block leaves the drafter's own approval to apply", async () => {
    // Only a metric bar: the gate improveRuns, names no approval, so the drafter's
    // approval (its own separate-approver rule, at standard) is what waits.
    const approval = await underReleaseGate(
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

  /**
   * A draft evaluated against a reference run of the current version, both
   * still running; `judging`: whose model the Improve run checks answers with.
   */
  async function held(rule: SuggestedChangeRule, judging?: TestRunJudging) {
    const h = await harness();
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: h.agents,
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      agentPins: h.pinStore.bindings,
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
      objective: 'passRate',
      actor: { kind: 'service', id: 'improve-run' },
      against: { rule, reference: { testRunId: referenceId } },
      ...(judging !== undefined && { judging }),
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

  test('the candidate is judged by the model the Improve run names; absent, by its own', async () => {
    const named = await held('cheaper', { model: { providerId: 'acme-ai', model: 'acme-large' } });
    // The reference run is started first, by the Improve run; the candidate's is the last.
    expect(named.testRuns.started.at(-1)).toMatchObject({
      agentRef: { agentId: AGENT },
      judging: { model: { providerId: 'acme-ai', model: 'acme-large' } },
    });
    const own = await held('cheaper');
    expect(own.testRuns.started.at(-1)).not.toHaveProperty('judging');
  });

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
    const { call, pinStore, suggestedChanges } = await harness({
      referenceScope: reach(new Set([WEIGHTS])),
    });
    pinStore.pin(PROJECT, '1.0.0');
    const res = await call('POST', '/v1/suggested-changes', CARD);
    expect(refused(res)).toEqual([`/change/blockId block ${WEIGHTS}`]);
    expect(suggestedChanges.rows.size).toBe(0);
  });

  test("pinning asks it too: a project that no longer reaches the agent isn't pinned", async () => {
    const out = new Set<string>();
    const { call, id, pinStore } = await checked(0.1, { referenceScope: reach(out) });
    out.add(AGENT);
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(refused(res)).toEqual([`/scope agent ${AGENT}`]);
    expect(pinStore.calls.filter((c) => c.method === 'request')).toEqual([]);
  });
});

describe('Improve runs', () => {
  const IMPROVE = { agentId: AGENT, projectId };

  test('improve starts an Improve run in the project named, from the version it runs, with the default budget (202)', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({
      agentId: AGENT,
      projectId,
      startsFrom: { version: '1.0.0', follows: 'pin' },
      tiers: ['prompt', 'settings'],
      objective: 'passRate',
      budget: { maxCostUsd: 5, maxCandidates: 30 },
      status: 'running',
      tried: 0,
      costUsd: '0',
      takes: [],
      requestedBy: 'user:user-1',
    });
    // No tiers named: the runtime tries every tier that's ready.
    expect(improveRuns.started[0]).not.toHaveProperty('tiers');
    expect(improveRuns.started[0]).toMatchObject({
      projectId,
      // With no corrector-group registry wired, the default stays experts-only.
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
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
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
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
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
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
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
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
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
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
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
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
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
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
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
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
  });

  test('resolves against the project the body names, not where the agent is made', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    const named = randomUUID() as ProjectId;
    // The agent is made in `projectId`, but the Improve run works in `named`,
    // where the expert group lives: it counts trusted corrections only, on the
    // check as on the start.
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'project', projectId: named },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    const res = await h.call('POST', '/v1/improve-runs', { ...IMPROVE, projectId: named });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.checked[0]).toMatchObject({
      projectId: named,
      groupWeights: 'experts-only',
    });
    expect(improveRuns.started[0]).toMatchObject({
      projectId: named,
      groupWeights: 'experts-only',
    });
  });

  test("an expert group only where the agent is made, not in the project named, doesn't count", async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    const named = randomUUID() as ProjectId;
    // The inverse: the expert group is in the agent's own project, but the
    // Improve run works in another, so the default must NOT flip.
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'project', projectId },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    const res = await h.call('POST', '/v1/improve-runs', { ...IMPROVE, projectId: named });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'as-recorded' });
  });

  test('an expert group on the agent in the project named flips the default', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    const named = randomUUID() as ProjectId;
    await corrections.createGroup({
      tenantId,
      scope: { kind: 'agent', projectId: named, agentId: AGENT },
      name: 'expert',
      weight: 3,
      assertableBy: { principalKinds: ['user'] },
    });
    const h = await harness({
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    const res = await h.call('POST', '/v1/improve-runs', { ...IMPROVE, projectId: named });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
  });

  test('an explicit groupWeights reads no corrector group', async () => {
    const improveRuns = inMemoryImproveRuns();
    // With `groupWeights` set, the default isn't resolved, so the route must
    // not list corrector groups at all: the registry throws if it does.
    const h = await harness({
      improveRuns: improveRuns.binding,
      correctionRegistry: {
        ...inMemoryCorrections(),
        listGroups: async () => {
          throw new Error('corrector groups were read for an explicit groupWeights');
        },
      },
    });
    const res = await h.call('POST', '/v1/improve-runs', {
      ...IMPROVE,
      groupWeights: 'as-recorded',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.checked[0]).toMatchObject({ groupWeights: 'as-recorded' });
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'as-recorded' });
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
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'as-recorded' });
  });

  test('an explicit groupWeights always wins over the project default', async () => {
    const improveRuns = inMemoryImproveRuns();
    const corrections = inMemoryCorrections();
    const h = await harness({
      improveRuns: improveRuns.binding,
      correctionRegistry: corrections,
    });
    // No expert group named, but the caller asks for experts-only outright.
    const res = await h.call('POST', '/v1/improve-runs', {
      ...IMPROVE,
      groupWeights: 'experts-only',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started[0]).toMatchObject({ groupWeights: 'experts-only' });
    expect(res.body.groupWeights).toBe('experts-only');
  });

  test('no Improve run starts for an agent whose project is suspended: 409 improve-not-ready, listing project; restored, it starts', async () => {
    const improveRuns = inMemoryImproveRuns();
    let suspended = true;
    const asked: string[] = [];
    const h = await harness({
      improveRuns: improveRuns.binding,
      projectSuspended: async (_tenantId, pid) => {
        asked.push(pid as unknown as string);
        return suspended;
      },
    });
    const refused = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('improve-not-ready');
    expect(refused.body.error.details.items).toMatchObject([
      { key: 'project', missing: true, fix: { where: 'kindgi' } },
    ]);
    expect(refused.body.error.details.items[0].fix.text).toContain('suspended');
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

  test('a prompt Improve run needs no model; `model` and `candidates` reach the check and the start, and are for the prompt tier only', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ improveRuns: improveRuns.binding });
    // No model: the runtime drafts with the model of the version's own model-settings block.
    const noModel = await h.call('POST', '/v1/improve-runs', { ...IMPROVE, tiers: ['prompt'] });
    expect(noModel.status, JSON.stringify(noModel.body)).toBe(202);
    expect(noModel.body.tiers).toEqual(['prompt']);
    expect(improveRuns.started[0]).not.toHaveProperty('model');
    const model = { providerId: 'acme-llm', model: 'm-1' };
    const res = await h.call('POST', '/v1/improve-runs', {
      ...IMPROVE,
      tiers: ['prompt'],
      model,
      candidates: 4,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ tiers: ['prompt'], model, candidates: 4 });
    expect(improveRuns.checked[1]).toMatchObject({ tiers: ['prompt'], model, candidates: 4 });
    expect(improveRuns.started[1]).toMatchObject({ tiers: ['prompt'], model, candidates: 4 });
    const settingsWithModel = await h.call('POST', '/v1/improve-runs', {
      ...IMPROVE,
      tiers: ['settings'],
      model,
    });
    expect(settingsWithModel.status).toBe(400);
    expect(settingsWithModel.body.error.message).toContain('are for the prompt tier');
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
    expect(improveRuns.started).toHaveLength(2);
  });

  test("an agent that isn't ready starts nothing: 409 improve-not-ready, listing every missing item at once", async () => {
    const improveRuns = inMemoryImproveRuns({ wording: false, testCases: 0 });
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', '/v1/improve-runs', { ...IMPROVE, tiers: ['prompt'] });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('improve-not-ready');
    expect(res.body.error.message).toContain('wording, test-cases missing');
    const items: Record<string, any>[] = res.body.error.details.items;
    expect(items.map((i) => [i.key, i.fix.where])).toEqual([
      ['wording', 'repo'],
      ['test-cases', 'kindgi'],
    ]);
    expect(items[1]?.count).toBe(0);
    expect(improveRuns.checked).toHaveLength(1);
    expect(improveRuns.started).toEqual([]);
  });

  test('with no tiers named, either tier is enough: improve-not-ready only when wording and settings are both missing', async () => {
    const neither = inMemoryImproveRuns({ wording: false, settings: false });
    const h = await harness({ improveRuns: neither.binding });
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('improve-not-ready');
    const keys = res.body.error.details.items.map((i: { key: string }) => i.key);
    expect(keys).toEqual(['wording', 'settings']);
    expect(neither.started).toEqual([]);
    const settingsOnly = inMemoryImproveRuns({ wording: false });
    const ready = await harness({ improveRuns: settingsOnly.binding });
    const started = await ready.call('POST', '/v1/improve-runs', IMPROVE);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
  });

  test('one Improve run at a time per agent and project: 409 improve-run-running, naming the running one, and nothing starts', async () => {
    const improveRuns = inMemoryImproveRuns({ runningId: 'improve-run-1' });
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('improve-run-running');
    expect(res.body.error.details.improveRunId).toBe('improve-run-1');
    expect(improveRuns.started).toEqual([]);
  });

  test('a run that starts between the check and the start: the start answers it, and that is 409 improve-run-running too', async () => {
    const improveRuns = inMemoryImproveRuns({ startsRunning: 'improve-run-2' });
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('improve-run-running');
    expect(res.body.error.details.improveRunId).toBe('improve-run-2');
    expect(improveRuns.started).toHaveLength(1);
  });

  test('a running run and another missing item: 409 improve-not-ready, listing both', async () => {
    const improveRuns = inMemoryImproveRuns({ runningId: 'improve-run-1', testCases: 0 });
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('improve-not-ready');
    const keys = res.body.error.details.items.map((i: { key: string }) => i.key);
    expect(keys).toEqual(['test-cases', 'one-at-a-time']);
    expect(res.body.error.details.items[1].improveRunId).toBe('improve-run-1');
    expect(improveRuns.started).toEqual([]);
  });

  test("the list narrows by agentId, projectId and status, and refuses a projectId or status it doesn't know (400)", async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ improveRuns: improveRuns.binding });
    const started = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const query = `agentId=${AGENT}&projectId=${projectId}&status=running`;
    const listed = await h.call('GET', `/v1/improve-runs?${query}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data.map((p: { id: string }) => p.id)).toEqual([started.body.id]);
    expect(improveRuns.listed[0]).toMatchObject({ agentId: AGENT, projectId, status: 'running' });
    const elsewhere = await h.call('GET', `/v1/improve-runs?projectId=${randomUUID()}`);
    expect(elsewhere.body.data).toEqual([]);
    const ended = await h.call('GET', '/v1/improve-runs?status=completed');
    expect(ended.body.data).toEqual([]);
    for (const [bad, message] of [
      ['projectId=prod', '`projectId` must be a project id'],
      ['status=paused', '`status` must be one of running, completed, failed, cancelled'],
    ] as const) {
      const res = await h.call('GET', `/v1/improve-runs?${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.error.message, bad).toContain(message);
    }
    expect(improveRuns.listed).toHaveLength(3);
  });

  test.each([
    [{ tiers: [] }],
    [{ budget: { maxCostUsd: 500 } }],
    [{ budget: { maxCandidates: 0 } }],
    [{ objective: 'speed' }],
    [{ extra: 1 }],
  ])('a malformed request is bad input: %j', async (patch) => {
    const h = await harness({ improveRuns: inMemoryImproveRuns().binding });
    const res = await h.call('POST', '/v1/improve-runs', { ...IMPROVE, ...patch });
    expect(res.status).toBe(400);
  });

  test('without Improve runs in the runtime: 501 improve-unsupported, for reads too', async () => {
    const h = await harness();
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('improve-unsupported');
    expect((await h.call('GET', '/v1/improve-runs')).status).toBe(501);
  });

  test('improve needs publish on the agent; an Improve run of an agent the caller cannot read is 404', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({
      improveRuns: improveRuns.binding,
      grants: [`read agent:${AGENT}`],
    });
    expect((await h.call('POST', '/v1/improve-runs', IMPROVE)).status).toBe(403);
    expect(improveRuns.checked).toEqual([]);
    const started = await improveRuns.binding.start({
      tenantId,
      projectId,
      agentId: 'acme.secret',
      objective: 'passRate',
      groupWeights: 'experts-only',
      budget: { maxCostUsd: 1, maxCandidates: 1 },
      requestedBy: { kind: 'user', id: 'u' },
    });
    if (started.kind !== 'started') throw new Error('the Improve run should have started');
    expect((await h.call('GET', `/v1/improve-runs/${started.improveRun.id}`)).status).toBe(404);
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
  const IMPROVE = { agentId: AGENT, projectId };
  const CHECK = '/v1/improve-runs/check';

  test('a ready agent: every item present in order, what it starts from, the estimate and the month', async () => {
    const improveRuns = inMemoryImproveRuns({ month: { spentUsd: '3.5', capUsd: '20' } });
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', CHECK, IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // 10 replays × $0.20 = $2.00, under the default $5 cap.
    expect(res.body).toEqual({
      ready: true,
      startsFrom: { version: '1.0.0', follows: 'pin' },
      items: [
        { key: 'wording', missing: false },
        { key: 'settings', missing: false },
        { key: 'test-cases', missing: false, count: 12 },
        { key: 'permission', missing: false },
        { key: 'one-at-a-time', missing: false },
        { key: 'project', missing: false },
      ],
      estimate: { costUsd: '2', maxCostUsd: '5', basis: { replays: 10, meanRunCostUsd: '0.2' } },
      month: { spentUsd: '3.5', capUsd: '20' },
    });
    expect(improveRuns.checked).toEqual([
      { tenantId, projectId, agentId: AGENT, groupWeights: 'experts-only' },
    ]);
    expect(improveRuns.started).toEqual([]);
  });

  test("caps the search's share of the estimate at the budget: the proof's replays come on top", async () => {
    const improveRuns = inMemoryImproveRuns({
      basis: { replays: 1000, proofReplays: 100, meanRunCostUsd: '1' },
    });
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', CHECK, { ...IMPROVE, budget: { maxCostUsd: 20 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The search's 900 × $1, clamped to the $20 cap, and the proof's 100 × $1.
    expect(res.body.estimate).toEqual({
      costUsd: '120',
      maxCostUsd: '20',
      basis: { replays: 1000, proofReplays: 100, meanRunCostUsd: '1' },
    });
  });

  test("counts no search below zero when a basis's proof replays outnumber its replays", async () => {
    const improveRuns = inMemoryImproveRuns({
      basis: { replays: 4, proofReplays: 6, meanRunCostUsd: '1' },
    });
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', CHECK, { ...IMPROVE, budget: { maxCostUsd: 20 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The search's share is none, not -2 × $1; the proof's 6 × $1 stays.
    expect(res.body.estimate).toMatchObject({ costUsd: '6', maxCostUsd: '20' });
  });

  test("clamps the whole estimate to the budget when the runtime doesn't count the proof's replays apart", async () => {
    const improveRuns = inMemoryImproveRuns({ basis: { replays: 1000, meanRunCostUsd: '1' } });
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', CHECK, { ...IMPROVE, budget: { maxCostUsd: 20 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // 1000 × $1 = $1000, clamped to the $20 cap.
    expect(res.body.estimate).toMatchObject({ costUsd: '20', maxCostUsd: '20' });
    expect('proofReplays' in res.body.estimate.basis).toBe(false);
  });

  test('leaves costUsd out when the version has no cost history, and month out without an Improve schedule', async () => {
    const improveRuns = inMemoryImproveRuns({ basis: { replays: 10 } });
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', CHECK, IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.estimate).toEqual({ maxCostUsd: '5', basis: { replays: 10 } });
    expect('month' in res.body).toBe(false);
  });

  test('forwards the prompt options (tiers, model, candidates) to the check', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ improveRuns: improveRuns.binding });
    const model = { providerId: 'acme-llm', model: 'm-1' };
    const res = await h.call('POST', CHECK, {
      ...IMPROVE,
      tiers: ['prompt'],
      model,
      candidates: 4,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(improveRuns.checked[0]).toMatchObject({ tiers: ['prompt'], model, candidates: 4 });
  });

  test("an agent that isn't ready: ready false, and each missing item in order, saying where and how to fix it", async () => {
    const improveRuns = inMemoryImproveRuns({
      startsFrom: null,
      wording: false,
      settings: false,
      testCases: 0,
      runningId: 'improve-run-1',
    });
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', CHECK, IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ready).toBe(false);
    expect('startsFrom' in res.body).toBe(false);
    const items: Record<string, any>[] = res.body.items;
    expect(items.map((i) => [i.key, i.missing, i.fix?.where])).toEqual([
      ['wording', true, 'repo'],
      ['settings', true, 'repo'],
      ['test-cases', true, 'kindgi'],
      ['permission', false, undefined],
      ['one-at-a-time', true, 'kindgi'],
      ['project', true, 'repo'],
    ]);
    expect(items[2]?.count).toBe(0);
    expect(items[4]?.improveRunId).toBe('improve-run-1');
    for (const item of items.filter((i) => i.missing)) {
      expect(item.fix.text, item.key).not.toBe('');
      // Where the agent's code lives isn't known here: no fix names a file.
      expect(item.fix.text, item.key).not.toMatch(/\/|\.(ts|js|json|ya?ml|md)\b/);
    }
    expect(improveRuns.started).toEqual([]);
  });

  test('with no tiers named, one ready tier is enough; a named tier needs its own', async () => {
    const improveRuns = inMemoryImproveRuns({ wording: false });
    const h = await harness({ improveRuns: improveRuns.binding });
    const either = await h.call('POST', CHECK, IMPROVE);
    expect(either.body.ready, JSON.stringify(either.body)).toBe(true);
    // The item still says what's missing for the prompt tier.
    expect(either.body.items[0]).toMatchObject({ key: 'wording', missing: true });
    const settings = await h.call('POST', CHECK, { ...IMPROVE, tiers: ['settings'] });
    expect(settings.body.ready).toBe(true);
    const prompt = await h.call('POST', CHECK, { ...IMPROVE, tiers: ['prompt'] });
    expect(prompt.body.ready).toBe(false);
  });

  test('a malformed body is bad input (400) and checks nothing', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ improveRuns: improveRuns.binding });
    const res = await h.call('POST', CHECK, { ...IMPROVE, extra: 1 });
    expect(res.status).toBe(400);
    expect(improveRuns.checked).toEqual([]);
  });

  test('needs publish on the agent: a read-only caller is 403, and nothing is checked', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({
      improveRuns: improveRuns.binding,
      grants: [`read agent:${AGENT}`],
    });
    expect((await h.call('POST', CHECK, IMPROVE)).status).toBe(403);
    expect(improveRuns.checked).toEqual([]);
  });

  test('without Improve runs in the runtime: 501 improve-unsupported', async () => {
    const h = await harness();
    const res = await h.call('POST', CHECK, IMPROVE);
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('improve-unsupported');
  });

  // Start and check take the same body: a field improve doesn't take is
  // refused the same way on both, before the runtime is asked anything.
  test.each([
    { field: 'scope', value: { kind: 'tenant' } },
    { field: 'testSetId', value: 'acme.scoring-judged' },
    { field: 'fromVersion', value: '1.0.0' },
  ])(
    '`$field` is no field of improve: 400 naming it on start and check, and nothing is checked',
    async ({ field, value }) => {
      const improveRuns = inMemoryImproveRuns();
      const h = await harness({ improveRuns: improveRuns.binding });
      for (const path of ['/v1/improve-runs', CHECK]) {
        const res = await h.call('POST', path, { ...IMPROVE, [field]: value });
        expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(400);
        expect(res.body.error.code, path).toBe('bad-input');
        expect(res.body.error.message, path).toContain(`\`${field}\` isn't a field of improve`);
      }
      expect(improveRuns.checked).toEqual([]);
      expect(improveRuns.started).toEqual([]);
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
  const IMPROVE = { agentId: AGENT, projectId };

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
    prodOnly.pinStore.pin(PROJECT, '1.0.0');
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
    expect(res.body.suggestedChange.status).toBe('pinned');
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
      improveRuns: improveRuns.binding,
      grants,
      orders,
      items: items(),
    });
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

  test('an agent with one project: publish and pin on the agent, as before', async () => {
    const one: ItemRow[] = [{ kind: 'agent', id: AGENT, projects: [projectId] }];
    const h = await harness({ grants: [...maker, `read agent:${AGENT}`], orders, items: one });
    h.pinStore.pin(PROJECT, '1.0.0');
    const res = await h.call('POST', '/v1/suggested-changes', CARD);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain(`publish on agent "${AGENT}"`);
  });
});

describe("an agent registry that takes Improve's candidates (kindgi dev)", () => {
  const IMPROVE = { agentId: AGENT, projectId };
  const NARROWER = {
    code: 'registry-read-only',
    message: TAKES_CANDIDATES.takesCandidates.scopeReason,
  };

  test.each(['/v1/improve-runs', '/v1/improve-runs/check'])(
    "a read-only registry that takes no candidates refuses an Improve run (%s: 409 registry-read-only, with the registry's reason): nothing checked or started",
    async (path) => {
      const improveRuns = inMemoryImproveRuns();
      const h = await harness({ improveRuns: improveRuns.binding, readOnly: true });
      const res = await h.call('POST', path, IMPROVE);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'registry-read-only',
        message: TAKES_CANDIDATES.reason,
      });
      expect(res.body.error.details).toBeUndefined();
      expect(improveRuns.checked).toEqual([]);
      expect(improveRuns.started).toEqual([]);
    },
  );

  test('an Improve run is checked and started in its project: its change is for the whole tenant, which the runtime drafts', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ improveRuns: improveRuns.binding, readOnly: 'takes-candidates' });
    const checked = await h.call('POST', '/v1/improve-runs/check', IMPROVE);
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    const started = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(improveRuns.started.map((r) => r.projectId)).toEqual([projectId]);
  });

  test("a suggested change by hand is refused with the by-hand reason, not the scope's (409 registry-read-only), and none is kept", async () => {
    const h = await harness({ readOnly: 'takes-candidates', freezes: false });
    h.pinStore.pin(PROJECT, '1.0.0');
    const res = await h.call('POST', '/v1/suggested-changes', CARD);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'registry-read-only',
      message: TAKES_CANDIDATES.takesCandidates.byHandReason,
    });
    expect(res.body.error.message).not.toBe(NARROWER.message);
    expect(h.suggestedChanges.rows.size).toBe(0);
  });

  test('one for a project from before is not checked again: nothing published or started', async () => {
    const h = await harness({ readOnly: 'takes-candidates', freezes: false });
    const id = await oldRow(h, PROJECT);
    const res = await h.call('POST', `/v1/suggested-changes/${id}/check`);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'registry-read-only',
      message: TAKES_CANDIDATES.takesCandidates.byHandReason,
    });
    expect(h.testRuns.started).toEqual([]);
    expect([...h.blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toEqual([
      `${WEIGHTS}@1.0.0`,
    ]);
  });

  test("one for the whole tenant isn't checked again either: the by-hand reason, never not-for-a-project", async () => {
    const h = await harness({ readOnly: 'takes-candidates', freezes: false });
    const id = await oldRow(h, { kind: 'tenant' });
    const res = await h.call('POST', `/v1/suggested-changes/${id}/check`);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'registry-read-only',
      message: TAKES_CANDIDATES.takesCandidates.byHandReason,
    });
  });

  test("an Improve run's change, for the whole tenant, is pinned for the whole tenant, through the project its version was made in", async () => {
    const h = await harness({ readOnly: 'takes-candidates', freezes: false });
    const id = await oldRow(h, { kind: 'tenant' }, { checked: true });
    expect(h.suggestedChanges.rows.get(id)?.projectId).toBe(projectId);
    const res = await h.call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      pin: { status: 'pinned', toVersion: '1.0.1' },
      suggestedChange: { status: 'pinned', pinned: { version: '1.0.1' } },
    });
    expect(h.pinStore.pins.map((p) => [p.scope, p.version])).toContainEqual([
      { kind: 'tenant' },
      '1.0.1',
    ]);
  });

  /** An open correction of the agent in `inProject`: a case on its test set. */
  async function correctedIn(corrections: CorrectionRegistryBinding, inProject: ProjectId) {
    await corrections.record({
      tenantId,
      projectId: inProject,
      runId: randomUUID(),
      run: {
        subject: { kind: 'agent', id: AGENT, version: '1.0.0' },
        input: { ask: 'score the acme filing' },
        output: { text: '0.4' },
      },
      madeBy: { kind: 'user', id: 'user-1' },
      status: 'open',
      answer: 'wrong',
      shouldSay: '0.8',
    });
  }
  const OTHER = randomUUID() as ProjectId;

  /** The projects the pin's answer checks, reused or started. */
  const checkedIn = (body: { testRuns?: readonly { projectId: string }[] }) =>
    (body.testRuns ?? []).map((r) => r.projectId).sort();

  test('its pin checks the project the registry places the agent in, with no item-projects binding to say which serve it', async () => {
    const corrections = inMemoryCorrections();
    const h = await harness({
      readOnly: 'takes-candidates',
      projects: [projectId, OTHER],
      correctionRegistry: corrections,
    });
    await correctedIn(corrections, projectId);
    await correctedIn(corrections, OTHER);
    const id = await oldRow(h, { kind: 'tenant' }, { checked: true });
    const res = await h.call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(checkedIn(res.body), JSON.stringify(res.body)).toEqual([projectId]);
  });

  test("with an item-projects binding, as a deployed runtime wires one, its pin checks the binding's projects, not the registry's one", async () => {
    const corrections = inMemoryCorrections();
    const h = await harness({
      readOnly: 'takes-candidates',
      projects: [projectId, OTHER],
      items: [{ kind: 'agent', id: AGENT, projects: [projectId, OTHER] }],
      correctionRegistry: corrections,
    });
    await correctedIn(corrections, projectId);
    await correctedIn(corrections, OTHER);
    const id = await oldRow(h, { kind: 'tenant' }, { checked: true });
    const res = await h.call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(checkedIn(res.body), JSON.stringify(res.body)).toEqual([projectId, OTHER].sort());
  });

  test("one built on a version that no longer runs isn't rebuilt: 409 out of date, run Improve again, nothing pinned", async () => {
    const h = await harness({ readOnly: 'takes-candidates', freezes: false });
    const id = await oldRow(h, { kind: 'tenant' }, { checked: true });
    // The pack's files changed to another version since it was built.
    h.pinStore.pin({ kind: 'tenant' }, '1.0.2');
    const before = h.pinStore.pins.length;
    const res = await h.call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'suggested-change-out-of-date',
      message: `Suggested change ${id} is built on 1.0.0, and its project now runs 1.0.2, which it can't be rebuilt on: here only an Improve run makes and checks one, so run Improve again. Withdraw it`,
    });
    expect(h.pinStore.pins).toHaveLength(before);
  });

  test('adding one as Latest is refused with the Latest reason (409 registry-read-only)', async () => {
    const h = await harness({ readOnly: 'takes-candidates', freezes: false });
    const id = await oldRow(h, { kind: 'tenant' }, { checked: true });
    const res = await h.call('POST', `/v1/suggested-changes/${id}/add-as-latest`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'registry-read-only',
      message: TAKES_CANDIDATES.takesCandidates.latestReason,
    });
  });

  test("without its own reasons, it refuses by hand and as Latest with the registry's reason", async () => {
    const h = await harness({ freezes: false });
    const { byHandReason: _b, latestReason: _l, ...older } = TAKES_CANDIDATES.takesCandidates;
    const service = createSuggestedChangeService({
      store: h.suggestedChanges,
      agents: {
        ...h.agents,
        readOnly: { reason: TAKES_CANDIDATES.reason, takesCandidates: older },
      },
      blocks: h.blocks,
      testRuns: h.testRuns.binding,
      agentPins: h.pinStore.bindings,
    });
    const id = await oldRow(h, { kind: 'tenant' }, { checked: true });
    const suggestedChange = h.suggestedChanges.rows.get(id) as StoredSuggestedChange;
    const actor = { kind: 'user', id: 'user-1' } as const;
    const refusal = { code: 'registry-read-only', message: TAKES_CANDIDATES.reason };
    expect(await service.check({ tenantId, suggestedChange, actor })).toMatchObject({
      kind: 'err',
      error: refusal,
    });
    expect(await service.addAsLatest({ tenantId, suggestedChange, actor })).toMatchObject({
      kind: 'err',
      error: refusal,
    });
  });
});

describe('an Improve run started by hand works in the project `projectId` names', () => {
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

  async function improver(
    opts: { grants?: string[]; answer?: Parameters<typeof inMemoryImproveRuns>[0] } = {},
  ) {
    const improveRuns = inMemoryImproveRuns(opts.answer);
    const asked: string[] = [];
    const h = await harness({
      improveRuns: improveRuns.binding,
      orders,
      items: items(),
      projectSuspended: async (_tenantId, pid) => {
        asked.push(pid as unknown as string);
        return false;
      },
      ...(opts.grants !== undefined && { grants: opts.grants }),
    });
    const improve = (body: Record<string, unknown>, path = '/v1/improve-runs') =>
      h.call('POST', path, { agentId: AGENT, ...body });
    return { ...h, improveRuns, asked, improve };
  }

  test('prod named: the Improve run is checked and works in prod, and asks whether prod is suspended', async () => {
    const h = await improver();
    const res = await h.improve({ projectId: PROD });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.projectId).toBe(PROD);
    expect(h.improveRuns.checked.map((p) => p.projectId)).toEqual([PROD]);
    expect(h.improveRuns.started.map((p) => p.projectId)).toEqual([PROD]);
    expect(h.asked).toEqual([PROD]);
  });

  test('write where its versions are made starts one in prod; write in prod alone does not', async () => {
    const maker = await improver({
      grants: [`read project:${projectId}`, `write project:${projectId}`],
    });
    const prod = await maker.improve({ projectId: PROD });
    expect(prod.status, JSON.stringify(prod.body)).toBe(202);
    const prodOnly = await improver({ grants: [`read project:${PROD}`, `write project:${PROD}`] });
    for (const path of ['/v1/improve-runs', '/v1/improve-runs/check']) {
      const denied = await prodOnly.improve({ projectId: PROD }, path);
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      expect(denied.body.error.message).toContain(
        `improving agent "${AGENT}" needs write on project ${projectId}`,
      );
    }
    expect(prodOnly.improveRuns.checked).toEqual([]);
    expect(prodOnly.improveRuns.started).toEqual([]);
  });

  test('no version of the agent runs in the project named: 409 improve-not-ready, naming no project, and no Improve run', async () => {
    const h = await improver({ answer: { startsFrom: null } });
    const res = await h.improve({ projectId: PROD });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('improve-not-ready');
    expect(res.body.error.details.items).toEqual([
      {
        key: 'project',
        missing: true,
        fix: {
          where: 'repo',
          text: 'No version of the agent runs in this project. Deploy the agent to the project first.',
        },
      },
    ]);
    expect(JSON.stringify(res.body.error)).not.toContain(PROD);
    expect(h.improveRuns.started).toEqual([]);
  });

  test('`projectId` is required, and a project id: 400 on start and check, and nothing is checked', async () => {
    const h = await improver();
    // `undefined` leaves it out of the body.
    for (const value of [undefined, '', 7, null, 'prod']) {
      for (const path of ['/v1/improve-runs', '/v1/improve-runs/check']) {
        const res = await h.improve({ projectId: value }, path);
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body.error).toMatchObject({
          code: 'bad-input',
          message:
            value === undefined
              ? '`projectId` is required: the project the Improve run works in (a UUID)'
              : '`projectId` must be a project id (a UUID)',
        });
      }
    }
    expect(h.improveRuns.checked).toEqual([]);
    expect(h.improveRuns.started).toEqual([]);
  });
});
