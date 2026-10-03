// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_SUITE = {
  id: 'suite.x',
  tenantId: '00000000-0000-4000-8000-000000000002',
  version: '1.0.0',
  kind: 'accuracy',
  spec: {},
};

/** A `POST /v1/eval-suites` body without its `projectId` (sent via options). */
const PUBLISH_BODY = {
  id: 'suite.x',
  version: '1.0.0',
  kind: 'accuracy' as const,
  spec: {},
};

describe('eval-suites — wire round-trips', () => {
  it('publish/list/get + versions.{list,get,unregister,reinstate}', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ suiteId: 'suite.x', version: '1.0.0' }) },
      { status: 200, body: JSON.stringify({ data: [SAMPLE_SUITE], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_SUITE) },
      { status: 200, body: JSON.stringify({ data: [SAMPLE_SUITE], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_SUITE) },
      { status: 200, body: JSON.stringify({ unregistered: true }) },
      { status: 200, body: JSON.stringify({ reinstated: true }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.evalSuites.publish(PUBLISH_BODY, { projectId: 'proj-1' });
    await client.evalSuites.list({ kind: 'accuracy' });
    await client.evalSuites.get('suite.x');
    await client.evalSuites.versions.list('suite.x');
    await client.evalSuites.versions.get('suite.x', '1.0.0');
    await client.evalSuites.versions.unregister('suite.x', '1.0.0');
    await client.evalSuites.versions.reinstate('suite.x', '1.0.0');
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/eval-suites',
      'GET /v1/eval-suites',
      'GET /v1/eval-suites/suite.x',
      'GET /v1/eval-suites/suite.x/versions',
      'GET /v1/eval-suites/suite.x/versions/1.0.0',
      'POST /v1/eval-suites/suite.x/versions/1.0.0/unregister',
      'POST /v1/eval-suites/suite.x/versions/1.0.0/reinstate',
    ]);
  });
});

describe('evalSuites.publish — projectId (POST /v1/eval-suites requires it)', () => {
  it('sends options.projectId in the body next to the suite fields', async () => {
    const stub = recordingFetch([
      { status: 201, body: JSON.stringify({ suiteId: 'suite.x', version: '1.0.0' }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const suite = {
      id: 'suite.x',
      version: '1.0.0',
      kind: 'accuracy' as const,
      description: 'Citation accuracy',
      spec: { cases: [] },
    };

    await client.evalSuites.publish(suite, { projectId: 'proj-1', idempotencyKey: 'idem-s' });

    const req = stub.calls[0]!;
    expect(`${req.method} ${new URL(req.url).pathname}`).toBe('POST /v1/eval-suites');
    expect(req.headers['idempotency-key']).toBe('idem-s');
    expect(JSON.parse(req.body ?? '{}')).toEqual({ ...suite, projectId: 'proj-1' });
  });
});
