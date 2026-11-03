// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Conversations and authorization: reading one, its messages, or the list
 * needs `read` on its project (its agent, for one from before projects);
 * opening or closing one needs `execute` on its agent, as starting a run
 * does; unregistering one (a tombstone the retention sweep then deletes)
 * needs `write` on its project (or agent). A caller refused on one they
 * can't read gets the answer for a conversation that doesn't exist, byte
 * for byte; one who can read it keeps the 403. Closing one doesn't take
 * reading it.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Conversation, ConversationBinding } from '@kindgi/agents';
import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'route-authz-conversations';
const P = randomUUID();
const AGENT = 'acme.desk';

function conversation(projectId?: string): Conversation {
  return {
    id: randomUUID(),
    tenantId,
    agentId: AGENT,
    agentVersion: '1.0.0',
    title: 't',
    ...(projectId !== undefined && { projectId }),
    scope: { tenantId },
    openedAt: '2026-10-07T08:00:00.000Z',
    turnCount: 0,
  } as unknown as Conversation;
}
const inP = conversation(P);
const legacy = conversation();
const Q = randomUUID();
const inQ = conversation(Q);

/** The same person's keys limited to a project: Q's, and P's. */
const LIMITED_TO_Q = 'route-authz-conversations-q';
const LIMITED_TO_P = 'route-authz-conversations-p';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN
    ? { tenantId, userId: 'user-1' as UserId }
    : token === LIMITED_TO_Q || token === LIMITED_TO_P
      ? {
          tenantId,
          userId: 'user-1' as UserId,
          tokenProjectId: token === LIMITED_TO_Q ? Q : P,
        }
      : null;

/**
 * `projects`: the ones that exist; unset, the app has no project binding
 * and checks none. `gone`: conversations the binding doesn't find, as if
 * they had never been opened.
 */
