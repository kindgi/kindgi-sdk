// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A flow run's record: its model usage per step from the cost ledger
 * (`ProvenanceBinding.getStepUsage`) beside the DAG, as `stepUsage`, and
 * signed in the export (bundle 1.3.0); the list's `flowId` filter; and a
 * run with no record yet saying why (`recordState`, `reason`).
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  createEd25519ExportSigner,
  generateEd25519KeyPair,
  parsePublicKeyPem,
  verifyEd25519,
} from '@kindgi/crypto';
import type { Provenance } from '@kindgi/provenance';
import type { FlowId, ProvenanceId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  ListProvenanceRecordsInput,
  ProvenanceBinding,
  ProvenanceBindingError,
  RunHandlerBinding,
  StepRunsUsage,
  StepUsageByNodeId,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const flowRunId = randomUUID() as RunId;
const turnRunId = randomUUID() as RunId;
const TOKEN = 'provenance-flow-token';
const AT = '2026-10-19T12:00:00.000Z' as Timestamp;

const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const notUsed = async () =>
  ({ kind: 'err', error: { code: 'bad-input', message: 'not used in this suite' } }) as const;
const runHandler: RunHandlerBinding = {
  invokeAgent: notUsed,
  invokeFlow: notUsed,
  resumeRun: notUsed,
};

const flowRecord: Provenance = {
  id: randomUUID() as ProvenanceId,
  runId: flowRunId,
  tenantId,
  flowRef: { id: 'acme.report' as FlowId, version: '1.0.0' },
  version: '1.1.0',
  createdAt: AT,
  nodes: [
    { id: 'input', kind: 'input', timestamp: AT },
    {
      id: 'step:write',
      kind: 'step',
      timestamp: AT,
      attributes: { nodeId: 'write', nodeKind: 'agent', status: 'completed', attempts: 1 },
    },
  ] as Provenance['nodes'],
  edges: [{ from: 'step:write', to: 'input', kind: 'caused-by' }],
};

const turnRecord: Provenance = {
  id: randomUUID() as ProvenanceId,
  runId: turnRunId,
  tenantId,
  version: '1.0.0',
  createdAt: AT,
  nodes: [{ id: 'input', kind: 'input', timestamp: AT }] as Provenance['nodes'],
  edges: [],
};

const writeUsage = {
  calls: 2,
  costUsd: 0.0061,
  tokens: { prompt: 1800, completion: 420, cacheRead: 1000, cacheWrite: 0, reasoning: 0 },
};
/** The ledger's rows: one per step, as its runs' rows name it. */
const stepRows: readonly StepRunsUsage[] = [
  { parentNodeId: 'write', parentScope: '', ...writeUsage },
];
/** What the routes make of them: by the node that counts the step's runs. */
const stepUsage: StepUsageByNodeId = { 'step:write': writeUsage };

const tokens = (prompt: number, completion: number) => ({
  prompt,
  completion,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
});

function binding(
  getStepUsage?: ProvenanceBinding['getStepUsage'],
  overrides: Partial<ProvenanceBinding> = {},
): ProvenanceBinding {
  return {
    listRecords: async () => ({ kind: 'ok', value: { records: [] } }),
    getByRunId: async (_tenant, id) => {
      if (id === flowRunId) return { kind: 'ok', value: flowRecord };
      if (id === turnRunId) return { kind: 'ok', value: turnRecord };
      return { kind: 'err', error: { code: 'provenance-not-found', message: 'no such run' } };
    },
    ...(getStepUsage !== undefined && { getStepUsage }),
    ...overrides,
  };
}

const keys = generateEd25519KeyPair();
const made = createEd25519ExportSigner({ privateKey: keys.privateKey });
if (made.kind === 'err') throw new Error(made.error.message);
const signer = made.value;
const KEY_ID = signer.activeKey().keyId;

function app(provenanceBinding: ProvenanceBinding) {
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    provenanceBinding,
    exportSigning: signer,
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe('GET /v1/provenance/:runId — stepUsage', () => {
  test("a flow record's model usage per step, by node id, beside the DAG", async () => {
    const asked: RunId[] = [];
    const res = await app(
      binding(async (_tenant, runId) => {
        asked.push(runId);
        return { kind: 'ok', value: stepRows };
      }),
    ).request(`/v1/provenance/${flowRunId}`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dag: { nodes: unknown[] }; stepUsage?: unknown };
    expect(body.stepUsage).toEqual(stepUsage);
    expect(body.dag.nodes).toHaveLength(2);
    expect(asked).toEqual([flowRunId]);
  });

  test("each step's row goes to the node that counts its runs; one with no node is left out", async () => {
    const loopRunId = randomUUID() as RunId;
    const step = (attributes: Record<string, unknown>) => ({
      kind: 'step',
      timestamp: AT,
      attributes: { status: 'completed', attempts: 1, ...attributes },
    });
    const loopRecord: Provenance = {
      ...flowRecord,
      id: randomUUID() as ProvenanceId,
      runId: loopRunId,
      nodes: [
        { id: 'input', kind: 'input', timestamp: AT },
        { id: 'step:L', ...step({ nodeId: 'L', nodeKind: 'loop' }) },
        { id: 'step:w@L#0', ...step({ nodeId: 'w', nodeKind: 'agent', iteration: 0 }) },
        {
          id: 'step:L#folded',
          kind: 'step',
          timestamp: AT,
          attributes: {
            nodeId: 'L',
            folded: { from: 1, to: 2, count: 2, byStatus: { completed: 2 }, runs: 2 },
          },
        },
      ] as Provenance['nodes'],
      edges: [],
    };
    const inL = (iteration: number) => JSON.stringify([{ loopNodeId: 'L', iteration }]);
    const rows: StepRunsUsage[] = [
      { parentNodeId: 'w', parentScope: inL(0), calls: 1, costUsd: 0.125, tokens: tokens(100, 10) },
      { parentNodeId: 'w', parentScope: inL(1), calls: 2, costUsd: 0.25, tokens: tokens(200, 20) },
      { parentNodeId: 'w', parentScope: inL(2), calls: 3, costUsd: 0.5, tokens: tokens(300, 30) },
      // Iteration 3's step isn't in the record: it was cut with the record's middle.
      { parentNodeId: 'w', parentScope: inL(3), calls: 5, costUsd: 1, tokens: tokens(500, 50) },
    ];
    const res = await app(
      binding(async () => ({ kind: 'ok', value: rows }), {
        getByRunId: async () => ({ kind: 'ok', value: loopRecord }),
      }),
    ).request(`/v1/provenance/${loopRunId}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stepUsage?: unknown }).stepUsage).toEqual({
      'step:w@L#0': { calls: 1, costUsd: 0.125, tokens: tokens(100, 10) },
      'step:L#folded': { calls: 5, costUsd: 0.75, tokens: tokens(500, 50) },
    });
  });

  test('never read for a record with no step nodes: a turn has its callUsage', async () => {
    let reads = 0;
    const res = await app(
      binding(async () => {
        reads += 1;
        return { kind: 'ok', value: stepRows };
      }),
    ).request(`/v1/provenance/${turnRunId}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('stepUsage');
    expect(reads).toBe(0);
  });

  test('no stepUsage when the steps made no calls, none has a node, or there is no ledger', async () => {
    const noNode: StepRunsUsage = {
      parentNodeId: 'gone',
      parentScope: '',
      calls: 1,
      costUsd: 0.5,
      tokens: tokens(10, 1),
    };
    for (const read of [
      binding(async () => ({ kind: 'ok', value: [] })),
      binding(async () => ({ kind: 'ok', value: [noNode] })),
      binding(),
    ]) {
      const res = await app(read).request(`/v1/provenance/${flowRunId}`, { headers: auth });
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('stepUsage');
    }
  });

  test("a ledger read that fails fails the request, with the binding's status", async () => {
    const failed: ProvenanceBindingError = {
      code: 'internal-server-error',
      message: 'Could not read step usage: connection refused',
    };
    const res = await app(binding(async () => ({ kind: 'err', error: failed }))).request(
      `/v1/provenance/${flowRunId}`,
      { headers: auth },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: failed });
  });
});

describe('POST /v1/provenance/:runId/export — stepUsage is signed', () => {
  test('bundle 1.3.0 carries stepUsage, and the signature covers it', async () => {
    const res = await app(binding(async () => ({ kind: 'ok', value: stepRows }))).request(
      `/v1/provenance/${flowRunId}/export`,
      {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ signingKeyId: KEY_ID }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle: string;
      bundleSchemaVersion: string;
      signature: string;
      publicKey: string;
    };
    expect(body.bundleSchemaVersion).toBe('1.3.0');
    const bytes = Buffer.from(body.bundle, 'base64');
    const decoded = JSON.parse(bytes.toString('utf8')) as {
      bundleSchemaVersion: string;
      stepUsage?: unknown;
    };
    expect(decoded.bundleSchemaVersion).toBe('1.3.0');
    expect(decoded.stepUsage).toEqual(stepUsage);

    const pub = parsePublicKeyPem(body.publicKey);
    if (pub.kind === 'err') throw new Error(pub.error.message);
    const signature = Buffer.from(body.signature, 'base64');
    expect(verifyEd25519(pub.value, bytes, signature)).toEqual({ kind: 'ok', value: true });
  });
});

describe('GET /v1/provenance — ?flowId=', () => {
  test("lists a flow's records: the filter reaches the binding", async () => {
    const inputs: ListProvenanceRecordsInput[] = [];
    const read = binding(undefined, {
      listRecords: async (input) => {
        inputs.push(input);
        return { kind: 'ok', value: { records: [] } };
      },
    });
    const res = await app(read).request('/v1/provenance?flowId=acme.report', { headers: auth });
    expect(res.status).toBe(200);
    expect(inputs[0]?.flowId).toBe('acme.report');
    // The page says the flow back, so a client can tell a runtime that ignored it.
    expect(await res.json()).toMatchObject({ data: [], flowId: 'acme.report' });

    // An empty filter is no filter, and the page says no flow.
    const unfiltered = await app(read).request('/v1/provenance?flowId=', { headers: auth });
    expect(inputs[1]).not.toHaveProperty('flowId');
    expect(await unfiltered.json()).not.toHaveProperty('flowId');
  });
});

describe('404 provenance-not-found — why a run has no record yet', () => {
  const notFound = (error: ProvenanceBindingError) =>
    binding(undefined, { getByRunId: async () => ({ kind: 'err', error }) });

  test("the binding's recordState and reason, beside the run id", async () => {
    const res = await app(
      notFound({
        code: 'provenance-not-found',
        message: "The run's record failed to build.",
        recordState: 'failed',
        reason: 'build-failed',
      }),
    ).request(`/v1/provenance/${flowRunId}`, { headers: auth });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'provenance-not-found',
        details: { runId: flowRunId, recordState: 'failed', reason: 'build-failed' },
      },
    });
  });

  test('the export says the same', async () => {
    const res = await app(
      notFound({
        code: 'provenance-not-found',
        message: "The run's record is being written.",
        recordState: 'being-written',
      }),
    ).request(`/v1/provenance/${flowRunId}/export`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ signingKeyId: KEY_ID }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details: object } };
    expect(body.error.code).toBe('provenance-not-found');
    expect(body.error.details).toEqual({ runId: flowRunId, recordState: 'being-written' });
  });

  test('neither, when the binding gives none, or gives them as anything but text', async () => {
    for (const error of [
      { code: 'provenance-not-found', message: 'no such run' },
      { code: 'provenance-not-found', message: 'no such run', recordState: 3, reason: { a: 1 } },
    ]) {
      const res = await app(notFound(error)).request(`/v1/provenance/${flowRunId}`, {
        headers: auth,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { details: object } };
      expect(body.error.details).toEqual({ runId: flowRunId });
    }
  });
});
