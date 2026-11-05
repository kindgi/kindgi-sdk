// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `/mcp`'s run tools through the real `/v1` routes, as a person signed in
 * from a chat app: narrowed to `kindgi:read` and `kindgi:run`, which hold
 * no `write`. A tool names no project, so the run lands where the runtime
 * puts it (the conversation's project, else the agent's or the flow's own)
 * and needs what a start from the API that names no project needs: the
 * right to run the item, and for an item more than one project serves, the
 * right to run it in the project the run lands in. Naming the item's own
 * project would ask `write` on it (`runs.ts`), which a chat app never holds,
 * so nobody could run anything from one. The stand-in check narrows by the
 * principal's scope before it reads a grant, and refuses as the runtime's
 * does.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  AgentRegistryBinding,
  CreateAppInput,
  FlowRegistryBinding,
  RunHandlerBinding,
  TokenResolution,
} from '../src/index.js';
import { mountMcpServer } from '../src/mcp-server/endpoint.js';
import { agentTools } from '../src/mcp-server/run-tools.js';
import { createStubAppBindings } from '../src/testing/index.js';
import { environmentOrders } from './support/environment-orders.js';
import { mcpRpc } from './support/mcp-rpc.js';
import { type Grant, itemProjects } from './support/order-items.js';

const tenantId = randomUUID() as TenantId;
/** The one project `acme.front-desk` and `acme.intake` are in. */
const OWN = randomUUID() as ProjectId;
/** `acme.desk`'s projects: an order carries it from staging to prod. */
const STAGING = randomUUID() as ProjectId;
const PROD = randomUUID() as ProjectId;

const SOLO = 'acme.front-desk';
const FLOW = 'acme.intake';
const SERVED = 'acme.desk';
/** A conversation with `acme.desk` in prod, which alice opened. */
const IN_PROD = randomUUID();

const HOME: Record<string, ProjectId> = { [SOLO]: OWN, [FLOW]: OWN, [SERVED]: STAGING };

const on = (project: ProjectId, ...actions: string[]) =>
  actions.map((a) => `${a} project:${project}` as Grant);

const PEOPLE: Record<string, readonly Grant[]> = {
  /**
   * Runs both one-project items, and is an editor of their project: from
   * the API, naming it works. Reads `acme.desk` in staging and prod, and
   * calls it in prod alone.
   */
  alice: [
    `read agent:${SOLO}`,
    `execute agent:${SOLO}`,
    `read flow:${FLOW}`,
    `execute flow:${FLOW}`,
    ...on(OWN, 'read', 'write'),
    ...on(STAGING, 'read'),
    ...on(PROD, 'read', 'call'),
  ],
  /** Sees `acme.front-desk`, and may not run it. */
  bob: [`read agent:${SOLO}`, ...on(OWN, 'read')],
};

/** Grants each person exactly theirs, after the principal's scope, as the runtime's check does. */
function scopedGrants() {
  const asked: string[] = [];
  /** Each check's `allowedActions`, in the order asked. */
  const scopes: (readonly Action[] | undefined)[] = [];
  const decide = (principal: Principal, action: Action, r: ResourceRef): Decision => {
    const who = principal.actor.id;
    const scope = principal.scope;
    scopes.push(scope?.allowedActions);
    const outOfScope =
      (scope?.allowedActions !== undefined && !scope.allowedActions.includes(action)) ||
      scope?.deniedActions?.includes(action) === true;
    asked.push(`${who} ${action} ${r.type}:${r.id}${outOfScope ? ' (scope)' : ''}`);
    const evidence = { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' };
    if (outOfScope) {
      return {
        allowed: false,
        failing: 'scope',
        reason: `downscope: action '${action}' not in allowedActions`,
        evidence,
      };
    }
    return (PEOPLE[who] ?? []).includes(`${action} ${r.type}:${r.id}`)
      ? { allowed: true, reason: 'test', evidence }
      : { allowed: false, failing: 'actor', reason: 'test', evidence };
  };
  const binding: AuthzCheckBinding = {
    check: async (p, action, r) => decide(p, action, r),
    checkBatch: async (p, action, rs) => rs.map((r) => decide(p, action, r)),
    inProject: async (_p, r, projectId) => HOME[r.id] === projectId,
  };
  return { asked, scopes, authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: binding } };
}

