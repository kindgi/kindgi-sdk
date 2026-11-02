// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** `countKeptBuildsReal`: one list read, its `keptBuilds` when the runtime counts them. */

import { describe, expect, test } from 'vitest';

import { countKeptBuildsReal } from '../src/deploy/post.js';

const PROJECT = '3f2b8c1e-4a5d-4e6f-9a0b-1c2d3e4f5a6b';

function answering(status: number, body: unknown) {
  const asked: { url: string; auth: string | null }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    asked.push({ url, auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

describe('countKeptBuildsReal', () => {
  test('reads one row of the project deployed into, and gives its count', async () => {
    const api = answering(200, { data: [], hasMore: true, keptBuilds: 7 });
    const got = await countKeptBuildsReal({
      endpoint: 'https://platform.example.com/',
      token: 'test-bearer-token',
      projectId: PROJECT,
      fetchImpl: api.fetchImpl,
    });
    expect(got).toEqual({ kind: 'ok', keptBuilds: 7 });
    expect(api.asked).toEqual([
      {
        url: `https://platform.example.com/v1/deployments?limit=1&projectId=${PROJECT}`,
        auth: 'Bearer test-bearer-token',
      },
    ]);
  });

  test('with no project, the tenant’s', async () => {
    const api = answering(200, { data: [], hasMore: false, keptBuilds: 0 });
    const got = await countKeptBuildsReal({
      endpoint: 'https://platform.example.com',
      token: 'test-bearer-token',
      fetchImpl: api.fetchImpl,
    });
    expect(got).toEqual({ kind: 'ok', keptBuilds: 0 });
    expect(api.asked[0]?.url).toBe('https://platform.example.com/v1/deployments?limit=1');
  });

  test('no count from a runtime that sends none, or one that isn’t a count', async () => {
    for (const keptBuilds of [undefined, -1, 1.5, '3']) {
      const api = answering(200, { data: [], hasMore: false, keptBuilds });
      const got = await countKeptBuildsReal({
        endpoint: 'https://platform.example.com',
        token: 'test-bearer-token',
        fetchImpl: api.fetchImpl,
      });
      expect(got, String(keptBuilds)).toEqual({ kind: 'ok' });
    }
  });

  test('a refusal says its status and code', async () => {
    const api = answering(403, { error: { code: 'permission-denied', message: 'no' } });
    const got = await countKeptBuildsReal({
      endpoint: 'https://platform.example.com',
      token: 'test-bearer-token',
      projectId: PROJECT,
      fetchImpl: api.fetchImpl,
    });
    expect(got).toEqual({
      kind: 'error',
      message: `GET https://platform.example.com/v1/deployments?limit=1&projectId=${PROJECT} answered HTTP 403 (permission-denied)`,
    });
  });
});
