// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `guardProviderKeys`: what hands secrets to tools and endpoints never
 * gets a model provider's key. `resolve` answers `provider-key-refused`,
 * `getVersion` throws it, and every other secret, and every other method,
 * reaches the store as before.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { EnvName, TenantId } from '@kindgi/types';

import { guardProviderKeys } from '../src/index.js';
import type { ProviderKeys, SecretBinding } from '../src/index.js';
import { usersOfSecret } from '../src/provider-keys.js';

const tenantId = randomUUID() as TenantId;
const scope = { kind: 'tenant', tenantId } as const;
const envName = 'local' as EnvName;
const resolveContext = { caller: 'dispatch' } as const;

function store(): { binding: SecretBinding; asked: string[] } {
  const asked: string[] = [];
  const binding = {
    list: async () => ({ data: [] }),
    get: async ({ name }: { name: string }) => {
      asked.push(`get ${name}`);
      return null;
    },
    listVersions: async () => ({ data: [] }),
    set: async () => ({ kind: 'ok' }),
    rotate: async () => ({ kind: 'ok' }),
    revoke: async () => ({ kind: 'ok' }),
    resolve: async ({ name }: { name: string }) => {
      asked.push(`resolve ${name}`);
      return { kind: 'ok', value: { name, versionId: 1, value: `value-of-${name}` } };
    },
    getVersion: async ({ name }: { name: string }) => {
      asked.push(`getVersion ${name}`);
      return null;
    },
  } as unknown as SecretBinding;
  return { binding, asked };
}

const keys: ProviderKeys = {
  of: async (t) => new Map(t === tenantId ? [['ANTHROPIC_API_KEY', 'anthropic']] : []),
};

describe('guardProviderKeys', () => {
  test("a provider's key: refused, naming it and its provider, and the store isn't asked", async () => {
    const { binding, asked } = store();
    const guarded = guardProviderKeys(binding, keys, 'a tool');
    const r = await guarded.resolve({ scope, envName, name: 'ANTHROPIC_API_KEY', resolveContext });
    expect(r).toEqual({
      kind: 'err',
      error: {
        code: 'provider-key-refused',
        message:
          '`ANTHROPIC_API_KEY` is the key of model provider "anthropic": a tool never gets a model provider\'s key. If it needs to call a model itself, store the key under its own name (the same value is fine) and use that name',
        name: 'ANTHROPIC_API_KEY',
        providerId: 'anthropic',
      },
    });
    await expect(
      guarded.getVersion({ scope, envName, name: 'ANTHROPIC_API_KEY', versionId: 1 }),
    ).rejects.toThrow(/^provider-key-refused: `ANTHROPIC_API_KEY` is the key of model provider/);
    expect(asked).toEqual([]);
  });

  test('any other secret, and every other method, reach the store', async () => {
    const { binding, asked } = store();
    const guarded = guardProviderKeys(binding, keys, 'an MCP endpoint');
    const r = await guarded.resolve({ scope, envName, name: 'SEARCH_KEY', resolveContext });
    expect(r).toEqual({
      kind: 'ok',
      value: { name: 'SEARCH_KEY', versionId: 1, value: 'value-of-SEARCH_KEY' },
    });
    await guarded.get({ scope, envName, name: 'ANTHROPIC_API_KEY' });
    await guarded.getVersion({ scope, envName, name: 'SEARCH_KEY', versionId: 1 });
    expect(asked).toEqual(['resolve SEARCH_KEY', 'get ANTHROPIC_API_KEY', 'getVersion SEARCH_KEY']);
  });

  test("another tenant's provider key is that tenant's: this one's tools may use the name", async () => {
    const { binding } = store();
    const other = randomUUID() as TenantId;
    const r = await guardProviderKeys(binding, keys, 'a webhook endpoint').resolve({
      scope: { kind: 'tenant', tenantId: other },
      envName,
      name: 'ANTHROPIC_API_KEY',
      resolveContext,
    });
    expect(r.kind).toBe('ok');
  });

  test('what the store says about itself passes through', () => {
    const { binding } = store();
    const dev = { ...binding, writesAppEnvFiles: true } as SecretBinding;
    expect(guardProviderKeys(dev, keys, 'a tool').writesAppEnvFiles).toBe(true);
    expect(guardProviderKeys(binding, keys, 'a tool')).not.toHaveProperty('writesAppEnvFiles');
  });

  test('the words name what asked', async () => {
    const { binding } = store();
    for (const user of ['an MCP endpoint', 'a webhook endpoint'] as const) {
      const r = await guardProviderKeys(binding, keys, user).resolve({
        scope,
        envName,
        name: 'ANTHROPIC_API_KEY',
        resolveContext,
      });
      expect(r.kind === 'err' && r.error.message).toContain(
        `: ${user} never gets a model provider's key.`,
      );
    }
  });
});

describe('usersOfSecret: MCP endpoints', () => {
  test("an endpoint naming the secret as its bearer or in its auth uses it; one that doesn't, doesn't", async () => {
    const secretRef = { envName, name: 'OPENAI_API_KEY' };
    const http = {
      name: 'MCP',
      transport: 'streamable-http',
      config: { transport: 'streamable-http', url: 'https://mcp.acme.example/mcp' },
    } as const;
    const endpoints = [
      { ...http, endpointId: 'acme.bearer', secretRef },
      {
        ...http,
        endpointId: 'acme.basic',
        auth: { scheme: 'basic', username: 'agent', secretRef },
      },
      {
        ...http,
        endpointId: 'acme.oauth',
        auth: {
          scheme: 'oauth2-client-credentials',
          tokenUrl: 'https://cms.acme.example/oauth/token',
          clientId: 'kindgi',
          secretRef,
        },
      },
      {
        ...http,
        endpointId: 'acme.header',
        auth: {
          scheme: 'header',
          headers: [
            { name: 'X-Api-Key', secretRef: { envName, name: 'INVENTORY_KEY' } },
            { name: 'X-Api-Secret', secretRef },
          ],
        },
      },
      {
        ...http,
        endpointId: 'acme.other',
        auth: { scheme: 'basic', username: 'agent', secretRef: { envName, name: 'SHOP_PASSWORD' } },
      },
    ];
    const users = await usersOfSecret(
      { mcpEndpoints: { list: async () => ({ data: endpoints }) } as never },
      tenantId,
      'OPENAI_API_KEY',
    );
    expect(users).toEqual([
      { kind: 'mcp-endpoint', id: 'acme.bearer' },
      { kind: 'mcp-endpoint', id: 'acme.basic' },
      { kind: 'mcp-endpoint', id: 'acme.oauth' },
      { kind: 'mcp-endpoint', id: 'acme.header' },
    ]);
  });
});
