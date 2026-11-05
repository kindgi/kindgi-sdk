// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

describe('projects — queue rules and queue', () => {
  it('wire round-trips', async () => {
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
    const stub = recordingFetch([
      ok({ data: [], hasMore: false }),
      { status: 201, body: JSON.stringify({ ruleId: 'r-1' }) },
      ok({ considered: 100, matched: 4 }),
      ok({ data: [], hasMore: false, total: 3 }),
      ok({ runId: 'run-1', state: 'dismissed' }),
      ok({ runId: 'run-1', state: 'open' }),
      ok({ queued: 3, alreadyQueued: 1 }),
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.projects.queueRules.list('p-1');
    await client.projects.queueRules.create('p-1', {
      name: 'Pinned refund runs',
      when: { agentIds: ['acme.refunds'], versions: ['pinned'] },
      sample: 0.05,
    });
    await client.projects.queueRules.preview('p-1', {
      agentIds: ['acme.refunds'],
      versions: ['pinned', '2.1.0'],
      sample: 0.05,
    });
    const queue = await client.projects.expertQueue.list('p-1', { forMe: true, limit: 0 });
    await client.projects.expertQueue.dismiss('p-1', 'run-1', 'a test run');
    await client.projects.expertQueue.reopen('p-1', 'run-1');
    const recent = await client.projects.queueRules.queueRecent('p-1', 'r-1', { last: 50 });
    expect(queue.total).toBe(3);
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/projects/p-1/queue-rules',
      'POST /v1/projects/p-1/queue-rules',
      'GET /v1/projects/p-1/queue-rules/preview',
      'GET /v1/projects/p-1/expert-queue',
      'POST /v1/projects/p-1/expert-queue/run-1/dismiss',
      'POST /v1/projects/p-1/expert-queue/run-1/reopen',
      'POST /v1/projects/p-1/queue-rules/r-1/queue-recent',
    ]);
    const preview = new URL(stub.calls[2]?.url ?? '').searchParams;
    expect(preview.get('versions')).toBe('pinned,2.1.0');
    expect(preview.get('sample')).toBe('0.05');
    const list = new URL(stub.calls[3]?.url ?? '').searchParams;
    expect([list.get('forMe'), list.get('limit')]).toEqual(['true', '0']);
    expect(JSON.parse(stub.calls[4]?.body ?? '{}')).toEqual({ reason: 'a test run' });
    expect(JSON.parse(stub.calls[6]?.body ?? '{}')).toEqual({ last: 50 });
    expect([recent.queued, recent.alreadyQueued]).toEqual([3, 1]);
  });
});
