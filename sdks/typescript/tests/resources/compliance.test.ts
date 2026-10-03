// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

// Valid against the wire `ComplianceEvidence` schema.
const SAMPLE_EVIDENCE = {
  id: 'ev-1',
  tenantId: '00000000-0000-0000-0000-000000000001',
  projectId: '00000000-0000-0000-0000-0000000000aa',
  kind: 'secret-resolved',
  timestamp: '2026-09-23T00:00:00Z',
  payload: { version: 1 },
};

describe('compliance — wire round-trips', () => {
  it('evidence.list + get + export hit /v1/compliance/evidence/*', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [SAMPLE_EVIDENCE], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_EVIDENCE) },
      { status: 200, body: JSON.stringify({ bundle: 'signed-body-bytes' }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.compliance.evidence.list({
      runId: 'r1',
      kind: 'secret-resolved',
    });
    await client.compliance.evidence.get('ev-1');
    await client.compliance.evidence.export(
      { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' } as never,
      { idempotencyKey: 'idem-export' },
    );
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/compliance/evidence',
      'GET /v1/compliance/evidence/ev-1',
      'POST /v1/compliance/evidence/export',
    ]);
    // list carries filters as query
    expect(stub.calls[0]?.url).toMatch(/runId=r1/);
    expect(stub.calls[0]?.url).toMatch(/kind=secret-resolved/);
    // export honors idempotency header
    expect(stub.calls[2]?.headers['idempotency-key']).toBe('idem-export');
  });
});
