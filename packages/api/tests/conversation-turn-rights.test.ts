// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Who may add a turn to a conversation, and where. A conversation belongs to
 * one project: a turn naming another project is refused. A turn into a
 * conversation with a stored participant keeps the participant rule
 * (`participant-access.test.ts`). One without a participant takes its
 * opener, or `write` on the conversation's project (on its agent, for a
 * conversation from before projects). A caller who can't read the
 * conversation gets the answer for a conversation that doesn't exist, byte
 * for byte. A closed conversation takes no new turns: once the caller may
 * add the turn, it's refused before a run is made. None of it depends on an
 * environment order: the app here has none, and the rule holds the same.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolution } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
/** The project a turn names. */
const A = randomUUID();
/** The conversations' project. */
const B = randomUUID();
const ALICE = randomUUID() as UserId;
const CAROL = randomUUID() as UserId;

/** Opened by Alice, in B, with no participant. */
const ALICES = randomUUID();
/** Opened by the app's key, in B, with no participant. */
const THE_APPS = randomUUID();
/** Opened by a site's key for Carol, in B: Carol is its participant. */
const CAROLS = randomUUID();
/** From before projects: no project, opened by Alice. */
const OLD_ALICES = randomUUID();
/** From before projects and before openers were recorded. */
const OLD = randomUUID();
/** Opened by Alice, in B, with no participant, and closed. */
const CLOSED_ALICES = randomUUID();
/** Carol's, as `CAROLS` is, and closed. */
const CLOSED_CAROLS = randomUUID();
/** No conversation has this id. */
const MISSING = randomUUID();

interface Stored {
  readonly projectId?: string;
  readonly openedBy?: string;
  readonly participantId?: string;
  readonly closedAt?: string;
}

const STORED: ReadonlyMap<string, Stored> = new Map<string, Stored>([
  [ALICES, { projectId: B, openedBy: `user:${ALICE}` }],
  [THE_APPS, { projectId: B, openedBy: 'service_account:sa-app' }],
  [CAROLS, { projectId: B, openedBy: 'service_account:sa-site', participantId: CAROL }],
  [OLD_ALICES, { openedBy: `user:${ALICE}` }],
  [OLD, {}],
  [CLOSED_ALICES, { projectId: B, openedBy: `user:${ALICE}`, closedAt: '2026-10-17T10:05:07Z' }],
  [
    CLOSED_CAROLS,
    {
      projectId: B,
      openedBy: 'service_account:sa-site',
      participantId: CAROL,
      closedAt: '2026-10-17T10:05:07Z',
    },
  ],
]);

/** Every key may run the desk agent; the rest is each key's own. */
const RUN = 'execute agent:acme.desk';