function harness() {
  /** Each run the route handed on: what, the project it named, the conversation. */
  const invoked: string[] = [];
  const stop = { message: 'test: stop here' };
  const runHandler = {
    invokeAgent: async (input: { agentId: string; projectId?: string; input?: any }) => {
      const conversation = input.input?.conversationId;
      invoked.push(
        `agent ${input.agentId} in ${input.projectId ?? '-'}${conversation ? ` turn ${conversation}` : ''}`,
      );
      return { kind: 'err', error: { code: 'agent-not-found', ...stop } };
    },
    invokeFlow: async (input: { flowId: string; projectId?: string }) => {
      invoked.push(`flow ${input.flowId} in ${input.projectId ?? '-'}`);
      return { kind: 'err', error: { code: 'flow-not-found', ...stop } };
    },
  } as unknown as RunHandlerBinding;
  const stubs = createStubAppBindings();
  const conversationBinding = {
    ...stubs.conversationBinding,
    getConversation: async (_t: TenantId, id: string) =>
      id === IN_PROD
        ? {
            kind: 'ok',
            value: {
              conversationId: IN_PROD,
              tenantId,
              agentId: SERVED,
              agentVersion: '1.0.0',
              projectId: PROD,
              scope: {},
              createdAt: '2026-11-01T00:00:00.000Z',
              openedBy: 'user:alice',
            },
          }
        : { kind: 'err', error: { code: 'conversation-not-found', message: 'test: none' } },
  } as unknown as CreateAppInput['conversationBinding'];
  const record = (id: string) =>
    HOME[id] === undefined
      ? null
      : {
          id,
          version: '1.0.0',
          tenantId,
          name: id,
          projectId: HOME[id],
          mcp: { expose: true },
        };
  const registry = {
    get: async (input: Record<string, string>) => record(input.agentId ?? input.flowId ?? ''),
    getVersion: async (input: Record<string, string>) =>
      record(input.agentId ?? input.flowId ?? ''),
    headExists: async () => false,
  };
  const row = (kind: 'agent' | 'flow', id: string, projects: ProjectId[]) => ({
    kind,
    id,
    projects,
    versions: [{ version: '1.0.0', projects }],
  });
  const items = itemProjects(
    (['agent', 'flow'] as const).flatMap((kind) => [
      row(kind, SOLO, [OWN]),
      row(kind, FLOW, [OWN]),
      row(kind, SERVED, [STAGING, PROD]),
    ]),
  );
  const grants = scopedGrants();
  const app = createApp({
    ...stubs,
    conversationBinding,
    // The API's own tokens: the people, unnarrowed.
    resolveToken: async (token) => (token in PEOPLE ? { tenantId, userId: token as UserId } : null),
    runHandler,
    agentRegistry: registry as unknown as AgentRegistryBinding,
    flowRegistry: registry as unknown as FlowRegistryBinding,
    authz: grants.authz,
    itemProjects: items,
    environmentOrders: environmentOrders([[STAGING, PROD]]),
  } as CreateAppInput);
  mountMcpServer(
    app,
    {
      // A chat app's tokens: `chat-<person>`.
      resolveToken: async (token): Promise<TokenResolution | null> => {
        const who = token.replace(/^chat-/, '');
        return token.startsWith('chat-') && who in PEOPLE
          ? {
              tenantId,
              userId: who as UserId,
              expiresAt: new Date(Date.now() + 3_600_000),
              scopes: ['kindgi:read', 'kindgi:run'],
            }
          : null;
      },
      resourceMetadataUrl: 'https://kindgi.test/.well-known/oauth-protected-resource/mcp',
      version: '0.0.0-test',
    },
    [agentTools({ waitMs: 60, firstCheckMs: 1, checkMs: 5 })],
  );
  const rpc = mcpRpc(app);
  const tool = async (who: string, name: string, args: Record<string, unknown>) => {
    const before = grants.asked.length;
    const { body } = await rpc(`chat-${who}`, 'tools/call', { name, arguments: args });
    return {
      result: body.result,
      asked: grants.asked.slice(before),
      scopes: grants.scopes.slice(before),
    };
  };
  return { app, tool, invoked };
}

const said = (result: Record<string, any>) =>
  (result.content as { text: string }[]).map((c) => c.text).join('\n');

/** Every check the call made ran under the chat app's scope, which holds no `write`. */
const underChatScope = (scopes: readonly (readonly Action[] | undefined)[]) => {
  expect(scopes.length).toBeGreaterThan(0);
  for (const allowed of scopes) {
    expect(allowed).toBeDefined();
    expect(allowed).not.toContain('write');
  }
};

describe('/mcp: starting a run through the real route, from a chat app', () => {
  test("a one-project agent runs: no project named, so it's execute on the agent, and no write", async () => {
    const { tool, invoked } = harness();
    const { result, asked, scopes } = await tool('alice', SOLO, { message: 'Hello' });
    underChatScope(scopes);
    expect(invoked).toEqual([`agent ${SOLO} in -`]);
    expect(asked).toContain(`alice execute agent:${SOLO}`);
    expect(asked.filter((a) => a.includes(' write '))).toEqual([]);
    expect(said(result)).not.toContain("can't run");
  });

  test('a one-project flow runs the same way', async () => {
    const { tool, invoked } = harness();
    const { result, asked, scopes } = await tool('alice', `flow.${FLOW}`, {
      input: { document: 'x' },
    });
    underChatScope(scopes);
    expect(invoked).toEqual([`flow ${FLOW} in -`]);
    expect(asked).toContain(`alice execute flow:${FLOW}`);
    expect(asked.filter((a) => a.includes(' write '))).toEqual([]);
    expect(said(result)).not.toContain("can't run");
  });

  test("continuing a conversation with an agent more than one project serves runs in the conversation's project, not the agent's first", async () => {
    const { tool, invoked } = harness();
    const { asked, scopes } = await tool('alice', SERVED, {
      message: 'And now?',
      conversationId: IN_PROD,
    });
    underChatScope(scopes);
    // Alice calls acme.desk in prod alone: the check is there, and passes.
    expect(asked).toContain(`alice call project:${PROD}`);
    expect(asked.filter((a) => a.endsWith(`project:${STAGING}`) && !a.includes(' read '))).toEqual(
      [],
    );
    expect(invoked).toEqual([`agent ${SERVED} in - turn ${IN_PROD}`]);
  });

  test('one who sees the agent and may not run it is still refused, in words, and nothing starts', async () => {
    const { tool, invoked } = harness();
    const { result, asked, scopes } = await tool('bob', SOLO, { message: 'Hello' });
    underChatScope(scopes);
    expect(asked).toContain(`bob execute agent:${SOLO}`);
    expect(invoked).toEqual([]);
    expect(result.isError).toBe(true);
    expect(said(result)).toContain("can't run it");
  });
});
