// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Who a turn may run as. A turn runs with its participant's memory, so
 * running as a participant takes what reading their memory takes: the
 * participant is the caller (a person, by their user id), or the caller holds
 * `write` on the turn's project. Checked at every way a turn gets a
 * participant: a body's `input.participantId` (an agent's or a flow's run),
 * posting into a conversation (its stored participant wins), and opening a
 * conversation for someone.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { ReferenceScopeBinding, RunHandlerBinding, TokenResolution } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const P1 = randomUUID();
/** A second project, which a run may be filed under by name. */
const P2 = randomUUID();
const ALICE = randomUUID() as UserId;
const BOBS_CONVERSATION = randomUUID();
const HIS_OWN = randomUUID();
/** A conversation whose lookup fails (the database is away). */
const UNREADABLE = randomUUID();

/** What each key may run: the desk agent, the triage flow, and an agent in no project. */
const RUN = ['execute agent:acme.desk', 'execute flow:acme.triage', 'execute agent:acme.loose'];

/** Each key's grants, as `<action> <type>:<id>`. */
const KEYS: Record<string, { readonly who: TokenResolution; readonly grants: readonly string[] }> =
  {
    // A person who may run the agent and nothing else (a site's person's shape).
    caller: { who: { tenantId, userId: ALICE }, grants: RUN },
    // An editor: `write` on the project, acting for all its end users.
    editor: {
      who: { tenantId, userId: randomUUID() as UserId },
      grants: [...RUN, `write project:${P1}`],
    },
    // An app's key that may only run the agent; one naming a user is still a key.
    app: {
      who: { tenantId, serviceAccountId: 'sa-app', tokenId: 'tok-app' as never, userId: ALICE },
      grants: RUN,
    },
    // An app's key acting for its project's end users.
    appWriter: {
      who: { tenantId, serviceAccountId: 'sa-desk', tokenId: 'tok-desk' as never },
      grants: [...RUN, `write project:${P1}`],
    },
    // A person with `write` on P2 only: may file a run there, not act in P1.
    p2Writer: {
      who: { tenantId, userId: randomUUID() as UserId },
      grants: [...RUN, `write project:${P2}`],
    },
  };

function decision(grants: readonly string[], action: Action, resource: ResourceRef): Decision {
  const allowed = grants.includes(`${action} ${resource.type}:${resource.id}`);
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

/** Conversations: Bob's (participant cus_bob), and one Alice's own. */
const conversations = new Map<string, { participantId: string; projectId: string }>([
  [BOBS_CONVERSATION, { participantId: 'cus_bob', projectId: P1 }],
  [HIS_OWN, { participantId: ALICE, projectId: P1 }],
]);

function makeApp(withAuthz = true, referenceScope?: ReferenceScopeBinding) {
  let current = 'caller';
  let opened = 0;
  const stub = createStubAppBindings();
  const app = createApp({
    ...stub,
    ...(referenceScope !== undefined && { referenceScope }),
    resolveToken: async (token) => KEYS[token]?.who ?? null,
    // Reaching the run handler means the participant rule let it through.
    runHandler: {
      invokeAgent: async () => ({
        kind: 'err',
        error: { code: 'bad-input', message: 'reached the run handler' },
      }),
      invokeFlow: async () => ({
        kind: 'err',
        error: { code: 'bad-input', message: 'reached the run handler' },
      }),
      resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
    } as unknown as RunHandlerBinding,
    // The desk agent and the triage flow live in P1; `acme.loose` in no project.
    agentRegistry: {
      ...(stub as unknown as { agentRegistry?: object }).agentRegistry,
      get: async ({ agentId }: { agentId: string }) => ({
        agentId,
        version: '1.0.0',
        ...(agentId === 'acme.desk' && { projectId: P1 }),
      }),
      getVersion: async ({ agentId }: { agentId: string }) => ({
        agentId,
        version: '1.0.0',
        ...(agentId === 'acme.desk' && { projectId: P1 }),
      }),
    } as never,
    flowRegistry: {
      get: async ({ flowId }: { flowId: string }) =>
        flowId === 'acme.triage' ? { flowId, version: '1.0.0', projectId: P1 } : null,
    } as never,
    conversationBinding: {
      ...stub.conversationBinding,
      getConversation: async (_t: TenantId, id: string) => {
        // As Postgres: an id that isn't a uuid fails the query, as does the database being away.
        if (id === UNREADABLE || !/^[0-9a-f-]{36}$/.test(id)) {
          return { kind: 'err', error: { code: 'persistence-error', message: 'query failed' } };
        }
        const found = conversations.get(id);
        return found === undefined
          ? {
              kind: 'err',
              error: { code: 'conversation-not-found', message: 'no such conversation' },
            }
          : {
              kind: 'ok',
              value: {
                id,
                agentId: 'acme.desk',
                agentVersion: '1.0.0',
                title: '',
                ...found,
                scope: { tenantId },
                openedAt: new Date().toISOString(),
              },
            };
      },
      openConversation: async (input: { participantId?: string }) => {
        opened += 1;
        return {
          kind: 'ok',
          value: {
            id: randomUUID(),
            agentId: 'acme.desk',
            agentVersion: '1.0.0',
            title: '',
            ...(input.participantId !== undefined && { participantId: input.participantId }),
            projectId: P1,
            scope: { tenantId },
            openedAt: new Date().toISOString(),
          },
        };
      },
    } as never,
    ...(withAuthz && {
      authz: {
        fgaApiUrl: 'http://fga.invalid',
        authzCheckBinding: {
          check: async (_p, action, resource) =>
            decision(KEYS[current]?.grants ?? [], action, resource),
          checkBatch: async (_p, action, resources) =>
            resources.map((r) => decision(KEYS[current]?.grants ?? [], action, r)),
        } satisfies AuthzCheckBinding,
      },
    }),
  });
  const as = (key: string) => {
    current = key;
    const post = async (path: string, body: unknown) => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      const json = JSON.parse(raw) as {
        error?: { code?: string; message?: string; details?: { resource?: string } };
      };
      return {
        status: res.status,
        code: json.error?.code,
        message: json.error?.message,
        resource: json.error?.details?.resource,
        raw,
      };
    };
    return {
      run: (input: Record<string, unknown>, agent = 'acme.desk') =>
        post('/v1/runs', {
          agent,
          agentVersion: '1.0.0',
          input: { userMessage: 'hello', ...input },
        }),
      runFlow: (input: Record<string, unknown>) => post('/v1/runs', { flow: 'acme.triage', input }),
      /** An agent's run filed under the project it names. */
      runIn: (projectId: string, input: Record<string, unknown>) =>
        post('/v1/runs', {
          agent: 'acme.desk',
          agentVersion: '1.0.0',
          projectId,
          input: { userMessage: 'hello', ...input },
        }),
      /** Opens one in the agent's own project, P1. */
      open: (participantId?: string) =>
        post('/v1/conversations', {
          agentId: 'acme.desk',
          agentVersion: '1.0.0',
          ...(participantId !== undefined && { participantId }),
        }),
    };
  };
  return { as, opened: () => opened };
}