/** Each key's grants, as `<action> <type>:<id>`. */
const KEYS: Record<string, { readonly who: TokenResolution; readonly grants: readonly string[] }> =
  {
    alice: { who: { tenantId, userId: ALICE }, grants: [RUN] },
    // Alice again, who may also file runs in A.
    aliceInA: { who: { tenantId, userId: ALICE }, grants: [RUN, `write project:${A}`] },
    carol: { who: { tenantId, userId: CAROL }, grants: [RUN] },
    app: {
      who: { tenantId, serviceAccountId: 'sa-app', tokenId: 'tok-app' as never },
      grants: [RUN],
    },
    // May run the agent, and nothing in B.
    stranger: { who: { tenantId, userId: randomUUID() as UserId }, grants: [RUN] },
    // Reads B, and may not act in it.
    viewer: {
      who: { tenantId, userId: randomUUID() as UserId },
      grants: [RUN, `read project:${B}`],
    },
    // Acts in B: an editor, or an app acting for its end users.
    bWriter: {
      who: { tenantId, userId: randomUUID() as UserId },
      grants: [RUN, `write project:${B}`],
    },
    // May file runs in A, and can't read B.
    aWriter: {
      who: { tenantId, userId: randomUUID() as UserId },
      grants: [RUN, `write project:${A}`],
    },
    // May file runs in A, and reads B.
    aWriterReadsB: {
      who: { tenantId, userId: randomUUID() as UserId },
      grants: [RUN, `write project:${A}`, `read project:${B}`],
    },
    // Old conversations are checked on their agent.
    agentWriter: {
      who: { tenantId, userId: randomUUID() as UserId },
      grants: [RUN, 'write agent:acme.desk'],
    },
    agentViewer: {
      who: { tenantId, userId: randomUUID() as UserId },
      grants: [RUN, 'read agent:acme.desk'],
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

function makeApp({
  withAuthz = true,
  stored = STORED,
}: { withAuthz?: boolean; stored?: ReadonlyMap<string, Stored> } = {}) {
  let current = 'alice';
  let reached = 0;
  let opened = 0;
  const stub = createStubAppBindings();
  const toHandler = async () => {
    reached += 1;
    return { kind: 'err', error: { code: 'bad-input', message: 'reached the run handler' } };
  };
  const app = createApp({
    ...stub,
    resolveToken: async (token) => KEYS[token]?.who ?? null,
    // Reaching the run handler means the route let the turn through.
    runHandler: {
      invokeAgent: toHandler,
      invokeFlow: toHandler,
      resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
    } as unknown as RunHandlerBinding,
    agentRegistry: {
      get: async ({ agentId }: { agentId: string }) => ({
        agentId,
        version: '1.0.0',
        projectId: B,
      }),
      getVersion: async ({ agentId }: { agentId: string }) => ({
        agentId,
        version: '1.0.0',
        projectId: B,
      }),
    } as never,
    conversationBinding: {
      ...stub.conversationBinding,
      getConversation: async (_t: TenantId, id: string) => {
        const found = stored.get(id);
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
      openConversation: async (input: { projectId?: string }) => {
        opened += 1;
        return {
          kind: 'ok',
          value: {
            id: randomUUID(),
            agentId: 'acme.desk',
            agentVersion: '1.0.0',
            title: '',
            ...(input.projectId !== undefined && { projectId: input.projectId }),
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
        error?: {
          code?: string;
          message?: string;
          details?: Record<string, unknown>;
          requestId?: string;
        };
      };
      return {
        status: res.status,
        code: json.error?.code,
        message: json.error?.message,
        details: json.error?.details,
        // The body as sent, less its request id: what two answers must share.
        bytes: raw.replace(`"requestId":"${json.error?.requestId ?? ''}"`, '"requestId":""'),
        raw,
      };
    };
    return {
      /** A turn into `conversationId`, naming `projectId` when given. */
      turn: (
        conversationId: string,
        {
          projectId,
          wait,
          participantId,
        }: { projectId?: string; wait?: boolean; participantId?: string } = {},
      ) =>
        post('/v1/runs', {
          agent: 'acme.desk',
          agentVersion: '1.0.0',
          ...(projectId !== undefined && { projectId }),
          ...(wait !== undefined && { options: { wait } }),
          input: {
            userMessage: 'hello',
            conversationId,
            ...(participantId !== undefined && { participantId }),
          },
        }),
      /** A flow run whose input names `conversationId`. */
      flowRun: (conversationId: string) =>
        post('/v1/runs', { flow: 'acme.triage', input: { conversationId } }),
      open: (projectId?: string) =>
        post('/v1/conversations', {
          agentId: 'acme.desk',
          agentVersion: '1.0.0',
          ...(projectId !== undefined && { projectId }),
        }),
    };
  };
  return { as, reached: () => reached, opened: () => opened };
}

type Answer = Awaited<ReturnType<ReturnType<ReturnType<typeof makeApp>['as']>['turn']>>;

const continued = (r: Answer) => r.status === 400 && r.code === 'bad-input';
const notFound = (r: Answer) => r.status === 404 && r.code === 'conversation-not-found';
const forbidden = (r: Answer) => r.status === 403 && r.code === 'permission-denied';
const closed = (r: Answer) => r.status === 409 && r.code === 'conversation-closed';

/** `id` as it answers when no conversation has it: the same caller, the same turn. */
async function asIfMissing(
  key: string,
  id: string,
  turn: { projectId?: string; wait?: boolean } = {},
): Promise<Answer> {
  const without = new Map(STORED);
  without.delete(id);
  return makeApp({ stored: without }).as(key).turn(id, turn);
}

describe('a conversation that does not exist', () => {
  test('answers 404 before any turn starts, whether or not the caller waits', async () => {
    for (const wait of [true, false, undefined]) {
      const { as, reached } = makeApp();
      const r = await as('bWriter').turn(MISSING, wait === undefined ? {} : { wait });
      expect(notFound(r)).toBe(true);
      expect(r.message).toBe(`No conversation with id "${MISSING}"`);
      expect(r.details).toEqual({ conversationId: MISSING });
      expect(reached()).toBe(0);
    }
  });

  test('answers 404 without authorization too', async () => {
    const { as, reached } = makeApp({ withAuthz: false });
    expect(notFound(await as('stranger').turn(MISSING, { wait: false }))).toBe(true);
    expect(reached()).toBe(0);
  });

  test("an id that isn't a uuid names no conversation: the run handler answers it", async () => {
    const { as, reached } = makeApp();
    expect(continued(await as('stranger').turn('not-a-uuid'))).toBe(true);
    expect(reached()).toBe(1);
  });
});

describe('a turn naming another project', () => {
  test("a caller who reads the conversation's project gets 409, naming both projects", async () => {
    const { as, reached } = makeApp();
    const r = await as('aWriterReadsB').turn(ALICES, { projectId: A });
    expect(r.status).toBe(409);
    expect(r.code).toBe('conversation-project-mismatch');
    expect(r.message).toBe(
      `Conversation "${ALICES}" is in project ${B}; the run names project ${A}. Name ${B}, or omit \`projectId\` to continue it in its own project.`,
    );
    expect(r.details).toEqual({ conversationId: ALICES, projectId: A, conversationProjectId: B });
    expect(reached()).toBe(0);
  });

  test("one who can't read it gets the 404 a missing conversation gets, byte for byte", async () => {
    for (const wait of [true, false]) {
      const { as, reached } = makeApp();
      const r = await as('aWriter').turn(ALICES, { projectId: A, wait });
      expect(notFound(r)).toBe(true);
      expect(r.raw).not.toContain(B);
      expect(r.bytes).toBe((await asIfMissing('aWriter', ALICES, { projectId: A, wait })).bytes);
      expect(reached()).toBe(0);
    }
  });

  test("is refused even to the conversation's opener", async () => {
    // Alice opened it, and may file runs in A: the conversation stays in B.
    const { as, reached } = makeApp();
    expect(notFound(await as('aliceInA').turn(ALICES, { projectId: A }))).toBe(true);
    expect(reached()).toBe(0);
  });

  test('is refused without authorization too, as a 409', async () => {
    const { as, reached } = makeApp({ withAuthz: false });
    const r = await as('stranger').turn(ALICES, { projectId: A });
    expect(r.status).toBe(409);
    expect(r.code).toBe('conversation-project-mismatch');
    expect(reached()).toBe(0);
  });

  test("naming the conversation's own project changes nothing", async () => {
    const { as, reached } = makeApp();
    expect(continued(await as('bWriter').turn(ALICES, { projectId: B }))).toBe(true);
    expect(reached()).toBe(1);
  });

  test('a conversation with no project is not compared', async () => {
    const { as } = makeApp();
    expect(continued(await as('aliceInA').turn(OLD_ALICES, { projectId: A }))).toBe(true);
  });
});

describe('a turn into a conversation with no participant', () => {
  test('its opener continues it: a person, and a service account', async () => {
    const { as, reached } = makeApp();
    expect(continued(await as('alice').turn(ALICES))).toBe(true);
    expect(continued(await as('app').turn(THE_APPS))).toBe(true);
    expect(reached()).toBe(2);
  });

  test("write on the conversation's project continues it", async () => {
    const { as } = makeApp();
    expect(continued(await as('bWriter').turn(ALICES))).toBe(true);
    expect(continued(await as('bWriter').turn(THE_APPS))).toBe(true);
  });

  test("a caller who only reads its project is refused 403: a viewer can't append turns", async () => {
    const { as, reached } = makeApp();
    const r = await as('viewer').turn(ALICES);
    expect(forbidden(r)).toBe(true);
    expect(r.details?.resource).toBe(`conversation:${ALICES}`);
    expect(r.details?.action).toBe('write');
    expect(forbidden(await as('viewer').turn(THE_APPS))).toBe(true);
    expect(reached()).toBe(0);
  });

  test("a caller who can't read its project gets the 404 a missing conversation gets", async () => {
    for (const wait of [true, false]) {
      const { as, reached } = makeApp();
      const r = await as('stranger').turn(ALICES, { wait });
      expect(notFound(r)).toBe(true);
      expect(r.bytes).toBe((await asIfMissing('stranger', ALICES, { wait })).bytes);
      expect(reached()).toBe(0);
    }
  });

  test('any other caller is not its opener', async () => {
    const { as } = makeApp();
    expect(notFound(await as('app').turn(ALICES))).toBe(true);
    expect(notFound(await as('alice').turn(THE_APPS))).toBe(true);
  });

  test('naming yourself as its participant does not make it yours', async () => {
    const { as, reached } = makeApp();
    expect(notFound(await as('stranger').turn(ALICES, { participantId: 'anyone' }))).toBe(true);
    expect(reached()).toBe(0);
  });

  test('without authorization, it continues', async () => {
    const { as } = makeApp({ withAuthz: false });
    expect(continued(await as('stranger').turn(ALICES))).toBe(true);
  });
});

describe('a turn into a conversation with a participant', () => {
  test('the participant rule decides, as before: the participant continues it', async () => {
    // Carol didn't open it (a site's key did), and holds no write on B.
    const { as } = makeApp();
    expect(continued(await as('carol').turn(CAROLS))).toBe(true);
    expect(continued(await as('bWriter').turn(CAROLS))).toBe(true);
  });

  test('anyone else without write on its project is refused by the participant rule', async () => {
    const { as } = makeApp();
    const r = await as('viewer').turn(CAROLS);
    expect(r.status).toBe(403);
    expect(r.code).toBe('participant-not-allowed');
  });

  test('naming another project is refused before the participant rule answers', async () => {
    // The participant rule's 403 would tell a caller who can't read B that it exists.
    const { as, reached } = makeApp();
    const hidden = await as('aWriter').turn(CAROLS, { projectId: A });
    expect(notFound(hidden)).toBe(true);
    expect(hidden.bytes).toBe((await asIfMissing('aWriter', CAROLS, { projectId: A })).bytes);
    expect((await as('aWriterReadsB').turn(CAROLS, { projectId: A })).status).toBe(409);
    expect(reached()).toBe(0);
  });
});

describe('a conversation from before projects', () => {
  test('its opener continues it', async () => {
    expect(continued(await makeApp().as('alice').turn(OLD_ALICES))).toBe(true);
  });

  test('write on its agent continues it, with or without an opener', async () => {
    const { as } = makeApp();
    expect(continued(await as('agentWriter').turn(OLD_ALICES))).toBe(true);
    expect(continued(await as('agentWriter').turn(OLD))).toBe(true);
  });

  test("a caller who reads its agent is refused 403; one who can't, 404", async () => {
    const { as } = makeApp();
    const r = await as('agentViewer').turn(OLD);
    expect(forbidden(r)).toBe(true);
    expect(r.details?.resource).toBe(`conversation:${OLD}`);
    const hidden = await as('stranger').turn(OLD);
    expect(notFound(hidden)).toBe(true);
    expect(hidden.bytes).toBe((await asIfMissing('stranger', OLD)).bytes);
  });

  test('write on a project is no help', async () => {
    expect(notFound(await makeApp().as('bWriter').turn(OLD))).toBe(true);
  });
});

describe('a turn into a closed conversation', () => {
  test('its opener is refused 409 before a run is made, whether or not the caller waits', async () => {
    for (const wait of [true, false, undefined]) {
      const { as, reached } = makeApp();
      const r = await as('alice').turn(CLOSED_ALICES, wait === undefined ? {} : { wait });
      expect(closed(r)).toBe(true);
      // The message a turn failed with at its setup, when a run was made for it.
      expect(r.message).toBe(`Conversation "${CLOSED_ALICES}" is closed`);
      expect(r.details).toEqual({ conversationId: CLOSED_ALICES });
      expect(reached()).toBe(0);
    }
  });

  test("write on its project is refused the same: it's closed for everyone", async () => {
    const { as, reached } = makeApp();
    expect(closed(await as('bWriter').turn(CLOSED_ALICES))).toBe(true);
    expect(reached()).toBe(0);
  });

  test('a caller who may not add a turn is answered as before: who may add one comes first', async () => {
    const { as, reached } = makeApp();
    // Reads B, and may not act in it.
    expect(forbidden(await as('viewer').turn(CLOSED_ALICES))).toBe(true);
    for (const wait of [true, false]) {
      const hidden = await as('stranger').turn(CLOSED_ALICES, { wait });
      expect(notFound(hidden)).toBe(true);
      expect(hidden.bytes).toBe((await asIfMissing('stranger', CLOSED_ALICES, { wait })).bytes);
    }
    // Naming another project.
    const elsewhere = await as('aWriterReadsB').turn(CLOSED_ALICES, { projectId: A });
    expect(elsewhere.code).toBe('conversation-project-mismatch');
    expect(reached()).toBe(0);
  });

  test("with a participant: the participant is told it's closed; anyone else, the participant rule", async () => {
    const { as, reached } = makeApp();
    expect(closed(await as('carol').turn(CLOSED_CAROLS))).toBe(true);
    const r = await as('viewer').turn(CLOSED_CAROLS);
    expect([r.status, r.code]).toEqual([403, 'participant-not-allowed']);
    expect(reached()).toBe(0);
  });

  test('without authorization, it is refused too', async () => {
    const { as, reached } = makeApp({ withAuthz: false });
    expect(closed(await as('stranger').turn(CLOSED_ALICES, { wait: false }))).toBe(true);
    expect(reached()).toBe(0);
  });

  test('a flow run naming it in `input.conversationId` is refused too; an open one goes through', async () => {
    const { as, reached } = makeApp({ withAuthz: false });
    expect(closed(await as('alice').flowRun(CLOSED_ALICES))).toBe(true);
    expect(reached()).toBe(0);
    expect(continued(await as('alice').flowRun(ALICES))).toBe(true);
    expect(reached()).toBe(1);
  });
});

describe('opening a conversation in a project the body names', () => {
  test('takes write on that project', async () => {
    const { as, opened } = makeApp();
    const r = await as('alice').open(A);
    expect(r.status).toBe(403);
    expect(r.code).toBe('permission-denied');
    expect(r.details?.resource).toBe(`project:${A}`);
    expect(r.details?.action).toBe('write');
    expect(opened()).toBe(0);
    expect((await as('aWriter').open(A)).status).toBe(201);
    expect(opened()).toBe(1);
  });

  test("unnamed, it opens in the agent's own project with execute alone, as before", async () => {
    const { as, opened } = makeApp();
    expect((await as('alice').open()).status).toBe(201);
    expect(opened()).toBe(1);
  });

  test('without authorization, nothing is checked', async () => {
    expect((await makeApp({ withAuthz: false }).as('alice').open(A)).status).toBe(201);
  });
});