function harness(
  grants: readonly string[],
  {
    authzOn = true,
    projects,
    gone = [],
  }: { authzOn?: boolean; projects?: readonly string[]; gone?: readonly string[] } = {},
) {
  const asked: string[] = [];
  const decide = (action: Action, r: ResourceRef): Decision => {
    asked.push(`${action} ${r.type}:${r.id}`);
    const allowed = grants.includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  /** The refusals the authorizer decided itself and recorded, as `<action> <type>:<id> <failing>`. */
  const recorded: string[] = [];
  const reached: string[] = [];
  const stored = [inP, legacy, inQ].filter((c) => !gone.includes(c.id as unknown as string));
  const conversations = {
    getConversation: async (_t: TenantId, id: string) => {
      const found = stored.find((c) => c.id === id);
      // A message of the binding's own: the routes answer a missing one in theirs.
      return found === undefined
        ? { kind: 'err', error: { code: 'conversation-not-found', message: 'x' } }
        : { kind: 'ok', value: found };
    },
    listConversationsPage: async () => ({
      kind: 'ok',
      value: { data: [inP, legacy], hasMore: false },
    }),
    openConversation: async () => {
      reached.push('open');
      return { kind: 'ok', value: inP };
    },
    closeConversation: async () => {
      reached.push('close');
      return { kind: 'ok', value: inP };
    },
    readMessages: async () => {
      reached.push('messages');
      return { kind: 'ok', value: [] };
    },
    unregisterConversation: async (_t: TenantId, id: string) => {
      reached.push(`unregister ${id}`);
      return { kind: 'ok', value: stored.find((c) => c.id === id) };
    },
  } as unknown as ConversationBinding;
  const app = createApp({
    ...createStubAppBindings(),
    conversationBinding: conversations,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    ...(projects !== undefined && {
      projectBinding: {
        get: async (_t: TenantId, id: string) => (projects.includes(id) ? { id } : undefined),
        getDefault: async () => undefined,
      } as never,
    }),
    ...(authzOn && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_p, action, r) => decide(action, r),
          checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
          recordDecision: (_p, action, r, d) => {
            recorded.push(`${action} ${r.type}:${r.id} ${d.failing ?? ''}`);
          },
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const call = (method: string, path: string, body?: unknown, token = TOKEN) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { call, asked, reached, recorded };
}

/** An answer as two must share it: its status, and its body less the request id. */
async function answer(res: Response): Promise<{ status: number; body: string }> {
  const raw = await res.text();
  const { error } = JSON.parse(raw) as { error?: { requestId?: string } };
  return {
    status: res.status,
    body: raw.replace(`"requestId":"${error?.requestId ?? ''}"`, '"requestId":""'),
  };
}

/**
 * What `method path` answers when no conversation has `id`: the same
 * grants, the same route. It's the 404 every route answers a missing one
 * with, in the routes' own words.
 */
async function asIfMissing(
  grants: readonly string[],
  method: string,
  path: string,
  id: string,
): Promise<{ status: number; body: string }> {
  const missing = await answer(await harness(grants, { gone: [id] }).call(method, path));
  expect(missing.status).toBe(404);
  expect(JSON.parse(missing.body).error).toMatchObject({
    code: 'conversation-not-found',
    message: `No conversation with id "${id}"`,
  });
  return missing;
}

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

describe('reading conversations needs read on their project (or agent)', () => {
  test('one, and its messages: without read, the 404 a missing one gets, byte for byte; with it, through', async () => {
    const one = `/v1/conversations/${inP.id}`;
    const messages = `/v1/conversations/${inP.id}/messages`;
    const denied = harness([]);
    const hiddenOne = await answer(await denied.call('GET', one));
    const hiddenMessages = await answer(await denied.call('GET', messages));
    expect(denied.asked).toEqual([`read project:${P}`, `read project:${P}`]);
    expect(denied.reached).toEqual([]);
    expect(hiddenOne).toEqual(await asIfMissing([], 'GET', one, inP.id));
    expect(hiddenMessages).toEqual(await asIfMissing([], 'GET', messages, inP.id));

    const allowed = harness([`read project:${P}`]);
    expect((await allowed.call('GET', one)).status).toBe(200);
    expect((await allowed.call('GET', messages)).status).toBe(200);
  });

  test('one from before projects is checked on its agent', async () => {
    const path = `/v1/conversations/${legacy.id}`;
    const { call, asked } = harness([]);
    expect(await answer(await call('GET', path))).toEqual(
      await asIfMissing([], 'GET', path, legacy.id),
    );
    expect(asked).toEqual([`read agent:${AGENT}`]);
  });

  test('a key limited to another project gets the 404 too, its refusal recorded', async () => {
    const path = `/v1/conversations/${inP.id}`;
    const limited = harness([`read project:${P}`]);
    const hidden = await answer(await limited.call('GET', path, undefined, LIMITED_TO_Q));
    expect(hidden).toEqual(await asIfMissing([`read project:${P}`], 'GET', path, inP.id));
    // The key ruled it out before the store was asked.
    expect(limited.asked).toEqual([]);
    expect(limited.recorded).toEqual([`read project:${P} scope`]);
    // Limited to the conversation's own project: through.
    const own = harness([`read project:${P}`]);
    expect((await own.call('GET', path, undefined, LIMITED_TO_P)).status).toBe(200);
  });

  test('the list holds only those the caller may read', async () => {
    const { call } = harness([`read project:${P}`]);
    const body = (await (await call('GET', '/v1/conversations')).json()) as {
      data: { id: string }[];
    };
    expect(body.data.map((c) => c.id)).toEqual([inP.id]);
  });
});

describe('opening or closing one needs execute on its agent', () => {
  test("refused before the binding: opening 403; closing one the caller can't read, the 404 a missing one gets", async () => {
    const close = `/v1/conversations/${inP.id}/close`;
    const { call, asked, reached } = harness([]);
    const opened = await call('POST', '/v1/conversations', {
      agentId: AGENT,
      agentVersion: '1.0.0',
    });
    expect(opened.status).toBe(403);
    const closed = await answer(await call('POST', close));
    expect(closed).toEqual(await asIfMissing([], 'POST', close, inP.id));
    // Close's own check, then whether the caller can read it.
    expect(asked).toEqual([
      `execute agent:${AGENT}`,
      `execute agent:${AGENT}`,
      `read project:${P}`,
    ]);
    expect(reached).toEqual([]);
  });

  test('a caller who can read it, refused, keeps the 403', async () => {
    const { call, reached } = harness([`read project:${P}`]);
    const res = await call('POST', `/v1/conversations/${inP.id}/close`);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('permission-denied');
    expect(reached).toEqual([]);
  });

  test("with execute, through: closing one doesn't take reading it", async () => {
    const { call, asked, reached } = harness([`execute agent:${AGENT}`]);
    await call('POST', '/v1/conversations', {
      agentId: AGENT,
      agentVersion: '1.0.0',
    });
    expect((await call('POST', `/v1/conversations/${inP.id}/close`)).status).toBe(200);
    expect(reached).toEqual(['open', 'close']);
    expect(asked).not.toContain(`read project:${P}`);
  });

  test('an unknown one answers 404 before any check', async () => {
    const id = randomUUID();
    const { call, asked, reached } = harness([`execute agent:${AGENT}`]);
    const res = await answer(await call('POST', `/v1/conversations/${id}/close`));
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error.message).toBe(`No conversation with id "${id}"`);
    expect(asked).toEqual([]);
    expect(reached).toEqual([]);
  });

  test('opening one in a project the body names also needs write on it, asked first', async () => {
    const body = { agentId: AGENT, agentVersion: '1.0.0', projectId: P };
    const refused = harness([`execute agent:${AGENT}`, `read project:${P}`]);
    expect((await refused.call('POST', '/v1/conversations', body)).status).toBe(403);
    expect(refused.asked).toEqual([`write project:${P}`]);
    expect(refused.reached).toEqual([]);
    const allowed = harness([`execute agent:${AGENT}`, `write project:${P}`]);
    await allowed.call('POST', '/v1/conversations', body);
    expect(allowed.reached).toEqual(['open']);
  });

  test('both are asked before the named project is looked up: the same 403 whether or not it exists', async () => {
    const body = (projectId: string) => ({ agentId: AGENT, agentVersion: '1.0.0', projectId });
    const gone = randomUUID();
    const error = async (res: Response) => {
      const body = (await res.json()) as { error: Record<string, unknown> };
      const { requestId: _, ...rest } = body.error;
      return { status: res.status, error: rest };
    };
    // Write on both projects, no execute on the agent.
    const noExecute = harness([`write project:${P}`, `write project:${gone}`], { projects: [P] });
    const there = await error(await noExecute.call('POST', '/v1/conversations', body(P)));
    const missing = await error(await noExecute.call('POST', '/v1/conversations', body(gone)));
    expect(there.status).toBe(403);
    expect(missing).toEqual(there);
    expect(noExecute.asked).toEqual([
      `write project:${P}`,
      `execute agent:${AGENT}`,
      `write project:${gone}`,
      `execute agent:${AGENT}`,
    ]);
    expect(noExecute.reached).toEqual([]);
    // With both rights, a project that doesn't exist is the 400.
    const both = harness([`execute agent:${AGENT}`, `write project:${gone}`], { projects: [P] });
    expect((await both.call('POST', '/v1/conversations', body(gone))).status).toBe(400);
    expect(both.reached).toEqual([]);
  });
});

describe('unregistering one needs write on its project (or agent)', () => {
  test("refused before the binding: a caller who can't read it gets the 404 a missing one gets", async () => {
    const path = `/v1/conversations/${inP.id}/unregister`;
    for (const grants of [[], [`execute agent:${AGENT}`]]) {
      const { call, asked, reached } = harness(grants);
      expect(await answer(await call('POST', path))).toEqual(
        await asIfMissing(grants, 'POST', path, inP.id),
      );
      expect(asked).toEqual([`write project:${P}`, `read project:${P}`]);
      expect(reached).toEqual([]);
    }
  });

  test('a caller who can read it (a viewer) keeps the 403', async () => {
    const { call, asked, reached } = harness([`read project:${P}`]);
    const res = await call('POST', `/v1/conversations/${inP.id}/unregister`);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('permission-denied');
    expect(asked).toEqual([`write project:${P}`, `read project:${P}`]);
    expect(reached).toEqual([]);
  });

  test('with write on its project, through', async () => {
    const { call, reached } = harness([`write project:${P}`]);
    expect((await call('POST', `/v1/conversations/${inP.id}/unregister`)).status).toBe(200);
    expect(reached).toEqual([`unregister ${inP.id}`]);
  });

  test("write on one project doesn't reach another project's conversation", async () => {
    const path = `/v1/conversations/${inQ.id}/unregister`;
    const { call, asked, reached } = harness([`write project:${P}`]);
    expect(await answer(await call('POST', path))).toEqual(
      await asIfMissing([`write project:${P}`], 'POST', path, inQ.id),
    );
    expect(asked).toEqual([`write project:${Q}`, `read project:${Q}`]);
    expect(reached).toEqual([]);
  });

  test('one from before projects is checked on its agent', async () => {
    const path = `/v1/conversations/${legacy.id}/unregister`;
    const denied = harness([]);
    expect(await answer(await denied.call('POST', path))).toEqual(
      await asIfMissing([], 'POST', path, legacy.id),
    );
    expect(denied.asked).toEqual([`write agent:${AGENT}`, `read agent:${AGENT}`]);
    const viewer = harness([`read agent:${AGENT}`]);
    expect((await viewer.call('POST', path)).status).toBe(403);
    const allowed = harness([`write agent:${AGENT}`]);
    expect((await allowed.call('POST', path)).status).toBe(200);
    expect(allowed.reached).toEqual([`unregister ${legacy.id}`]);
  });

  test('with authorization off, as before: through, unchecked', async () => {
    const { call, asked, reached } = harness([], { authzOn: false });
    expect((await call('POST', `/v1/conversations/${inP.id}/unregister`)).status).toBe(200);
    expect(asked).toEqual([]);
    expect(reached).toEqual([`unregister ${inP.id}`]);
  });

  test('an unknown one answers 404 before any check, as reading one does', async () => {
    const { call, asked, reached } = harness([`write project:${P}`]);
    expect((await call('POST', `/v1/conversations/${randomUUID()}/unregister`)).status).toBe(404);
    expect(asked).toEqual([]);
    expect(reached).toEqual([]);
  });
});
