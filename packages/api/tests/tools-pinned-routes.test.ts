// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The tools router with pinned versions: the pin routes mount only with
 * `pinnedVersions`; changing a pin needs `pin` on the tool and reading one
 * needs `read`; the tool registry answers what the pin routes ask
 * (registered, gone, an active version, the newest version, a catalog
 * tool); a tool pin on a later environment is refused; and unregistering
 * a pinned version is `409 tool-version-pinned`.
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { ref } from '@kindgi/authz';
import type { ToolManifest } from '@kindgi/tools';
import type { PinScope, ProjectId, Semver, TenantId, Timestamp, ToolId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import type { EnvironmentOrderBinding } from '../src/environment-orders-binding.js';
import { createApp } from '../src/index.js';
import type {
  PinnedVersionBinding,
  PinnedVersionChange,
  RunHandlerBinding,
  TokenResolver,
  ToolRegistryBinding,
  ToolVersionRow,
} from '../src/index.js';
import type { Authorizer } from '../src/middleware/authorize.js';
import { toolsRouter } from '../src/routes/tools.js';
import type { AppEnv } from '../src/types.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID();
const TOKEN = 'tools-pinned-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: userId as never } : null;
const TOOL = 'acme.lookup-order';
const FIRST = randomUUID() as ProjectId;
const LATER = randomUUID() as ProjectId;

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

function toolAt(
  version: string,
  over: { unregisteredAt?: string; metadata?: Record<string, unknown> } = {},
): ToolVersionRow {
  return {
    id: TOOL,
    version,
    description: 'Look up an order',
    input: { type: 'object' },
    output: { type: 'object' },
    ...over,
  } as unknown as ToolManifest as ToolVersionRow;
}

/**
 * A tool with these versions (the last one newest); `retired` → none
 * active, the head kept. Unregistering a version in `pinnedIn` is refused
 * with those scopes.
 */
function toolRegistry(
  versions: readonly ToolVersionRow[],
  options: { retired?: boolean; pinnedIn?: readonly PinScope[] } = {},
): ToolRegistryBinding {
  const active = versions.filter((v) => v.unregisteredAt === undefined);
  return {
    list: unused,
    // Active versions only, as `listVersions` answers with no flag.
    async listVersions({ toolId }: { toolId: ToolId }) {
      return { data: toolId === TOOL ? active : [] };
    },
    resolve: unused,
    publish: unused,
    reinstateVersion: unused,
    async get({ toolId }: { toolId: ToolId }) {
      return toolId === TOOL && options.retired !== true ? (active.at(-1) ?? null) : null;
    },
    async headExists({ toolId }: { toolId: ToolId }) {
      return toolId === TOOL;
    },
    async getVersion({ toolId, version }: { toolId: ToolId; version: Semver }) {
      if (toolId !== TOOL) return null;
      return versions.find((v) => v.version === (version as unknown as string)) ?? null;
    },
    async unregister() {
      return options.pinnedIn !== undefined
        ? { unregistered: false, pinned: options.pinnedIn }
        : { unregistered: true };
    },
  } as unknown as ToolRegistryBinding;
}

function change(over: Partial<PinnedVersionChange> = {}): PinnedVersionChange {
  return {
    id: randomUUID(),
    kind: 'tool',
    itemId: TOOL,
    scope: { kind: 'tenant' },
    action: 'pin',
    fromVersion: null,
    toVersion: '1.0.0' as Semver,
    requestedBy: { kind: 'user', id: userId },
    createdAt: '2026-10-27T05:00:00.000Z' as Timestamp,
    ...over,
  };
}

/** A pinned-version binding with no pins: it records each pin. */
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

function app(registry: ToolRegistryBinding, pinnedVersions?: PinnedVersionBinding) {
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    toolRegistry: registry,
    ...(pinnedVersions !== undefined && { pinnedVersions }),
  });
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const tenantPin = { version: '1.0.0', scope: { kind: 'tenant' } };

