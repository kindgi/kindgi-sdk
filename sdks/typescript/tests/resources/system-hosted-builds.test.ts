// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import type { RegisterDeploymentInput } from '../../src/resources/deployments.js';
import { errorFetch, jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';
const TENANT = '6f1c2c0e-3b0a-4f1e-9a51-0c1d2e3f4a5b';
const PROJECT = '3f2b8c1e-4a5d-4e6f-9a0b-1c2d3e4f5a6b';
const INPUT: RegisterDeploymentInput = {
  imageRef: 'ghcr.io/acme/pack@sha256:abc',
  artifactVersion: '20261110.1',
  indexHash: 'sha256:idx',
  signerKeyId: 'key-1',
  signerPublicKey: 'pem',
  signature: 'sig',
  publishedAt: '2026-11-10T09:00:00Z',
  projectId: PROJECT,
};
const RECORD = {
  deploymentId: 'd1',
  tenantId: TENANT,
  projectId: PROJECT,
  imageRef: INPUT.imageRef,
  artifactVersion: INPUT.artifactVersion,
  signerKeyId: 'key-1',
  publishedAt: INPUT.publishedAt,
  primitiveCounts: { agents: 1, tools: 1, guardrails: 0, flows: 0 },
  keyScope: 'project',
};

describe('systemHostedBuilds — wire round-trip', () => {
  it("register: POST …/tenants/{tenantId}/deployments with the deploy's body", async () => {
    const stub = jsonFetch(RECORD, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(
      await client.systemHostedBuilds.register(TENANT, INPUT, { idempotencyKey: 'k-1' }),
    ).toEqual(RECORD);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(
      `POST ${API}/v1/system/tenants/${TENANT}/deployments`,
    );
    expect(JSON.parse(call.body ?? '{}')).toEqual(INPUT);
    expect(call.headers['idempotency-key']).toBe('k-1');
  });

  it('register: a refusal is thrown, with its code', async () => {
    const stub = errorFetch(403, { code: 'system-scope-missing', message: 'no' });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await expect(client.systemHostedBuilds.register(TENANT, INPUT)).rejects.toMatchObject({
      error: { serverCode: 'system-scope-missing' },
    });
  });
});
