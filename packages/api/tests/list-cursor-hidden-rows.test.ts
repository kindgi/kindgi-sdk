// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Every list that hides rows after fetching them (`filterByCan`, or a
 * trigger list's `visible`) and pages on: its next cursor must not name a
 * row the caller can't read, and following it must still continue right
 * after the last row fetched, so paging never stops short.
 *
 * Each list's binding hands out a page of two rows the caller can't read,
 * with a readable cursor at the last of them, as the bindings' cursors are
 * today: base64url `{createdAt, id}`, or a time alone where the binding
 * pages by time. The route hides both rows and answers `hasMore`.
 *
 * With the app's cursor sealer (`cursorSealer`, as the runtime sets it):
 * - "continues after the last row it fetched": the binding gets its own
 *   position back, so paging never stops short;
 * - "hands out no cursor naming a hidden row": the sealed cursor shows
 *   nothing of it. Without a sealer the binding's cursor comes back as it
 *   is, and names the hidden row (the last test).
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createAeadCursorSealer, createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'list-cursor-hidden-rows';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;

/** The hidden row's time and position: what a readable cursor at it carries. */
const HIDDEN_AT = '2026-10-09T01:02:03.004Z';
const POSITION = { createdAt: HIDDEN_AT, id: 'hid-2' };
const JSON_CURSOR = Buffer.from(JSON.stringify(POSITION)).toString('base64url');

/** The caller may read nothing whose id says it's hidden. */
function decide(action: Action, r: ResourceRef): Decision {
  const allowed = !r.id.includes('hid');
  return {
    allowed,
    reason: allowed ? 'test: visible' : 'test: hidden',
    evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
  };
}

/** A binding whose `method` answers `first`, then `rest`; the position each later call asked for. */
function lister(
  method: string,
  first: unknown,
  rest: unknown,
  cursorIn: (args: unknown[]) => unknown,
) {
  const received: unknown[] = [];
  let calls = 0;
  const binding = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (name === 'then') return undefined;
        if (name !== method) {
          return async () => {
            throw new Error(`${String(name)} is not reached in this test`);
          };
        }
        return async (...args: unknown[]) => {
          calls += 1;
          if (calls === 1) return first;
          received.push(cursorIn(args));
          return rest;
        };
      },
    },
  ) as never;
  return { binding, received };
}

/** A binding no list reaches: present only so a router mounts. */
const absent = () => lister('—', undefined, undefined, () => undefined).binding;

/** The position a binding got back, as `{createdAt, id}` (or `{createdAt}` for a time). */
function positionOf(value: unknown): unknown {
  if (typeof value === 'string') {
    return value === HIDDEN_AT
      ? { createdAt: HIDDEN_AT }
      : JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  }
  const o = value as { openedAt?: string; createdAt?: string; id?: string } | undefined;
  return o?.openedAt !== undefined ? { createdAt: o.openedAt, id: o.id } : o;
}

const two = <T>(row: (id: string) => T): T[] => [row('hid-1'), row('hid-2')];
const arg0 = (args: unknown[]) => (args[0] as { cursor?: unknown }).cursor;

interface Entry {
  readonly name: string;
  readonly path: string;
  /** The app bindings this list needs, around its binding. */
  readonly bindings: (s: ReturnType<typeof createStubAppBindings>) => {
    readonly bindings: Record<string, unknown>;
    readonly received: unknown[];
  };
  /** A binding that pages by time hands out the time alone. */
  readonly byTime?: true;
}

/** The bindings the supervisor's lists need to mount (improvement passes, proposals). */
const supervised = () => ({
  agentRegistry: absent(),
  blockRegistry: absent(),
  evalRunBinding: absent(),
  agentReleases: { gatePolicies: absent(), live: absent(), promotions: absent() },
});

/** A `{ data, nextCursor }` page of two hidden rows, then an empty one. */
function page(method: string, row: (id: string) => unknown, cursorIn = arg0) {
  return lister(method, { data: two(row), nextCursor: JSON_CURSOR }, { data: [] }, cursorIn);
}

