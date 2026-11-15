// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { type AppEntry, defineApp } from '@kindgi/connections';
import { asana } from '@kindgi/connections/asana';
import { hubspot } from '@kindgi/connections/hubspot';
import { type EnvName, type TenantId, type UserId, makeEnvName } from '@kindgi/types';

import type { ConnectionRecord } from '../src/connection-binding.js';
import {
  type MCPEndpoint,
  type MCPEndpointRegisterInput,
  type MCPEndpointRegistryBinding,
  type TokenResolver,
  createApp,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';
import { noopConnections, noopRunHandler } from './support/full-app.js';
import { validateAgainst } from './support/openapi-schema.js';

/**
 * An MCP endpoint that signs in with a connection (`auth.scheme:
 * 'connection'`): checked against the server's entries and connections,
 * with no secret stored, and the binding's metadata check passed through.
 */

const tenantId = randomUUID() as TenantId;
const ENV = makeEnvName('local') as EnvName;
const ANA = 'user-ana';
const BEN = 'user-ben';
const TOKENS: Record<string, Awaited<ReturnType<TokenResolver>>> = {
  ana: { tenantId, userId: ANA as UserId },
  bot: { tenantId, serviceAccountId: 'sa-bot' },
};
const resolveToken: TokenResolver = async (token) => TOKENS[token] ?? null;

/** An app with no MCP server, and one that connects only a person. */
const plain: AppEntry = defineApp({
  id: 'acme-crm',
  name: 'Acme CRM',
  signIn: {
    kind: 'oauth2',
    authorizeUrl: 'https://crm.acme.test/authorize',
    tokenUrl: 'https://crm.acme.test/token',
    pkce: 'S256',
  },
  owners: ['member', 'company'],
  permissions: { 'crm.read': { grants: 'crm.read', says: 'Read your records', changes: false } },
  account: { kind: 'none' },
  removal: {},
  setupGuide: '/guides/connections/acme-crm/',
});
const personOnly: AppEntry = defineApp({
  ...plain,
  id: 'acme-notes',
  name: 'Acme Notes',
  owners: ['member'],
  mcpServers: [
    {
      origin: 'https://mcp.notes.acme.test',
      resource: 'https://mcp.notes.acme.test',
      issuer: 'https://mcp.notes.acme.test',
    },
  ],
});

const at = '2026-11-15T12:00:00.000Z';
function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    connectionId: randomUUID(),
    tenantId,
    envName: ENV,
    appId: randomUUID(),
    app: 'hubspot',
    owner: { kind: 'member', userId: ANA },
    account: { id: ANA, label: 'HubSpot' },
    permissions: ['mcp.tools'],
    state: 'working',
    connectedAt: at,
    createdAt: at,
    createdBy: ANA,
    updatedAt: at,
    ...overrides,
  };
}

const anas = connection();
const company = connection({
  owner: { kind: 'company' },
  account: { id: 'company', label: 'HubSpot' },
});
const bens = connection({ owner: { kind: 'member', userId: BEN } });
const removed = connection({ state: 'removed' });
const otherEnv = connection({ envName: makeEnvName('staging') as EnvName });
const anasAsana = connection({ app: 'asana', account: { id: ANA, label: 'Asana' } });
const CONNECTIONS = new Map(
  [anas, company, bens, removed, otherEnv, anasAsana].map((c) => [c.connectionId, c]),
);

function makeApp(
  options: {
    readonly connections?: boolean;
    readonly metadata?: 'ok' | 'issuer-mismatch';
  } = {},
) {
  const store = new Map<string, MCPEndpoint>();
  const registered: MCPEndpointRegisterInput[] = [];
  const binding: MCPEndpointRegistryBinding = {
    list: async () => ({ data: [...store.values()] }),
    get: async ({ endpointId }) => store.get(endpointId) ?? null,
    async register(input) {
      registered.push(input);
      if (options.metadata === 'issuer-mismatch') {
        return {
          kind: 'resource-metadata-refused',
          endpointId: input.endpoint.endpointId,
          reason: 'issuer-mismatch',
          message: `endpoint "${input.endpoint.endpointId}": its Protected Resource Metadata names https://login.acme.test, not ${input.mcpServer?.issuer}`,
        };
      }
      store.set(input.endpoint.endpointId, input.endpoint);
      return { kind: 'ok', endpointId: input.endpoint.endpointId };
    },
    unregister: async ({ endpointId }) => ({ unregistered: store.delete(endpointId) }),
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: noopRunHandler,
    mcpEndpointRegistry: binding,
    tenantHostAccess: 'local',
    envName: ENV,
    ...(options.connections !== false && {
      connections: {
        ...noopConnections,
        entries: () => [hubspot, asana, plain, personOnly],
        get: async ({ tenantId: tenant, connectionId }) => {
          const found = CONNECTIONS.get(connectionId);
          return found !== undefined && found.tenantId === tenant ? found : null;
        },
      },
    }),
  });
  return { app, registered };
}

