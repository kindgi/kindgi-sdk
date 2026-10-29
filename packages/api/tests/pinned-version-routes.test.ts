// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type {
  Cursor,
  PinScope,
  PinnedItemKind,
  ProjectId,
  Semver,
  TenantId,
  Timestamp,
} from '@kindgi/types';

import type {
  EnvironmentOrderBinding,
  EnvironmentOrderKey,
} from '../src/environment-orders-binding.js';
import type { ItemCheck, ItemRights } from '../src/item-rights.js';
import type { Authorizer } from '../src/middleware/authorize.js';
import type {
  PinVersionInput,
  PinnedResolveInput,
  PinnedVersionBinding,
  PinnedVersionChange,
  PinnedVersionError,
  UnpinVersionInput,
} from '../src/pinned-version-binding.js';
import type { ReferenceScopeBinding } from '../src/reference-scope.js';
import {
  type PinnedItem,
  type PinnedRouteDeps,
  isPinWrite,
  mountPinnedVersionRoutes,
  pinRightsMiddleware,
} from '../src/routes/pinned-versions.js';
import type { AppEnv } from '../src/types.js';

/**
 * The pinned-version routes, mounted alone on a bare app: a fake binding
 * records each call and answers what a test sets up; a fake item stands in
 * for the flow or tool registry. A pin's checks run in this order:
 * rights, the scope, the item, reach, a tool's environment, the width.
 */

const tenantId = randomUUID() as TenantId;
const PROJECT = randomUUID();
const OTHER = randomUUID();
const ORG = randomUUID();
const ITEM = 'acme.ticket-triage';

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function change(overrides: Partial<PinnedVersionChange> = {}): PinnedVersionChange {
  return {
    id: randomUUID(),
    kind: 'flow',
    itemId: ITEM,
    scope: { kind: 'project', projectId: PROJECT as ProjectId },
    action: 'pin',
    fromVersion: null,
    toVersion: '1.0.0' as Semver,
    requestedBy: { kind: 'service', id: 'unknown' },
    createdAt: '2026-10-27T05:00:00.000Z' as Timestamp,
    ...overrides,
  };
}

type PinAnswer =
  | { kind: 'ok'; value: { change: PinnedVersionChange; unchanged: boolean } }
  | { kind: 'err'; error: PinnedVersionError };
type UnpinAnswer =
  | { kind: 'ok'; value: PinnedVersionChange }
  | { kind: 'err'; error: PinnedVersionError };

function fakeBinding() {
  const calls = {
    resolve: [] as PinnedResolveInput[],
    pin: [] as PinVersionInput[],
    unpin: [] as UnpinVersionInput[],
  };
  const state = {
    resolved: null as { version: Semver; scope: PinScope } | null,
    pin: { kind: 'ok', value: { change: change(), unchanged: false } } as PinAnswer,
    unpin: { kind: 'ok', value: change({ action: 'unpin', toVersion: null }) } as UnpinAnswer,
    history: {
      data: [change()] as PinnedVersionChange[],
      nextCursor: undefined as Cursor | undefined,
    },
  };
  const binding: PinnedVersionBinding = {
    resolve: async (input) => {
      calls.resolve.push(input);
      return state.resolved;
    },
    list: async ({ kind, itemId }) => [
      {
        kind,
        itemId,
        scope: { kind: 'tenant' },
        version: '1.0.0' as Semver,
        changeId: randomUUID(),
        setAt: '2026-10-27T05:00:00.000Z' as Timestamp,
        setBy: { kind: 'user', id: 'u-1' },
      },
    ],
    pin: async (input) => {
      calls.pin.push(input);
      return state.pin;
    },
    unpin: async (input) => {
      calls.unpin.push(input);
      return state.unpin;
    },
    history: async () => ({
      data: state.history.data,
      ...(state.history.nextCursor !== undefined && { nextCursor: state.history.nextCursor }),
    }),
    issuedCursor: (_list, cursor) => cursor.startsWith('ok-'),
  };
  return { binding, calls, state };
}

