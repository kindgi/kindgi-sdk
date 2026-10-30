// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * suggested changes (`/v1/suggested-changes`): a hand-written change to one
 * data block an agent version pins, evaluated as a real (inert) agent
 * version on a test set, then pinned for its scope through the gate.
 * The status is derived from the suggested change's test run and pin. The
 * stores are in memory; pins and test runs are fakes that record
 * what they're asked.
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

import type { TestSetRecord, TestSetRegistryBinding } from '../src/test-set-binding.js';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp, createSuggestedChangeService } from '../src/index.js';
import type {
  AgentPinBindings,
  AgentPinnedVersion,
  AgentRegistryBinding,
  AgentVersionRecord,
  CheckImproveRunInput,
  CorrectedComparisonSummary,
  CorrectionRegistryBinding,
  GatePolicy,
  GatePolicySpec,
  ImproveRun,
  ImproveRunBinding,
  ImproveRunCheckBasis,
  Pin,
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
const SEGMENT: AgentPinScope = {
  kind: 'segment',
  projectId,
  path: [{ key: 'company', value: 'acme' }],
};
const SEGMENT_WIRE = { kind: 'segment', projectId, path: [{ key: 'company', value: 'acme' }] };
const projectRef: ResourceRef = { type: 'project', id: projectId as unknown as string };
const tenantRef: ResourceRef = { type: 'tenant', id: tenantId as unknown as string };

const ACCOUNT_TOKEN = 'suggested-changes-account-token';
const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId, userId: 'user-1' as UserId };
  if (token === ACCOUNT_TOKEN) return { tenantId, serviceAccountId: 'sa-ci' };
  return null;
};

