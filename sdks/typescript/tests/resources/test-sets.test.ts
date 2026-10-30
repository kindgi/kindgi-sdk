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

describe('testSets.listCases', () => {
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
