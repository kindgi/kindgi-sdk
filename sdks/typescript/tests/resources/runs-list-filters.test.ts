// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

describe('runs.list — the narrowing filters', () => {
  it('sends status (one or a list), the creation bounds, versions, the flow and whose runs', async () => {
    const page = { status: 200, body: JSON.stringify({ data: [], hasMore: false }) };
    const stub = recordingFetch([page, page]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.runs.list({
      status: ['failed', 'cancelled'],
      createdAfter: '2026-10-01T00:00:00.000Z',
      createdBefore: '2026-10-08T00:00:00.000Z',
      agentId: 'acme.refunds',
      agentVersion: '2.1.0',
    });
    await client.runs.list({
      status: 'running',
      flowId: 'acme.digest',
      flowVersion: '1.0.0',
      actsFor: 'me',
    });
    const [first, second] = stub.calls.map((c) => new URL(c.url).searchParams);
    expect(first?.getAll('status')).toEqual(['failed', 'cancelled']);
    first?.delete('status');
    expect(Object.fromEntries(first ?? [])).toEqual({
      createdAfter: '2026-10-01T00:00:00.000Z',
      createdBefore: '2026-10-08T00:00:00.000Z',
      agentId: 'acme.refunds',
      agentVersion: '2.1.0',
    });
    expect(Object.fromEntries(second ?? [])).toEqual({
      status: 'running',
      flowId: 'acme.digest',
      flowVersion: '1.0.0',
      actsFor: 'me',
    });
  });

  it('sends the completion bounds with their tie-break, and startedBy', async () => {
    const page = { status: 200, body: JSON.stringify({ data: [], hasMore: false }) };
    const stub = recordingFetch([page]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.runs.list({
      completedAfter: '2026-10-08T10:30:00.123456Z',
      afterRunId: '7b0c2f1e-9a51-4c43-8d0e-2f6a1b3c4d5e',
      completedBefore: '2026-10-08T11:00:00Z',
      startedBy: 'schedule',
      topLevel: true,
    });
    const [only] = stub.calls.map((c) => new URL(c.url).searchParams);
    expect(Object.fromEntries(only ?? [])).toEqual({
      topLevel: 'true',
      completedAfter: '2026-10-08T10:30:00.123456Z',
      afterRunId: '7b0c2f1e-9a51-4c43-8d0e-2f6a1b3c4d5e',
      completedBefore: '2026-10-08T11:00:00Z',
      startedBy: 'schedule',
    });
  });
});
