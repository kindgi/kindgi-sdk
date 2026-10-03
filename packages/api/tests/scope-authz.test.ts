// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The authorization middleware must check the scope the handler acts on.
 * Each route derives its scope once — `?scopeKind` + `?scopeId`, or the
 * body where the route takes it from there — and both the check and the
 * handler use that derivation. Parameters outside the wire contract
 * (`?projectId`, `?orgId`, `body.projectId` on MCP register) never steer
 * the check.
 */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { Authorizer } from '../src/middleware/authorize.js';
import { agentsRouter } from '../src/routes/agents.js';
import { envRouter } from '../src/routes/env.js';
import { evalSuitesRouter } from '../src/routes/eval-suites.js';
import { flowsRouter } from '../src/routes/flows.js';
import { guardrailsRouter } from '../src/routes/guardrails.js';
import { mcpRouter } from '../src/routes/mcp.js';
import { secretsRouter } from '../src/routes/secrets.js';
import { toolsRouter } from '../src/routes/tools.js';
import type { AppEnv } from '../src/types.js';

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const A = 'proj-a';
const B = 'proj-b';

interface Call {
  readonly method: string;
  readonly input: { readonly scope?: unknown };
}

/** Grants exactly `allowed` (`type:id` keys); records every checked resource. */
function authorizerGranting(allowed: readonly string[], checked: string[]): Authorizer {
  return {
    authorize: (_action, getResource) => async (c, next) => {
      const r = await getResource(c);
      const key = `${r.type}:${r.id}`;
      checked.push(key);
      if (!allowed.includes(key)) {
        c.status(403);
        return c.json({ code: 'forbidden', resource: key });
      }
      return next();
    },
    can: async () => false,
    check: async () => {
      throw new Error('not used by these routes');
    },
    filterByCan: async () => [],
  };
}

/**
 * A binding whose every method records its input. `list` returns an empty
 * page; every other method returns a failure.
 */
function recordingBinding(calls: Call[]): never {
  return new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'then'
          ? undefined
          : async (input: Call['input']) => {
              calls.push({ method: String(prop), input });
              return prop === 'list'
                ? { data: [] }
                : { kind: 'err', error: { code: 'bad-input', message: 'stub' } };
            },
    },
  ) as never;
}

function mount(router: Hono<AppEnv>, capabilities: readonly string[]): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, TENANT as never);
    c.set('requestId' as never, 'req-scope-authz' as never);
    c.set('capabilities' as never, capabilities as never);
    return next();
  });
  app.route('/', router);
  return app;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const projectScope = (projectId: string) => ({ kind: 'project', tenantId: TENANT, projectId });

describe('env — the check uses ?scopeKind + ?scopeId', () => {
  function setup(allowed: readonly string[]) {
    const checked: string[] = [];
    const calls: Call[] = [];
    const app = mount(envRouter(recordingBinding(calls), authorizerGranting(allowed, checked)), [
      'env:write',
    ]);
    return { app, checked, calls };
  }

  test.each([
    ['PUT', '/K', json('PUT', { value: 'x' })],
    ['GET', '/K', { method: 'GET' }],
    ['DELETE', '/K', { method: 'DELETE' }],
    ['GET', '/', { method: 'GET' }],
  ] as const)(
    '%s %s: ?projectId=A cannot authorize a request for scopeId=B',
    async (_m, path, init) => {
      const { app, checked, calls } = setup([`project:${A}`]);
      const res = await app.request(
        `${path}?envName=staging&scopeKind=project&scopeId=${B}&projectId=${A}`,
        init,
      );
      expect(res.status).toBe(403);
      expect(checked).toEqual([`project:${B}`]);
      expect(calls).toEqual([]);
    },
  );

  test('a project admin can write its project (the client request shape)', async () => {
    const { app, checked, calls } = setup([`project:${A}`]);
    const res = await app.request(
      `/K?envName=staging&scopeKind=project&scopeId=${A}`,
      json('PUT', { value: 'x' }),
    );
    expect(res.status).not.toBe(403);
    expect(checked).toEqual([`project:${A}`]);
    expect(calls.map((c) => c.input.scope)).toEqual([projectScope(A)]);
  });
});

