// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A registry that takes no writes (under `kindgi dev`, the pack's files
 * are the source) sets `readOnly` on its binding: every write is refused
 * with `409 registry-read-only` and the binding's reason, before the
 * binding is called; never `already-registered`, never a "next free
 * version". Reads go on as before.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  FlowRegistryBinding,
  GuardrailRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
  ToolRegistryBinding,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'read-only-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const REASON = {
  agents: "Under kindgi dev, the pack is the source of agents: edit the pack's file.",
  tools: "Under kindgi dev, the pack is the source of tools: edit the pack's file.",
  flows: "Under kindgi dev, the pack is the source of flows: edit the pack's file.",
  guardrails: "Under kindgi dev, the pack is the source of guardrails: edit the pack's file.",
};

/** A binding whose reads answer empty and whose every other method fails the test if called. */
function readOnlyBinding<T>(reason: string, calls: string[]): T {
  const reads = new Set(['list', 'get', 'getVersion', 'listVersions', 'headExists', 'resolve']);
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'readOnly') return { reason };
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return async () => {
        calls.push(prop);
        if (reads.has(prop))
          return prop === 'list' || prop === 'listVersions' ? { data: [] } : null;
        throw new Error(`a read-only registry was asked to ${prop}`);
      };
    },
  }) as T;
}

function harness() {
  const calls: string[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    agentRegistry: readOnlyBinding<AgentRegistryBinding>(REASON.agents, calls),
    toolRegistry: readOnlyBinding<ToolRegistryBinding>(REASON.tools, calls),
    flowRegistry: readOnlyBinding<FlowRegistryBinding>(REASON.flows, calls),
    guardrailRegistry: readOnlyBinding<GuardrailRegistryBinding>(REASON.guardrails, calls),
  });
  const call = async (method: string, path: string, body: unknown = {}) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(method !== 'GET' && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, calls };
}

const WRITES: readonly (readonly [keyof typeof REASON, string])[] = [
  ['agents', '/v1/agents'],
  ['agents', '/v1/agents/acme.intake/versions'],
  ['agents', '/v1/agents/acme.intake/versions/1.0.0/unregister'],
  ['agents', '/v1/agents/acme.intake/versions/1.0.0/reinstate'],
  ['tools', '/v1/tools'],
  ['tools', '/v1/tools/acme.lookup/versions/1.0.0/unregister'],
  ['tools', '/v1/tools/acme.lookup/versions/1.0.0/reinstate'],
  ['flows', '/v1/flows'],
  ['flows', '/v1/flows/acme.triage/versions/1.0.0/unregister'],
  ['flows', '/v1/flows/acme.triage/versions/1.0.0/reinstate'],
  ['guardrails', '/v1/guardrails'],
  ['guardrails', '/v1/guardrails/acme.must-cite/unregister'],
];

describe('a write to a read-only registry', () => {
  test.each(WRITES)(
    '%s: POST %s is refused with the reason, and the store is never called',
    async (kind, path) => {
      const { call, calls } = harness();
      const res = await call('POST', path, {
        id: 'acme.x',
        version: '1.0.0',
        from: '1.0.0',
        pins: {},
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'registry-read-only', message: REASON[kind] });
      expect(JSON.stringify(res.body)).not.toMatch(/already registered|next free version/);
      expect(calls).toEqual([]);
    },
  );

  test('reads go on as before', async () => {
    const { call } = harness();
    for (const path of ['/v1/agents', '/v1/tools', '/v1/flows', '/v1/guardrails']) {
      expect((await call('GET', path)).status, path).toBe(200);
    }
  });
});
