// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The flows router with pinned versions: the pin routes mount only with
 * `pinnedVersions`; changing a pin needs `pin` on the flow and reading one
 * needs `read`; the flow registry answers what the pin routes ask
 * (registered, gone, an active version, the newest version); and
 * unregistering a pinned version is `409 flow-version-pinned`.
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { ref } from '@kindgi/authz';
import type { Flow } from '@kindgi/flow';
import type { FlowId, PinScope, Semver, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  FlowRegistryBinding,
  FlowVersionRecord,
  PinnedVersionBinding,
  PinnedVersionChange,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import type { Authorizer } from '../src/middleware/authorize.js';
import { flowsRouter } from '../src/routes/flows.js';
import type { AppEnv } from '../src/types.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID();
const TOKEN = 'flows-pinned-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: userId as never } : null;
const FLOW = 'acme.ticket-triage';

const notUsed = async () => ({
  kind: 'err' as const,
  error: { code: 'bad-input' as const, message: 'not used in this suite' },
});
const runHandler: RunHandlerBinding = {
  invokeAgent: notUsed,
  invokeFlow: notUsed,
  resumeRun: notUsed,
};
const unused = async (): Promise<never> => {
  throw new Error('not used in this suite');
};

function flowAt(version: string, unregisteredAt?: string): FlowVersionRecord {
  return {
    id: FLOW,
    version,
    nodes: [],
    edges: [],
    ...(unregisteredAt !== undefined && { unregisteredAt }),
  } as unknown as Flow as FlowVersionRecord;
}

/**
 * A flow with these versions (the last one newest); `retired` → none
 * active, the head kept. Unregistering a version in `pinnedIn` is refused
 * with those scopes.
 */
function flowRegistry(
  versions: readonly FlowVersionRecord[],
  retired = false,
  pinnedIn?: readonly PinScope[],
): FlowRegistryBinding {
  const active = versions.filter((v) => v.unregisteredAt === undefined);
  return {
    list: unused,
    listVersions: unused,
    publish: unused,
    async unregister() {
      return pinnedIn !== undefined
        ? { unregistered: false, pinned: pinnedIn }
        : { unregistered: true };
    },
    reinstateVersion: unused,
    async get({ flowId }: { flowId: FlowId }) {
      return flowId === FLOW && !retired ? (active.at(-1) ?? null) : null;
    },
    async headExists({ flowId }: { flowId: FlowId }) {
      return flowId === FLOW;
    },
    async getVersion({ flowId, version }: { flowId: FlowId; version: string }) {
      return flowId === FLOW ? (versions.find((v) => v.version === version) ?? null) : null;
    },
  } as unknown as FlowRegistryBinding;
}

function change(over: Partial<PinnedVersionChange> = {}): PinnedVersionChange {
  return {
    id: randomUUID(),
    kind: 'flow',
    itemId: FLOW,
    scope: { kind: 'tenant' },
    action: 'pin',
    fromVersion: null,
    toVersion: '1.0.0' as Semver,
    requestedBy: { kind: 'user', id: userId },
    createdAt: '2026-10-27T05:00:00.000Z' as Timestamp,
    ...over,
  };
}

/** A pinned-version binding with no pins: it records each pin and unpin. */
function pins(): PinnedVersionBinding & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve: async () => null,
    list: async () => [],
    history: async () => ({ data: [] }),
    async pin(input) {
      calls.push(`pin ${input.version}`);
      return {
        kind: 'ok',
        value: { change: change({ toVersion: input.version }), unchanged: false },
      };
    },
    async unpin() {
      calls.push('unpin');
      return { kind: 'err', error: { code: 'not-pinned', message: 'No pin of its own.' } };
    },
  };
}

