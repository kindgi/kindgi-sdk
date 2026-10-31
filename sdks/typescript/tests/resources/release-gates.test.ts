// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Release gates and gated pins: what each call sends, and a refusal. */

import { describe, expect, it } from 'vitest';

import { KindgiApiError, type KindgiClient, createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const API = 'https://api.example.com';
const PROJECT = '00000000-0000-4000-8000-0000000000aa';
const RELEASE_GATE = {
  id: 'acme.drafting-prod',
  version: '1.0.0',
  agentId: 'acme.drafting',
  scope: { kind: 'project', projectId: PROJECT },
  spec: { metrics: [{ name: 'passRate', minCandidate: 0.7 }] },
  createdAt: '2026-10-06T12:00:00.000Z',
} as const;

async function sent(answer: unknown, call: (c: KindgiClient) => Promise<unknown>) {
  const stub = jsonFetch(answer);
  const client = createClient({
    apiUrl: API,
    auth: { kind: 'apiToken', token: 't' },
    fetch: stub.fetch,
  });
  const result = await call(client);
  const req = stub.calls[0];
  return { result, method: req?.method, url: req?.url, body: req?.body };
}

describe('releaseGates', () => {
  it.each([
    [
      'list',
      (c: KindgiClient) =>
        c.releaseGates.list({
          agentId: 'acme.drafting',
          scope: { kind: 'project', projectId: PROJECT },
        }),
      'GET',
      `/v1/release-gates?agentId=acme.drafting&scopeKind=project&scopeId=${PROJECT}`,
    ],
    [
      'get',
      (c: KindgiClient) => c.releaseGates.get('acme.drafting-prod'),
      'GET',
      '/v1/release-gates/acme.drafting-prod',
    ],
    [
      'versions.list',
      (c: KindgiClient) => c.releaseGates.versions.list('acme.drafting-prod'),
      'GET',
      '/v1/release-gates/acme.drafting-prod/versions',
    ],
    [
      'versions.get',
      (c: KindgiClient) => c.releaseGates.versions.get('acme.drafting-prod', '1.0.0'),
      'GET',
      '/v1/release-gates/acme.drafting-prod/versions/1.0.0',
    ],
    [
      'versions.unregister',
      (c: KindgiClient) => c.releaseGates.versions.unregister('acme.drafting-prod', '1.0.0'),
      'POST',
      '/v1/release-gates/acme.drafting-prod/versions/1.0.0/unregister',
    ],
    [
      'versions.reinstate',
      (c: KindgiClient) => c.releaseGates.versions.reinstate('acme.drafting-prod', '1.0.0'),
      'POST',
      '/v1/release-gates/acme.drafting-prod/versions/1.0.0/reinstate',
    ],
  ] as const)('%s → %s %s', async (_name, call, method, path) => {
    const req = await sent({ ...RELEASE_GATE, data: [], hasMore: false }, call);
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${API}${path}`);
  });

  it('publish sends the release gate', async () => {
    const { method, url, body } = await sent(RELEASE_GATE, (c) =>
      c.releaseGates.publish({
        id: RELEASE_GATE.id,
        version: RELEASE_GATE.version,
        agentId: RELEASE_GATE.agentId,
        scope: RELEASE_GATE.scope,
        spec: RELEASE_GATE.spec,
      } as never),
    );
    expect([method, url]).toEqual(['POST', `${API}/v1/release-gates`]);
    expect(JSON.parse(body as string)).toMatchObject({
      id: RELEASE_GATE.id,
      spec: RELEASE_GATE.spec,
    });
  });
});

describe('gated pins', () => {
  const input = {
    version: '1.2.0',
    scope: { kind: 'project', projectId: PROJECT },
    testRunId: 'eval-1',
  } as const;

  it('agents.pinned.check posts the same body to …/pinned/check', async () => {
    const answer = {
      outcome: 'needs-approval',
      releaseGate: { id: RELEASE_GATE.id, version: '1.0.0' },
      checks: [],
    };
    const { result, method, url, body } = await sent(answer, (c) =>
      c.agents.pinned.check('acme.drafting', input as never),
    );
    expect([method, url]).toEqual(['POST', `${API}/v1/agents/acme.drafting/pinned/check`]);
    expect(JSON.parse(body as string)).toEqual(input);
    expect(result).toEqual(answer);
  });

  it('agents.releaseGate.resolve asks for a scope', async () => {
    const segment = {
      kind: 'segment',
      projectId: PROJECT,
      path: [{ key: 'company', value: 'acme' }],
    } as const;
    const { url } = await sent({ releaseGate: null }, (c) =>
      c.agents.releaseGate.resolve('acme.drafting', segment),
    );
    expect(url).toBe(
      `${API}/v1/agents/acme.drafting/release-gate?scopeKind=segment&scopeId=${PROJECT}&segment=company%3Aacme`,
    );
  });

  it('a refused pin throws gate-failed, with the checks', async () => {
    const checks = [{ name: 'metric.passRate.minCandidate', passed: false, message: 'too low' }];
    const stub = recordingFetch([
      {
        status: 422,
        body: JSON.stringify({
          error: {
            code: 'gate-failed',
            message: 'The release gate refused acme.drafting 1.2.0: too low',
            details: {
              changeId: 'promo-1',
              releaseGate: { id: RELEASE_GATE.id, version: '1.0.0' },
              checks,
            },
            requestId: 'req-1',
          },
        }),
      },
    ]);
    const client = createClient({
      apiUrl: API,
      auth: { kind: 'apiToken', token: 't' },
      fetch: stub.fetch,
    });
    const failure = await client.agents.pinned
      .pin('acme.drafting', input as never)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(KindgiApiError);
    expect((failure as KindgiApiError).error).toMatchObject({
      code: 'server',
      serverCode: 'gate-failed',
      fields: { changeId: 'promo-1', checks },
    });
  });
});
