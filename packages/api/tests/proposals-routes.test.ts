// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Improvement proposals (`/v1/proposals`): a hand-written change to one
 * data block an agent version pins, evaluated as a real (inert) agent
 * version on a test set, then promoted for its scope through the gate.
 * The status is derived from the proposal's eval run and promotion. The
 * stores are in memory; promotions and eval runs are fakes that record
 * what they're asked.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { type Agent, createAgentRegistry, pinsDigest } from '@kindgi/agents';
import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { createStubAppBindings } from '@kindgi/testing';
import type {
  LiveScope,
  ProjectId,
  RunId,
  Semver,
  TenantId,
  Timestamp,
  UserId,
} from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  AgentReleaseBindings,
  AgentVersionRecord,
  EvalRun,
  EvalRunBinding,
  EvalRunStartInput,
  GatePolicy,
  GatePolicySpec,
  JudgedComparisonSummary,
  LivePin,
  Promotion,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { inMemoryBlocks } from './support/in-memory-blocks.js';
import { inMemoryProposals } from './support/in-memory-proposals.js';

const tenantId = randomUUID() as TenantId;
const projectId = randomUUID() as ProjectId;
const TOKEN = 'proposals-token';
const AGENT = 'acme.scorer';
const WEIGHTS = 'acme.scoring-weights';
const NOW = '2026-10-07T00:00:00.000Z' as Timestamp;
const SEGMENT: LiveScope = {
  kind: 'segment',
  projectId,
  path: [{ key: 'company', value: 'acme' }],
};
const SEGMENT_WIRE = { kind: 'segment', projectId, path: [{ key: 'company', value: 'acme' }] };

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

/** The agent registry in memory, recording each version's project. */
function agentBinding(): AgentRegistryBinding {
  const registry = createAgentRegistry();
  return {
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
      const record: AgentVersionRecord = { ...got.value, projectId };
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
    async publish({ agent }) {
      if (registry.get(agent.id, agent.version as unknown as string).kind === 'ok') {
        return { kind: 'already-registered', agentId: agent.id, version: agent.version };
      }
      registry.register(agent);
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
): JudgedComparisonSummary {
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
    evalRunId: 'set later',
    status: 'completed',
    completedAt: NOW,
    suite: { id: 'acme.scoring-judged', version: '1.0.0' },
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

/** Eval runs: `start` records its input; a test finishes a run with `finish`. */
function evalRunFake(agents: AgentRegistryBinding) {
  const runs = new Map<string, EvalRun>();
  const started: EvalRunStartInput[] = [];
  const binding: EvalRunBinding = {
    async start(input) {
      started.push(input);
      const runId = randomUUID() as RunId;
      runs.set(runId as unknown as string, {
        runId,
        tenantId: input.tenantId,
        suiteId: input.suiteId,
        suiteVersion: '1.0.0',
        kind: 'judged',
        ...(input.agentRef !== undefined && { agentRef: input.agentRef }),
        status: 'running',
        dryRun: false,
        startedAt: NOW,
      });
      return { kind: 'ok', runId };
    },
    async get({ runId }) {
      return runs.get(runId as unknown as string) ?? null;
    },
    async list() {
      return { data: [] };
    },
    async cancel() {
      return { kind: 'not-found' as const };
    },
  };
  /** Finish a run: failed, or completed with the candidate's pins recorded, as the dispatcher does. */
  const finish = async (
    runId: string,
    outcome: { delta: number | null; spread?: number } | 'failed',
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
      result: { summary: { ...s, evalRunId: runId } },
    });
  };
  return { binding, started, finish, runs };
}

/** Live pins and promotions, kept as a store keeps them; the gate's outcome decides a request's status. */
function releasesFake(agents: AgentRegistryBinding) {
  const pins: LivePin[] = [];
  const promotions = new Map<string, Promotion>();
  const state: { policy: GatePolicy | null } = { policy: null };
  const calls: { method: string; input: unknown }[] = [];
  const key = (scope: LiveScope) => JSON.stringify(scope);
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
          ...(input.evalRunId !== undefined && { evalRunId: input.evalRunId }),
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

async function harness(opts: { grants?: readonly string[] } = {}) {
  const agents = agentBinding();
  const blocks = inMemoryBlocks([projectId]);
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
            recency: { type: 'number', minimum: 0, maximum: 1 },
            fit: { type: 'number', minimum: 0, maximum: 1 },
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
  const pinned = {
    tools: {},
    prompts: { 'acme.scorer-prompt': '1.0.0' },
    settings: { [WEIGHTS]: '1.0.0' },
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
      capabilities: [],
      tools: [],
      retrieval: [],
      guardrails: [],
      pins: pinned,
      pinsDigest: pinsDigest(pinned),
    } as unknown as Agent,
    enqueueTuples: () => [],
  });
  const evalRuns = evalRunFake(agents);
  const releases = releasesFake(agents);
  const proposals = inMemoryProposals();
  const grants = opts.grants;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    agentRegistry: agents,
    blockRegistry: blocks,
    evalRunBinding: evalRuns.binding,
    agentReleases: releases.releases,
    supervisor: proposals,
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
        authorization: `Bearer ${TOKEN}`,
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
  return { call, agents, blocks, evalRuns, releases, proposals };
}