const ENTRIES: readonly Entry[] = [
  {
    name: 'agents',
    path: '/v1/agents',
    bindings: () => {
      const l = page('list', (id) => ({ id }));
      return { bindings: { agentRegistry: l.binding }, received: l.received };
    },
  },
  {
    name: 'artifacts',
    path: '/v1/artifacts',
    bindings: () => {
      const l = lister(
        'list',
        {
          kind: 'ok',
          value: { data: two(() => ({ projectId: 'hid-project' })), nextCursor: JSON_CURSOR },
        },
        { kind: 'ok', value: { data: [] } },
        (args) => args[2],
      );
      return { bindings: { blobStorage: l.binding }, received: l.received };
    },
  },
  {
    name: 'blocks',
    path: '/v1/blocks',
    bindings: () => {
      const l = page('list', () => ({ projectId: 'hid-project' }));
      return { bindings: { blockRegistry: l.binding }, received: l.received };
    },
  },
  {
    name: 'conversations',
    path: '/v1/conversations',
    bindings: (s) => {
      const l = lister(
        'listConversationsPage',
        {
          kind: 'ok',
          value: {
            data: two((id) => ({ id, projectId: 'hid-project', openedAt: HIDDEN_AT })),
            hasMore: true,
            next: { openedAt: HIDDEN_AT, id: 'hid-2' },
          },
        },
        { kind: 'ok', value: { data: [], hasMore: false } },
        (args) => (args[0] as { before?: unknown }).before,
      );
      return {
        bindings: {
          conversationBinding: {
            ...s.conversationBinding,
            listConversationsPage: (l.binding as Record<string, unknown>).listConversationsPage,
          },
        },
        received: l.received,
      };
    },
  },
  {
    name: 'cost records',
    path: '/v1/cost/records',
    bindings: () => {
      const l = page('listRecords', () => ({ projectId: 'hid-project' }));
      return { bindings: { cost: l.binding }, received: l.received };
    },
  },
  {
    name: 'eval runs',
    path: '/v1/eval-runs',
    bindings: () => {
      const l = page('list', () => ({ suiteId: 'hid-suite' }));
      return { bindings: { evalRunBinding: l.binding }, received: l.received };
    },
  },
  {
    name: 'eval suites',
    path: '/v1/eval-suites',
    bindings: () => {
      const l = page('list', (id) => ({ id }));
      return { bindings: { evalSuiteRegistry: l.binding }, received: l.received };
    },
  },
  {
    name: 'event triggers',
    path: '/v1/event-triggers',
    bindings: () => {
      const l = page('list', () => ({ flowId: 'hid-flow' }));
      return { bindings: { triggerRegistry: l.binding }, received: l.received };
    },
  },
  {
    name: 'flows',
    path: '/v1/flows',
    bindings: () => {
      const l = page('list', (id) => ({ id }));
      return { bindings: { flowRegistry: l.binding }, received: l.received };
    },
  },
  {
    name: 'gate policies',
    path: '/v1/gate-policies',
    bindings: () => {
      const l = page('list', () => ({ scope: { kind: 'project', projectId: 'hid-project' } }));
      return {
        bindings: {
          agentReleases: { gatePolicies: l.binding, live: absent(), promotions: absent() },
        },
        received: l.received,
      };
    },
  },
  {
    name: 'guardrails',
    path: '/v1/guardrails',
    bindings: () => {
      const l = page('list', (id) => ({ id }));
      return { bindings: { guardrailRegistry: l.binding }, received: l.received };
    },
  },
  {
    name: 'improvement passes',
    path: '/v1/improvement-passes',
    bindings: () => {
      const l = page('list', () => ({ agentId: 'hid-agent' }));
      return {
        bindings: { ...supervised(), supervisor: absent(), improvementPasses: l.binding },
        received: l.received,
      };
    },
  },
  {
    name: 'judgments',
    path: '/v1/judgments',
    bindings: () => {
      const l = lister(
        'list',
        { data: two(() => ({ projectId: 'hid-project' })), hasMore: true, nextCursor: JSON_CURSOR },
        { data: [], hasMore: false },
        arg0,
      );
      return { bindings: { judgmentRegistry: l.binding }, received: l.received };
    },
  },
  {
    name: 'judge classes',
    path: '/v1/judge-classes',
    bindings: () => {
      const l = lister(
        'listClasses',
        {
          data: two(() => ({ scope: { kind: 'project', projectId: 'hid-project' } })),
          hasMore: true,
          nextCursor: JSON_CURSOR,
        },
        { data: [], hasMore: false },
        arg0,
      );
      return { bindings: { judgmentRegistry: l.binding }, received: l.received };
    },
  },
  {
    name: 'MCP endpoints',
    path: '/v1/mcp/endpoints',
    bindings: () => {
      const l = page('list', (id) => ({ endpointId: id }));
      return { bindings: { mcpEndpointRegistry: l.binding }, received: l.received };
    },
  },
  {
    name: 'observations',
    path: '/v1/observations',
    byTime: true,
    bindings: () => {
      const l = lister(
        'queryObservations',
        {
          kind: 'ok',
          page: { data: two(() => ({ agentId: 'hid-agent' })), nextCursor: HIDDEN_AT },
        },
        { kind: 'ok', page: { data: [] } },
        arg0,
      );
      return {
        bindings: { supervisor: l.binding, enableObservations: true },
        received: l.received,
      };
    },
  },
  {
    name: 'orgs',
    path: '/v1/orgs',
    bindings: () => {
      const l = lister(
        'list',
        { items: two((id) => ({ id })), nextCursor: JSON_CURSOR },
        { items: [] },
        (args) => (args[1] as { cursor?: unknown }).cursor,
      );
      return { bindings: { orgBinding: l.binding }, received: l.received };
    },
  },
  {
    name: 'projects',
    path: '/v1/projects',
    bindings: () => {
      const l = lister(
        'list',
        { items: two((id) => ({ id })), nextCursor: JSON_CURSOR },
        { items: [] },
        (args) => (args[1] as { cursor?: unknown }).cursor,
      );
      return {
        bindings: { projectBinding: l.binding, projectMembershipBinding: absent() },
        received: l.received,
      };
    },
  },
  {
    name: 'proposals',
    path: '/v1/proposals',
    bindings: () => {
      const l = page('listProposals', () => ({ agentId: 'hid-agent' }));
      return { bindings: { ...supervised(), supervisor: l.binding }, received: l.received };
    },
  },
  {
    name: 'provenance',
    path: '/v1/provenance',
    bindings: (s) => {
      const l = lister(
        'listRecords',
        {
          kind: 'ok',
          value: { records: two(() => ({ projectId: 'hid-project' })), nextCursor: POSITION },
        },
        { kind: 'ok', value: { records: [] } },
        arg0,
      );
      return {
        bindings: {
          provenanceBinding: {
            ...s.provenanceBinding,
            listRecords: (l.binding as Record<string, unknown>).listRecords,
          },
        },
        received: l.received,
      };
    },
  },
  {
    name: 'runs',
    path: '/v1/runs',
    bindings: (s) => {
      const l = page('listRuns', () => ({ projectId: 'hid-project' }));
      return {
        bindings: {
          kernelBinding: {
            ...s.kernelBinding,
            run: {
              ...s.kernelBinding.run,
              listRuns: (l.binding as Record<string, unknown>).listRuns,
            },
          },
        },
        received: l.received,
      };
    },
  },
  {
    name: 'schedules',
    path: '/v1/schedules',
    bindings: () => {
      const l = page('list', () => ({ projectId: 'hid-project' }));
      return { bindings: { triggerRegistry: l.binding }, received: l.received };
    },
  },
  {
    name: 'teams',
    path: '/v1/teams',
    bindings: () => {
      const l = lister(
        'list',
        { items: two((id) => ({ id })), nextCursor: JSON_CURSOR },
        { items: [] },
        (args) => (args[1] as { cursor?: unknown }).cursor,
      );
      return {
        bindings: { teamBinding: l.binding, teamMembershipBinding: absent() },
        received: l.received,
      };
    },
  },
  {
    name: 'tools',
    path: '/v1/tools',
    bindings: () => {
      const l = page('list', (id) => ({ id }));
      return { bindings: { toolRegistry: l.binding }, received: l.received };
    },
  },
  {
    name: 'webhooks',
    path: '/v1/webhooks',
    bindings: () => {
      const l = page('list', () => ({ flowId: 'hid-flow' }));
      return { bindings: { triggerRegistry: l.binding }, received: l.received };
    },
  },
];

