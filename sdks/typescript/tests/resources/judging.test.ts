// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

describe('projects — judging rules and queue', () => {
  it('wire round-trips', async () => {
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
    const stub = recordingFetch([
      ok({ data: [], hasMore: false }),
      { status: 201, body: JSON.stringify({ ruleId: 'r-1' }) },
      ok({ considered: 100, matched: 4 }),
      ok({ data: [], hasMore: false, total: 3 }),
      ok({ runId: 'run-1', state: 'dismissed' }),
      ok({ runId: 'run-1', state: 'open' }),
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.projects.judgingRules.list('p-1');
    await client.projects.judgingRules.create('p-1', {
      name: 'Live refund runs',
      when: { agentIds: ['acme.refunds'], versions: ['live'] },
      sample: 0.05,
    });
    await client.projects.judgingRules.preview('p-1', {
      agentIds: ['acme.refunds'],
      versions: ['live', '2.1.0'],
      sample: 0.05,
    });
    const queue = await client.projects.judgingQueue.list('p-1', { forMe: true, limit: 0 });
    await client.projects.judgingQueue.dismiss('p-1', 'run-1', 'a test run');
    await client.projects.judgingQueue.reopen('p-1', 'run-1');
    expect(queue.total).toBe(3);
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/projects/p-1/judging-rules',
      'POST /v1/projects/p-1/judging-rules',
      'GET /v1/projects/p-1/judging-rules/preview',
      'GET /v1/projects/p-1/judging-queue',
      'POST /v1/projects/p-1/judging-queue/run-1/dismiss',
      'POST /v1/projects/p-1/judging-queue/run-1/reopen',
    ]);
    const preview = new URL(stub.calls[2]?.url ?? '').searchParams;
    expect(preview.get('versions')).toBe('live,2.1.0');
    expect(preview.get('sample')).toBe('0.05');
    const list = new URL(stub.calls[3]?.url ?? '').searchParams;
    expect([list.get('forMe'), list.get('limit')]).toEqual(['true', '0']);
    expect(JSON.parse(stub.calls[4]?.body ?? '{}')).toEqual({ reason: 'a test run' });
  });
});
