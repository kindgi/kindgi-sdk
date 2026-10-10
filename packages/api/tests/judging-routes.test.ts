// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A project's judging rules and queue, over an in-memory binding: who may
 * read and who may change them (`read` / `write` on the project, as judging
 * a run needs), the rule body's checks, versions on change, what the caller
 * may do with each item (`can`), `limit=0` totals, `forMe` asking for the
 * classes the caller may assert, dismiss and reopen, and the preview.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import { makeInMemoryProjectBinding } from '@kindgi/platform';
import type { TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  JudgeClass,
  JudgingQueueBinding,
  JudgingQueueItem,
  JudgingQueueListInput,
  JudgingRule,
  JudgingRuleSpec,
  JudgmentRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const PROJECT = randomUUID();
const EDITOR = 'tok-editor';
const VIEWER = 'tok-viewer'; // a standard reviewer with `read` only

const resolveToken: TokenResolver = async (token) =>
  token === EDITOR
    ? { tenantId, userId: 'editor' as UserId, scopes: [] }
    : token === VIEWER
      ? { tenantId, userId: 'viewer' as UserId, scopes: [], reviewerRole: 'standard' }
      : null;

/** The editor may read and write the project; the viewer only read it. */
const authzCheckBinding: AuthzCheckBinding = {
  check: async (principal, action) => {
    const allowed = action === 'read' || principal.actor.id === 'editor';
    return {
      allowed,
      reason: 'test',
      evidence: { action, relation: '', resource: '', actorSubject: principal.actor.id },
    } satisfies Decision;
  },
  checkBatch: async () => [],
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
};

const CLASSES: JudgeClass[] = [
  {
    id: 'cls-expert',
    tenantId,
    scope: { kind: 'tenant' },
    name: 'expert',
    weight: 3,
    assertableBy: { minReviewerRole: 'senior' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: 'cls-user',
    tenantId,
    scope: { kind: 'tenant' },
    name: 'user',
    weight: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
];

const judgments = {
  listClasses: async () => ({ data: CLASSES, hasMore: false }),
  getClass: async ({ judgeClassId }: { judgeClassId: string }) =>
    CLASSES.find((c) => c.id === judgeClassId) ?? null,
} as unknown as JudgmentRegistryBinding;

/** An in-memory binding, enough for the routes: versions, a queue, and what each call was asked. */
function memoryBinding() {
  const rules = new Map<string, JudgingRule[]>();
  const items = new Map<string, JudgingQueueItem>();
  const asked: JudgingQueueListInput[] = [];
  let seq = 0;
  const at = () => new Date(Date.UTC(2026, 9, 10, 12, 0, seq++)).toISOString() as Timestamp;
  const rule = (
    projectId: string,
    ruleId: string,
    version: number,
    spec: JudgingRuleSpec,
    by?: string,
  ): JudgingRule => ({
    ruleId,
    projectId,
    version,
    name: spec.name,
    when: spec.when,
    sample: spec.sample ?? 1,
    ...(spec.maxOpen !== undefined && { maxOpen: spec.maxOpen }),
    ...(spec.judgeClassId !== undefined && { judgeClassId: spec.judgeClassId }),
    enabled: spec.enabled ?? true,
    ...(by !== undefined && { createdBy: by }),
    createdAt: at(),
  });
  const binding: JudgingQueueBinding = {
    async createRule({ projectId, spec, by }) {
      const r = rule(projectId, randomUUID(), 1, spec, by);
      rules.set(r.ruleId, [r]);
      return { kind: 'ok', value: r };
    },
    async updateRule({ ruleId, patch, by }) {
      const versions = rules.get(ruleId);
      const latest = versions?.at(-1);
      if (versions === undefined || latest === undefined) {
        return { kind: 'err', error: { code: 'judging-rule-not-found', message: 'no' } };
      }
      const next = rule(latest.projectId, ruleId, latest.version + 1, { ...latest, ...patch }, by);
      versions.push(next);
      return { kind: 'ok', value: next };
    },
    async unregisterRule({ ruleId }) {
      return { unregistered: rules.delete(ruleId) };
    },
    async getRule({ ruleId }) {
      return rules.get(ruleId)?.at(-1) ?? null;
    },
    async listRules() {
      return { data: [...rules.values()].map((v) => v.at(-1) as JudgingRule), hasMore: false };
    },
    async ruleVersions({ ruleId }) {
      return { data: [...(rules.get(ruleId) ?? [])].reverse(), hasMore: false };
    },
    async listQueue(input) {
      asked.push(input);
      const all = [...items.values()].filter(
        (i) => input.state === undefined || i.state === input.state,
      );
      return { data: input.limit === 0 ? [] : all, hasMore: false, total: all.length };
    },
    async dismiss({ runId, by, reason }) {
      const item = items.get(runId);
      if (item === undefined)
        return { kind: 'err', error: { code: 'judging-item-not-found', message: 'no' } };
      if (item.state !== 'open')
        return { kind: 'err', error: { code: 'judging-item-not-open', message: 'not open' } };
      const next = {
        ...item,
        state: 'dismissed' as const,
        closedAt: at(),
        ...(by && { closedBy: by }),
        ...(reason && { reason }),
      };
      items.set(runId, next);
      return { kind: 'ok', value: next };
    },
    async reopen({ runId }) {
      const item = items.get(runId);
      if (item === undefined)
        return { kind: 'err', error: { code: 'judging-item-not-found', message: 'no' } };
      if (item.state !== 'dismissed')
        return { kind: 'err', error: { code: 'judging-item-not-open', message: 'not dismissed' } };
      const { closedAt: _a, reason: _r, ...rest } = item;
      const next = { ...rest, state: 'open' as const };
      items.set(runId, next);
      return { kind: 'ok', value: next };
    },
    async results({ ruleId }) {
      return rules.has(ruleId)
        ? { kind: 'ok', value: { ruleId, versions: [] } }
        : { kind: 'err', error: { code: 'judging-rule-not-found', message: 'no' } };
    },
    async preview({ last }) {
      return { considered: last, matched: 3, failed: 1 };
    },
  };
  const queue = (runId: string) =>
    items.set(runId, {
      runId,
      projectId: PROJECT,
      agentId: 'acme.refunds',
      agentVersion: '2.1.0',
      flowId: 'agent-turn',
      runStatus: 'failed',
      completedAt: at(),
      ruleIds: ['r-1'],
      wantedClassIds: ['cls-expert'],
      anyJudgment: false,
      progress: { total: 0, byClass: [] },
      addedAt: at(),
      state: 'open',
    });
  return { binding, asked, queue };
}

function harness(opts: { readonly projects?: boolean } = {}) {
  const memory = memoryBinding();
  const projects = opts.projects === true ? makeInMemoryProjectBinding() : undefined;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    judgingQueue: memory.binding,
    judgmentRegistry: judgments,
    ...(projects !== undefined && {
      projectBinding: projects.projects,
      projectMembershipBinding: projects.memberships,
    }),
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/v1/projects/${PROJECT}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { ...memory, app, call };
}

const RULE = {
  name: 'Every failed refund run',
  when: { agentIds: ['acme.refunds'], status: ['failed'] },
  sample: 0.5,
  maxOpen: 20,
  judgeClassId: 'cls-expert',
};

describe('judging rules', () => {
  test('an editor creates and changes a rule; each change is a new version; a viewer reads them', async () => {
    const h = harness();
    const created = await h.call(EDITOR, 'POST', '/judging-rules', RULE);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      ...RULE,
      version: 1,
      enabled: true,
      createdBy: 'user:editor',
    });
    const ruleId = created.body.ruleId;

    const changed = await h.call(EDITOR, 'PATCH', `/judging-rules/${ruleId}`, { sample: 0.1 });
    expect(changed.body).toMatchObject({ version: 2, sample: 0.1, maxOpen: 20 });

    const versions = await h.call(VIEWER, 'GET', `/judging-rules/${ruleId}/versions`);
    expect(versions.body.data.map((v: JudgingRule) => v.version)).toEqual([2, 1]);
    expect((await h.call(VIEWER, 'GET', '/judging-rules')).body.data).toHaveLength(1);
  });

  test('a viewer may not change rules', async () => {
    const h = harness();
    expect((await h.call(VIEWER, 'POST', '/judging-rules', RULE)).status).toBe(403);
  });

  test("a rule's body is checked", async () => {
    const h = harness();
    for (const [body, message] of [
      [{ ...RULE, extra: 1 }, 'Unknown field(s): extra'],
      [{ ...RULE, sample: 0 }, '`sample` must be a number greater than 0 and at most 1'],
      [{ ...RULE, sample: 1.5 }, '`sample` must be a number greater than 0 and at most 1'],
      [{ ...RULE, maxOpen: 0 }, '`maxOpen` must be a whole number from 1 to 10000'],
      [
        { ...RULE, when: { status: ['crashed'] } },
        '`when.status` values are: completed, failed, cancelled',
      ],
      [
        { ...RULE, when: { agentIds: [] } },
        '`when.agentIds` must be a list of 1 to 50 non-empty strings',
      ],
      [{ when: {} }, '`name` must be a non-empty string of at most 200 characters'],
    ] as const) {
      const r = await h.call(EDITOR, 'POST', '/judging-rules', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.message).toBe(message);
    }
  });

  test("a judge class that isn't live is refused", async () => {
    const h = harness();
    const r = await h.call(EDITOR, 'POST', '/judging-rules', { ...RULE, judgeClassId: 'cls-nope' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('judge-class-not-found');
  });

  test('an unknown rule: 404', async () => {
    const h = harness();
    expect((await h.call(VIEWER, 'GET', '/judging-rules/nope')).body.error.code).toBe(
      'judging-rule-not-found',
    );
    expect((await h.call(VIEWER, 'GET', '/judging-rules/nope/results')).status).toBe(404);
  });

  test('the preview reads the rule from the query, and bounds `last`', async () => {
    const h = harness();
    const r = await h.call(
      VIEWER,
      'GET',
      '/judging-rules/preview?agentIds=acme.refunds&status=failed&sample=0.05&last=200',
    );
    expect(r.body).toEqual({ considered: 200, matched: 3, failed: 1 });
    expect((await h.call(VIEWER, 'GET', '/judging-rules/preview?last=501')).status).toBe(400);
    expect((await h.call(VIEWER, 'GET', '/judging-rules/preview?status=crashed')).status).toBe(400);
  });
});

describe('the judging queue', () => {
  test('each item says what the caller may do with it', async () => {
    const h = harness();
    h.queue('run-1');
    const asEditor = await h.call(EDITOR, 'GET', '/judging-queue');
    expect(asEditor.body.data[0].can).toEqual({ dismiss: true, reopen: false });
    const asViewer = await h.call(VIEWER, 'GET', '/judging-queue');
    expect(asViewer.body.data[0].can).toEqual({ dismiss: false, reopen: false });
    expect(asViewer.body.total).toBe(1);
  });

  test('limit=0 answers the total alone', async () => {
    const h = harness();
    h.queue('run-1');
    h.queue('run-2');
    const r = await h.call(VIEWER, 'GET', '/judging-queue?state=open&limit=0');
    expect(r.body).toMatchObject({ data: [], total: 2 });
  });

  test('forMe asks for the classes the caller may assert, by their assertableBy', async () => {
    const h = harness();
    await h.call(VIEWER, 'GET', '/judging-queue?forMe=true');
    // A standard reviewer may assert "user" (unrestricted), not "expert" (senior and above).
    expect(h.asked.at(-1)?.wantedFrom).toEqual(['cls-user']);
    await h.call(VIEWER, 'GET', '/judging-queue');
    expect(h.asked.at(-1)?.wantedFrom).toBeUndefined();
  });

  test('dismiss, then reopen; each needs write, and the item must be in the right state', async () => {
    const h = harness();
    h.queue('run-1');
    expect((await h.call(VIEWER, 'POST', '/judging-queue/run-1/dismiss', {})).status).toBe(403);
    const dismissed = await h.call(EDITOR, 'POST', '/judging-queue/run-1/dismiss', {
      reason: 'a test run',
    });
    expect(dismissed.body).toMatchObject({
      state: 'dismissed',
      reason: 'a test run',
      can: { dismiss: false, reopen: true },
    });
    const again = await h.call(EDITOR, 'POST', '/judging-queue/run-1/dismiss', {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('judging-item-not-open');
    const reopened = await h.call(EDITOR, 'POST', '/judging-queue/run-1/reopen');
    expect(reopened.body).toMatchObject({ state: 'open', can: { dismiss: true, reopen: false } });
    expect((await h.call(EDITOR, 'POST', '/judging-queue/run-x/dismiss', {})).status).toBe(404);
  });

  test('filters are checked', async () => {
    const h = harness();
    expect((await h.call(VIEWER, 'GET', '/judging-queue?state=lost')).status).toBe(400);
    expect((await h.call(VIEWER, 'GET', '/judging-queue?addedAfter=yesterday')).status).toBe(400);
    expect((await h.call(VIEWER, 'GET', '/judging-queue?forMe=yes')).status).toBe(400);
  });
});

describe('the project in the path', () => {
  test("a project id that isn't one: 400; one the tenant hasn't: 404", async () => {
    const h = harness({ projects: true });
    const bad = await h.app.request('/v1/projects/acme/judging-queue', {
      headers: { authorization: `Bearer ${VIEWER}` },
    });
    expect(bad.status).toBe(400);
    const unknown = await h.call(VIEWER, 'GET', '/judging-queue');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('project-not-found');
  });
});