describe('secrets — query routes use ?scopeKind + ?scopeId', () => {
  test.each([
    ['GET', '/K'],
    ['DELETE', '/K'],
    ['GET', '/K/versions'],
    ['GET', '/'],
  ] as const)(
    '%s %s: ?projectId=A cannot authorize a request for scopeId=B',
    async (method, path) => {
      const checked: string[] = [];
      const calls: Call[] = [];
      const app = mount(
        secretsRouter({
          secretsBinding: recordingBinding(calls),
          rotationStatusStore: recordingBinding([]),
          authorizer: authorizerGranting([`project:${A}`], checked),
        }),
        ['secrets:revoke'],
      );
      const res = await app.request(
        `${path}?envName=staging&scopeKind=project&scopeId=${B}&projectId=${A}`,
        { method },
      );
      expect(res.status).toBe(403);
      expect(checked).toEqual([`project:${B}`]);
      expect(calls).toEqual([]);
    },
  );
});

describe('secrets rotate — the check and the handler resolve the same scope', () => {
  function setup(allowed: readonly string[]) {
    const checked: string[] = [];
    const calls: Call[] = [];
    const app = mount(
      secretsRouter({
        secretsBinding: recordingBinding(calls),
        rotationStatusStore: recordingBinding([]),
        authorizer: authorizerGranting(allowed, checked),
      }),
      ['secrets:rotate'],
    );
    return { app, checked, calls };
  }

  test('body scope B with query scope A: denied for a project-A admin', async () => {
    const { app, checked, calls } = setup([`project:${A}`]);
    const res = await app.request(
      `/K/rotate?envName=staging&scopeKind=project&scopeId=${A}&projectId=${A}`,
      json('POST', { scope: { kind: 'project', projectId: B }, newValue: 'v' }),
    );
    expect(res.status).toBe(403);
    expect(checked).toEqual([`tenant:${TENANT}`]);
    expect(calls).toEqual([]);
  });

  test('body scope B with query scope A: scope-mismatch for a tenant admin', async () => {
    const { app, calls } = setup([`tenant:${TENANT}`]);
    const res = await app.request(
      `/K/rotate?envName=staging&scopeKind=project&scopeId=${A}`,
      json('POST', { scope: { kind: 'project', projectId: B }, newValue: 'v' }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('scope-mismatch');
    expect(calls).toEqual([]);
  });

  test('body-only scope (the OpenAPI shape) is what gets checked', async () => {
    const denied = setup([`project:${A}`]);
    const body = json('POST', { envName: 'staging', scope: { kind: 'project', projectId: B } });
    expect((await denied.app.request('/K/rotate', body)).status).toBe(403);
    expect(denied.calls).toEqual([]);

    const allowed = setup([`project:${B}`]);
    const res = await allowed.app.request(
      '/K/rotate',
      json('POST', { envName: 'staging', scope: { kind: 'project', projectId: B } }),
    );
    expect(res.status).not.toBe(403);
    expect(allowed.checked).toEqual([`project:${B}`]);
    expect(allowed.calls.map((c) => c.input.scope)).toEqual([projectScope(B)]);
  });

  test('query and body naming the same scope (the client shape) is allowed', async () => {
    const { app, checked, calls } = setup([`project:${A}`]);
    const res = await app.request(
      `/K/rotate?envName=staging&scopeKind=project&scopeId=${A}`,
      json('POST', { scope: { kind: 'project', projectId: A } }),
    );
    expect(res.status).not.toBe(403);
    expect(checked).toEqual([`project:${A}`]);
    expect(calls.map((c) => c.input.scope)).toEqual([projectScope(A)]);
  });

  test('an empty body falls back to the query scope', async () => {
    const { app, checked, calls } = setup([`project:${A}`]);
    const res = await app.request(`/K/rotate?envName=staging&scopeKind=project&scopeId=${A}`, {
      method: 'POST',
    });
    expect(res.status).not.toBe(403);
    expect(checked).toEqual([`project:${A}`]);
    expect(calls.map((c) => c.input.scope)).toEqual([projectScope(A)]);
  });

  test('body envName must match query envName', async () => {
    const { app, calls } = setup([`project:${A}`]);
    const res = await app.request(
      `/K/rotate?envName=staging&scopeKind=project&scopeId=${A}`,
      json('POST', { envName: 'production' }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'env-name-mismatch',
    );
    expect(calls).toEqual([]);
  });
});

describe('secrets create — the check uses body.scope', () => {
  test('a project-A admin cannot create in project B', async () => {
    const checked: string[] = [];
    const calls: Call[] = [];
    const app = mount(
      secretsRouter({
        secretsBinding: recordingBinding(calls),
        rotationStatusStore: recordingBinding([]),
        authorizer: authorizerGranting([`project:${A}`], checked),
      }),
      ['secrets:write'],
    );
    const res = await app.request(
      `/?scopeKind=project&scopeId=${A}`,
      json('POST', {
        envName: 'staging',
        name: 'K',
        value: 'v',
        scope: { kind: 'project', projectId: B },
      }),
    );
    expect(res.status).toBe(403);
    expect(checked).toEqual([`project:${B}`]);
    expect(calls).toEqual([]);
  });
});

describe('MCP register — the check uses body.scopeKind + body.scopeId', () => {
  const endpoint = {
    endpointId: 'weather.http',
    name: 'Weather',
    transport: 'streamable-http',
    config: { transport: 'streamable-http', url: 'https://mcp.example.com/weather' },
  };
  function setup(allowed: readonly string[]) {
    const checked: string[] = [];
    const calls: Call[] = [];
    const app = mount(
      mcpRouter(recordingBinding(calls), undefined, authorizerGranting(allowed, checked), {
        hostAccess: 'deployed',
      }),
      [],
    );
    return { app, checked, calls };
  }

  test('body.projectId=A cannot authorize a registration in scopeId=B', async () => {
    const { app, checked, calls } = setup([`project:${A}`]);
    const res = await app.request(
      '/endpoints',
      json('POST', { ...endpoint, scopeKind: 'project', scopeId: B, projectId: A }),
    );
    expect(res.status).toBe(403);
    expect(checked).toEqual([`project:${B}`]);
    expect(calls).toEqual([]);
  });

  test('a project admin can register in its project', async () => {
    const { app, checked, calls } = setup([`project:${A}`]);
    const res = await app.request(
      '/endpoints',
      json('POST', { ...endpoint, scopeKind: 'project', scopeId: A }),
    );
    expect(res.status).not.toBe(403);
    expect(checked).toEqual([`project:${A}`]);
    expect(calls.map((c) => c.input.scope)).toEqual([projectScope(A)]);
  });
});

describe('registry lists — a project filter needs read on that project', () => {
  const routers: ReadonlyArray<readonly [string, (a: Authorizer) => Hono<AppEnv>]> = [
    ['agents', (a) => agentsRouter(recordingBinding([]), a)],
    ['flows', (a) => flowsRouter(recordingBinding([]), a)],
    ['tools', (a) => toolsRouter(recordingBinding([]), a)],
    ['guardrails', (a) => guardrailsRouter(recordingBinding([]), a)],
    ['eval-suites', (a) => evalSuitesRouter(recordingBinding([]), a)],
  ];

  test.each(routers)('%s: ?scopeKind=project&scopeId= is checked', async (_name, make) => {
    const checked: string[] = [];
    const app = mount(make(authorizerGranting([`project:${A}`], checked)), []);
    expect((await app.request(`/?scopeKind=project&scopeId=${B}`)).status).toBe(403);
    expect((await app.request(`/?scopeKind=project&scopeId=${A}`)).status).not.toBe(403);
    expect(checked).toEqual([`project:${B}`, `project:${A}`]);
  });

  test.each(routers)('%s: an unfiltered list is not project-checked', async (_name, make) => {
    const checked: string[] = [];
    const app = mount(make(authorizerGranting([], checked)), []);
    expect((await app.request('/')).status).not.toBe(403);
    expect(checked).toEqual([]);
  });
});