function fakeItem(kind: PinnedItemKind, overrides: Partial<PinnedItem> = {}): PinnedItem {
  return {
    kind,
    state: async () => 'ok',
    active: async (_t, _id, version) => version === ('1.0.0' as Semver),
    latest: async () => '1.1.0',
    ...overrides,
  };
}

/** Item rights for an item `projects` serve, in an order when `inOrder`; `checks` records each `enforce`. */
function fakeRights(how: {
  projects?: readonly string[];
  inOrder?: boolean;
  checks?: ItemCheck[];
  refuse?: boolean;
}): ItemRights {
  const rights: Pick<ItemRights, 'multi' | 'spannedOrder' | 'visibleVersions' | 'enforce'> = {
    multi: async () => how.projects as readonly ProjectId[] | undefined,
    spannedOrder: async () =>
      how.inOrder === true
        ? {
            orderId: 'order-1' as EnvironmentOrderKey,
            parent: { kind: 'tenant' },
            projects: [PROJECT as ProjectId],
            position: 0,
          }
        : undefined,
    visibleVersions: async (_c, _k, _id, _p, rows) => [...rows],
    enforce: async (c, _k, _id, _p, check) => {
      how.checks?.push(check);
      if (how.refuse !== true) return undefined;
      c.status(403);
      return c.json({ error: { code: 'forbidden' } });
    },
  };
  return rights as unknown as ItemRights;
}

function authorizer(checked: string[], allow = true): Authorizer {
  return {
    authorize: (action, getResource) => async (c, next) => {
      const r = await getResource(c);
      checked.push(`${action} ${r.type}:${r.id}`);
      if (!allow) {
        c.status(403);
        return c.json({ error: { code: 'forbidden' } });
      }
      return next();
    },
    can: async () => true,
    canFor: async () => {
      throw new Error('unused');
    },
    check: async () => {
      throw new Error('unused');
    },
    filterByCan: async () => [],
  };
}

function mounted(kind: PinnedItemKind, item: PinnedItem, deps: PinnedRouteDeps = {}) {
  const fake = fakeBinding();
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, tenantId as never);
    c.set('requestId' as never, 'req-pins' as never);
    return next();
  });
  const r = new Hono<AppEnv>();
  r.use('/:id/*', pinRightsMiddleware(kind, 'id', deps));
  mountPinnedVersionRoutes(r, 'id', item, fake.binding, deps);
  app.route('/', r);
  return { app, ...fake };
}

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

describe('which routes are pin writes', () => {
  test('pin and unpin are; the reads and other paths are not', () => {
    expect(isPinWrite('POST', '/v1/flows/f/pinned/pin')).toBe(true);
    expect(isPinWrite('POST', '/v1/tools/t/pinned/unpin')).toBe(true);
    expect(isPinWrite('GET', '/v1/flows/f/pinned')).toBe(false);
    expect(isPinWrite('POST', '/v1/flows/f/versions/1.0.0/unregister')).toBe(false);
  });
});

