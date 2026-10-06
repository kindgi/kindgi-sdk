// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * One name for a version's calls on every resource: `X.versions.list /
 * get / unregister / reinstate` (and `policies.publish`). Each old name
 * still works, deprecated, and sends the same request.
 */

import { describe, expect, it } from 'vitest';

import { type KindgiClient, createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const API = 'https://api.example.com';

/** What `call` sends, answered with `body`. */
async function request(body: unknown, call: (client: KindgiClient) => Promise<unknown>) {
  const stub = recordingFetch([{ status: 200, body: JSON.stringify(body) }]);
  const client = createClient({
    apiUrl: API,
    auth: { kind: 'apiToken', token: 't' },
    fetch: stub.fetch,
  });
  const result = await call(client);
  const sent = stub.calls[0];
  return {
    result,
    sent: { method: sent?.method, url: sent?.url, body: sent?.body },
  };
}

const PAGE = { data: [], hasMore: false };
const TOOL_UNREGISTERED = { toolId: 'acme.lookup', version: '1.0.0', unregistered: true };
const TOOL_REINSTATED = { toolId: 'acme.lookup', version: '1.0.0', wasTombstoned: true };
const FLOW_UNREGISTERED = { flowId: 'acme.intake', version: '1.0.0', unregistered: true };
const FLOW_REINSTATED = { flowId: 'acme.intake', version: '1.0.0', wasTombstoned: true };
const AGENT_REINSTATED = { agentId: 'acme.drafter', version: '1.0.0', wasTombstoned: true };
const POLICY_SPEC = { id: 'acme.keep-90d', version: '1.0.0', domain: 'run', mode: 'tombstone' };

const CASES: readonly {
  readonly name: string;
  readonly deprecated: string;
  readonly answer: unknown;
  readonly method: string;
  readonly path: string;
  readonly call: (c: KindgiClient) => Promise<unknown>;
  readonly old: (c: KindgiClient) => Promise<unknown>;
}[] = [
  {
    name: 'agents.versions.reinstate',
    deprecated: 'agents.reinstateVersion',
    answer: AGENT_REINSTATED,
    method: 'POST',
    path: '/v1/agents/acme.drafter/versions/1.0.0/reinstate',
    call: (c) => c.agents.versions.reinstate('acme.drafter' as never, '1.0.0' as never),
    old: (c) => c.agents.reinstateVersion('acme.drafter' as never, '1.0.0' as never),
  },
  {
    name: 'tools.versions.list',
    deprecated: 'tools.listVersions',
    answer: PAGE,
    method: 'GET',
    path: '/v1/tools/acme.lookup/versions?limit=5',
    call: (c) => c.tools.versions.list('acme.lookup' as never, { limit: 5 }),
    old: (c) => c.tools.listVersions('acme.lookup' as never, { limit: 5 }),
  },
  {
    name: 'tools.versions.get',
    deprecated: 'tools.getVersion',
    answer: { id: 'acme.lookup', version: '1.0.0' },
    method: 'GET',
    path: '/v1/tools/acme.lookup/versions/1.0.0',
    call: (c) => c.tools.versions.get('acme.lookup' as never, '1.0.0'),
    old: (c) => c.tools.getVersion('acme.lookup' as never, '1.0.0'),
  },
  {
    name: 'tools.versions.unregister',
    deprecated: 'tools.unregisterVersion',
    answer: TOOL_UNREGISTERED,
    method: 'POST',
    path: '/v1/tools/acme.lookup/versions/1.0.0/unregister',
    call: (c) => c.tools.versions.unregister('acme.lookup' as never, '1.0.0'),
    old: (c) => c.tools.unregisterVersion('acme.lookup' as never, '1.0.0'),
  },
  {
    name: 'tools.versions.reinstate',
    deprecated: 'tools.reinstateVersion',
    answer: TOOL_REINSTATED,
    method: 'POST',
    path: '/v1/tools/acme.lookup/versions/1.0.0/reinstate',
    call: (c) => c.tools.versions.reinstate('acme.lookup' as never, '1.0.0'),
    old: (c) => c.tools.reinstateVersion('acme.lookup' as never, '1.0.0'),
  },
  {
    name: 'flows.versions.list',
    deprecated: 'flows.versions(id)',
    answer: PAGE,
    method: 'GET',
    path: '/v1/flows/acme.intake/versions',
    call: (c) => c.flows.versions.list('acme.intake' as never),
    old: (c) => c.flows.versions('acme.intake' as never),
  },
  {
    name: 'flows.versions.get',
    deprecated: 'flows.getVersion',
    answer: { id: 'acme.intake', version: '1.0.0', nodes: [], edges: [] },
    method: 'GET',
    path: '/v1/flows/acme.intake/versions/1.0.0',
    call: (c) => c.flows.versions.get('acme.intake' as never, '1.0.0'),
    old: (c) => c.flows.getVersion('acme.intake' as never, '1.0.0'),
  },
  {
    name: 'flows.versions.unregister',
    deprecated: 'flows.delete',
    answer: FLOW_UNREGISTERED,
    method: 'POST',
    path: '/v1/flows/acme.intake/versions/1.0.0/unregister',
    call: (c) => c.flows.versions.unregister('acme.intake' as never, '1.0.0'),
    old: (c) => c.flows.delete('acme.intake' as never, '1.0.0'),
  },
  {
    name: 'flows.versions.reinstate',
    deprecated: 'flows.reinstateVersion',
    answer: FLOW_REINSTATED,
    method: 'POST',
    path: '/v1/flows/acme.intake/versions/1.0.0/reinstate',
    call: (c) => c.flows.versions.reinstate('acme.intake' as never, '1.0.0'),
    old: (c) => c.flows.reinstateVersion('acme.intake' as never, '1.0.0'),
  },
  {
    name: 'policies.publish',
    deprecated: 'policies.author',
    answer: { policyId: 'acme.keep-90d', version: '1.0.0' },
    method: 'POST',
    path: '/v1/policies',
    call: (c) => c.policies.publish(POLICY_SPEC as never),
    old: (c) => c.policies.author(POLICY_SPEC as never),
  },
];

describe.each(CASES)('$name', (t) => {
  it(`sends ${t.method} ${t.path}`, async () => {
    const { sent } = await request(t.answer, t.call);
    expect(sent.method).toBe(t.method);
    expect(sent.url).toBe(`${API}${t.path}`);
  });

  it(`the deprecated ${t.deprecated} sends the same request`, async () => {
    const now = await request(t.answer, t.call);
    const before = await request(t.answer, t.old);
    expect(before.sent).toEqual(now.sent);
  });
});

describe('what the new calls answer', () => {
  it('flows.versions.unregister returns the result that flows.delete dropped', async () => {
    const { result } = await request(FLOW_UNREGISTERED, (c) =>
      c.flows.versions.unregister('acme.intake' as never, '1.0.0'),
    );
    expect(result).toEqual(FLOW_UNREGISTERED);
  });

  it('agents.versions.reinstate says whether the version was tombstoned', async () => {
    const { result } = await request(AGENT_REINSTATED, (c) =>
      c.agents.versions.reinstate('acme.drafter' as never, '1.0.0' as never),
    );
    expect(result).toEqual(AGENT_REINSTATED);
  });
});
