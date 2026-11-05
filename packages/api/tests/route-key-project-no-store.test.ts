// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A key or session limited to a project, and the records it acts on by
 * their id: a run, a test run, an approval, a run's provenance, a
 * correction, a conversation, an artifact, a deployment's secrets, a
 * suggested change, an Improve run and a connection choice. Without an
 * authorization store, one that reaches another project is refused,
 * `403 key-project-mismatch`, before anything is written or signed, as a
 * store refuses it (`permission-denied`, or the 404 it hides it behind).
 *
 * What it reaches is what a store asks. A record's own project, for most.
 * A test run's test set, and a suggested change's or an Improve run's
 * agent: its own project, or for one more than one project serves, the
 * project a pin is in or the one its new versions are made in. A record
 * with no project answers to the workspace: a session is refused there,
 * and a key too where a store asks `admin`.
 *
 * A record in the key's project, one that isn't there, and a key limited
 * to no project are not refused, nor is a correction's author removing it.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { createEd25519ExportSigner, generateEd25519KeyPair } from '@kindgi/crypto';
import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
import type { ProjectId, RunId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { OPERATIONS, createApp } from '../src/index.js';
import type { CreateAppInput, TokenResolver } from '../src/index.js';
import { LIMITED_RECORD_PROJECT } from '../src/openapi/operations.js';
import { environmentOrders } from './support/environment-orders.js';
import { fullAppInput } from './support/full-app.js';
import { type ItemRow, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
const USER = randomUUID() as UserId;
const OTHER = randomUUID() as UserId;
/** The key's project. */
const P1 = randomUUID() as ProjectId;
/** Another project. */
const P2 = randomUUID() as ProjectId;
/** The first environment of P1's order, where a shared agent's new versions are made. */
const P0 = randomUUID() as ProjectId;
const NOW = '2026-10-01T00:00:00.000Z' as Timestamp;
const LIMITED = 'kgi_ak_test_limited_to_p1';
const SESSION = 'kgi_ak_test_session_limited_to_p1';
const UNLIMITED = 'kgi_ak_test_not_limited';

/** Every caller reviews, and syncs deployment secrets, so only the limit tells them apart. */
const caller = {
  tenantId,
  userId: USER,
  reviewerRole: 'standard',
  capabilities: ['secrets:write'],
};
const resolveToken: TokenResolver = async (token) => {
  if (token === LIMITED) return { ...caller, tokenProjectId: P1 } as never;
  if (token === SESSION) return { ...caller, tokenProjectId: P1, sessionId: 'ses-acme' } as never;
  return token === UNLIMITED ? (caller as never) : null;
};

/** An agent and a test set in another project alone, in the key's, and one both serve. */
const AWAY = 'acme.away';
const HOME = 'acme.home';
/** Served in P1 and P2, its own P1, the later environment of an order that starts at P0. */
const SHARED = 'acme.shared';

const ITEMS: Record<string, readonly ProjectId[]> = {
  [AWAY]: [P2],
  [HOME]: [P1],
  [SHARED]: [P1, P2],
};

function rows(): ItemRow[] {
  return (['agent', 'test_set'] as const).flatMap((kind) =>
    Object.entries(ITEMS).map(([id, projects]) => ({
      kind,
      id,
      projects,
      versions: [{ version: '1.0.0', projects }],
    })),
  );
}

/** The newest version of an item as its registry records it: its own project. */
const versionOf = (id: string) => ({
  id,
  version: '1.0.0',
  tenantId,
  name: id,
  publishedAt: NOW,
  ...(ITEMS[id] !== undefined && { projectId: ITEMS[id][0] }),
});

function run(agentId: string, projectId: ProjectId): KernelRunRecord {
  return {
    runId: randomUUID() as RunId,
    tenantId,
    projectId,
    flowId: 'acme.match',
    flowVersion: '1.0.0',
    status: 'completed',
    input: { query: 'acme' },
    output: { answer: 'Refunded.' },
    dryRun: false,
    createdAt: NOW,
    updatedAt: NOW,
    agent: { id: agentId, version: '1.0.0' },
  } as KernelRunRecord;
}

const RUNS = { away: run(AWAY, P2), home: run(HOME, P1) };

/** Which record a row acts on: another project's, or the key's own. */
type Side = 'away' | 'home';
const id = () => randomUUID();

const TEST_RUNS = {
  away: { testRunId: id(), testSetId: AWAY, projectId: P2 },
  home: { testRunId: id(), testSetId: HOME, projectId: P1 },
  /** In the key's project, of a test set only another project has: a store asks on the test set. */
  awaySet: { testRunId: id(), testSetId: AWAY, projectId: P1 },
};
const APPROVALS = {
  away: { id: id(), projectId: P2 },
  home: { id: id(), projectId: P1 },
  tenant: { id: id() },
};
const CORRECTIONS = {
  away: { correctionId: id(), projectId: P2, subject: HOME, madeBy: OTHER },
  home: { correctionId: id(), projectId: P1, subject: HOME, madeBy: OTHER },
  /** Made by the caller: its author removes it, as with a store. */
  own: { correctionId: id(), projectId: P2, subject: HOME, madeBy: USER },
  /** In the key's project, of an agent only another project has: a store asks `publish` on the agent. */
  awayAgent: { correctionId: id(), projectId: P1, subject: AWAY, madeBy: OTHER },
};
const CONVERSATIONS = {
  away: { id: id(), agentId: AWAY, projectId: P2 },
  home: { id: id(), agentId: HOME, projectId: P1 },
  /** From before projects: the agent's version says where it is. */
  unfiled: { id: id(), agentId: AWAY },
};
const ARTIFACTS = {
  away: { blobId: id(), projectId: P2 },
  home: { blobId: id(), projectId: P1 },
  tenant: { blobId: id() },
};
const DEPLOYMENTS = {
  away: { deploymentId: id(), projectId: P2 },
  home: { deploymentId: id(), projectId: P1 },
  tenant: { deploymentId: id() },
};
const CHOICES = {
  away: { choiceId: id(), projectId: P2, userId: USER },
  home: { choiceId: id(), projectId: P1, userId: USER },
  /** Another person's: still not found, wherever it is. */
  others: { choiceId: id(), projectId: P2, userId: OTHER },
};
const project = (projectId: ProjectId) => ({ kind: 'project' as const, projectId });
/** Each at the key's project: what a store asks is the agent's. */
const CARDS = {
  away: { id: id(), agentId: AWAY, scope: project(P1) },
  home: { id: id(), agentId: HOME, scope: project(P1) },
  shared: { id: id(), agentId: SHARED, scope: project(P1) },
  sharedAtP2: { id: id(), agentId: SHARED, scope: project(P2) },
  homeAtP2: { id: id(), agentId: HOME, scope: project(P2) },
  tenant: { id: id(), agentId: HOME, scope: { kind: 'tenant' as const } },
  org: { id: id(), agentId: HOME, scope: { kind: 'org' as const, orgId: id() } },
};
const IMPROVE_RUNS = {
  away: { id: id(), agentId: AWAY },
  home: { id: id(), agentId: HOME },
  shared: { id: id(), agentId: SHARED },
};

const byKey = <T, K extends keyof T>(records: Record<string, T>, key: K, value: unknown) =>
  Object.values(records).find((r) => r[key] === value) ?? null;

/** A store that refuses beyond the key's project, as the runtime's does, and grants the rest. */
const granted = (action: Action, r: ResourceRef): Decision => ({
  allowed: true,
  reason: 'granted',
  evidence: { action, relation: '', resource: r.id, actorSubject: '' },
});

type Mode = 'served' | 'recorded' | 'store';

function harness(mode: Mode) {
  const changed: string[] = [];
  /** A write the route makes: recorded, then it fails, so a test sees it got that far. */
  const write =
    (name: string) =>
    async (..._args: unknown[]): Promise<never> => {
      changed.push(name);
      throw new Error(`${name}: recorded`);
    };
  const { authz, sites, ...base } = fullAppInput();
  const runBinding = {
    ...base.kernelBinding.run,
    getRun: async (_t: TenantId, runId: RunId) => byKey(RUNS, 'runId', runId),
    cancelRun: write('runs.cancelRun'),
  } as unknown as RunBinding;
  const agents = {
    ...base.agentRegistry,
    headExists: async ({ agentId }: { agentId: string }) => ITEMS[agentId] !== undefined,
    listVersions: async ({ agentId }: { agentId: string }) => ({
      data: ITEMS[agentId] === undefined ? [] : [versionOf(agentId)],
    }),
    getVersion: async ({ agentId }: { agentId: string }) =>
      ITEMS[agentId] === undefined ? null : versionOf(agentId),
  };
  const signer = createEd25519ExportSigner({ privateKey: generateEd25519KeyPair().privateKey });
  if (signer.kind !== 'ok') throw new Error('no signer');
  const input = {
    ...base,
    resolveToken,
    kernelBinding: { ...base.kernelBinding, run: runBinding },
    agentRegistry: agents,
    environmentOrders: environmentOrders([[P0, P1]]),
    waitTokens: { complete: write('waitTokens.complete'), waiting: async () => [] },
    exportSigning: { ...signer.value, sign: write('exportSigning.sign') },
    provenanceBinding: {
      ...base.provenanceBinding,
      getByRunId: async () => ({
        kind: 'err',
        error: { code: 'provenance-not-found', message: 'none here' },
      }),
    },
    hitlBinding: {
      ...base.hitlBinding,
      getApproval: async (_t: TenantId, approvalId: string) => {
        const a = byKey(APPROVALS, 'id', approvalId);
        return a === null
          ? { kind: 'err', error: { code: 'approval-not-found', message: 'none' } }
          : {
              kind: 'ok',
              value: {
                ...a,
                tenantId,
                subjectKind: 'acme.refund',
                subjectRef: 'refund-1',
                requiredRole: 'standard',
                status: 'approved',
                createdAt: NOW,
                updatedAt: NOW,
              },
            };
      },
      submitReview: write('hitl.submitReview'),
    },
    testRunBinding: {
      ...base.testRunBinding,
      get: async ({ testRunId }: { testRunId: string }) => {
        const t = byKey(TEST_RUNS, 'testRunId', testRunId);
        return t === null
          ? null
          : {
              ...t,
              tenantId,
              testSetVersion: '1.0.0',
              kind: 'corrections',
              status: 'completed',
              dryRun: false,
              startedAt: NOW,
            };
      },
      cancel: write('testRuns.cancel'),
      start: write('testRuns.start'),
    },
    testSetRegistry: {
      ...base.testSetRegistry,
      listVersions: async ({ testSetId }: { testSetId: string }) => ({
        data: ITEMS[testSetId] === undefined ? [] : [versionOf(testSetId)],
      }),
    },
    correctionRegistry: {
      ...base.correctionRegistry,
      get: async ({ correctionId }: { correctionId: string }) => {
        const k = byKey(CORRECTIONS, 'correctionId', correctionId);
        return k === null
          ? null
          : {
              id: k.correctionId,
              tenantId,
              projectId: k.projectId,
              runId: RUNS.home.runId,
              subject: { kind: 'agent', id: k.subject, version: '1.0.0' },
              madeBy: { kind: 'user', id: k.madeBy },
              status: 'open',
              createdAt: NOW,
              updatedAt: NOW,
            };
      },
      unregister: write('corrections.unregister'),
      update: write('corrections.update'),
      record: write('corrections.record'),
    },
    conversationBinding: {
      ...base.conversationBinding,
      getConversation: async (_t: TenantId, conversationId: string) => {
        const v = byKey(CONVERSATIONS, 'id', conversationId);
        return v === null
          ? { kind: 'err', error: { code: 'conversation-not-found', message: 'none' } }
          : {
              kind: 'ok',
              value: {
                ...v,
                tenantId,
                agentVersion: '1.0.0',
                title: 'acme',
                scope: { tenantId },
                openedAt: NOW,
                openedBy: `user:${USER}`,
                turnCount: 1,
              },
            };
      },
      closeConversation: write('conversations.closeConversation'),
      unregisterConversation: write('conversations.unregisterConversation'),
    },
    blobStorage: {
      ...base.blobStorage,
      head: async (_t: TenantId, blobId: string) => {
        const a = byKey(ARTIFACTS, 'blobId', blobId);
        return a === null
          ? null
          : {
              ...a,
              tenantId,
              name: 'acme.txt',
              contentType: 'text/plain',
              size: 1,
              hash: 'x',
              tags: {},
              createdAt: NOW,
            };
      },
      delete: write('blobs.delete'),
    },
    deploymentRegistry: {
      ...base.deploymentRegistry,
      get: async ({ deploymentId }: { deploymentId: string }) => {
        const d = byKey(DEPLOYMENTS, 'deploymentId', deploymentId);
        return d === null ? null : { ...d, tenantId, publishedAt: NOW };
      },
    },
    secretsBinding: { ...base.secretsBinding, set: write('secrets.set') },
    connections: {
      ...base.connections,
      getChoice: async ({ choiceId }: { choiceId: string }) => {
        const k = byKey(CHOICES, 'choiceId', choiceId);
        return k === null
          ? null
          : {
              choiceId: k.choiceId,
              tenantId,
              projectId: k.projectId,
              envName: 'test',
              app: 'acme-crm',
              connectionId: 'conn-1',
              agentId: HOME,
              person: { userId: k.userId },
              version: 1,
              createdAt: NOW,
              createdBy: `user:${k.userId}`,
            };
      },
      removeChoice: write('connections.removeChoice'),
    },
    supervisor: {
      ...base.supervisor,
      getSuggestedChange: async ({ suggestedChangeId }: { suggestedChangeId: string }) => {
        const k = byKey(CARDS, 'id', suggestedChangeId);
        return k === null
          ? null
          : { ...k, tenantId, fromVersion: '1.0.0', revision: 1, steps: [], createdAt: NOW };
      },
      createSuggestedChange: write('cards.create'),
      recordSuggestedChange: write('cards.record'),
    },
    improveRuns: {
      get: async ({ improveRunId }: { improveRunId: string }) => {
        const k = byKey(IMPROVE_RUNS, 'id', improveRunId);
        return k === null ? null : { ...k, tenantId, status: 'running', startedAt: NOW };
      },
      list: async () => ({ data: [] }),
      start: write('improve.start'),
      check: write('improve.check'),
      cancel: write('improve.cancel'),
    },
    ...(mode === 'served' && { itemProjects: itemProjects(rows()) }),
    ...(mode === 'store' && {
      sites,
      itemProjects: itemProjects(rows()),
      authz: {
        ...authz,
        authzCheckBinding: {
          inProject: async (_p, r, projectId) =>
            ITEMS[r.id]?.includes(projectId as ProjectId) ?? false,
          check: async (_p, action, r) => granted(action, r),
          checkBatch: async (_p, action, rs) => rs.map((r) => granted(action, r)),
        } satisfies AuthzCheckBinding,
      },
    }),
  };
  const app = createApp(input as unknown as CreateAppInput);
  const send = async (token: string, method: string, path: string, body?: unknown) => {
    changed.length = 0;
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: Body = {};
    try {
      parsed = text.length > 0 ? (JSON.parse(text) as Body) : {};
    } catch {
      // Not JSON: no error code to read.
    }
    return { status: res.status, body: parsed, changed: [...changed] };
  };
  return { send };
}

type Harness = ReturnType<typeof harness>;

type Body = {
  error?: { code: string; message?: string; details?: Record<string, unknown> };
};

type Row = {
  readonly label: string;
  /** The operation, as `METHOD /openapi/path`. */
  readonly op: string;
  readonly method: string;
  /** What the refusal names. */
  readonly word: string;
  /** The request on the side's record. */
  readonly to: (side: Side) => { path: string; body?: unknown };
};

/** One row per write by id that a store holds and, until now, nothing held without one. */
const HELD: readonly Row[] = [
  {
    label: 'run cancel',
    op: 'POST /v1/runs/{runId}/cancel',
    method: 'POST',
    word: 'the run',
    to: (side) => ({ path: `/v1/runs/${RUNS[side].runId}/cancel` }),
  },
  {
    label: 'run resume',
    op: 'POST /v1/runs/{runId}/resume',
    method: 'POST',
    word: 'the run',
    // A pause token, so the row reaches the hold and not the 400 or the 422.
    to: (side) => ({
      path: `/v1/runs/${RUNS[side].runId}/resume`,
      body: { waitpointId: 'pause:acme', value: {} },
    }),
  },
  ...(['rescore', 'cancel'] as const).map(
    (verb): Row => ({
      label: `test run ${verb}`,
      op: `POST /v1/test-runs/{testRunId}/${verb}`,
      method: 'POST',
      word: 'the test set',
      to: (side) => ({ path: `/v1/test-runs/${TEST_RUNS[side].testRunId}/${verb}` }),
    }),
  ),
  {
    label: 'approval complete',
    op: 'POST /v1/approvals/{approvalId}/complete',
    method: 'POST',
    word: 'the approval',
    to: (side) => ({
      path: `/v1/approvals/${APPROVALS[side].id}/complete`,
      body: { decision: 'approve' },
    }),
  },
  {
    label: 'approval audit bundle',
    op: 'POST /v1/approvals/{approvalId}/audit-bundle',
    method: 'POST',
    word: 'the approval',
    to: (side) => ({ path: `/v1/approvals/${APPROVALS[side].id}/audit-bundle`, body: {} }),
  },
  {
    label: 'provenance export',
    op: 'POST /v1/provenance/{runId}/export',
    method: 'POST',
    word: 'the run',
    to: (side) => ({ path: `/v1/provenance/${RUNS[side].runId}/export`, body: {} }),
  },
  {
    label: 'correction remove',
    op: 'POST /v1/corrections/{correctionId}/remove',
    method: 'POST',
    word: 'the correction',
    to: (side) => ({ path: `/v1/corrections/${CORRECTIONS[side].correctionId}/remove` }),
  },
  {
    label: 'correction change',
    op: 'PATCH /v1/corrections/{correctionId}',
    method: 'PATCH',
    word: 'the correction',
    to: (side) => ({
      path: `/v1/corrections/${CORRECTIONS[side].correctionId}`,
      body: { status: 'fixed' },
    }),
  },
  {
    label: 'correction of a run',
    op: 'POST /v1/corrections',
    method: 'POST',
    word: 'the run',
    to: (side) => ({ path: '/v1/corrections', body: { runId: RUNS[side].runId, answer: 'right' } }),
  },
  ...(['close', 'unregister'] as const).map(
    (verb): Row => ({
      label: `conversation ${verb}`,
      op: `POST /v1/conversations/{conversationId}/${verb}`,
      method: 'POST',
      word: 'the conversation',
      to: (side) => ({ path: `/v1/conversations/${CONVERSATIONS[side].id}/${verb}` }),
    }),
  ),
  {
    label: 'artifact delete',
    op: 'DELETE /v1/artifacts/{blobId}',
    method: 'DELETE',
    word: 'the artifact',
    to: (side) => ({ path: `/v1/artifacts/${ARTIFACTS[side].blobId}` }),
  },
  {
    label: 'deployment secrets',
    op: 'POST /v1/deployments/{deploymentId}/secrets',
    method: 'POST',
    word: 'the deployment',
    to: (side) => ({
      path: `/v1/deployments/${DEPLOYMENTS[side].deploymentId}/secrets`,
      body: { envName: 'test', secrets: [{ name: 'ACME_KEY', value: 'x' }] },
    }),
  },
  ...(['pin', 'add-as-latest', 'withdraw'] as const).map(
    (verb): Row => ({
      label: `suggested change ${verb}`,
      op: `POST /v1/suggested-changes/{suggestedChangeId}/${verb}`,
      method: 'POST',
      word: 'the agent',
      to: (side) => ({ path: `/v1/suggested-changes/${CARDS[side].id}/${verb}`, body: {} }),
    }),
  ),
  {
    label: 'Improve run cancel',
    op: 'POST /v1/improve-runs/{improveRunId}/cancel',
    method: 'POST',
    word: 'the agent',
    to: (side) => ({ path: `/v1/improve-runs/${IMPROVE_RUNS[side].id}/cancel`, body: {} }),
  },
  {
    label: 'connection choice remove',
    op: 'DELETE /v1/connection-choices/{choiceId}',
    method: 'DELETE',
    word: 'the connection choice',
    to: (side) => ({ path: `/v1/connection-choices/${CHOICES[side].choiceId}` }),
  },
];

const send = (h: Harness, token: string, r: Pick<Row, 'method' | 'to'>, side: Side) => {
  const { path, body } = r.to(side);
  return h.send(token, r.method, path, body);
};

const row = (label: string) => HELD.find((r) => r.label === label) as Row;

const refusedWith = (
  res: Awaited<ReturnType<Harness['send']>>,
  message: string,
  projectId: string | undefined,
) => {
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expect(res.body.error).toMatchObject({
    code: 'key-project-mismatch',
    message,
    details: { keyProjectId: P1, ...(projectId !== undefined && { projectId }) },
  });
  if (projectId === undefined) expect(res.body.error?.details).not.toHaveProperty('projectId');
  expect(res.changed).toEqual([]);
};

const notRefused = (res: Awaited<ReturnType<Harness['send']>>) =>
  expect(res.body.error?.code, JSON.stringify(res.body)).not.toBe('key-project-mismatch');

const served = harness('served');
const recorded = harness('recorded');
const withStore = harness('store');

test('every operation whose 403 names this refusal has a row, and no other', () => {
  const documented = OPERATIONS.filter((o) =>
    JSON.stringify(o.responses['403'] ?? '').includes(LIMITED_RECORD_PROJECT),
  ).map((o) => `${o.method.toUpperCase()} ${o.openapiPath}`);
  expect(HELD.map((r) => r.op).sort()).toEqual(documented.sort());
});

describe.each([
  ['the host says which projects serve each item', served],
  ['each item records its own project', recorded],
] as const)("another project's record, with no store, where %s", (_where, h) => {
  test.each(HELD)('$label: 403 key-project-mismatch, nothing written', async (r) => {
    const res = await send(h, LIMITED, r, 'away');
    refusedWith(res, `This API key is limited to project ${P1}; ${r.word} is in project ${P2}`, P2);
  });

  test.each(HELD)("$label, on the key project's own record: not refused", async (r) => {
    notRefused(await send(h, LIMITED, r, 'home'));
  });

  test.each(HELD)('$label, by a key limited to no project: not refused', async (r) => {
    notRefused(await send(h, UNLIMITED, r, 'away'));
  });

  test.each(HELD)('$label, by a session limited to a project: the same refusal', async (r) => {
    const res = await send(h, SESSION, r, 'away');
    refusedWith(res, `This session is limited to project ${P1}; ${r.word} is in project ${P2}`, P2);
  });

  test("a test run in the key's project, of another project's test set, is refused for the test set", async () => {
    const res = await h.send(
      LIMITED,
      'POST',
      `/v1/test-runs/${TEST_RUNS.awaySet.testRunId}/cancel`,
    );
    refusedWith(
      res,
      `This API key is limited to project ${P1}; the test set is in project ${P2}`,
      P2,
    );
  });

  test("a correction in the key's project, of another project's agent, is refused its change for the agent", async () => {
    const res = await h.send(
      LIMITED,
      'PATCH',
      `/v1/corrections/${CORRECTIONS.awayAgent.correctionId}`,
      { status: 'fixed' },
    );
    refusedWith(res, `This API key is limited to project ${P1}; the agent is in project ${P2}`, P2);
  });

  test("a correction's author removes it, as with a store", async () => {
    const res = await h.send(
      LIMITED,
      'POST',
      `/v1/corrections/${CORRECTIONS.own.correctionId}/remove`,
    );
    notRefused(res);
    expect(res.changed).toEqual(['corrections.unregister']);
  });

  test('a conversation from before projects is held where its agent is', async () => {
    const res = await h.send(
      LIMITED,
      'POST',
      `/v1/conversations/${CONVERSATIONS.unfiled.id}/unregister`,
    );
    refusedWith(
      res,
      `This API key is limited to project ${P1}; the conversation is in project ${P2}`,
      P2,
    );
  });

  test("another person's connection choice is still not found", async () => {
    const res = await h.send(
      LIMITED,
      'DELETE',
      `/v1/connection-choices/${CHOICES.others.choiceId}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.changed).toEqual([]);
  });

  test.each([
    ['pin', 'the agent is in project'],
    ['add-as-latest', 'the agent is in project'],
  ])(
    "a suggested change at the key's project, for an agent another project has: %s refused for the agent",
    async (verb, words) => {
      const res = await h.send(
        LIMITED,
        'POST',
        `/v1/suggested-changes/${CARDS.away.id}/${verb}`,
        {},
      );
      refusedWith(res, `This API key is limited to project ${P1}; ${words} ${P2}`, P2);
    },
  );

  // Stricter than a store, which asks only the agent here: held on the
  // card's scope, as an agent pin's scope is held.
  test.each(['pin', 'add-as-latest'])(
    "a suggested change at another project, for the key project's agent: %s refused for its scope",
    async (verb) => {
      const res = await h.send(
        LIMITED,
        'POST',
        `/v1/suggested-changes/${CARDS.homeAtP2.id}/${verb}`,
        {},
      );
      refusedWith(
        res,
        `This API key is limited to project ${P1}; the suggested change is in project ${P2}`,
        P2,
      );
    },
  );

  test.each(HELD)('$label: a record that is not there is not refused', async (r) => {
    const { path, body } = r.to('away');
    const res = await h.send(
      LIMITED,
      r.method,
      path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, randomUUID()),
      r.label === 'correction of a run' ? { runId: randomUUID(), answer: 'right' } : body,
    );
    notRefused(res);
  });
});

describe('an agent more than one project serves, with no store: what a store asks', () => {
  test('a pin at the key project is not refused', async () => {
    notRefused(
      await served.send(LIMITED, 'POST', `/v1/suggested-changes/${CARDS.shared.id}/pin`, {}),
    );
  });

  test("a pin at another of its projects is refused for the card's scope, that project", async () => {
    const res = await served.send(
      LIMITED,
      'POST',
      `/v1/suggested-changes/${CARDS.sharedAtP2.id}/pin`,
      {},
    );
    refusedWith(
      res,
      `This API key is limited to project ${P1}; the suggested change is in project ${P2}`,
      P2,
    );
  });

  test.each([
    ['suggested change withdraw', `/v1/suggested-changes/${CARDS.shared.id}/withdraw`],
    ['Improve run cancel', `/v1/improve-runs/${IMPROVE_RUNS.shared.id}/cancel`],
  ])('%s: refused where its new versions are made', async (_label, path) => {
    const res = await served.send(LIMITED, 'POST', path, {});
    refusedWith(
      res,
      `This API key is limited to project ${P1}; new versions of the agent are made in project ${P0}`,
      P0,
    );
  });
});

describe("a record of the workspace's, with no store", () => {
  const above = (who: string) =>
    new RegExp(`^This ${who} is limited to project ${P1}, and this request changes the workspace`);

  test.each([
    ['approval complete', `/v1/approvals/${APPROVALS.tenant.id}/complete`, { decision: 'approve' }],
    ['approval audit bundle', `/v1/approvals/${APPROVALS.tenant.id}/audit-bundle`, {}],
  ])(
    '%s: refused for a session, and not for a key, as a store asks `read`',
    async (_l, path, body) => {
      const bySession = await served.send(SESSION, 'POST', path, body);
      expect(bySession.status).toBe(403);
      expect(bySession.body.error?.message).toMatch(above('session'));
      expect(bySession.changed).toEqual([]);
      notRefused(await served.send(LIMITED, 'POST', path, body));
    },
  );

  test('an artifact: its delete is refused for a session, and not for a key', async () => {
    const path = `/v1/artifacts/${ARTIFACTS.tenant.blobId}`;
    const bySession = await served.send(SESSION, 'DELETE', path);
    expect(bySession.status).toBe(403);
    expect(bySession.body.error?.message).toMatch(above('session'));
    expect(bySession.changed).toEqual([]);
    notRefused(await served.send(LIMITED, 'DELETE', path));
  });

  test.each([
    ['API key', LIMITED],
    ['session', SESSION],
  ])(
    'a deployment with no project: its secrets are refused for a %s, as a store asks `admin`',
    async (who, token) => {
      const res = await served.send(
        token,
        'POST',
        `/v1/deployments/${DEPLOYMENTS.tenant.deploymentId}/secrets`,
        row('deployment secrets').to('away').body,
      );
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('key-project-mismatch');
      expect(res.body.error?.message).toMatch(above(who));
      expect(res.changed).toEqual([]);
    },
  );

  test.each([
    ['tenant', CARDS.tenant.id],
    ['org', CARDS.org.id],
  ])("a suggested change's %s-wide pin is refused", async (_scope, cardId) => {
    const res = await served.send(LIMITED, 'POST', `/v1/suggested-changes/${cardId}/pin`, {});
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('key-project-mismatch');
    expect(res.body.error?.message).toMatch(
      new RegExp(`^This API key is limited to project ${P1}, and this request changes `),
    );
    expect(res.changed).toEqual([]);
  });
});

describe("another project's record, by a key limited to a project, with a store", () => {
  test.each(HELD)('$label: refused by the store, as before', async (r) => {
    const res = await send(withStore, LIMITED, r, 'away');
    expect([403, 404], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body.error?.code).not.toBe('key-project-mismatch');
    expect(res.changed).toEqual([]);
  });
});
