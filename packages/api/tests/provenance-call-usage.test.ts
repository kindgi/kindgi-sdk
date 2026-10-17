// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A provenance read carries each model call's usage from the cost ledger
 * (`ProvenanceBinding.getCallUsage`) beside the DAG, as `callUsage`; the
 * signed export (bundle 1.2.0) signs it with the DAG. A ledger read that
 * fails fails the request with its status.
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
import type { ProvenanceId, RunId, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  CallUsageByCallId,
  ProvenanceBinding,
  ProvenanceBindingError,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const runId = randomUUID() as RunId;
const callId = randomUUID();
const TOKEN = 'provenance-usage-token';

const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const notUsed = async () =>
  ({ kind: 'err', error: { code: 'bad-input', message: 'not used in this suite' } }) as const;
const runHandler: RunHandlerBinding = {
  invokeAgent: notUsed,
  invokeFlow: notUsed,
  resumeRun: notUsed,
};

const provenance: Provenance = {
  id: randomUUID() as ProvenanceId,
  runId,
  tenantId,
  version: '1.0.0',
  createdAt: '2026-10-04T12:00:00.000Z' as Timestamp,
  nodes: [
    {
      id: 'model-call:1',
      kind: 'model-call',
      timestamp: '2026-10-04T12:00:00.000Z' as Timestamp,
      modelVersion: 'anthropic/claude-acme',
      attributes: { step: 1, callId, providerId: 'anthropic', model: 'claude-acme' },
    },
  ] as Provenance['nodes'],
  edges: [],
};

const usage: CallUsageByCallId = {
  [callId]: {
    usage: { promptTokens: 1200, completionTokens: 300, cacheReadTokens: 1000 },
    costUsd: 0.0042,
    durationMs: 840,
    servedModel: 'claude-acme-20261001',
  },
};

function binding(getCallUsage?: ProvenanceBinding['getCallUsage']): ProvenanceBinding {
  return {
    listRecords: async () => ({ kind: 'ok', value: { records: [] } }),
    getByRunId: async (_tenant, id) =>
      id === runId
        ? { kind: 'ok', value: provenance }
        : { kind: 'err', error: { code: 'provenance-not-found', message: 'no such run' } },
    ...(getCallUsage !== undefined && { getCallUsage }),
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

describe('GET /v1/provenance/:runId — callUsage', () => {
  test("the run's model calls' usage, by call id, beside the DAG", async () => {
    const res = await app(binding(async () => ({ kind: 'ok', value: usage }))).request(
      `/v1/provenance/${runId}`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dag: { nodes: unknown[] }; callUsage?: unknown };
    expect(body.callUsage).toEqual(usage);
    expect(body.dag.nodes).toHaveLength(1);
  });

  test('no callUsage when the run has no recorded calls, or the deployment no ledger', async () => {
    for (const read of [binding(async () => ({ kind: 'ok', value: {} })), binding()]) {
      const res = await app(read).request(`/v1/provenance/${runId}`, { headers: auth });
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('callUsage');
    }
  });

  test("a ledger read that fails fails the request, with the binding's status", async () => {
    const failed: ProvenanceBindingError = {
      code: 'internal-server-error',
      message: 'Could not read call usage: connection refused',
    };
    const res = await app(binding(async () => ({ kind: 'err', error: failed }))).request(
      `/v1/provenance/${runId}`,
      { headers: auth },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: failed });
  });
});

describe('POST /v1/provenance/:runId/export — callUsage is signed', () => {
  async function exportRun(read: ProvenanceBinding) {
    return app(read).request(`/v1/provenance/${runId}/export`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ signingKeyId: KEY_ID }),
    });
  }

  test('bundle 1.2.0 carries callUsage and exportedAt, and the signature covers them', async () => {
    const res = await exportRun(binding(async () => ({ kind: 'ok', value: usage })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bundle: string;
      bundleSchemaVersion: string;
      signature: string;
      publicKey: string;
      exportedAt: string;
    };
    expect(body.bundleSchemaVersion).toBe('1.2.0');
    const bytes = Buffer.from(body.bundle, 'base64');
    const decoded = JSON.parse(bytes.toString('utf8')) as {
      bundleSchemaVersion: string;
      callUsage?: unknown;
      exportedAt: string;
    };
    expect(decoded.bundleSchemaVersion).toBe('1.2.0');
    // Signed once: the envelope's exportedAt is the body's.
    expect(decoded.exportedAt).toBe(body.exportedAt);
    expect(decoded.callUsage).toEqual(usage);

    const pub = parsePublicKeyPem(body.publicKey);
    if (pub.kind === 'err') throw new Error(pub.error.message);
    const signature = Buffer.from(body.signature, 'base64');
    expect(verifyEd25519(pub.value, bytes, signature)).toEqual({ kind: 'ok', value: true });

    // Changing the usage breaks the signature.
    const tampered = new TextEncoder().encode(
      bytes.toString('utf8').replace('"costUsd":0.0042', '"costUsd":0.0001'),
    );
    expect(verifyEd25519(pub.value, tampered, signature)).toEqual({ kind: 'ok', value: false });
  });

  test("a ledger read that fails fails the export: nothing is signed without the calls' usage", async () => {
    const res = await exportRun(
      binding(async () => ({
        kind: 'err',
        error: { code: 'internal-server-error', message: 'connection refused' },
      })),
    );
    expect(res.status).toBe(500);
  });
});
