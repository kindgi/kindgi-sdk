// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Gate policies and gated promotions (evals step 4b): what each call sends, and a refusal. */

import { describe, expect, it } from 'vitest';

import { KindgiApiError, type KindgiClient, createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const API = 'https://api.example.com';
const PROJECT = '00000000-0000-4000-8000-0000000000aa';
const POLICY = {
  id: 'acme.drafting-prod',
  version: '1.0.0',
  agentId: 'acme.drafting',
  scope: { kind: 'project', projectId: PROJECT },
  spec: { metrics: [{ name: 'weightedYesShare', minCandidate: 0.7 }] },
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

describe('gatePolicies', () => {
  it.each([
    [
      'list',
      (c: KindgiClient) =>
        c.gatePolicies.list({
          agentId: 'acme.drafting',
          scope: { kind: 'project', projectId: PROJECT },
        }),
      'GET',
      `/v1/gate-policies?agentId=acme.drafting&scopeKind=project&scopeId=${PROJECT}`,
    ],
    [
      'get',
      (c: KindgiClient) => c.gatePolicies.get('acme.drafting-prod'),
      'GET',
      '/v1/gate-policies/acme.drafting-prod',
    ],
    [
      'versions.list',
      (c: KindgiClient) => c.gatePolicies.versions.list('acme.drafting-prod'),
      'GET',
      '/v1/gate-policies/acme.drafting-prod/versions',
    ],
    [
      'versions.get',
      (c: KindgiClient) => c.gatePolicies.versions.get('acme.drafting-prod', '1.0.0'),
      'GET',
      '/v1/gate-policies/acme.drafting-prod/versions/1.0.0',
    ],
    [
      'versions.unregister',
      (c: KindgiClient) => c.gatePolicies.versions.unregister('acme.drafting-prod', '1.0.0'),
      'POST',
      '/v1/gate-policies/acme.drafting-prod/versions/1.0.0/unregister',
    ],
    [
      'versions.reinstate',
      (c: KindgiClient) => c.gatePolicies.versions.reinstate('acme.drafting-prod', '1.0.0'),
      'POST',
      '/v1/gate-policies/acme.drafting-prod/versions/1.0.0/reinstate',
    ],
  ] as const)('%s → %s %s', async (_name, call, method, path) => {
    const req = await sent({ ...POLICY, data: [], hasMore: false }, call);
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${API}${path}`);
  });

  it('publish sends the policy', async () => {
    const { method, url, body } = await sent(POLICY, (c) =>
      c.gatePolicies.publish({
        id: POLICY.id,
        version: POLICY.version,
        agentId: POLICY.agentId,
        scope: POLICY.scope,
        spec: POLICY.spec,
      } as never),
    );
    expect([method, url]).toEqual(['POST', `${API}/v1/gate-policies`]);
    expect(JSON.parse(body as string)).toMatchObject({ id: POLICY.id, spec: POLICY.spec });
  });
});

describe('gated promotions', () => {
  const input = {
    version: '1.2.0',
    scope: { kind: 'project', projectId: PROJECT },
    evalRunId: 'eval-1',
  } as const;

  it('agents.promotions.check posts the same body to …/promotions/check', async () => {
    const answer = {
      outcome: 'needs-approval',
      policy: { id: POLICY.id, version: '1.0.0' },
      checks: [],
    };
    const { result, method, url, body } = await sent(answer, (c) =>
      c.agents.promotions.check('acme.drafting', input as never),
    );
    expect([method, url]).toEqual(['POST', `${API}/v1/agents/acme.drafting/promotions/check`]);
    expect(JSON.parse(body as string)).toEqual(input);
    expect(result).toEqual(answer);
  });

  it('agents.gatePolicy.resolve asks for a scope', async () => {
    const segment = {
      kind: 'segment',
      projectId: PROJECT,
      path: [{ key: 'company', value: 'acme' }],
    } as const;
    const { url } = await sent({ policy: null }, (c) =>
      c.agents.gatePolicy.resolve('acme.drafting', segment),
    );
    expect(url).toBe(
      `${API}/v1/agents/acme.drafting/gate-policy?scopeKind=segment&scopeId=${PROJECT}&segment=company%3Aacme`,
    );
  });

  it('a refused promotion throws gate-failed, with the checks', async () => {
    const checks = [
      { name: 'metric.weightedYesShare.minCandidate', passed: false, message: 'too low' },
    ];
    const stub = recordingFetch([
      {
        status: 422,
        body: JSON.stringify({
          error: {
            code: 'gate-failed',
            message: 'The gate refused acme.drafting 1.2.0: too low',
            details: {
              promotionId: 'promo-1',
              policy: { id: POLICY.id, version: '1.0.0' },
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
    const failure = await client.agents.promotions
      .create('acme.drafting', input as never)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(KindgiApiError);
    expect((failure as KindgiApiError).error).toMatchObject({
      code: 'server',
      serverCode: 'gate-failed',
      fields: { promotionId: 'promo-1', checks },
    });
  });
});
