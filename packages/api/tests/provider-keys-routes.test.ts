// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A model provider's key is used by its provider only, refused where it's
 * named:
 *
 * - a tool declaring it (`needsSpec.secrets`) or sending it (an HTTP
 *   spec's `authorization.secretRef`): `POST /v1/tools` answers 400;
 * - an MCP endpoint's or a webhook endpoint's `secretRef`: 400;
 * - a provider registered with a key that a tool or an endpoint already
 *   uses: 409 `provider-key-in-use`, naming what uses it.
 *
 * (A deployment that brings such a tool: `deployments-routes.test.ts`.)
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ToolManifest } from '@kindgi/tools';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'provider-keys-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);
const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

const MODEL_KEY = 'ANTHROPIC_API_KEY';
const projectId = randomUUID();
const REFUSED = (user: string) =>
  `\`${MODEL_KEY}\` is the key of model provider "anthropic-main": ${user} never gets a model provider's key. If it needs to call a model itself, store the key under its own name (the same value is fine) and use that name`;

function tool(id: string, extra: Partial<ToolManifest> = {}): Record<string, unknown> {
  return {
    id,
    version: '1.0.0',
    description: 'A tool.',
    input: { type: 'object' },
    output: { type: 'object' },
    ...extra,
  };
}

function makeApp() {
  const tools: ToolManifest[] = [
    tool('acme.search', { needsSpec: { secrets: { SEARCH_KEY: { type: 'string' } } } }) as never,
  ];
  const hooks = [
    {
      endpointId: 'whe-1',
      url: 'https://app.acme.example/hooks',
      events: ['run.finished'],
      filter: {},
      description: null,
      secretRef: { envName: 'local', name: 'HOOK_SECRET' },
    },
  ];
  const registered: unknown[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    providerRegistry: {
      resolveForRuntime: async () => [
        {
          metadata: { id: 'anthropic-main' },
          adapterId: '@kindgi/adapter-model-anthropic',
          secretRef: { envName: 'local', name: MODEL_KEY },
        },
      ],
      register: async (input: { metadata: { id: string } }) => {
        registered.push(input);
        return { kind: 'ok', providerId: input.metadata.id };
      },
      list: async () => ({ data: [] }),
      get: async () => null,
    } as never,
    toolRegistry: {
      list: async () => ({ data: tools }),
      headExists: async () => false,
      get: async () => null,
      // Retired versions: one declares the model key, one a key of its own.
      getVersion: async (input: { toolId: string }) =>
        input.toolId === 'acme.t'
          ? tool('acme.t', { needsSpec: { secrets: { [MODEL_KEY]: { type: 'string' } } } })
          : tool('acme.own', { needsSpec: { secrets: { OWN_KEY: { type: 'string' } } } }),
      reinstateVersion: async (input: { toolId: string; version: string }) => ({
        kind: 'ok',
        toolId: input.toolId,
        version: input.version,
        wasTombstoned: true,
      }),
      publish: async (input: { tool: ToolManifest }) => ({
        kind: 'ok',
        toolId: input.tool.id,
        version: input.tool.version,
      }),
    } as never,
    mcpEndpointRegistry: {
      list: async () => ({ data: [] }),
      get: async () => null,
      register: async () => ({ kind: 'ok', endpointId: 'acme.docs' }),
    } as never,
    webhookEndpoints: {
      list: async () => ({ data: hooks }),
      create: async () => {
        throw new Error('not reached');
      },
      update: async () => {
        throw new Error('not reached');
      },
    } as never,
  });
  const call = async (method: string, path: string, body: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, registered };
}