/** The agent registry in memory, recording each version's project and the entries its publish wrote. */
function agentBinding(
  unregistered: ReadonlySet<string> = new Set(),
): AgentRegistryBinding & { written: TupleIntent[] } {
  const registry = createAgentRegistry();
  const written: TupleIntent[] = [];
  // Where a version was made, when it's not the agent's project (an environment order's first).
  const madeIn = new Map<string, ProjectId>();
  return {
    written,
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

/** Test runs: `start` records its input; a test finishes a run with `finish`. */
function testRunFake(agents: AgentRegistryBinding) {
  const runs = new Map<string, TestRun>();
  const started: TestRunStartInput[] = [];
  const binding: TestRunBinding = {
    async start(input) {
      started.push(input);
      const runId = randomUUID() as RunId;
      runs.set(runId as unknown as string, {
        testRunId: runId,
        tenantId: input.tenantId,
        // The test run records the agent's project. A drafter's approval resolves
        // to the suggested change's SCOPE, not this — set equal to the segment's project
        // here, so only a tenant-scoped test tells the two apart.
        projectId,
        testSetId: input.testSetId,
        testSetVersion: '1.0.0',
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
    async cancel() {
      return { kind: 'not-found' as const };
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
      result: { summary: { ...s, ...outcome.more, testRunId: runId } },
    });
  };
  return { binding, started, finish, runs };
}

/** Pins and their changes, kept as a store keeps them; the gate's outcome decides a request's status. */
function pinsFake(agents: AgentRegistryBinding) {
  const pins: AgentPinnedVersion[] = [];
  const pinChanges = new Map<string, Pin>();
  const state: { policy: GatePolicy | null } = { policy: null };
  const calls: { method: string; input: unknown }[] = [];
  const key = (scope: AgentPinScope) => JSON.stringify(scope);
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
          policy: input.gate.policy,
          checks: input.gate.checks,
          ...(status === 'pending-approval' && { approvalId: 'appr-1' }),
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
  } = {},
) {
  const agents = agentBinding(new Set(opts.unregisteredVersions ?? []));
  const blocks = inMemoryBlocks([projectId, ...(opts.orders ?? []).flat()], {}, opts.orders);
  await blocks.publish({
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
    enqueueTuples: () => [],
  });
  const testRuns = testRunFake(agents);
  const pinStore = pinsFake(agents);
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
    agentPins: pinStore.bindings,
    supervisor: suggestedChanges,
    ...(opts.improveRuns !== undefined && { improveRuns: opts.improveRuns }),
    ...(opts.referenceScope !== undefined && { referenceScope: opts.referenceScope }),
    ...(opts.projectSuspended !== undefined && { projectSuspended: opts.projectSuspended }),
    ...(opts.orders !== undefined && { environmentOrders: environmentOrders(opts.orders) }),
    ...(opts.items !== undefined && { itemProjects: itemProjects(opts.items) }),
    ...(opts.correctionRegistry !== undefined && { correctionRegistry: opts.correctionRegistry }),
    testSetRegistry: testSets,
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
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${opts.token ?? TOKEN}`,
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
  return { call, agents, blocks, testRuns, pinStore, suggestedChanges };
}

const DRAFT = {
  agentId: AGENT,
  fromVersion: '1.0.0',
  scope: SEGMENT_WIRE,
  tier: 'settings-block',
  change: { blockId: WEIGHTS, content: { values: { recency: 0.5, fit: 0.5 } } },
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
 * A draft, with the tenant pinned to 1.0.0 so it can be evaluated. One
 * that takes Improve's candidates improves the whole tenant only.
 */
async function drafted(
  opts: {
    readOnly?: boolean | 'takes-candidates';
    grants?: readonly string[];
    referenceScope?: ReferenceScopeBinding;
    orders?: readonly (readonly ProjectId[])[];
    items?: ItemRow[];
    token?: string;
  } = {},
) {
  const h = await harness(opts);
  h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
  const draft =
    opts.readOnly === 'takes-candidates' ? { ...DRAFT, scope: { kind: 'tenant' } } : DRAFT;
  const res = await h.call('POST', '/v1/suggested-changes', draft);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...h, id: res.body.id as string };
}

/** A suggested change whose comparison finished with `delta`. */
async function evaluated(
  delta: number,
  opts: { referenceScope?: ReferenceScopeBinding; readOnly?: 'takes-candidates' } = {},
) {
  const h = await drafted(opts);
  const res = await h.call('POST', `/v1/suggested-changes/${h.id}/evaluate`, {
    testSetId: 'acme.scoring-judged',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await h.testRuns.finish(res.body.evaluation.testRunId, { delta });
  return h;
}

describe('POST /v1/suggested-changes', () => {
  test('a hand-written draft names the block version the agent version pins, and who wrote it', async () => {
    const { call, suggestedChanges } = await harness();
    const res = await call('POST', '/v1/suggested-changes', DRAFT);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      agentId: AGENT,
      fromVersion: '1.0.0',
      scope: SEGMENT_WIRE,
      tier: 'settings-block',
      change: { blockId: WEIGHTS, fromVersion: '1.0.0', content: DRAFT.change.content },
      madeBy: { kind: 'person', by: 'user:user-1' },
      status: 'draft',
    });
    expect(res.body.candidate).toBeUndefined();
    // The store gets the agent version's project, for a scoped list.
    expect(suggestedChanges.rows.get(res.body.id)?.projectId).toBe(projectId);
  });

  test('the same change again is the same suggested change, marked deduped', async () => {
    const { call } = await harness();
    const first = await call('POST', '/v1/suggested-changes', DRAFT);
    const again = await call('POST', '/v1/suggested-changes', DRAFT);
    expect(again.status).toBe(200);
    expect(again.headers.get('x-suggested-change-deduped')).toBe('true');
    expect(again.body.id).toBe(first.body.id);
  });

  test.each([
    [
      'a block the version does not pin',
      { change: { blockId: 'acme.other', content: { values: { x: 1 } } } },
      'adding a block is a code change',
    ],
    [
      'values the schema refuses',
      { change: { blockId: WEIGHTS, content: { values: { recency: 2, fit: 0.5 } } } },
      'recency',
    ],
    [
      'the content the version already pins',
      { change: { blockId: WEIGHTS, content: { values: { fit: 0.7, recency: 0.3 } } } },
      "doesn't change",
    ],
    [
      'a prompt tier for a settings block',
      { tier: 'prompt-block', change: { blockId: WEIGHTS, content: { template: 'x' } } },
      "doesn't use prompt block",
    ],
  ])('refuses %s (400 validation-failed)', async (_name, patch, words) => {
    const { call, suggestedChanges } = await harness();
    const res = await call('POST', '/v1/suggested-changes', { ...DRAFT, ...patch });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('validation-failed');
    expect(JSON.stringify(res.body.error)).toContain(words);
    expect(suggestedChanges.rows.size).toBe(0);
  });

  test.each([
    ['no why', { why: '' }],
    [
      'a schema in the content',
      { change: { blockId: WEIGHTS, content: { values: {}, schema: {} } } },
    ],
    ['an unknown tier', { tier: 'prompt' }],
    ['an evidence field it does not know', { evidence: { finding: 'x' } }],
    [
      'a correction count, which only answers carry',
      { evidence: { fixes: ['j-1'], correctionCount: 5 } },
    ],
  ])('refuses %s (400 bad-input)', async (_name, patch) => {
    const { call } = await harness();
    const res = await call('POST', '/v1/suggested-changes', { ...DRAFT, ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
  });

  test('an unknown agent version is 404 agent-version-not-found', async () => {
    const { call } = await harness();
    const res = await call('POST', '/v1/suggested-changes', { ...DRAFT, fromVersion: '9.9.9' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('agent-version-not-found');
  });
});

describe('POST /v1/suggested-changes/:id/evaluate', () => {
  test('without a tenant-wide pinned version it refuses (409 suggested-change-needs-pin) and publishes nothing', async () => {
    const { call, blocks, testRuns } = await harness();
    const created = await call('POST', '/v1/suggested-changes', DRAFT);
    const res = await call('POST', `/v1/suggested-changes/${created.body.id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('suggested-change-needs-pin');
    expect(res.body.error.message).toContain('Pin its current version for the tenant first');
    expect([...blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toEqual([
      `${WEIGHTS}@1.0.0`,
    ]);
    expect(testRuns.started).toHaveLength(0);
  });

  test('with a read-only agent registry (kindgi dev) it refuses (409 registry-read-only) and publishes nothing', async () => {
    const { call, pinStore, blocks, testRuns } = await harness({ readOnly: true });
    pinStore.pin({ kind: 'tenant' }, '1.0.0');
    const created = await call('POST', '/v1/suggested-changes', DRAFT);
    expect(created.status).toBe(201);
    const res = await call('POST', `/v1/suggested-changes/${created.body.id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'registry-read-only',
      message: 'The pack files are the source: change them instead.',
    });
    expect([...blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toHaveLength(1);
    expect(testRuns.started).toHaveLength(0);
  });

  test('publishes the block version, derives the agent version for the suggested change, and starts the comparison', async () => {
    const { call, id, blocks, agents, testRuns } = await drafted();
    const res = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
      repetitions: 3,
      groupWeights: 'experts-only',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.status).toBe('evaluating');
    expect(res.body.candidate).toMatchObject({ agentVersion: '1.0.1', blockVersion: '1.0.1' });

    const block = blocks.rows.get(`${WEIGHTS}@1.0.1`);
    expect(block?.content).toMatchObject({ values: { recency: 0.5, fit: 0.5 } });
    // The schema carried over from the pinned version.
    expect(block?.content).toHaveProperty('schema');
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
    expect(res.body.candidate.pinsDigest).toBe(derived?.pinsDigest);

    expect(testRuns.started).toEqual([
      expect.objectContaining({
        projectId,
        testSetId: 'acme.scoring-judged',
        agentRef: { agentId: AGENT, version: '1.0.1' },
        correlationId: `suggested-change:${id}`,
        comparison: expect.objectContaining({ repetitions: 3, groupWeights: 'experts-only' }),
      }),
    ]);
  });

  test("in an environment order, the candidate is made and evaluated in the order's first environment", async () => {
    // The agent lives in prod (`projectId`), last of the order.
    const staging1 = randomUUID() as ProjectId;
    const staging2 = randomUUID() as ProjectId;
    const { call, id, blocks, agents, testRuns } = await drafted({
      orders: [[staging1, staging2, projectId]],
    });
    const res = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.candidate).toMatchObject({ agentVersion: '1.0.1', blockVersion: '1.0.1' });
    expect(blocks.rows.get(`${WEIGHTS}@1.0.1`)?.projectId).toBe(staging1);
    const derived = await agents.getVersion({
      tenantId,
      agentId: AGENT as never,
      version: '1.0.1' as Semver,
    });
    expect(derived?.projectId).toBe(projectId);
    expect(derived?.madeInProjectId).toBe(staging1);
    expect(testRuns.started).toEqual([expect.objectContaining({ projectId: staging1 })]);
  });

  test("model settings that aren't are refused (400) before the block version is written", async () => {
    const { call, pinStore, blocks, agents, testRuns } = await harness({ modelSettings: true });
    pinStore.pin({ kind: 'tenant' }, '1.0.0');
    const created = await call('POST', '/v1/suggested-changes', {
      ...DRAFT,
      change: { blockId: MODEL, content: { values: { temperature: 5 } } },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const res = await call('POST', `/v1/suggested-changes/${created.body.id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
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
    expect(testRuns.started).toHaveLength(0);
  });

  test('model settings that name the model the agent version names too are refused (400) before the block version is written', async () => {
    const { call, pinStore, blocks, agents, testRuns } = await harness({
      modelSettings: true,
      preferredModel: 'claude-sonnet-5-5',
    });
    pinStore.pin({ kind: 'tenant' }, '1.0.0');
    const created = await call('POST', '/v1/suggested-changes', {
      ...DRAFT,
      change: {
        blockId: MODEL,
        content: { values: { temperature: 0.2, model: 'claude-haiku-4-5' } },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const res = await call('POST', `/v1/suggested-changes/${created.body.id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
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
    expect(testRuns.started).toHaveLength(0);
  });

  test("its schemas' compiles count against the tenant's budget, first ones included: refused, nothing is stored", async () => {
    const { call, id, blocks, agents, testRuns } = await drafted();
    const evaluate = () =>
      call('POST', `/v1/suggested-changes/${id}/evaluate`, { testSetId: 'acme.scoring-judged' });
    const restore = overrideTenantInputBounds({ ...SELF_HOSTED_BOUNDS, schemaCompileBudgetMs: 0 });
    try {
      await expectCompileBudgetRefused(await evaluate());
      expect([...blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toEqual([
        `${WEIGHTS}@1.0.0`,
      ]);
      expect(
        await agents.getVersion({ tenantId, agentId: AGENT as never, version: '1.0.1' as Semver }),
      ).toBeNull();
      expect(testRuns.started).toHaveLength(0);
    } finally {
      restore();
    }
    expect((await evaluate()).status).toBe(202);
  });

  test.each([
    [{ delta: 0.1 }, 'evaluated', true],
    [{ delta: 0 }, 'not-better', false],
    [{ delta: 0.1, spread: 0.2 }, 'not-better', false],
    [{ delta: null }, 'not-better', false],
  ] as const)('a finished comparison with %j is %s', async (metric, status, better) => {
    const { call, id, testRuns } = await drafted();
    const started = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    await testRuns.finish(started.body.evaluation.testRunId, metric);
    const res = await call('GET', `/v1/suggested-changes/${id}`);
    expect(res.body.status).toBe(status);
    expect(res.body.evaluation).toMatchObject({
      runStatus: 'completed',
      objective: 'weightedYesShare',
      better,
    });
  });

  test('a failed comparison is evaluation-failed; evaluating again reuses the candidate', async () => {
    const { call, id, testRuns, blocks } = await drafted();
    const first = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    await testRuns.finish(first.body.evaluation.testRunId, 'failed');
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body.status).toBe(
      'evaluation-failed',
    );

    const again = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(again.status).toBe(202);
    expect(again.body.candidate.agentVersion).toBe('1.0.1');
    expect(again.body.evaluation.testRunId).not.toBe(first.body.evaluation.testRunId);
    expect([...blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toHaveLength(2);
    expect(testRuns.started).toHaveLength(2);
  });

  test('while evaluating, evaluate again is 409 suggested-change-invalid-state-transition', async () => {
    const { call, id } = await drafted();
    await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    const res = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'suggested-change-invalid-state-transition',
      details: { status: 'evaluating' },
    });
  });

  test("a flow's `versions` or another baseline is refused", async () => {
    const { call, id } = await drafted();
    for (const extra of [{ versions: { agents: { x: '1.0.0' } } }, { baseline: 'recorded' }]) {
      const res = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
        testSetId: 'acme.scoring-judged',
        ...extra,
      });
      expect(res.status).toBe(400);
    }
  });

  test('a step recorded meanwhile is 409, not a lost write', async () => {
    const { call, id, suggestedChanges } = await drafted();
    suggestedChanges.before = () => {
      suggestedChanges.before = undefined;
      const row = suggestedChanges.rows.get(id);
      if (row !== undefined) suggestedChanges.rows.set(id, { ...row, revision: row.revision + 1 });
    };
    const res = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('changed while this ran');
  });
});

describe('POST /v1/suggested-changes/:id/rescore', () => {
  test("after people correct the new answers: the same replays scored again become the suggested change's evaluation", async () => {
    const { call, id, testRuns } = await drafted();
    const first = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
      repetitions: 3,
    });
    const firstRunId = first.body.evaluation.testRunId as string;
    // Every answer changed, so nothing measured the candidate.
    await testRuns.finish(firstRunId, { delta: null });
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body.status).toBe('not-better');

    const res = await call('POST', `/v1/suggested-changes/${id}/rescore`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.status).toBe('evaluating');
    const rescoreRunId = res.body.evaluation.testRunId as string;
    expect(rescoreRunId).not.toBe(firstRunId);
    expect(res.body.evaluation).toMatchObject({
      testSetId: 'acme.scoring-judged',
      objective: 'weightedYesShare',
    });
    expect(testRuns.started[1]).toEqual({
      tenantId,
      projectId,
      testSetId: 'acme.scoring-judged',
      testSetVersion: '1.0.0',
      agentRef: { agentId: AGENT, version: '1.0.1' },
      correlationId: `suggested-change:${id}`,
      comparison: expect.objectContaining({ repetitions: 3, rescoreOf: firstRunId }),
    });

    await testRuns.finish(rescoreRunId, { delta: 0.2 });
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body.status).toBe('evaluated');
    // The run rescored stays as it was.
    expect(testRuns.runs.get(firstRunId)?.result).toMatchObject({
      summary: { metrics: { weightedYesShare: { delta: null } } },
    });
  });

  test('only after a completed evaluation: a draft, an evaluating or a failed one is 409', async () => {
    const { call, id, testRuns } = await drafted();
    const draft = await call('POST', `/v1/suggested-changes/${id}/rescore`);
    expect(draft.status).toBe(409);
    expect(draft.body.error).toMatchObject({
      code: 'suggested-change-invalid-state-transition',
      details: { status: 'draft' },
    });
    const started = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    const evaluating = await call('POST', `/v1/suggested-changes/${id}/rescore`);
    expect(evaluating.body.error).toMatchObject({ details: { status: 'evaluating' } });
    await testRuns.finish(started.body.evaluation.testRunId, 'failed');
    const failed = await call('POST', `/v1/suggested-changes/${id}/rescore`);
    expect(failed.status).toBe(409);
    expect(failed.body.error).toMatchObject({ details: { status: 'evaluation-failed' } });
    expect(testRuns.started).toHaveLength(1);
  });

  test('a latest evaluation that is no comparison of a test set is 409 test-run-not-rescorable', async () => {
    const h = await evaluated(0.1);
    const suggestedChange = await h.call('GET', `/v1/suggested-changes/${h.id}`);
    const runId = suggestedChange.body.evaluation.testRunId as string;
    const run = h.testRuns.runs.get(runId);
    if (run === undefined) throw new Error('no run');
    h.testRuns.runs.set(runId, { ...run, kind: 'accuracy' });
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/rescore`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'test-run-not-rescorable' });
  });

  test('it takes no fields: the test set and settings are the latest evaluation’s (400)', async () => {
    const h = await evaluated(0);
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/rescore`, {
      testSetId: 'acme.other',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('`testSetId`');
    expect(h.testRuns.started).toHaveLength(1);
  });
});

describe('POST /v1/suggested-changes/:id/pin', () => {
  test('a draft cannot be requested (409)', async () => {
    const { call, id } = await drafted();
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.details.status).toBe('draft');
  });

  test('a not-better suggested change can still be requested: the gate decides', async () => {
    const { call, id } = await evaluated(0);
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body.status).toBe('not-better');
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('pinned');
  });

  test('with no gate policy it pins the candidate for the scope (201), pinned now', async () => {
    const { call, id, pinStore } = await evaluated(0.1);
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {
      reason: 'acme wants recency',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('pinned');
    expect(res.body.pin).toMatchObject({ status: 'pinned', pinnedNow: true });
    const request = pinStore.calls.find((c) => c.method === 'request')?.input as Record<
      string,
      unknown
    >;
    expect(request).toMatchObject({
      agentId: AGENT,
      version: '1.0.1',
      scope: SEGMENT,
      reason: 'acme wants recency',
      gate: { policy: null, passed: true, servingVersion: '1.0.0' },
    });
  });

  test('a policy that wants an approval leaves it in review (202), then pinned once approved', async () => {
    const { call, id, pinStore } = await evaluated(0.1);
    const spec: GatePolicySpec = { approvals: { role: 'standard' } };
    pinStore.state.policy = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: SEGMENT,
      spec,
      createdAt: NOW,
    };
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({
      status: 'in-review',
      pin: { status: 'pending-approval', approvalId: 'appr-1' },
    });
    expect(
      (await call('POST', `/v1/suggested-changes/${id}/withdraw`, { reason: 'x' })).status,
    ).toBe(409);

    pinStore.decide(res.body.pin.id, 'pinned');
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body).toMatchObject({
      status: 'pinned',
      pin: { pinnedNow: true },
    });
  });

  test("a gate refusal is 422 gate-failed with the suggested change's id; it can be evaluated again", async () => {
    const { call, id, pinStore } = await evaluated(0.1);
    pinStore.state.policy = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: SEGMENT,
      spec: { metrics: [{ name: 'weightedYesShare', minCandidate: 0.99 }] },
      createdAt: NOW,
    };
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'gate-failed',
      details: { suggestedChangeId: id },
    });
    expect((await call('GET', `/v1/suggested-changes/${id}`)).body.status).toBe('refused');

    const again = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(again.status).toBe(202);
    expect(again.body.status).toBe('evaluating');
    expect(again.body.pin).toBeUndefined();
  });
});

describe('POST /v1/suggested-changes/:id/withdraw', () => {
  test('withdraw needs a reason, closes a draft, and a withdrawn suggested change can no longer be evaluated', async () => {
    const { call, id } = await drafted();
    expect((await call('POST', `/v1/suggested-changes/${id}/withdraw`, {})).status).toBe(400);
    const res = await call('POST', `/v1/suggested-changes/${id}/withdraw`, {
      reason: 'wrong segment',
    });
    expect(res.body).toMatchObject({ status: 'withdrawn', withdrawn: { reason: 'wrong segment' } });
    const evaluate = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(evaluate.status).toBe(409);
  });
});

describe('an agent an environment order carries: a tenant- or org-wide change spans the order (409)', () => {
  const PROD = randomUUID() as ProjectId;
  const ORG = randomUUID();
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

  async function wideDraft(scope: unknown) {
    const h = await harness(wide);
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/suggested-changes', { ...DRAFT, scope });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { ...h, id: res.body.id as string };
  }

  const spans = (scope: unknown) => async () => {
    const { call, id } = await wideDraft(scope);
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('pin-scope-spans-environments');
  };

  test('a tenant-wide pin is refused', spans({ kind: 'tenant' }));
  test('an org-wide pin is refused', spans({ kind: 'org', orgId: ORG }));

  test('a project-scoped change for the same agent is not a width refusal', async () => {
    const { call, id } = await wideDraft({ kind: 'project', projectId: PROD });
    // The project scope stays within one environment: past the width check,
    // on to the service (which here has no evaluation to pin).
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
    const draft = await h.call('POST', '/v1/suggested-changes', {
      ...DRAFT,
      scope: { kind: 'tenant' },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const res = await h.call('POST', `/v1/suggested-changes/${draft.body.id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('pin-scope-spans-environments');
  });
});

describe('GET /v1/suggested-changes', () => {
  test('lists newest first with derived statuses; filters by status and agent', async () => {
    const { call, id, testRuns } = await drafted();
    const second = await call('POST', '/v1/suggested-changes', {
      ...DRAFT,
      change: { blockId: WEIGHTS, content: { values: { recency: 0.4, fit: 0.6 } } },
    });
    const started = await call('POST', `/v1/suggested-changes/${second.body.id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    await testRuns.finish(started.body.evaluation.testRunId, { delta: 0.2 });

    const all = await call('GET', '/v1/suggested-changes');
    expect(all.body.data.map((p: { id: string }) => p.id)).toEqual([second.body.id, id]);
    expect(all.body.data.map((p: { status: string }) => p.status)).toEqual(['evaluated', 'draft']);
    const evaluatedOnly = await call('GET', '/v1/suggested-changes?status=evaluated');
    expect(evaluatedOnly.body.data.map((p: { id: string }) => p.id)).toEqual([second.body.id]);
    expect((await call('GET', '/v1/suggested-changes?agentId=acme.other')).body.data).toEqual([]);
    expect((await call('GET', '/v1/suggested-changes?status=applied')).status).toBe(400);
  });

  test('filters by the pinned scope a suggested change is for, as the pin history does', async () => {
    const { call, id } = await drafted();
    const tenantWide = await call('POST', '/v1/suggested-changes', {
      ...DRAFT,
      scope: { kind: 'tenant' },
    });
    const segment = await call(
      'GET',
      `/v1/suggested-changes?scopeKind=segment&scopeId=${projectId}&segment=company:acme`,
    );
    expect(segment.body.data.map((p: { id: string }) => p.id)).toEqual([id]);
    const tenant = await call('GET', '/v1/suggested-changes?scopeKind=tenant');
    expect(tenant.body.data.map((p: { id: string }) => p.id)).toEqual([tenantWide.body.id]);
    expect((await call('GET', '/v1/suggested-changes?scopeKind=segment')).status).toBe(400);
  });
});

describe('authorization on the agent', () => {
  test("a suggested change of an agent the caller can't read is 404, and isn't listed", async () => {
    const { call, id } = await drafted({
      grants: [`publish agent:${AGENT}`, `read agent:${AGENT}`],
    });
    const outsider = await harness({ grants: [] });
    expect((await outsider.call('GET', `/v1/suggested-changes/${id}`)).status).toBe(404);
    expect((await call('GET', `/v1/suggested-changes/${id}`)).status).toBe(200);
  });

  test('drafting needs publish; requesting needs pin', async () => {
    const readOnly = await harness({ grants: [`read agent:${AGENT}`] });
    const draft = await readOnly.call('POST', '/v1/suggested-changes', DRAFT);
    expect(draft.status).toBe(403);

    const h = await drafted({ grants: [`read agent:${AGENT}`, `publish agent:${AGENT}`] });
    const started = await h.call('POST', `/v1/suggested-changes/${h.id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    await h.testRuns.finish(started.body.evaluation.testRunId, { delta: 0.1 });
    const request = await h.call('POST', `/v1/suggested-changes/${h.id}/pin`, {});
    expect(request.status).toBe(403);
    expect(request.body.error.message).toContain('pin');
  });

  test('rescoring needs publish, as evaluating does', async () => {
    const grants = [`read agent:${AGENT}`, `publish agent:${AGENT}`];
    const h = await drafted({ grants });
    const started = await h.call('POST', `/v1/suggested-changes/${h.id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    await h.testRuns.finish(started.body.evaluation.testRunId, { delta: 0 });
    grants.pop(); // read only, from here on
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/rescore`);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('publish');
    expect(h.testRuns.started).toHaveLength(1);
  });

  test('withdrawing needs publish, as drafting does', async () => {
    const grants = [`read agent:${AGENT}`, `publish agent:${AGENT}`];
    const h = await drafted({ grants });
    grants.pop(); // read only, from here on
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/withdraw`, { reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('publish');
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('draft');
  });
});

describe('a suggested change a drafter wrote (not a person)', () => {
  test('it answers with the corrections it names and how many it rests on in all', async () => {
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
      scope: SEGMENT,
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
    expect(res.body.evidence).toEqual({ fixes: ['j-1', 'j-2'], correctionCount: 140 });
  });

  test('its request waits for a reviewer even where no gate policy asks for one (K2)', async () => {
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
      scope: SEGMENT,
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
    expect(requested.value.pin).toMatchObject({
      kind: 'ok',
      pin: { status: 'pending-approval' },
    });
    const request = h.pinStore.calls.find((c) => c.method === 'request')?.input as {
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
    scope: AgentPinScope = SEGMENT,
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
      objective: 'weightedYesShare',
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

  test('a tenant-scoped drafter counts a reviewer who can read the tenant', async () => {
    const authz = authzReads({ 'u-alice': [tenantRef], 'u-bob': [tenantRef] });
    const approval = await draftedApprovalFor(
      roster({ userId: 'u-alice' }, { userId: 'u-bob' }),
      { kind: 'user', id: 'u-alice' },
      authz.binding,
      { kind: 'tenant' },
    );
    expect(approval).toMatchObject({ separateApprover: true });
    // A tenant-scoped pin opens an approval with no project and no
    // provenance run, so the decide route resolves it to the tenant — and the
    // count asks the same resource.
    expect(authz.checks).toContainEqual({ userId: 'u-bob', action: 'read', resource: tenantRef });
  });

  test("a tenant-scoped drafter asks the tenant, not the test run's project", async () => {
    // u-bob may read the test run's project but not the tenant. Resolving the
    // count to the run's project (the bug) would admit u-bob; resolving to the
    // tenant-scoped pin's own resource does not.
    const authz = authzReads({ 'u-alice': [tenantRef], 'u-bob': [projectRef] });
    const approval = await draftedApprovalFor(
      roster({ userId: 'u-alice' }, { userId: 'u-bob' }),
      { kind: 'user', id: 'u-alice' },
      authz.binding,
      { kind: 'tenant' },
    );
    expect(approval).toMatchObject({ separateApprover: false });
    expect(authz.checks).toContainEqual({ userId: 'u-bob', action: 'read', resource: tenantRef });
    expect(authz.checks).not.toContainEqual({
      userId: 'u-bob',
      action: 'read',
      resource: projectRef,
    });
  });

  /**
   * Like `draftedApprovalFor`, but with a scope policy in force — so the
   * pin's approval is `resolveApproval`'s combination of the policy's own
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
    h.pinStore.state.policy = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: SEGMENT,
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
      agentPins: h.pinStore.bindings,
      reviewers,
    });
    const drafted = await service.draft({
      tenantId,
      agentId: AGENT,
      fromVersion: '1.0.0',
      scope: SEGMENT,
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
    const request = h.pinStore.calls.find((c) => c.method === 'request')?.input as {
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

  test('a policy that sets separateApprover false lets a lone reviewer approve their own drafted pin', async () => {
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
  type Correction = readonly [correctionId: string, pass: boolean];
  /** What a finished comparison adds: whether each correction passed, and its cost. */
  const more = (
    corrections: readonly Correction[],
    costUsd?: { candidate: number; spread?: number; cases: number },
  ): Partial<CorrectedComparisonSummary> => ({
    corrections: {
      checked: corrections.length,
      passed: corrections.filter(([, pass]) => pass).length,
      results: corrections.map(([correctionId, pass]) => ({ correctionId, pass })),
    },
    ...(costUsd !== undefined && { costUsd }),
  });
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
      scope: SEGMENT,
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

  test('no worse on the same cases, cheaper beyond the spread, every decision kept: evaluated, and the wire says why', async () => {
    const h = await held('cheaper');
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('evaluating');
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
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('evaluating');
    await h.testRuns.finish(h.referenceId, { delta: 0, more: CURRENT });
    const res = await h.call('GET', `/v1/suggested-changes/${h.id}`);
    expect(res.body.status).toBe('evaluated');
    expect(res.body.evaluation).toMatchObject({
      testRunId: h.runId,
      rule: 'cheaper',
      runStatus: 'completed',
      better: false,
      costUsd: { current: 0.42, candidate: 0.26 },
      decisions: { checked: 3, held: 2, broken: 0, stillWrong: 0 },
    });
    // The reference run stays the runtime's.
    expect(res.body.evaluation).not.toHaveProperty('reference');
    expect(JSON.stringify(res.body)).not.toContain(h.referenceId);
    expect((await h.seen()).evaluation).toMatchObject({ kept: true });
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
  ] as const)('%s: not-better (%s)', async (_what, candidate, reference, notKept) => {
    const h = await held('cheaper');
    await h.testRuns.finish(h.runId, candidate);
    await h.testRuns.finish(h.referenceId, reference);
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('not-better');
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
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('evaluated');
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
    expect((await kept.call('GET', `/v1/suggested-changes/${kept.id}`)).body).toMatchObject({
      status: 'evaluated',
      evaluation: { rule: 'better', decisions: { checked: 3, held: 2, broken: 0, stillWrong: 1 } },
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
    expect((await same.call('GET', `/v1/suggested-changes/${same.id}`)).body.status).toBe(
      'not-better',
    );
    expect((await same.seen()).evaluation).toMatchObject({ notKept: 'not-better' });
  });

  test('a reference run that failed, or that is gone, is evaluation-failed', async () => {
    const failed = await held('cheaper');
    await failed.testRuns.finish(failed.runId, { delta: 0, more: CURRENT });
    await failed.testRuns.finish(failed.referenceId, 'failed');
    expect((await failed.call('GET', `/v1/suggested-changes/${failed.id}`)).body.status).toBe(
      'evaluation-failed',
    );

    const gone = await held('cheaper');
    await gone.testRuns.finish(gone.runId, { delta: 0, more: CURRENT });
    gone.testRuns.runs.delete(gone.referenceId);
    expect((await gone.call('GET', `/v1/suggested-changes/${gone.id}`)).body.status).toBe(
      'evaluation-failed',
    );
  });

  test('a rescore scores both again and keeps holding the candidate to the current version', async () => {
    const h = await held('cheaper');
    await h.testRuns.finish(h.runId, { delta: null, more: more([['j1', true]]) });
    await h.testRuns.finish(h.referenceId, { delta: 0, more: CURRENT });
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('not-better');

    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/rescore`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.evaluation).toMatchObject({ rule: 'cheaper' });
    const [candidate, reference] = h.testRuns.started.slice(-2);
    expect(candidate).toMatchObject({
      agentRef: { agentId: AGENT, version: '1.0.1' },
      comparison: { rescoreOf: h.runId },
    });
    expect(reference).toMatchObject({
      agentRef: { agentId: AGENT, version: '1.0.0' },
      comparison: { rescoreOf: h.referenceId },
    });
    const stored = h.suggestedChanges.rows.get(h.id)?.evaluation;
    const rescoredReference = stored?.reference?.testRunId as string;
    expect(stored).toMatchObject({ rule: 'cheaper', testRunId: res.body.evaluation.testRunId });
    expect(rescoredReference).not.toBe(h.referenceId);

    await h.testRuns.finish(res.body.evaluation.testRunId, {
      delta: 0,
      more: more(
        [
          ['j1', true],
          ['j2', true],
        ],
        { candidate: 0.2, cases: 12 },
      ),
    });
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('evaluating');
    await h.testRuns.finish(rescoredReference, { delta: 0, more: CURRENT });
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('evaluated');
  });

  test('a rescore whose reference run is no comparison of a test set is refused, and starts nothing', async () => {
    const h = await held('cheaper');
    await h.testRuns.finish(h.runId, { delta: 0, more: CURRENT });
    await h.testRuns.finish(h.referenceId, { delta: 0, more: CURRENT });
    const run = h.testRuns.runs.get(h.referenceId);
    if (run === undefined) throw new Error('no run');
    h.testRuns.runs.set(h.referenceId, { ...run, kind: 'accuracy' });
    const before = h.testRuns.started.length;
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/rescore`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'test-run-not-rescorable' });
    expect(h.testRuns.started).toHaveLength(before);
  });
  test("a rescore whose reference can't start cancels the candidate's and records nothing", async () => {
    const h = await held('cheaper');
    await h.testRuns.finish(h.runId, { delta: 0, more: CURRENT });
    await h.testRuns.finish(h.referenceId, { delta: 0, more: CURRENT });
    const before = h.suggestedChanges.rows.get(h.id);
    const start = h.testRuns.binding.start;
    h.testRuns.binding.start = async (input) =>
      input.comparison?.rescoreOf === h.referenceId
        ? { kind: 'test-set-not-found', testSetId: input.testSetId }
        : start(input);
    const cancelled: string[] = [];
    h.testRuns.binding.cancel = async ({ testRunId }) => {
      cancelled.push(testRunId as unknown as string);
      return { kind: 'ok' };
    };
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/rescore`);
    expect(res.body.error).toMatchObject({ code: 'test-set-not-found' });
    const rescored = [...h.testRuns.runs.values()].find((r) => r.comparison?.rescoreOf === h.runId);
    expect(cancelled).toEqual([rescored?.testRunId]);
    expect(h.suggestedChanges.rows.get(h.id)).toEqual(before);
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
  test('a draft for a scope in another project is refused', async () => {
    const { call, suggestedChanges } = await harness({ referenceScope: reach(new Set()) });
    const res = await call('POST', '/v1/suggested-changes', { ...DRAFT, scope: OTHER_SEGMENT });
    expect(refused(res)).toEqual([`/scope agent ${AGENT}`]);
    expect(suggestedChanges.rows.size).toBe(0);
  });

  test('a draft editing a block out of reach is refused, before the block is read', async () => {
    const { call, suggestedChanges } = await harness({ referenceScope: reach(new Set([WEIGHTS])) });
    const res = await call('POST', '/v1/suggested-changes', DRAFT);
    expect(refused(res)).toEqual([`/change/blockId block ${WEIGHTS}`]);
    expect(suggestedChanges.rows.size).toBe(0);
  });

  test('evaluating on a test set out of reach is refused, and starts no test run', async () => {
    const out = new Set<string>();
    const { call, id, testRuns } = await drafted({ referenceScope: reach(out) });
    out.add('acme.scoring-judged');
    const res = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(refused(res)).toEqual(['/testSetId test-set acme.scoring-judged']);
    expect(testRuns.started).toEqual([]);
  });

  test("requesting asks it too: a scope that no longer reaches the agent isn't pinned", async () => {
    const out = new Set<string>();
    const { call, id, pinStore } = await evaluated(0.1, { referenceScope: reach(out) });
    out.add(AGENT);
    const res = await call('POST', `/v1/suggested-changes/${id}/pin`, {});
    expect(refused(res)).toEqual([`/scope agent ${AGENT}`]);
    expect(pinStore.calls.filter((c) => c.method === 'request')).toEqual([]);
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
      h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
      const res = await h.call('POST', '/v1/improve-runs', body);
      expect(refused(res)).toEqual([issue]);
      expect(improveRuns.started).toEqual([]);
    }
  });
});

describe('Improve runs', () => {
  const IMPROVE = { agentId: AGENT, scope: SEGMENT_WIRE, testSetId: 'acme.scoring-judged' };

  test('improve starts an Improve run for the version serving the scope, with the default budget (202)', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ tunable: true, improveRuns: improveRuns.binding });
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('no-tunable-keys');
    expect(res.body.error.message).toBe(
      `${AGENT} 1.0.0 pins no settings block with keys marked "x-kindgi-tunable": there's nothing for an Improve run to tune. Mark the keys it may tune in the block's schema (a number or integer with a minimum and maximum, or an enum) and publish it. In its model-settings block, "model" can't be tried: the agent version names its model (preferredProvider or preferredModel), and a model-settings block that named one too would name it twice.`,
    );
    expect(improveRuns.started).toHaveLength(0);
  });

  test('without a tenant-wide pinned version: 409 suggested-change-needs-pin', async () => {
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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

describe("POST /v1/suggested-changes/:id/evaluate: who is made the derived version's owner", () => {
  const evaluate = async (token?: string) => {
    const h = await drafted(token === undefined ? {} : { token });
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    return h.agents.written.filter((t) => t.relation === 'owner').map((t) => t.user);
  };

  test("a person's key makes them its owner", async () => {
    expect(await evaluate()).toEqual(['user:user-1']);
  });

  test("a service account's key makes no one its owner", async () => {
    expect(await evaluate(ACCOUNT_TOKEN)).toEqual([]);
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

  async function evaluatedBy(grants: string[]) {
    const h = await drafted({ grants, orders, items: items() });
    const started = await h.call('POST', `/v1/suggested-changes/${h.id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await h.testRuns.finish(started.body.evaluation.testRunId, { delta: 0.1 });
    return h;
  }

  test('drafting and evaluating are write where its versions are made, not publish on the agent', async () => {
    const h = await evaluatedBy([...maker]);
    expect((await h.call('GET', `/v1/suggested-changes/${h.id}`)).body.status).toBe('evaluated');

    const prodOnly = await harness({
      grants: [`read project:${PROD}`, `write project:${PROD}`, `publish agent:${AGENT}`],
      orders,
      items: items(),
    });
    const res = await prodOnly.call('POST', '/v1/suggested-changes', DRAFT);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.message).toContain(
      `changing a suggested change for agent "${AGENT}" needs write on project ${projectId}`,
    );
  });

  test('rescoring and withdrawing are write where its versions are made, not publish on the agent', async () => {
    const grants = [...maker];
    const h = await evaluatedBy(grants);
    grants.splice(
      0,
      grants.length,
      `read project:${PROD}`,
      `write project:${PROD}`,
      `publish agent:${AGENT}`,
    );
    for (const [verb, body] of [
      ['rescore', {}],
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

  test("pinning is admin where the suggested change's scope is, with no pin on the agent", async () => {
    const grants = [...maker];
    const h = await evaluatedBy(grants);
    const refused = await h.call('POST', `/v1/suggested-changes/${h.id}/pin`, {});
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.message).toContain('needs admin on each project it changes');
    grants.push(`admin project:${PROD}`); // prod's admin doesn't reach a scope in the agent's project
    expect((await h.call('POST', `/v1/suggested-changes/${h.id}/pin`, {})).status).toBe(403);
    grants.push(`admin project:${projectId}`);
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/pin`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('pinned');
  });

  test('a prod member reads its suggested changes; someone in neither project gets 404', async () => {
    const grants = [...maker];
    const h = await drafted({ grants, orders, items: items() });
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    const res = await h.call('POST', '/v1/suggested-changes', DRAFT);
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', IMPROVE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(improveRuns.started).toHaveLength(1);
  });

  test('a read-only one refuses an Improve run (409 registry-read-only) and starts none', async () => {
    const improveRuns = inMemoryImproveRuns();
    const h = await harness({ tunable: true, improveRuns: improveRuns.binding, readOnly: true });
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
    const res = await h.call('POST', '/v1/improve-runs', { ...IMPROVE, scope: SEGMENT_WIRE });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject(NARROWER);
    expect(improveRuns.started).toEqual([]);
  });

  test('a draft for a narrower scope is refused the same way, and none is kept', async () => {
    const h = await harness({ readOnly: 'takes-candidates' });
    const res = await h.call('POST', '/v1/suggested-changes', DRAFT);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject(NARROWER);
    expect(h.suggestedChanges.rows.size).toBe(0);
  });

  test('a narrower suggested change from before is not evaluated: nothing published or started', async () => {
    const h = await drafted({ readOnly: 'takes-candidates' });
    const row = h.suggestedChanges.rows.get(h.id);
    if (row === undefined) throw new Error('no suggested change');
    h.suggestedChanges.rows.set(h.id, { ...row, scope: { kind: 'project', projectId } });
    const res = await h.call('POST', `/v1/suggested-changes/${h.id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject(NARROWER);
    expect(h.testRuns.started).toEqual([]);
  });

  test('an evaluation publishes the block version, derives its agent version, and starts the comparison (202)', async () => {
    const { call, id, testRuns } = await drafted({ readOnly: 'takes-candidates' });
    const res = await call('POST', `/v1/suggested-changes/${id}/evaluate`, {
      testSetId: 'acme.scoring-judged',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.candidate).toMatchObject({ agentVersion: '1.0.1', blockVersion: '1.0.1' });
    expect(testRuns.started).toHaveLength(1);
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
    h.pinStore.pin({ kind: 'tenant' }, '1.0.0');
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
