// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Content lists hold only what the caller may read (T243 A): agents,
 * flows, tools, guardrails, eval suites and MCP endpoints are filtered
 * by `read` on each row's object, as `GET …/:id` asks. With no grants,
 * every list is empty, having asked about every row.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-lists';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

/** A registry whose `list` answers two rows; nothing else is reached. */
function listing(rows: readonly Record<string, string>[]) {
  return new Proxy(
    {},
    {
      get: (_t, name) =>
        name === 'list'
          ? async () => ({ data: rows, items: rows })
          : async () => {
              throw new Error(`${String(name)} is not reached in this test`);
            },
    },
  ) as never;
}

function harness() {
  const asked: string[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => {
    asked.push(`${action} ${r.type}:${r.id}`);
    return {
      allowed: false,
      reason: 'test: no grants',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const two = [{ id: 'acme.one' }, { id: 'acme.two' }];
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    agentRegistry: listing(two),
    flowRegistry: listing(two),
    toolRegistry: listing(two),
    guardrailRegistry: listing(two),
    evalSuiteRegistry: listing(two),
    mcpEndpointRegistry: listing([{ endpointId: 'acme.one' }, { endpointId: 'acme.two' }]),
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, r) => decide(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  return { app, asked };
}

describe('content lists hold only what the caller may read', () => {
  test.each([
    ['/v1/agents', 'agent'],
    ['/v1/flows', 'flow'],
    ['/v1/tools', 'tool'],
    ['/v1/guardrails', 'guardrail'],
    ['/v1/eval-suites', 'eval_suite'],
    ['/v1/mcp/endpoints', 'mcp_endpoint'],
  ])('GET %s asks read on each %s', async (path, type) => {
    const { app, asked } = harness();
    const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
    expect(asked).toEqual([`read ${type}:acme.one`, `read ${type}:acme.two`]);
  });
});