describe("a model provider's key, named where it's not the provider", () => {
  test('a tool declaring it, or sending it: 400, naming the key and the provider', async () => {
    const h = makeApp();
    const declared = await h.call('POST', '/v1/tools', {
      ...tool('acme.summarize', { needsSpec: { secrets: { [MODEL_KEY]: { type: 'string' } } } }),
      projectId,
    });
    expect([declared.status, declared.body.error]).toEqual([
      400,
      expect.objectContaining({
        code: 'provider-key-refused',
        message: REFUSED('a tool'),
        details: { secret: MODEL_KEY, providerId: 'anthropic-main' },
      }),
    ]);
    const sent = await h.call('POST', '/v1/tools', {
      ...tool('acme.relay', {
        spec: {
          kind: 'http',
          method: 'POST',
          urlTemplate: 'https://elsewhere.example/relay',
          authorization: { kind: 'bearer', secretRef: { envName: 'local', name: MODEL_KEY } },
        } as never,
      }),
      projectId,
    });
    expect([sent.status, sent.body.error?.code]).toEqual([400, 'provider-key-refused']);
    const own = await h.call('POST', '/v1/tools', {
      ...tool('acme.lookup', { needsSpec: { secrets: { SEARCH_KEY: { type: 'string' } } } }),
      projectId,
    });
    expect(own.status).toBe(201);
  });

  test('reinstating a retired version that names it: 400, and it stays retired', async () => {
    const h = makeApp();
    const refused = await h.call('POST', '/v1/tools/acme.t/versions/1.0.0/reinstate', {});
    expect([refused.status, refused.body.error?.code, refused.body.error?.message]).toEqual([
      400,
      'provider-key-refused',
      REFUSED('a tool'),
    ]);
    const own = await h.call('POST', '/v1/tools/acme.own/versions/1.0.0/reinstate', {});
    expect([own.status, own.body.wasTombstoned]).toEqual([200, true]);
  });

  test('an MCP or a webhook endpoint naming it: 400', async () => {
    const h = makeApp();
    const mcp = await h.call('POST', '/v1/mcp/endpoints', {
      endpointId: 'acme.docs',
      name: 'Docs MCP',
      transport: 'stdio',
      config: { transport: 'stdio', command: '/usr/local/bin/docs-mcp', args: ['--stdio'] },
      secretRef: { envName: 'local', name: MODEL_KEY },
    });
    expect([mcp.status, mcp.body.error?.message]).toEqual([400, REFUSED('an MCP endpoint')]);
    // As an endpoint's auth secret too: a Basic password, an OAuth client secret.
    const http = {
      endpointId: 'acme.shop',
      name: 'Shop MCP',
      transport: 'streamable-http',
      config: { transport: 'streamable-http', url: 'https://shop.acme.example/mcp' },
    };
    for (const auth of [
      { scheme: 'basic', username: 'agent', secretRef: { envName: 'local', name: MODEL_KEY } },
      {
        scheme: 'oauth2-client-credentials',
        tokenUrl: 'https://shop.acme.example/oauth/token',
        clientId: 'kindgi',
        secretRef: { envName: 'local', name: MODEL_KEY },
      },
      {
        scheme: 'header',
        headers: [
          { name: 'X-Api-Key', secretRef: { envName: 'local', name: 'SHOP_KEY' } },
          { name: 'X-Api-Secret', secretRef: { envName: 'local', name: MODEL_KEY } },
        ],
      },
    ]) {
      const named = await h.call('POST', '/v1/mcp/endpoints', { ...http, auth });
      expect([named.status, named.body.error?.message]).toEqual([400, REFUSED('an MCP endpoint')]);
    }
    const hook = await h.call('POST', '/v1/webhook-endpoints', {
      url: 'https://app.acme.example/hooks',
      events: ['run.finished'],
      secretRef: { envName: 'local', name: MODEL_KEY },
    });
    expect([hook.status, hook.body.error?.message]).toEqual([400, REFUSED('a webhook endpoint')]);
    const changed = await h.call('PATCH', '/v1/webhook-endpoints/whe-1', {
      secretRef: { envName: 'local', name: MODEL_KEY },
    });
    expect([changed.status, changed.body.error?.code]).toEqual([400, 'provider-key-refused']);
  });

  test('a provider registered with a key a tool or an endpoint uses: 409, naming them', async () => {
    const h = makeApp();
    const metadata = {
      id: 'openai-main',
      region: 'us-east-1',
      models: [
        {
          name: 'gpt-x',
          contextWindow: 128_000,
          features: ['tool-use'],
          cost: { promptUsdPer1kTokens: 0.01, completionUsdPer1kTokens: 0.03 },
        },
      ],
    };
    for (const [name, usedBy] of [
      ['SEARCH_KEY', [{ kind: 'tool', id: 'acme.search', version: '1.0.0' }]],
      ['HOOK_SECRET', [{ kind: 'webhook-endpoint', id: 'whe-1' }]],
    ] as const) {
      const r = await h.call('POST', '/v1/providers', {
        metadata,
        adapter_id: '@kindgi/adapter-model-anthropic',
        secret_ref: { envName: 'local', name },
      });
      expect([name, r.status, r.body.error?.code, r.body.error?.details?.usedBy]).toEqual([
        name,
        409,
        'provider-key-in-use',
        usedBy,
      ]);
    }
    expect(h.registered).toEqual([]);
  });
});