const DRAFT = {
  agentId: AGENT,
  fromVersion: '1.0.0',
  scope: SEGMENT_WIRE,
  tier: 'settings-block',
  change: { blockId: WEIGHTS, content: { values: { recency: 0.5, fit: 0.5 } } },
  hypothesis: 'Recent filings matter more for acme',
};

/** A draft, with the tenant pinned to 1.0.0 so it can be evaluated. */
async function drafted(opts: { grants?: readonly string[] } = {}) {
  const h = await harness(opts);
  h.releases.pin({ kind: 'tenant' }, '1.0.0');
  const res = await h.call('POST', '/v1/proposals', DRAFT);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...h, id: res.body.id as string };
}

/** A proposal whose comparison finished with `delta`. */
async function evaluated(delta: number) {
  const h = await drafted();
  const res = await h.call('POST', `/v1/proposals/${h.id}/evaluate`, {
    suiteId: 'acme.scoring-judged',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await h.evalRuns.finish(res.body.evaluation.evalRunId, { delta });
  return h;
}

describe('POST /v1/proposals', () => {
  test('a hand-written draft names the block version the agent version pins, and who wrote it', async () => {
    const { call } = await harness();
    const res = await call('POST', '/v1/proposals', DRAFT);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      agentId: AGENT,
      fromVersion: '1.0.0',
      scope: SEGMENT_WIRE,
      tier: 'settings-block',
      change: { blockId: WEIGHTS, fromVersion: '1.0.0', content: DRAFT.change.content },
      drafter: { kind: 'person', by: 'user:user-1' },
      status: 'draft',
    });
    expect(res.body.candidate).toBeUndefined();
  });

  test('the same change again is the same proposal, marked deduped', async () => {
    const { call } = await harness();
    const first = await call('POST', '/v1/proposals', DRAFT);
    const again = await call('POST', '/v1/proposals', DRAFT);
    expect(again.status).toBe(200);
    expect(again.headers.get('x-proposal-deduped')).toBe('true');
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
    const { call, proposals } = await harness();
    const res = await call('POST', '/v1/proposals', { ...DRAFT, ...patch });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('validation-failed');
    expect(JSON.stringify(res.body.error)).toContain(words);
    expect(proposals.rows.size).toBe(0);
  });

  test.each([
    ['no hypothesis', { hypothesis: '' }],
    [
      'a schema in the content',
      { change: { blockId: WEIGHTS, content: { values: {}, schema: {} } } },
    ],
    ['an unknown tier', { tier: 'prompt' }],
    ['an evidence field it does not know', { evidence: { finding: 'x' } }],
  ])('refuses %s (400 bad-input)', async (_name, patch) => {
    const { call } = await harness();
    const res = await call('POST', '/v1/proposals', { ...DRAFT, ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad-input');
  });

  test('an unknown agent version is 404 agent-version-not-found', async () => {
    const { call } = await harness();
    const res = await call('POST', '/v1/proposals', { ...DRAFT, fromVersion: '9.9.9' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('agent-version-not-found');
  });
});

describe('POST /v1/proposals/:id/evaluate', () => {
  test('without a tenant-wide live version it refuses (409 proposal-needs-pin) and publishes nothing', async () => {
    const { call, blocks, evalRuns } = await harness();
    const created = await call('POST', '/v1/proposals', DRAFT);
    const res = await call('POST', `/v1/proposals/${created.body.id}/evaluate`, {
      suiteId: 'acme.scoring-judged',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('proposal-needs-pin');
    expect(res.body.error.message).toContain('Promote its current version for the tenant first');
    expect([...blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toEqual([
      `${WEIGHTS}@1.0.0`,
    ]);
    expect(evalRuns.started).toHaveLength(0);
  });

  test('publishes the block version, derives the agent version for the proposal, and starts the comparison', async () => {
    const { call, id, blocks, agents, evalRuns } = await drafted();
    const res = await call('POST', `/v1/proposals/${id}/evaluate`, {
      suiteId: 'acme.scoring-judged',
      repetitions: 3,
      classWeights: 'restricted-only',
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
      proposalId: id,
    });
    expect(res.body.candidate.pinsDigest).toBe(derived?.pinsDigest);

    expect(evalRuns.started).toEqual([
      expect.objectContaining({
        projectId,
        suiteId: 'acme.scoring-judged',
        agentRef: { agentId: AGENT, version: '1.0.1' },
        correlationId: `proposal:${id}`,
        comparison: expect.objectContaining({ repetitions: 3, classWeights: 'restricted-only' }),
      }),
    ]);
  });

  test.each([
    [{ delta: 0.1 }, 'evaluated', true],
    [{ delta: 0 }, 'not-better', false],
    [{ delta: 0.1, spread: 0.2 }, 'not-better', false],
    [{ delta: null }, 'not-better', false],
  ] as const)('a finished comparison with %j is %s', async (metric, status, better) => {
    const { call, id, evalRuns } = await drafted();
    const started = await call('POST', `/v1/proposals/${id}/evaluate`, {
      suiteId: 'acme.scoring-judged',
    });
    await evalRuns.finish(started.body.evaluation.evalRunId, metric);
    const res = await call('GET', `/v1/proposals/${id}`);
    expect(res.body.status).toBe(status);
    expect(res.body.evaluation).toMatchObject({
      runStatus: 'completed',
      objective: 'weightedYesShare',
      better,
    });
  });

  test('a failed comparison is evaluation-failed; evaluating again reuses the candidate', async () => {
    const { call, id, evalRuns, blocks } = await drafted();
    const first = await call('POST', `/v1/proposals/${id}/evaluate`, {
      suiteId: 'acme.scoring-judged',
    });
    await evalRuns.finish(first.body.evaluation.evalRunId, 'failed');
    expect((await call('GET', `/v1/proposals/${id}`)).body.status).toBe('evaluation-failed');

    const again = await call('POST', `/v1/proposals/${id}/evaluate`, {
      suiteId: 'acme.scoring-judged',
    });
    expect(again.status).toBe(202);
    expect(again.body.candidate.agentVersion).toBe('1.0.1');
    expect(again.body.evaluation.evalRunId).not.toBe(first.body.evaluation.evalRunId);
    expect([...blocks.rows.keys()].filter((k) => k.startsWith(WEIGHTS))).toHaveLength(2);
    expect(evalRuns.started).toHaveLength(2);
  });

  test('while evaluating, evaluate again is 409 proposal-invalid-state-transition', async () => {
    const { call, id } = await drafted();
    await call('POST', `/v1/proposals/${id}/evaluate`, { suiteId: 'acme.scoring-judged' });
    const res = await call('POST', `/v1/proposals/${id}/evaluate`, {
      suiteId: 'acme.scoring-judged',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'proposal-invalid-state-transition',
      details: { status: 'evaluating' },
    });
  });

  test("a flow's `versions` or another baseline is refused", async () => {
    const { call, id } = await drafted();
    for (const extra of [{ versions: { agents: { x: '1.0.0' } } }, { baseline: 'recorded' }]) {
      const res = await call('POST', `/v1/proposals/${id}/evaluate`, {
        suiteId: 'acme.scoring-judged',
        ...extra,
      });
      expect(res.status).toBe(400);
    }
  });

  test('a step recorded meanwhile is 409, not a lost write', async () => {
    const { call, id, proposals } = await drafted();
    proposals.before = () => {
      proposals.before = undefined;
      const row = proposals.rows.get(id);
      if (row !== undefined) proposals.rows.set(id, { ...row, revision: row.revision + 1 });
    };
    const res = await call('POST', `/v1/proposals/${id}/evaluate`, {
      suiteId: 'acme.scoring-judged',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('changed while this ran');
  });
});

describe('POST /v1/proposals/:id/request', () => {
  test('a draft cannot be requested (409)', async () => {
    const { call, id } = await drafted();
    const res = await call('POST', `/v1/proposals/${id}/request`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.details.status).toBe('draft');
  });

  test('with no gate policy it promotes the candidate for the scope (201), live now', async () => {
    const { call, id, releases } = await evaluated(0.1);
    const res = await call('POST', `/v1/proposals/${id}/request`, { reason: 'acme wants recency' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('promoted');
    expect(res.body.promotion).toMatchObject({ status: 'promoted', liveNow: true });
    const request = releases.calls.find((c) => c.method === 'request')?.input as Record<
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

  test('a policy that wants an approval leaves it in review (202), then promoted once approved', async () => {
    const { call, id, releases } = await evaluated(0.1);
    const spec: GatePolicySpec = { approvals: { role: 'standard' } };
    releases.state.policy = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: SEGMENT,
      spec,
      createdAt: NOW,
    };
    const res = await call('POST', `/v1/proposals/${id}/request`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({
      status: 'in-review',
      promotion: { status: 'pending-approval', approvalId: 'appr-1' },
    });
    expect((await call('POST', `/v1/proposals/${id}/withdraw`, { reason: 'x' })).status).toBe(409);

    releases.decide(res.body.promotion.id, 'promoted');
    expect((await call('GET', `/v1/proposals/${id}`)).body).toMatchObject({
      status: 'promoted',
      promotion: { liveNow: true },
    });
  });

  test("a gate refusal is 422 gate-failed with the proposal's id; it can be evaluated again", async () => {
    const { call, id, releases } = await evaluated(0.1);
    releases.state.policy = {
      id: 'acme.prod',
      version: '1.0.0',
      tenantId,
      agentId: AGENT,
      scope: SEGMENT,
      spec: { metrics: [{ name: 'weightedYesShare', minCandidate: 0.99 }] },
      createdAt: NOW,
    };
    const res = await call('POST', `/v1/proposals/${id}/request`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'gate-failed', details: { proposalId: id } });
    expect((await call('GET', `/v1/proposals/${id}`)).body.status).toBe('refused');

    const again = await call('POST', `/v1/proposals/${id}/evaluate`, {
      suiteId: 'acme.scoring-judged',
    });
    expect(again.status).toBe(202);
    expect(again.body.status).toBe('evaluating');
    expect(again.body.promotion).toBeUndefined();
  });
});

describe('POST /v1/proposals/:id/rollback and /withdraw', () => {
  test('rollback puts the scope back on its version before (here: unpins it, since it had no pin)', async () => {
    const { call, id, releases } = await evaluated(0.1);
    await call('POST', `/v1/proposals/${id}/request`, {});
    const res = await call('POST', `/v1/proposals/${id}/rollback`, { reason: 'acme complained' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      status: 'rolled-back',
      rolledBack: { by: 'user:user-1', reason: 'acme complained' },
    });
    expect(releases.calls.map((c) => c.method)).toContain('unpin');
    expect(releases.pins.find((p) => p.scope.kind === 'segment')).toBeUndefined();
  });

  test('rollback goes back to the scope pin it replaced', async () => {
    const { call, id, releases } = await evaluated(0.1);
    releases.pin(SEGMENT, '1.0.0');
    await call('POST', `/v1/proposals/${id}/request`, {});
    const res = await call('POST', `/v1/proposals/${id}/rollback`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rollback = releases.calls.find((c) => c.method === 'rollback')?.input;
    expect(rollback).toMatchObject({ scope: SEGMENT, toVersion: '1.0.0' });
    expect(releases.pins.find((p) => p.scope.kind === 'segment')?.version).toBe('1.0.0');
  });

  test("once the scope has moved on, there's nothing of it to roll back (409)", async () => {
    const { call, id, releases } = await evaluated(0.1);
    const promoted = await call('POST', `/v1/proposals/${id}/request`, {});
    releases.pin(SEGMENT, '1.0.0');
    const res = await call('POST', `/v1/proposals/${id}/rollback`, {});
    expect(res.status).toBe(409);
    expect(promoted.body.promotion.liveNow).toBe(true);
    expect((await call('GET', `/v1/proposals/${id}`)).body.promotion.liveNow).toBe(false);
  });

  test('withdraw needs a reason, closes a draft, and a withdrawn proposal can no longer be evaluated', async () => {
    const { call, id } = await drafted();
    expect((await call('POST', `/v1/proposals/${id}/withdraw`, {})).status).toBe(400);
    const res = await call('POST', `/v1/proposals/${id}/withdraw`, { reason: 'wrong segment' });
    expect(res.body).toMatchObject({ status: 'withdrawn', withdrawn: { reason: 'wrong segment' } });
    const evaluate = await call('POST', `/v1/proposals/${id}/evaluate`, {
      suiteId: 'acme.scoring-judged',
    });
    expect(evaluate.status).toBe(409);
  });
});

describe('GET /v1/proposals', () => {
  test('lists newest first with derived statuses; filters by status and agent', async () => {
    const { call, id, evalRuns } = await drafted();
    const second = await call('POST', '/v1/proposals', {
      ...DRAFT,
      change: { blockId: WEIGHTS, content: { values: { recency: 0.4, fit: 0.6 } } },
    });
    const started = await call('POST', `/v1/proposals/${second.body.id}/evaluate`, {
      suiteId: 'acme.scoring-judged',
    });
    await evalRuns.finish(started.body.evaluation.evalRunId, { delta: 0.2 });

    const all = await call('GET', '/v1/proposals');
    expect(all.body.data.map((p: { id: string }) => p.id)).toEqual([second.body.id, id]);
    expect(all.body.data.map((p: { status: string }) => p.status)).toEqual(['evaluated', 'draft']);
    const evaluatedOnly = await call('GET', '/v1/proposals?status=evaluated');
    expect(evaluatedOnly.body.data.map((p: { id: string }) => p.id)).toEqual([second.body.id]);
    expect((await call('GET', '/v1/proposals?agentId=acme.other')).body.data).toEqual([]);
    expect((await call('GET', '/v1/proposals?status=applied')).status).toBe(400);
  });
});

describe('authorization on the agent', () => {
  test("a proposal of an agent the caller can't read is 404, and isn't listed", async () => {
    const { call, id } = await drafted({
      grants: [`publish agent:${AGENT}`, `read agent:${AGENT}`],
    });
    const outsider = await harness({ grants: [] });
    expect((await outsider.call('GET', `/v1/proposals/${id}`)).status).toBe(404);
    expect((await call('GET', `/v1/proposals/${id}`)).status).toBe(200);
  });

  test('drafting needs publish; requesting needs promote', async () => {
    const readOnly = await harness({ grants: [`read agent:${AGENT}`] });
    const draft = await readOnly.call('POST', '/v1/proposals', DRAFT);
    expect(draft.status).toBe(403);

    const h = await drafted({ grants: [`read agent:${AGENT}`, `publish agent:${AGENT}`] });
    const started = await h.call('POST', `/v1/proposals/${h.id}/evaluate`, {
      suiteId: 'acme.scoring-judged',
    });
    await h.evalRuns.finish(started.body.evaluation.evalRunId, { delta: 0.1 });
    const request = await h.call('POST', `/v1/proposals/${h.id}/request`, {});
    expect(request.status).toBe(403);
    expect(request.body.error.message).toContain('promote');
  });
});