const endpoint = (overrides: Record<string, unknown> = {}) => ({
  endpointId: 'acme-hubspot',
  name: 'HubSpot',
  transport: 'streamable-http',
  config: { transport: 'streamable-http', url: 'https://mcp.hubspot.com' },
  auth: { scheme: 'connection', app: 'hubspot', as: 'person' },
  catalogConnectionId: anas.connectionId,
  scopeKind: 'tenant',
  ...overrides,
});

const post = (app: ReturnType<typeof makeApp>['app'], body: unknown, token = 'ana') =>
  app.request('/v1/mcp/endpoints', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const refusal = async (res: Response) => {
  const error = (
    (await res.json()) as {
      error: { code: string; message: string; details?: { reason?: string } };
    }
  ).error;
  return [res.status, error.code, error.details?.reason];
};

describe('an MCP endpoint that signs in with a connection', () => {
  test("registers with the entry's server, and reads back as registered, with no secret", async () => {
    const { app, registered } = makeApp();
    const res = await post(app, endpoint());
    expect(res.status).toBe(201);
    expect(registered[0]?.mcpServer).toEqual(hubspot.mcpServers?.[0]);
    expect(registered[0]?.endpoint.secretScopes).toBeUndefined();

    const read = await app.request('/v1/mcp/endpoints/acme-hubspot', {
      headers: { authorization: 'Bearer ana' },
    });
    const body = await read.json();
    expect(body).toMatchObject({
      auth: { scheme: 'connection', app: 'hubspot', as: 'person' },
      catalogConnectionId: anas.connectionId,
    });
    expect(validateAgainst('MCPEndpoint', body)).toEqual([]);
  });

  test("takes the entry's permissions, the company's account, and Asana's v2 server", async () => {
    const { app, registered } = makeApp();
    const res = await post(
      app,
      endpoint({
        endpointId: 'acme-asana',
        config: { transport: 'streamable-http', url: 'https://mcp.asana.com/v2/mcp' },
        auth: { scheme: 'connection', app: 'asana', as: 'company', permissions: ['mcp.tools'] },
        catalogConnectionId: anasAsana.connectionId,
      }),
    );
    expect(res.status).toBe(201);
    expect(registered[0]?.mcpServer).toEqual({
      origin: 'https://mcp.asana.com',
      resource: 'https://mcp.asana.com/v2',
      issuer: 'https://mcp.asana.com',
    });
    expect(registered[0]?.endpoint.auth).toEqual({
      scheme: 'connection',
      app: 'asana',
      as: 'company',
      permissions: ['mcp.tools'],
    });
  });

  test("lists tools with the company's connection, whoever registers", async () => {
    const { app } = makeApp();
    const res = await post(app, endpoint({ catalogConnectionId: company.connectionId }), 'bot');
    expect(res.status).toBe(201);
  });

  test.each([
    [
      'an app the server has no entry for',
      { auth: { scheme: 'connection', app: 'acme-none', as: 'person' } },
      'unknown-app',
    ],
    [
      'an app with no MCP server',
      { auth: { scheme: 'connection', app: 'acme-crm', as: 'person' } },
      'origin-not-listed',
    ],
    [
      "a URL on another origin than the entry's",
      { config: { transport: 'streamable-http', url: 'https://mcp.acme.test/hubspot' } },
      'origin-not-listed',
    ],
    [
      "the entry's host on another port",
      { config: { transport: 'streamable-http', url: 'https://mcp.hubspot.com:8443/' } },
      'origin-not-listed',
    ],
    [
      'an SSE stream on another origin',
      {
        transport: 'http-sse',
        config: {
          transport: 'http-sse',
          url: 'https://mcp.hubspot.com/messages',
          sseUrl: 'https://sse.acme.test/stream',
        },
      },
      'origin-not-listed',
    ],
    [
      "an owner the entry doesn't allow",
      {
        config: { transport: 'streamable-http', url: 'https://mcp.notes.acme.test/mcp' },
        auth: { scheme: 'connection', app: 'acme-notes', as: 'company' },
      },
      'owner-not-allowed',
    ],
    [
      "a permission that isn't the entry's",
      { auth: { scheme: 'connection', app: 'hubspot', as: 'person', permissions: ['crm.read'] } },
      'unknown-permission',
    ],
    ['no catalog connection', { catalogConnectionId: undefined }, 'catalog-connection-required'],
    [
      'a catalog connection that is no UUID',
      { catalogConnectionId: 'anas' },
      'invalid-catalog-connection-id',
    ],
    [
      'a catalog connection that is unknown',
      { catalogConnectionId: randomUUID() },
      'catalog-connection-not-found',
    ],
    [
      'a removed catalog connection',
      { catalogConnectionId: removed.connectionId },
      'catalog-connection-not-found',
    ],
    [
      'a catalog connection under another env',
      { catalogConnectionId: otherEnv.connectionId },
      'catalog-connection-not-found',
    ],
    [
      'a catalog connection to another app',
      { catalogConnectionId: anasAsana.connectionId },
      'catalog-connection-not-found',
    ],
    [
      "another person's catalog connection",
      { catalogConnectionId: bens.connectionId },
      'catalog-connection-not-yours',
    ],
    [
      'a catalog connection without a connection auth',
      { auth: undefined },
      'catalog-connection-without-connection-auth',
    ],
    [
      'an unknown field',
      { auth: { scheme: 'connection', app: 'hubspot', as: 'person', resource: 'x' } },
      'invalid-auth',
    ],
    [
      "an owner that's neither",
      { auth: { scheme: 'connection', app: 'hubspot', as: 'team' } },
      'invalid-auth',
    ],
    ['no app', { auth: { scheme: 'connection', as: 'person' } }, 'invalid-auth'],
    [
      'no permission',
      { auth: { scheme: 'connection', app: 'hubspot', as: 'person', permissions: [] } },
      'invalid-auth',
    ],
    [
      'a permission twice',
      {
        auth: {
          scheme: 'connection',
          app: 'hubspot',
          as: 'person',
          permissions: ['mcp.tools', 'mcp.tools'],
        },
      },
      'invalid-auth',
    ],
    [
      'a bearer as well',
      { secretRef: { envName: 'local', name: 'HUBSPOT_TOKEN' } },
      'auth-with-secret-ref',
    ],
    [
      'an Authorization header in config',
      {
        config: {
          transport: 'streamable-http',
          url: 'https://mcp.hubspot.com',
          headers: { Authorization: 'Bearer x' },
        },
      },
      undefined,
    ],
    [
      'a stdio server',
      { transport: 'stdio', config: { transport: 'stdio', command: '/usr/local/bin/hubspot-mcp' } },
      'auth-on-stdio',
    ],
  ])('refuses %s', async (_what, overrides, reason) => {
    const { app, registered } = makeApp();
    const body = Object.fromEntries(
      Object.entries(endpoint(overrides)).filter(([, value]) => value !== undefined),
    );
    const [status, code, got] = await refusal(await post(app, body));
    expect([status, code]).toEqual([400, 'invalid-mcp-endpoint']);
    if (reason !== undefined) expect(got).toBe(reason);
    expect(registered).toEqual([]);
  });

  test('refuses every connection auth on a server with no connections', async () => {
    const { app } = makeApp({ connections: false });
    expect(await refusal(await post(app, endpoint()))).toEqual([
      400,
      'invalid-mcp-endpoint',
      'unknown-app',
    ]);
  });

  test("answers the binding's metadata refusal with its reason, naming no token", async () => {
    const { app } = makeApp({ metadata: 'issuer-mismatch' });
    const res = await post(app, endpoint());
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { reason?: string } };
    };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('invalid-mcp-endpoint');
    expect(body.error.details?.reason).toBe('issuer-mismatch');
    expect(body.error.message).toContain('https://mcp.hubspot.com');
  });
});