const refusedForParticipant = (r: { status: number; code?: string | undefined }) =>
  r.status === 403 && r.code === 'participant-not-allowed';
const reachedTheHandler = (r: { status: number; code?: string | undefined }) =>
  r.status === 400 && r.code === 'bad-input';

describe('a person who may only run the agent', () => {
  test('naming someone else as participant is refused', async () => {
    const r = await makeApp().as('caller').run({ participantId: 'cus_bob' });
    expect(refusedForParticipant(r)).toBe(true);
    expect(r.message).toContain(`write on project ${P1}`);
  });

  test("posting into someone else's conversation is refused, even naming themselves", async () => {
    const { as } = makeApp();
    expect(
      refusedForParticipant(await as('caller').run({ conversationId: BOBS_CONVERSATION })),
    ).toBe(true);
    expect(
      refusedForParticipant(
        await as('caller').run({ conversationId: BOBS_CONVERSATION, participantId: ALICE }),
      ),
    ).toBe(true);
  });

  test('the refusal names only the conversation they sent, never its participant or project', async () => {
    const r = await makeApp().as('caller').run({ conversationId: BOBS_CONVERSATION });
    expect(refusedForParticipant(r)).toBe(true);
    expect(r.resource).toBe(`conversation:${BOBS_CONVERSATION}`);
    expect(r.message).toContain('this conversation');
    expect(r.raw).not.toContain('cus_bob');
    expect(r.raw).not.toContain(P1);
  });

  test("a flow's run naming someone else is refused; as themselves it goes ahead", async () => {
    const { as } = makeApp();
    expect(refusedForParticipant(await as('caller').runFlow({ participantId: 'cus_bob' }))).toBe(
      true,
    );
    expect(reachedTheHandler(await as('caller').runFlow({ participantId: ALICE }))).toBe(true);
  });

  test('opening a conversation for someone else is refused', async () => {
    expect(refusedForParticipant(await makeApp().as('caller').open('cus_bob'))).toBe(true);
  });

  test('as themselves, or with no participant, it goes ahead', async () => {
    const { as } = makeApp();
    expect(reachedTheHandler(await as('caller').run({ participantId: ALICE }))).toBe(true);
    expect(reachedTheHandler(await as('caller').run({ conversationId: HIS_OWN }))).toBe(true);
    expect(reachedTheHandler(await as('caller').run({}))).toBe(true);
    expect((await as('caller').open(ALICE)).status).toBe(201);
  });
});

