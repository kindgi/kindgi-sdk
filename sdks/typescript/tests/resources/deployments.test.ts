// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

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
});
