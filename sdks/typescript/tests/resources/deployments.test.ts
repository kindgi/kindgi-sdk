// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import type { RegisterDeploymentInput } from '../../src/resources/deployments.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_DEPLOYMENT = {
  deploymentId: 'd1',
  tenantId: 'tenant-1',
  imageRef: 'oci://example.com/agent@sha256:abc',
  artifactVersion: '1.0.0',
  signerKeyId: 'key-1',
  publishedAt: '2026-09-23T00:00:00Z',
  primitiveCounts: { agents: 1, tools: 3, guardrails: 2, flows: 1 },
};

describe('deployments — wire round-trips', () => {
  it('register + list + get + syncSecrets hit /v1/deployments/*', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify(SAMPLE_DEPLOYMENT) },
      { status: 200, body: JSON.stringify({ data: [SAMPLE_DEPLOYMENT], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_DEPLOYMENT) },
      { status: 200, body: JSON.stringify({ synced: 3 }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.deployments.register(
      {
        imageDigest: 'sha256:abc',
        artifactVersion: '1.0.0',
        indexHash: 'sha256:idx',
        publishedAt: '2026-09-23T00:00:00Z',
        signature: 'sig',
        signerKeyId: 'key-1',
      } as never,
      { idempotencyKey: 'idem-1' },
    );
    await client.deployments.list({ imageRefPrefix: 'oci://example.com/' });
    await client.deployments.get('d1');
    await client.deployments.syncSecrets('d1', { secrets: [] as never } as never, {
      idempotencyKey: 'idem-2',
    });
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/deployments',
      'GET /v1/deployments',
      'GET /v1/deployments/d1',
      'POST /v1/deployments/d1/secrets',
    ]);
    expect(stub.calls[0]?.headers['idempotency-key']).toBe('idem-1');
    expect(stub.calls[3]?.headers['idempotency-key']).toBe('idem-2');
  });

  it('register sends the project to deploy into, and the record names it', async () => {
    const PROJECT = '3f2b8c1e-4a5d-4e6f-9a0b-1c2d3e4f5a6b';
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ ...SAMPLE_DEPLOYMENT, projectId: PROJECT }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const input: RegisterDeploymentInput = {
      imageRef: 'ghcr.io/acme/pack@sha256:abc',
      artifactVersion: '20261012.1',
      indexHash: 'sha256:idx',
      signerKeyId: 'key-1',
      signerPublicKey: 'pem',
      signature: 'sig',
      publishedAt: '2026-10-12T09:00:00Z',
      projectId: PROJECT,
    };
    const deployment = await client.deployments.register(input);
    expect(JSON.parse(String(stub.calls[0]?.body))).toMatchObject({ projectId: PROJECT });
    expect(deployment.projectId).toBe(PROJECT);
  });

  it('packEnv: GET /v1/deployments/:id/pack-env, names and where each is set', async () => {
    const names = {
      envName: 'prod',
      data: [
        {
          name: 'API_BASE',
          required: true,
          kind: null,
          scope: null,
          missing: true,
          problem: 'missing',
        },
      ],
      problem: 'pack-env-missing',
    };
    const stub = jsonFetch(names);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.deployments.packEnv('dep/1')).toEqual(names);
    expect(`${stub.calls[0]!.method} ${stub.calls[0]!.url}`).toBe(
      `GET ${API}/v1/deployments/dep%2F1/pack-env`,
    );
  });

  it('values.list reads what a deployment needs in a project, with or without projectId', async () => {
    const PROJECT = '3f2b8c1e-4a5d-4e6f-9a0b-1c2d3e4f5a6b';
    const VALUE = {
      name: 'ACME_TOKEN',
      kind: 'secret',
      neededBy: { type: 'tool', id: 'acme.search', version: '1.0.0' },
      foundAt: 'tenant',
    };
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [VALUE] }) },
      { status: 200, body: JSON.stringify({ data: [] }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const own = await client.deployments.values.list('d1');
    const there = await client.deployments.values.list('d1', { projectId: PROJECT });
    expect(own.data).toEqual([VALUE]);
    expect(there.data).toEqual([]);
    expect(
      stub.calls.map((c) => {
        const url = new URL(c.url);
        return `${c.method} ${url.pathname}${url.search}`;
      }),
    ).toEqual([
      'GET /v1/deployments/d1/values',
      `GET /v1/deployments/d1/values?projectId=${PROJECT}`,
    ]);
  });

  it('promote and promoteCheck send where to; list filters by environment and pack', async () => {
    const moves = {
      imageDigest: 'sha256:abc',
      agents: [{ id: 'acme.matcher', version: '1.0.1', carried: true }],
      flows: [],
      tools: [],
      guardrails: [],
    };
    const stub = recordingFetch([
      {
        status: 201,
        body: JSON.stringify({
          deployment: { ...SAMPLE_DEPLOYMENT, deploymentId: 'd2', promotedFromDeploymentId: 'd1' },
          moved: moves,
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          moves,
          values: [],
          nextEnvironment: { projectId: 'p-prod', position: 2 },
        }),
      },
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const promoted = await client.deployments.promote('d1', {
      toProjectId: 'p-staging-2',
      reason: 'release',
    });
    const check = await client.deployments.promoteCheck('d2', { toProjectId: 'p-prod' });
    await client.deployments.list({ projectId: 'p-prod', packId: 'acme.pack' });
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/deployments/d1/promotions',
      'POST /v1/deployments/d2/promotions/check',
      'GET /v1/deployments',
    ]);
    expect(JSON.parse(String(stub.calls[0]?.body))).toEqual({
      toProjectId: 'p-staging-2',
      reason: 'release',
    });
    expect(new URL(stub.calls[2]?.url ?? '').searchParams.toString()).toBe(
      'projectId=p-prod&packId=acme.pack',
    );
    expect(promoted.deployment.promotedFromDeploymentId).toBe('d1');
    expect(promoted.moved.agents[0]?.carried).toBe(true);
    expect(check.nextEnvironment.position).toBe(2);
  });
});