describe("a caller acting for the project's end users (write on the project)", () => {
  test('an editor runs as any participant, posts into their conversation, opens one for them', async () => {
    const { as } = makeApp();
    expect(reachedTheHandler(await as('editor').run({ participantId: 'cus_bob' }))).toBe(true);
    expect(reachedTheHandler(await as('editor').run({ conversationId: BOBS_CONVERSATION }))).toBe(
      true,
    );
    expect((await as('editor').open('cus_bob')).status).toBe(201);
  });

  test('an editor runs a flow as any participant', async () => {
    expect(
      reachedTheHandler(await makeApp().as('editor').runFlow({ participantId: 'cus_bob' })),
    ).toBe(true);
  });

  test("an app's key with write acts for its end users", async () => {
    expect(
      reachedTheHandler(await makeApp().as('appWriter').run({ participantId: 'cus_bob' })),
    ).toBe(true);
  });
});

describe("an app's key that may only run the agent", () => {
  test('is refused for any participant, even one equal to a user it names (a key is never the person)', async () => {
    const { as } = makeApp();
    expect(refusedForParticipant(await as('app').run({ participantId: 'cus_bob' }))).toBe(true);
    expect(refusedForParticipant(await as('app').run({ participantId: ALICE }))).toBe(true);
  });
});

describe("a turn whose project isn't known", () => {
  test('only the participant themselves may: write on some project is no help', async () => {
    const { as } = makeApp();
    const r = await as('editor').run({ participantId: 'cus_bob' }, 'acme.loose');
    expect(refusedForParticipant(r)).toBe(true);
    expect(r.message).toContain("project isn't known");
    expect(reachedTheHandler(await as('caller').run({ participantId: ALICE }, 'acme.loose'))).toBe(
      true,
    );
  });
});

describe('looking up the conversation', () => {
  test('a failed lookup answers 500 and starts no turn, for anyone', async () => {
    const { as } = makeApp();
    for (const key of ['caller', 'editor']) {
      const r = await as(key).run({ conversationId: UNREADABLE });
      expect(r.status).toBe(500);
      expect(r.code).toBe('internal-server-error');
    }
  });

  test("an id that isn't a uuid names no conversation: the run handler answers it", async () => {
    const { as } = makeApp();
    expect(reachedTheHandler(await as('caller').run({ conversationId: 'not-a-uuid' }))).toBe(true);
    // The body's participant is still checked.
    expect(
      refusedForParticipant(
        await as('caller').run({ conversationId: 'not-a-uuid', participantId: 'cus_bob' }),
      ),
    ).toBe(true);
  });
});

describe("a project that doesn't reach the agent, and a participant the caller may not act for", () => {
  // Both would refuse. The reach check answers first, before anything is written.
  const unreachable: ReferenceScopeBinding = { reachable: async () => false };
  const outOfScope = (r: { status: number; code?: string | undefined }) =>
    r.status === 400 && r.code === 'reference-out-of-scope';

  test('opening a conversation answers reference-out-of-scope, and opens none', async () => {
    const { as, opened } = makeApp(true, unreachable);
    expect(outOfScope(await as('caller').open('cus_bob'))).toBe(true);
    expect(opened()).toBe(0);
  });

  test('a run filed under the project answers reference-out-of-scope, and starts no turn', async () => {
    // Bob's conversation is in P1, where p2Writer may not act for him.
    const r = await makeApp(true, unreachable)
      .as('p2Writer')
      .runIn(P2, { conversationId: BOBS_CONVERSATION });
    expect(outOfScope(r)).toBe(true);
  });

  test('with the project reaching it, the participant is refused', async () => {
    const reachable: ReferenceScopeBinding = { reachable: async () => true };
    const { as, opened } = makeApp(true, reachable);
    expect(refusedForParticipant(await as('caller').open('cus_bob'))).toBe(true);
    expect(opened()).toBe(0);
  });

  test("a run naming P2 into a conversation in P1 is refused as P1's conversation, not by the participant rule", async () => {
    // A conversation belongs to one project (`conversation-turn-rights.test.ts`).
    const reachable: ReferenceScopeBinding = { reachable: async () => true };
    const r = await makeApp(true, reachable)
      .as('p2Writer')
      .runIn(P2, { conversationId: BOBS_CONVERSATION });
    expect(r.status).toBe(404);
    expect(r.code).toBe('conversation-not-found');
  });
});

test('without authorization, nothing is checked', async () => {
  const r = await makeApp(false).as('caller').run({ participantId: 'cus_bob' });
  expect(reachedTheHandler(r)).toBe(true);
});