function app(registry: FlowRegistryBinding, pinnedVersions?: PinnedVersionBinding) {
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    flowRegistry: registry,
    ...(pinnedVersions !== undefined && { pinnedVersions }),
  });
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('mounting', () => {
  test('without pinnedVersions, the pin routes are not mounted', async () => {
    const res = await app(flowRegistry([flowAt('1.0.0')])).request(`/v1/flows/${FLOW}/pinned`, {
      headers: auth,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('route-not-found');
  });

  test('with it, a flow with no pin answers its newest version', async () => {
    const res = await app(flowRegistry([flowAt('1.0.0'), flowAt('1.1.0')]), pins()).request(
      `/v1/flows/${FLOW}/pinned`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ itemId: FLOW, version: '1.1.0', via: 'latest' });
  });
});

describe('what the flow registry answers', () => {
  test('a registered, active version is pinned', async () => {
    const binding = pins();
    const res = await app(flowRegistry([flowAt('1.0.0'), flowAt('1.1.0')]), binding).request(
      `/v1/flows/${FLOW}/pinned/pin`,
      post({ version: '1.0.0', scope: { kind: 'tenant' } }),
    );
    expect(res.status).toBe(200);
    expect(binding.calls).toEqual(['pin 1.0.0']);
  });

  test('an unregistered version is the flow’s 404, naming the version; nothing is pinned', async () => {
    const binding = pins();
    const res = await app(
      flowRegistry([flowAt('1.0.0', '2026-10-26T00:00:00.000Z'), flowAt('1.1.0')]),
      binding,
    ).request(
      `/v1/flows/${FLOW}/pinned/pin`,
      post({ version: '1.0.0', scope: { kind: 'tenant' } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('flow-not-found');
    expect(body.error.details).toMatchObject({ flowId: FLOW, version: '1.0.0' });
    expect(binding.calls).toEqual([]);
  });

  test('a retired flow is 410 flow-gone; an unknown one 404', async () => {
    const binding = pins();
    const retired = await app(flowRegistry([flowAt('1.0.0')], true), binding).request(
      `/v1/flows/${FLOW}/pinned/pin`,
      post({ version: '1.0.0', scope: { kind: 'tenant' } }),
    );
    expect(retired.status).toBe(410);
    const unknown = await app(flowRegistry([flowAt('1.0.0')]), binding).request(
      '/v1/flows/acme.other/pinned/pin',
      post({ version: '1.0.0', scope: { kind: 'tenant' } }),
    );
    expect(unknown.status).toBe(404);
    expect(binding.calls).toEqual([]);
  });

  test('unregistering a pinned version is 409 flow-version-pinned, naming the scopes', async () => {
    const projectId = randomUUID();
    const res = await app(
      flowRegistry([flowAt('1.0.0')], false, [{ kind: 'project', projectId: projectId as never }]),
      pins(),
    ).request(`/v1/flows/${FLOW}/versions/1.0.0/unregister`, { method: 'POST', headers: auth });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('flow-version-pinned');
    expect(body.error.details).toEqual({
      flowId: FLOW,
      version: '1.0.0',
      scopes: [{ kind: 'project', projectId }],
    });
  });

  test('an unpin with no pin of its own is 409 not-pinned', async () => {
    const res = await app(flowRegistry([flowAt('1.0.0')]), pins()).request(
      `/v1/flows/${FLOW}/pinned/unpin`,
      post({ scope: { kind: 'tenant' } }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not-pinned');
  });
});

describe('authorization: changing a pin needs pin; reading one needs read', () => {
  function recordingAuthorizer(checked: string[]): Authorizer {
    return {
      authorize: (action, getResource) => async (c, next) => {
        const r = await getResource(c);
        checked.push(`${action} ${r.type}:${r.id}`);
        return next();
      },
      can: async () => false,
      canFor: async () => {
        throw new Error('unused');
      },
      check: async () => {
        throw new Error('unused');
      },
      filterByCan: async () => [],
    };
  }

  function mounted(checked: string[]) {
    const r = new Hono<AppEnv>();
    r.use('*', async (c, next) => {
      c.set('tenantId' as never, tenantId as never);
      c.set('requestId' as never, 'req-flow-pins' as never);
      return next();
    });
    r.route(
      '/',
      flowsRouter(
        flowRegistry([flowAt('1.0.0')]),
        recordingAuthorizer(checked),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        pins(),
      ),
    );
    return r;
  }

  const flow = ref('flow', FLOW);
  const on = `${flow.type}:${flow.id}`;

  test.each([
    ['POST', '/pinned/pin', { version: '1.0.0', scope: { kind: 'tenant' } }, 'pin'],
    ['POST', '/pinned/unpin', { scope: { kind: 'tenant' } }, 'pin'],
    ['GET', '/pinned', undefined, 'read'],
    ['GET', '/pinned-versions', undefined, 'read'],
    ['GET', '/pin-history', undefined, 'read'],
  ])('%s %s → %s on the flow', async (method, path, body, action) => {
    const checked: string[] = [];
    await mounted(checked).request(`/${FLOW}${path}`, {
      method,
      ...(body !== undefined && {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    expect(checked).toEqual([`${action} ${on}`]);
  });

  test('unregistering a version still needs admin', async () => {
    const checked: string[] = [];
    await mounted(checked).request(`/${FLOW}/versions/1.0.0/unregister`, { method: 'POST' });
    expect(checked).toEqual([`admin ${on}`]);
  });
});
