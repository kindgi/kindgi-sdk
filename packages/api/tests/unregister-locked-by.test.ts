// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The tool and agent unregister answers' `lockedBy`: what can still run the
 * version, when the deployment wires `versionLocks`. Without it, or when
 * its read fails, the answer has no `lockedBy`, and the version is
 * unregistered either way.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { createLogger } from '@kindgi/log';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
  ToolRegistryBinding,
  VersionLock,
  VersionLocksBinding,
  VersionLocksInput,
} from '../src/index.js';
import { validateAgainst } from './support/openapi-schema.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'unregister-locked-by-token';

const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const runHandler = {} as RunHandlerBinding;

// Only what the unregister routes call.
const tools = {
  unregister: async () => ({ unregistered: true }),
} as unknown as ToolRegistryBinding;
const agents = {
  unregister: async () => ({ unregistered: true }),
} as unknown as AgentRegistryBinding;

const LOCKS: readonly VersionLock[] = [
  { kind: 'agent', id: 'acme.triage', version: '1.2.0' },
  { kind: 'agent', id: 'acme.triage', version: '1.3.0', unregistered: true },
  { kind: 'flow', id: 'acme.desk', version: '2.0.0' },
];

function harness(versionLocks?: VersionLocksBinding) {
  const logLines: string[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    logger: createLogger({ write: (line) => logLines.push(line) }),
    resolveToken,
    runHandler,
    toolRegistry: tools,
    agentRegistry: agents,
    ...(versionLocks !== undefined && { versionLocks }),
  });
  const unregister = async (path: string) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { unregister, logLines };
}

function recording(answer: readonly VersionLock[]) {
  const asked: VersionLocksInput[] = [];
  const binding: VersionLocksBinding = {
    lockedBy: async (input) => {
      asked.push(input);
      return answer;
    },
  };
  return { binding, asked };
}

describe('POST /v1/tools/:toolId/versions/:version/unregister: lockedBy', () => {
  const path = '/v1/tools/acme.score/versions/1.0.0/unregister';

  test('lists what locks the version, as the binding answers it', async () => {
    const { binding, asked } = recording(LOCKS);
    const { status, body } = await harness(binding).unregister(path);
    expect(status).toBe(200);
    expect(body).toEqual({
      toolId: 'acme.score',
      version: '1.0.0',
      unregistered: true,
      lockedBy: LOCKS,
    });
    expect(asked).toEqual([{ tenantId, kind: 'tool', id: 'acme.score', version: '1.0.0' }]);
    expect(validateAgainst('UnregisterToolResult', body)).toEqual([]);
  });

  test('says [] when nothing locks it', async () => {
    const { body } = await harness(recording([]).binding).unregister(path);
    expect(body.lockedBy).toEqual([]);
    expect(validateAgainst('UnregisterToolResult', body)).toEqual([]);
  });

  test('carries only the wire fields of each lock', async () => {
    const extra = [
      { ...LOCKS[0], projectId: 'p-1', unregistered: undefined },
    ] as unknown as VersionLock[];
    const { body } = await harness(recording(extra).binding).unregister(path);
    expect(body.lockedBy).toEqual([{ kind: 'agent', id: 'acme.triage', version: '1.2.0' }]);
    expect(validateAgainst('UnregisterToolResult', body)).toEqual([]);
  });

  test('without versionLocks, the answer has no lockedBy', async () => {
    const { status, body } = await harness().unregister(path);
    expect(status).toBe(200);
    expect(body).toEqual({ toolId: 'acme.score', version: '1.0.0', unregistered: true });
  });

  test("a read that fails leaves lockedBy out, and logs the error's name only", async () => {
    const failing: VersionLocksBinding = {
      lockedBy: async () => {
        throw new TypeError('connection to db-7.internal refused');
      },
    };
    const { unregister, logLines } = harness(failing);
    const { status, body } = await unregister(path);
    expect(status).toBe(200);
    expect(body).toEqual({ toolId: 'acme.score', version: '1.0.0', unregistered: true });
    const line = logLines.find((l) => l.includes('What locks an unregistered version'));
    expect(line).toBeDefined();
    expect(line).toContain('TypeError');
    expect(line).not.toContain('db-7.internal');
  });
});

describe('POST /v1/agents/:agentId/versions/:version/unregister: lockedBy', () => {
  const path = '/v1/agents/acme.triage/versions/1.2.0/unregister';
  const flowLocks: readonly VersionLock[] = [{ kind: 'flow', id: 'acme.desk', version: '2.0.0' }];

  test('lists what locks the version, as the binding answers it', async () => {
    const { binding, asked } = recording(flowLocks);
    const { status, body } = await harness(binding).unregister(path);
    expect(status).toBe(200);
    expect(body).toEqual({
      agentId: 'acme.triage',
      version: '1.2.0',
      unregistered: true,
      lockedBy: flowLocks,
    });
    expect(asked).toEqual([{ tenantId, kind: 'agent', id: 'acme.triage', version: '1.2.0' }]);
    expect(validateAgainst('UnregisterAgentResult', body)).toEqual([]);
  });

  test('without versionLocks, the answer has no lockedBy', async () => {
    const { body } = await harness().unregister(path);
    expect(body).toEqual({ agentId: 'acme.triage', version: '1.2.0', unregistered: true });
  });

  test('a read that fails leaves lockedBy out', async () => {
    const failing: VersionLocksBinding = {
      lockedBy: async () => {
        throw new Error('down');
      },
    };
    const { status, body } = await harness(failing).unregister(path);
    expect(status).toBe(200);
    expect(body).toEqual({ agentId: 'acme.triage', version: '1.2.0', unregistered: true });
  });
});

describe('the spec', () => {
  const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as {
    components: {
      schemas: Record<
        string,
        { required?: readonly string[]; properties?: Record<string, unknown> }
      >;
    };
  };

  test.each(['UnregisterToolResult', 'UnregisterAgentResult'])(
    '%s has lockedBy, and does not require it',
    (name) => {
      const schema = spec.components.schemas[name];
      expect(schema?.properties?.lockedBy).toMatchObject({
        type: 'array',
        items: { $ref: '#/components/schemas/VersionLock' },
      });
      expect(schema?.required).not.toContain('lockedBy');
    },
  );

  test('a lock names only an agent or a flow', () => {
    expect(
      validateAgainst('VersionLock', { kind: 'tool', id: 'acme.score', version: '1.0.0' }),
    ).not.toEqual([]);
    expect(
      validateAgainst('VersionLock', { kind: 'flow', id: 'acme.desk', version: '2.0.0' }),
    ).toEqual([]);
  });
});