describe('GET /:id/pinned', () => {
  test('a covering pin answers the version and the scope that chose it', async () => {
    const { app, calls, state } = mounted('flow', fakeItem('flow'));
    state.resolved = { version: '1.0.0' as Semver, scope: { kind: 'org', orgId: ORG as never } };
    const res = await app.request(`/${ITEM}/pinned?projectId=${PROJECT}&orgId=${ORG}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      itemId: ITEM,
      version: '1.0.0',
      via: 'pinned',
      pinnedScope: { kind: 'org', orgId: ORG },
    });
    expect(calls.resolve).toEqual([
      { tenantId, kind: 'flow', itemId: ITEM, projectId: PROJECT, orgId: ORG },
    ]);
  });

  test('with no pin, the version the item answers for the project, as `latest`', async () => {
    const asked: (string | undefined)[] = [];
    const { app } = mounted(
      'tool',
      fakeItem('tool', {
        latest: async (_c, _t, _id, projectId) => {
          asked.push(projectId as unknown as string | undefined);
          return '2.0.0';
        },
      }),
    );
    const res = await app.request(`/${ITEM}/pinned?projectId=${PROJECT}`);
    expect(await res.json()).toEqual({ itemId: ITEM, version: '2.0.0', via: 'latest' });
    expect(asked).toEqual([PROJECT]);
  });

  test('a flow’s pin whose version doesn’t reach the project is passed over, as a run passes it', async () => {
    const asked: unknown[] = [];
    const referenceScope: ReferenceScopeBinding = {
      reachable: async (input) => {
        asked.push(input);
        return false;
      },
    };
    const pinned = { version: '1.0.0' as Semver, scope: { kind: 'tenant' } as const };
    const flow = mounted('flow', fakeItem('flow', { latest: async () => '0.9.0' }), {
      referenceScope,
    });
    flow.state.resolved = pinned;
    const passed = await flow.app.request(`/${ITEM}/pinned?projectId=${PROJECT}`);
    expect(await passed.json()).toEqual({ itemId: ITEM, version: '0.9.0', via: 'latest' });
    expect(asked).toEqual([
      { tenantId, fromProjectId: PROJECT, ref: { kind: 'flow', id: ITEM, version: '1.0.0' } },
    ]);
    // With no project, and for a tool, the pin is taken as found.
    const noProject = await flow.app.request(`/${ITEM}/pinned`);
    expect(((await noProject.json()) as { via: string }).via).toBe('pinned');
    const tool = mounted('tool', fakeItem('tool'), { referenceScope });
    tool.state.resolved = pinned;
    const toolPin = await tool.app.request(`/${ITEM}/pinned?projectId=${PROJECT}`);
    expect(((await toolPin.json()) as { via: string }).via).toBe('pinned');
    expect(asked).toHaveLength(1);
  });

  test('no version at all is the item’s 404; a malformed id is a 400', async () => {
    const { app } = mounted('flow', fakeItem('flow', { latest: async () => undefined }));
    const missing = await app.request(`/${ITEM}/pinned`);
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('flow-not-found');
    const bad = await app.request(`/${ITEM}/pinned?orgId=nope`);
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe('bad-input');
  });
});

describe('GET /:id/pinned-versions and /:id/pin-history', () => {
  test('every pin, serialized', async () => {
    const { app } = mounted('tool', fakeItem('tool'));
    const body = (await (await app.request(`/${ITEM}/pinned-versions`)).json()) as {
      data: Record<string, unknown>[];
    };
    expect(body.data).toEqual([
      expect.objectContaining({
        itemId: ITEM,
        scope: { kind: 'tenant' },
        version: '1.0.0',
        setBy: { kind: 'user', id: 'u-1' },
      }),
    ]);
  });

  test('the history pages, and a cursor the binding never issued is a 400', async () => {
    const { app, state } = mounted('flow', fakeItem('flow'));
    state.history.nextCursor = 'ok-next' as Cursor;
    const page = (await (await app.request(`/${ITEM}/pin-history?limit=1`)).json()) as {
      data: unknown[];
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('ok-next');
    expect(page.data).toHaveLength(1);
    const bad = await app.request(`/${ITEM}/pin-history?cursor=forged`);
    expect(bad.status).toBe(400);
  });
});

describe('POST /:id/pinned/pin', () => {
  const projectScope = { kind: 'project', projectId: PROJECT };

  test('pins the version for the scope and answers the change', async () => {
    const { app, calls } = mounted('flow', fakeItem('flow'));
    const res = await app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: projectScope, reason: 'hold for the release' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      expect.objectContaining({ itemId: ITEM, action: 'pin', toVersion: '1.0.0' }),
    );
    expect(calls.pin).toEqual([
      {
        tenantId,
        kind: 'flow',
        itemId: ITEM,
        scope: projectScope,
        version: '1.0.0',
        requestedBy: { kind: 'service', id: 'unknown' },
        reason: 'hold for the release',
      },
    ]);
  });

  test('a body that isn’t one, a missing version or an overlong reason is a 400', async () => {
    const { app, calls } = mounted('flow', fakeItem('flow'));
    for (const body of [
      'not json',
      { scope: projectScope },
      { version: '1.0.0', scope: { kind: 'team' } },
      { version: '1.0.0', scope: projectScope, reason: 'x'.repeat(2001) },
    ]) {
      const res = await app.request(
        `/${ITEM}/pinned/pin`,
        typeof body === 'string' ? { ...post({}), body } : post(body),
      );
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('bad-input');
    }
    expect(calls.pin).toEqual([]);
  });

  test('a segment scope is `scope-invalid`: flows and tools pin per project, org or tenant', async () => {
    const { app } = mounted('flow', fakeItem('flow'));
    const res = await app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: { kind: 'segment', projectId: PROJECT, path: [] } }),
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('scope-invalid');
  });

  test('an unknown item is a 404, a deleted one a 410, an inactive version a 404 naming it', async () => {
    const missing = mounted('tool', fakeItem('tool', { state: async () => 'not-found' }));
    const a = await missing.app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: projectScope }),
    );
    expect([a.status, await errorCode(a)]).toEqual([404, 'tool-not-found']);

    const gone = mounted('flow', fakeItem('flow', { state: async () => 'gone' }));
    const b = await gone.app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: projectScope }),
    );
    expect([b.status, await errorCode(b)]).toEqual([410, 'flow-gone']);

    const { app } = mounted('flow', fakeItem('flow'));
    const c = await app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '9.9.9', scope: projectScope }),
    );
    expect(c.status).toBe(404);
    expect(await c.json()).toEqual({
      error: expect.objectContaining({
        code: 'flow-not-found',
        details: { flowId: ITEM, version: '9.9.9' },
      }),
    });
  });

  test('a tool that follows its server is `tool-not-pinnable`, and so is the binding’s refusal', async () => {
    const catalog = mounted('tool', fakeItem('tool', { followsItsServer: async () => true }));
    const a = await catalog.app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: projectScope }),
    );
    expect([a.status, await errorCode(a)]).toEqual([400, 'tool-not-pinnable']);
    expect(catalog.calls.pin).toEqual([]);

    const shipped = mounted('tool', fakeItem('tool'));
    shipped.state.pin = { kind: 'err', error: { code: 'not-pinnable', message: 'runtime tool' } };
    const b = await shipped.app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: projectScope }),
    );
    expect([b.status, await errorCode(b)]).toEqual([400, 'tool-not-pinnable']);
  });

  test('a project that doesn’t reach the item (a flow: the version) is `reference-out-of-scope`', async () => {
    const asked: unknown[] = [];
    const referenceScope: ReferenceScopeBinding = {
      reachable: async (input) => {
        asked.push(input);
        return false;
      },
    };
    const flow = mounted('flow', fakeItem('flow'), { referenceScope });
    const a = await flow.app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: projectScope }),
    );
    expect([a.status, await errorCode(a)]).toEqual([400, 'reference-out-of-scope']);
    const tool = mounted('tool', fakeItem('tool'), { referenceScope });
    await tool.app.request(`/${ITEM}/pinned/pin`, post({ version: '1.0.0', scope: projectScope }));
    expect(asked).toEqual([
      { tenantId, fromProjectId: PROJECT, ref: { kind: 'flow', id: ITEM, version: '1.0.0' } },
      { tenantId, fromProjectId: PROJECT, ref: { kind: 'tool', id: ITEM } },
    ]);
  });

  test('a tool pin on a later environment is `environment-takes-promotions`; a flow pin there is not', async () => {
    const environmentOrders: Pick<EnvironmentOrderBinding, 'orderOf'> = {
      orderOf: async () =>
        ({ projects: [OTHER, PROJECT], position: 1, parent: { kind: 'tenant' } }) as never,
    };
    const tool = mounted('tool', fakeItem('tool'), { environmentOrders });
    const a = await tool.app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: projectScope }),
    );
    expect(a.status).toBe(409);
    expect(await a.json()).toEqual({
      error: expect.objectContaining({
        code: 'environment-takes-promotions',
        details: { firstProjectId: OTHER, position: 1 },
      }),
    });
    expect(tool.calls.pin).toEqual([]);
    const flow = mounted('flow', fakeItem('flow'), { environmentOrders });
    const b = await flow.app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: projectScope }),
    );
    expect(b.status).toBe(200);
  });

  test('a tenant or org pin of an item in an order is `pin-scope-spans-environments`', async () => {
    const itemRights = fakeRights({ inOrder: true });
    const { app, calls } = mounted('flow', fakeItem('flow'), { itemRights });
    for (const scope of [{ kind: 'tenant' }, { kind: 'org', orgId: ORG }]) {
      const res = await app.request(`/${ITEM}/pinned/pin`, post({ version: '1.0.0', scope }));
      expect([res.status, await errorCode(res)]).toEqual([409, 'pin-scope-spans-environments']);
    }
    expect(calls.pin).toEqual([]);
    const project = await app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: projectScope }),
    );
    expect(project.status).toBe(200);
  });
});

describe('POST /:id/pinned/unpin', () => {
  test('removes the scope’s pin; none there is `not-pinned`', async () => {
    const { app, calls, state } = mounted('tool', fakeItem('tool'));
    const ok = await app.request(`/${ITEM}/pinned/unpin`, post({ scope: { kind: 'tenant' } }));
    expect(ok.status).toBe(200);
    expect(calls.unpin).toEqual([
      {
        tenantId,
        kind: 'tool',
        itemId: ITEM,
        scope: { kind: 'tenant' },
        requestedBy: { kind: 'service', id: 'unknown' },
      },
    ]);
    state.unpin = { kind: 'err', error: { code: 'not-pinned', message: 'Nothing pinned here' } };
    const none = await app.request(`/${ITEM}/pinned/unpin`, post({ scope: { kind: 'tenant' } }));
    expect([none.status, await errorCode(none)]).toEqual([409, 'not-pinned']);
  });

  test('an unpin is never refused for its width', async () => {
    const { app } = mounted('flow', fakeItem('flow'), {
      itemRights: fakeRights({ inOrder: true }),
    });
    const res = await app.request(`/${ITEM}/pinned/unpin`, post({ scope: { kind: 'tenant' } }));
    expect(res.status).toBe(200);
  });
});

describe('the rights a pin write asks', () => {
  test('for an item one project serves: `pin` on the item, for a pin and an unpin', async () => {
    const checked: string[] = [];
    const { app } = mounted('tool', fakeItem('tool'), { authorizer: authorizer(checked) });
    await app.request(`/${ITEM}/pinned/pin`, post({ version: '1.0.0', scope: { kind: 'tenant' } }));
    await app.request(`/${ITEM}/pinned/unpin`, post({ scope: { kind: 'tenant' } }));
    expect(checked).toEqual([`pin tool:${ITEM}`, `pin tool:${ITEM}`]);
  });

  test('for an item several projects serve: admin on the scope’s project, or on every project', async () => {
    const checks: ItemCheck[] = [];
    const itemRights = fakeRights({ projects: [PROJECT, OTHER], checks });
    const { app } = mounted('flow', fakeItem('flow'), { authorizer: authorizer([]), itemRights });
    await app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: { kind: 'project', projectId: PROJECT } }),
    );
    await app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: { kind: 'segment', projectId: PROJECT, path: [] } }),
    );
    expect(checks).toEqual([
      { rule: 'on', action: 'admin', projectId: PROJECT },
      { rule: 'every', action: 'admin' },
    ]);
  });

  test('a caller without the right gets the 403 before a segment scope’s 400', async () => {
    const { app, calls } = mounted('flow', fakeItem('flow'), { authorizer: authorizer([], false) });
    const res = await app.request(
      `/${ITEM}/pinned/pin`,
      post({ version: '1.0.0', scope: { kind: 'segment', projectId: PROJECT, path: [] } }),
    );
    expect(res.status).toBe(403);
    expect(calls.pin).toEqual([]);
  });

  test('the reads ask nothing here (the item’s own middleware asks `read`)', async () => {
    const checked: string[] = [];
    const { app } = mounted('flow', fakeItem('flow'), { authorizer: authorizer(checked) });
    await app.request(`/${ITEM}/pinned`);
    await app.request(`/${ITEM}/pin-history`);
    expect(checked).toEqual([]);
  });
});