describe('mounting', () => {
  test('without pinnedVersions, the pin routes are not mounted', async () => {
    const res = await app(toolRegistry([toolAt('1.0.0')])).request(`/v1/tools/${TOOL}/pinned`, {
      headers: auth,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('route-not-found');
  });

  test('with it, a tool with no pin answers its newest version', async () => {
    const res = await app(toolRegistry([toolAt('1.0.0'), toolAt('1.1.0')]), pins()).request(
      `/v1/tools/${TOOL}/pinned`,
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ itemId: TOOL, version: '1.1.0', via: 'latest' });
  });
});

describe('what the tool registry answers', () => {
  test('a registered, active version is pinned', async () => {
    const binding = pins();
    const res = await app(toolRegistry([toolAt('1.0.0'), toolAt('1.1.0')]), binding).request(
      `/v1/tools/${TOOL}/pinned/pin`,
      post(tenantPin),
    );
    expect(res.status).toBe(200);
    expect(binding.calls).toEqual(['pin 1.0.0']);
  });

  test('an unregistered version is the tool’s 404, naming the version; nothing is pinned', async () => {
    const binding = pins();
    const res = await app(
      toolRegistry([
        toolAt('1.0.0', { unregisteredAt: '2026-10-26T00:00:00.000Z' }),
        toolAt('1.1.0'),
      ]),
      binding,
    ).request(`/v1/tools/${TOOL}/pinned/pin`, post(tenantPin));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('tool-not-found');
    expect(body.error.details).toMatchObject({ toolId: TOOL, version: '1.0.0' });
    expect(binding.calls).toEqual([]);
  });

  test('a retired tool is 410 tool-gone; an unknown one 404', async () => {
    const binding = pins();
    const retired = await app(toolRegistry([toolAt('1.0.0')], { retired: true }), binding).request(
      `/v1/tools/${TOOL}/pinned/pin`,
      post(tenantPin),
    );
    expect(retired.status).toBe(410);
    const unknown = await app(toolRegistry([toolAt('1.0.0')]), binding).request(
      '/v1/tools/acme.other/pinned/pin',
      post(tenantPin),
    );
    expect(unknown.status).toBe(404);
    expect(binding.calls).toEqual([]);
  });

  test('a tool an MCP catalog lists (its `kindgi.mcp` metadata) is 400 tool-not-pinnable', async () => {
    const binding = pins();
    const catalog = toolAt('1.0.0', {
      metadata: { 'kindgi.mcp': { endpointId: 'ep-1', toolName: 'lookup' } },
    });
    const res = await app(toolRegistry([catalog]), binding).request(
      `/v1/tools/${TOOL}/pinned/pin`,
      post(tenantPin),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'tool-not-pinnable',
    );
    expect(binding.calls).toEqual([]);
  });

  test('a pin on a later environment of an order is 409 environment-takes-promotions', async () => {
    const environmentOrders: Pick<EnvironmentOrderBinding, 'orderOf'> = {
      orderOf: async () =>
        ({ projects: [FIRST, LATER], position: 1, parent: { kind: 'tenant' } }) as never,
    };
    const binding = pins();
    const r = new Hono<AppEnv>();
    r.use('*', async (c, next) => {
      c.set('tenantId' as never, tenantId as never);
      c.set('requestId' as never, 'req-tool-pins' as never);
      return next();
    });
    r.route(
      '/',
      toolsRouter(toolRegistry([toolAt('1.0.0')]), undefined, undefined, {
        environmentOrders,
        pinnedVersions: binding,
      }),
    );
    const res = await r.request(`/${TOOL}/pinned/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.0.0', scope: { kind: 'project', projectId: LATER } }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('environment-takes-promotions');
    expect(body.error.details).toEqual({ firstProjectId: FIRST, position: 1 });
    expect(binding.calls).toEqual([]);
  });

  test('unregistering a pinned version is 409 tool-version-pinned, naming the scopes', async () => {
    const res = await app(
      toolRegistry([toolAt('1.0.0')], {
        pinnedIn: [{ kind: 'project', projectId: FIRST }, { kind: 'tenant' }],
      }),
      pins(),
    ).request(`/v1/tools/${TOOL}/versions/1.0.0/unregister`, { method: 'POST', headers: auth });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('tool-version-pinned');
    expect(body.error.details).toEqual({
      toolId: TOOL,
      version: '1.0.0',
      scopes: [{ kind: 'project', projectId: FIRST }, { kind: 'tenant' }],
    });
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
      c.set('requestId' as never, 'req-tool-pins' as never);
      return next();
    });
    r.route(
      '/',
      toolsRouter(toolRegistry([toolAt('1.0.0')]), recordingAuthorizer(checked), undefined, {
        pinnedVersions: pins(),
      }),
    );
    return r;
  }

  const tool = ref('tool', TOOL);
  const on = `${tool.type}:${tool.id}`;

  test.each([
    ['POST', '/pinned/pin', tenantPin, 'pin'],
    ['POST', '/pinned/unpin', { scope: { kind: 'tenant' } }, 'pin'],
    ['GET', '/pinned', undefined, 'read'],
    ['GET', '/pinned-versions', undefined, 'read'],
    ['GET', '/pin-history', undefined, 'read'],
  ])('%s %s → %s on the tool', async (method, path, body, action) => {
    const checked: string[] = [];
    await mounted(checked).request(`/${TOOL}${path}`, {
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
    await mounted(checked).request(`/${TOOL}/versions/1.0.0/unregister`, { method: 'POST' });
    expect(checked).toEqual([`admin ${on}`]);
  });
});
