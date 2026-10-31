// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_TEST_SET = {
  id: 'testSet.x',
  tenantId: '00000000-0000-4000-8000-000000000002',
  version: '1.0.0',
  kind: 'accuracy',
  spec: {},
};

/** A `POST /v1/test-sets` body without its `projectId` (sent via options). */
const PUBLISH_BODY = {
  id: 'testSet.x',
  version: '1.0.0',
  kind: 'accuracy' as const,
  spec: {},
};

describe('test-sets — wire round-trips', () => {
  it('publish/list/get + versions.{list,get,unregister,reinstate}', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ testSetId: 'testSet.x', version: '1.0.0' }) },
      { status: 200, body: JSON.stringify({ data: [SAMPLE_TEST_SET], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_TEST_SET) },
      { status: 200, body: JSON.stringify({ data: [SAMPLE_TEST_SET], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_TEST_SET) },
      { status: 200, body: JSON.stringify({ unregistered: true }) },
      { status: 200, body: JSON.stringify({ reinstated: true }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.testSets.publish(PUBLISH_BODY, { projectId: 'proj-1' });
    await client.testSets.list({ kind: 'accuracy' });
    await client.testSets.get('testSet.x');
    await client.testSets.versions.list('testSet.x');
    await client.testSets.versions.get('testSet.x', '1.0.0');
    await client.testSets.versions.unregister('testSet.x', '1.0.0');
    await client.testSets.versions.reinstate('testSet.x', '1.0.0');
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/test-sets',
      'GET /v1/test-sets',
      'GET /v1/test-sets/testSet.x',
      'GET /v1/test-sets/testSet.x/versions',
      'GET /v1/test-sets/testSet.x/versions/1.0.0',
      'POST /v1/test-sets/testSet.x/versions/1.0.0/unregister',
      'POST /v1/test-sets/testSet.x/versions/1.0.0/reinstate',
    ]);
  });
});

describe("an agent's own test set id (`agent.`)", () => {
  it('is refused before a request is sent, with the words the API answers', async () => {
    const stub = recordingFetch([]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const id = 'agent.acme.desk.p1';
    const message = `Test set ids starting \`agent.\` are agents' own test sets, and only a test run or a suggested change's check makes their versions. Publish "${id}" under another id.`;

    await expect(
      client.testSets.publish({ ...PUBLISH_BODY, id }, { projectId: 'proj-1' }),
    ).rejects.toMatchObject({
      name: 'KindgiApiError',
      error: { code: 'invalid-request', message, issues: [{ path: '/id' }] },
    });
    await expect(
      client.testSets.buildFromCorrections(id, { version: '1.0.0', projectId: 'proj-1' } as never),
    ).rejects.toMatchObject({
      error: { code: 'invalid-request', message, issues: [{ path: '/testSetId' }] },
    });
    expect(stub.calls).toEqual([]);
  });
});

describe('testSets.publish — projectId (POST /v1/test-sets requires it)', () => {
  it('sends options.projectId in the body next to the test set fields', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ testSetId: 'testSet.x', version: '1.0.0' }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const testSet = {
      id: 'testSet.x',
      version: '1.0.0',
      kind: 'accuracy' as const,
      description: 'Citation accuracy',
      spec: { cases: [] },
    };

    await client.testSets.publish(testSet, { projectId: 'proj-1', idempotencyKey: 'idem-s' });

    const req = stub.calls[0]!;
    expect(`${req.method} ${new URL(req.url).pathname}`).toBe('POST /v1/test-sets');
    expect(req.headers['idempotency-key']).toBe('idem-s');
    expect(JSON.parse(req.body ?? '{}')).toEqual({ ...testSet, projectId: 'proj-1' });
  });
});

describe('testSets.buildFromCorrections and listCases', () => {
  it('POSTs the build body with the Idempotency-Key and returns the result', async () => {
    const result = {
      testSetId: 'acme.matches',
      version: '1.0.0',
      kind: 'corrections',
      caseCount: 2,
      truncated: false,
    };
    const stub = recordingFetch([{ status: 201, body: JSON.stringify(result) }]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const body = {
      version: '1.0.0',
      projectId: 'proj-1',
      agentId: 'acme.matcher',
      agentVersion: '2.0.0',
      correctorGroupIds: ['jc-1'],
      minCorrections: 2,
    };

    const out = await client.testSets.buildFromCorrections('acme.matches', body, {
      idempotencyKey: 'idem-b',
    });

    expect(out).toEqual(result);
    const req = stub.calls[0]!;
    expect(`${req.method} ${new URL(req.url).pathname}`).toBe(
      'POST /v1/test-sets/acme.matches/versions/from-corrections',
    );
    expect(req.headers['idempotency-key']).toBe('idem-b');
    expect(JSON.parse(req.body ?? '{}')).toEqual(body);
  });

  it("GETs a version's cases with limit and cursor", async () => {
    const page = { data: [], hasMore: false };
    const stub = recordingFetch([{ status: 200, body: JSON.stringify(page) }]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });

    const out = await client.testSets.listCases('acme.matches', '1.0.0', {
      limit: 10,
      cursor: 'c1',
    });

    expect(out).toEqual(page);
    const url = new URL(stub.calls[0]!.url);
    expect(stub.calls[0]!.method).toBe('GET');
    expect(url.pathname).toBe('/v1/test-sets/acme.matches/versions/1.0.0/cases');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('cursor')).toBe('c1');
  });
});