const sealer = createAeadCursorSealer({
  keys: [{ kid: 'test', key: new Uint8Array(32).fill(7) }],
});

/** One list's app, with only its bindings (and what its router needs to mount). */
function harness(entry: Entry, sealed = true) {
  const stubs = createStubAppBindings();
  const { bindings, received } = entry.bindings(stubs);
  const app = createApp({
    ...stubs,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    ...bindings,
    ...(sealed && { cursorSealer: sealer }),
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, r) => decide(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  } as never);
  const get = async (path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { get, received };
}

/** A cursor and what it decodes to, as a caller could read it. */
const readable = (cursor: string) =>
  `${cursor} ${Buffer.from(cursor, 'base64url').toString('utf8')}`;

describe('a list that hides the rows it fetched pages on without naming them', () => {
  test.each(ENTRIES.map((e) => [e.name, e] as const))(
    '%s: hides both rows, and its cursor continues after the last row it fetched',
    async (_name, entry) => {
      const { get, received } = harness(entry);
      const first = await get(entry.path);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.data ?? first.body.items).toEqual([]);
      expect(first.body.hasMore).toBe(true);
      expect(typeof first.body.nextCursor).toBe('string');
      const second = await get(
        `${entry.path}?cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
      );
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      expect(received.map(positionOf)).toEqual([
        entry.byTime === true ? { createdAt: HIDDEN_AT } : POSITION,
      ]);
    },
  );

  test.each(ENTRIES.map((e) => [e.name, e] as const))(
    "%s: hands out no cursor naming a row the caller can't read",
    async (_name, entry) => {
      const { get } = harness(entry);
      const first = await get(entry.path);
      expect(first.status).toBe(200);
      const text = readable(first.body.nextCursor as string);
      expect(text).not.toContain('hid');
      expect(text).not.toContain(HIDDEN_AT);
    },
  );

  test.each(ENTRIES.map((e) => [e.name, e] as const))(
    '%s, without a sealer: the binding’s cursor, which names the hidden row',
    async (_name, entry) => {
      const { get } = harness(entry, false);
      const first = await get(entry.path);
      expect(first.status).toBe(200);
      expect(readable(first.body.nextCursor as string)).toMatch(new RegExp(`hid|${HIDDEN_AT}`));
    },
  );
});
