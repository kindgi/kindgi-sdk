// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { createAgentRegistry, defineAgent } from '@kindgi/agents';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  AgentOwner,
  AgentRegistryBinding,
  AgentSetOwnerInput,
  CreateAppInput,
  IdentityDirectoryBinding,
  TokenResolver,
  UserRecord,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'agent-owner-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const ANA = 'user-ana' as UserId;
const BEN = 'user-ben' as UserId;
const GONE = 'user-gone' as UserId;

/** The tenant's people: Ana and Ben, and someone who has left. */
const directory = {
  async getUser({ userId }: { userId: UserId }): Promise<UserRecord | null> {
    const base = { userId, tenantId, createdAt: '2026-10-01T00:00:00.000Z' } as UserRecord;
    if (userId === ANA) return { ...base, displayName: 'Ana Ortiz' };
    if (userId === BEN) return base;
    if (userId === GONE)
      return { ...base, unregisteredAt: '2026-10-20T00:00:00.000Z' } as UserRecord;
    return null;
  },
} as unknown as IdentityDirectoryBinding;

/** An in-memory registry with one agent, `acme.returns`, and an owner it keeps. */
function makeBinding(withOwner = true): {
  binding: AgentRegistryBinding;
  calls: AgentSetOwnerInput[];
} {
  const registry = createAgentRegistry();
  const defined = defineAgent({
    id: 'acme.returns',
    version: '1.0.0',
    name: 'Returns helper',
    instructions: 'Answer questions about returns.',
    capabilities: [{ needs: [{ feature: 'structured-output' as const }] }],
    tools: [{ id: 'orders.lookup', version: '1.0.0' }],
    retrieval: [{ types: ['order'], scope: 'same-conversation' as const }],
    guardrails: ['no-fabricated-quotes'],
  });
  if (defined.kind === 'err') throw new Error(defined.error.message);
  registry.register(defined.value);
  let owner: AgentOwner | undefined;
  const calls: AgentSetOwnerInput[] = [];
  const binding: AgentRegistryBinding = {
    async list() {
      return { data: [] };
    },
    async get({ agentId }) {
      const got = registry.getLatest(agentId);
      if (got.kind !== 'ok') return null;
      return { ...got.value, ...(owner !== undefined && { owner }) };
    },
    async getVersion() {
      return null;
    },
    async headExists({ agentId }) {
      return registry.getLatest(agentId).kind === 'ok';
    },
    async listVersions() {
      return { data: [] };
    },
    async publish({ agent }) {
      return { kind: 'ok', agentId: agent.id, version: agent.version };
    },
    async unregister() {
      return { unregistered: false };
    },
    async reinstateVersion({ agentId, version }) {
      return { kind: 'not-found', agentId, version };
    },
    ...(withOwner && {
      async setOwner(input: AgentSetOwnerInput) {
        calls.push(input);
        if (registry.getLatest(input.agentId).kind !== 'ok') return { kind: 'not-found' as const };
        owner = {
          userId: input.userId,
          ...(input.setBy !== undefined && { setBy: input.setBy }),
          setAt: '2026-10-30T09:00:00.000Z',
        };
        return { kind: 'set' as const, owner };
      },
    }),
  };
  return { binding, calls };
}

function makeApp(opts: { withOwner?: boolean; withDirectory?: boolean } = {}) {
  const { binding, calls } = makeBinding(opts.withOwner ?? true);
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    agentRegistry: binding,
    ...((opts.withDirectory ?? true) && { identityDirectory: directory }),
  } as unknown as CreateAppInput);
  return { app, calls };
}

const auth = { authorization: `Bearer ${TOKEN}` };
/** A response body, read as JSON. */
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const put = (app: ReturnType<typeof makeApp>['app'], agentId: string, body: unknown) =>
  app.request(`/v1/agents/${agentId}/owner`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe("PUT /v1/agents/:agentId/owner: the agent's owner", () => {
  test('sets the owner, and GET answers it with the name the directory has', async () => {
    const { app, calls } = makeApp();
    const res = await put(app, 'acme.returns', { userId: ANA });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      agentId: 'acme.returns',
      owner: { userId: ANA, name: 'Ana Ortiz' },
    });
    expect(calls).toEqual([{ tenantId, agentId: 'acme.returns', userId: ANA }]);

    const got = await app.request('/v1/agents/acme.returns', { headers: auth });
    expect(got.status).toBe(200);
    expect((await json(got)).owner).toEqual({ userId: ANA, name: 'Ana Ortiz' });
  });

  test('setting it again replaces it; a person without a display name is named by id alone', async () => {
    const { app } = makeApp();
    await put(app, 'acme.returns', { userId: ANA });
    const res = await put(app, 'acme.returns', { userId: BEN });
    expect(res.status).toBe(200);
    const got = await app.request('/v1/agents/acme.returns', { headers: auth });
    expect((await json(got)).owner).toEqual({ userId: BEN });
  });

  test('an agent without an owner answers no owner', async () => {
    const { app } = makeApp();
    const got = await app.request('/v1/agents/acme.returns', { headers: auth });
    expect(got.status).toBe(200);
    expect(await json(got)).not.toHaveProperty('owner');
  });

  test("a person the directory doesn't have, or who has left, is refused, and nothing is set", async () => {
    const { app, calls } = makeApp();
    for (const userId of ['user-nobody', GONE]) {
      const res = await put(app, 'acme.returns', { userId });
      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.error.code).toBe('identity-user-not-found');
      expect(body.error.details).toMatchObject({ userId });
    }
    expect(calls).toEqual([]);
  });

  test('without a directory, any id is taken, and the owner has no name', async () => {
    const { app } = makeApp({ withDirectory: false });
    const res = await put(app, 'acme.returns', { userId: 'user-anyone' });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ agentId: 'acme.returns', owner: { userId: 'user-anyone' } });
  });

  test('a body other than { userId } is refused', async () => {
    const { app, calls } = makeApp();
    for (const body of [
      'not json',
      [],
      {},
      { userId: '' },
      { userId: 7 },
      { userId: ANA, role: 'x' },
    ]) {
      const res = await put(app, 'acme.returns', body);
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe('bad-input');
    }
    expect(calls).toEqual([]);
  });

  test('an agent that was never published is not found', async () => {
    const { app } = makeApp();
    const res = await put(app, 'acme.nothing', { userId: ANA });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('agent-not-found');
  });

  test("an agent store that doesn't keep an owner answers 501", async () => {
    const { app } = makeApp({ withOwner: false });
    const res = await put(app, 'acme.returns', { userId: ANA });
    expect(res.status).toBe(501);
    expect((await json(res)).error.code).toBe('agent-owner-unsupported');
  });
});
