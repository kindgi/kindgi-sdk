// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `guardProviderKeys`: what hands secrets to tools and endpoints never
 * gets a model provider's key. `resolve` answers `provider-key-refused`,
 * `getVersion` throws it, and every other secret, and every other method,
 * reaches the store as before. `connectionKeysOf` and `refuseSecretNames`:
 * a texts registration's account key is its registration's only.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Cursor, EnvName, TenantId } from '@kindgi/types';

import { connectionKeysOf, guardProviderKeys } from '../src/index.js';
import type {
  ConnectionAppRecord,
  ConnectionBinding,
  ConnectionKeys,
  EnvNamesInput,
  ProviderKeys,
  SecretBinding,
} from '../src/index.js';
import { refuseSecretNames, usersOfSecret } from '../src/provider-keys.js';

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

  test('what the store says about itself passes through', async () => {
    const { binding } = store();
    const refusal = { code: 'secret-name-invalid', message: 'not an env-file key' } as const;
    const asked: EnvNamesInput[] = [];
    const dev = {
      ...binding,
      writesAppEnvFiles: true,
      nameRefusal: (name: string) => (name === 'acme-key' ? refusal : undefined),
      listEnvNames: async (input: EnvNamesInput) => {
        asked.push(input);
        return ['local'] as EnvName[];
      },
      issuedCursor: (list: 'secrets' | 'versions', cursor: Cursor) =>
        list === 'secrets' && (cursor as unknown as string) === 'issued',
    } as SecretBinding;
    const guarded = guardProviderKeys(dev, keys, 'a tool');
    expect(guarded.writesAppEnvFiles).toBe(true);
    expect(guarded.nameRefusal?.('acme-key')).toEqual(refusal);
    expect(guarded.nameRefusal?.('ACME_KEY')).toBeUndefined();
    const input: EnvNamesInput = { tenantId: 'tenant-test' as TenantId, limit: 2 };
    expect(await guarded.listEnvNames?.(input)).toEqual(['local']);
    expect(asked).toEqual([input]);
    expect(guarded.issuedCursor?.('secrets', 'issued' as Cursor)).toBe(true);
    expect(guarded.issuedCursor?.('versions', 'issued' as Cursor)).toBe(false);
    expect(guardProviderKeys(binding, keys, 'a tool')).not.toHaveProperty('writesAppEnvFiles');
    expect(guardProviderKeys(binding, keys, 'a tool')).not.toHaveProperty('nameRefusal');
    expect(guardProviderKeys(binding, keys, 'a tool')).not.toHaveProperty('listEnvNames');
    expect(guardProviderKeys(binding, keys, 'a tool')).not.toHaveProperty('issuedCursor');
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

  test('an identity provider is told to store its own secret, not to call a model', async () => {
    const { binding } = store();
    const r = await guardProviderKeys(binding, keys, 'an identity provider').resolve({
      scope,
      envName,
      name: 'ANTHROPIC_API_KEY',
      resolveContext,
    });
    expect(r.kind === 'err' && r.error.message).toBe(
      '`ANTHROPIC_API_KEY` is the key of model provider "anthropic": an identity provider never gets a model provider\'s key. Store the identity provider\'s own secret under its own name and use that name',
    );
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

/** A registration of `app`, with a texts account key when `apiKey` is given. */
function registration(
  appId: string,
  opts: { readonly apiKey?: string; readonly clientSecret?: string; readonly removed?: boolean },
): ConnectionAppRecord & { readonly removedAt?: string } {
  return {
    appId,
    tenantId,
    app: opts.apiKey !== undefined ? 'texts' : 'google',
    ...(opts.clientSecret !== undefined && {
      oauth2: { clientId: 'acme-client', clientSecret: { envName, name: opts.clientSecret } },
    }),
    ...(opts.apiKey !== undefined && {
      token: {
        provider: 'telnyx',
        apiKey: { envName, name: opts.apiKey },
        publicKey: `${'A'.repeat(43)}=`,
      },
    }),
    ...(opts.removed === true && { removedAt: '2026-01-01T00:00:00.000Z' }),
  } as ConnectionAppRecord & { readonly removedAt?: string };
}

/**
 * A binding whose `listApps` serves `perPage` records a page, live ones
 * only unless asked for removed ones too, as a binding's does.
 */
function connectionBinding(
  apps: readonly (ConnectionAppRecord & { readonly removedAt?: string })[],
  perPage: number,
): { binding: ConnectionBinding; asked: { cursor?: string; includeRemoved?: boolean }[] } {
  const asked: { cursor?: string; includeRemoved?: boolean }[] = [];
  const binding = {
    listApps: async (input: {
      tenantId: TenantId;
      limit: number;
      cursor?: Cursor;
      includeRemoved?: boolean;
    }) => {
      asked.push({
        ...(input.cursor !== undefined && { cursor: input.cursor as string }),
        ...(input.includeRemoved !== undefined && { includeRemoved: input.includeRemoved }),
      });
      const listed = apps.filter(
        (app) =>
          app.tenantId === input.tenantId &&
          (input.includeRemoved === true || app.removedAt === undefined),
      );
      const start = input.cursor === undefined ? 0 : Number(input.cursor);
      const end = start + perPage;
      return {
        data: listed.slice(start, end),
        ...(end < listed.length && { nextCursor: String(end) as Cursor }),
      };
    },
  } as unknown as ConnectionBinding;
  return { binding, asked };
}

describe('connectionKeysOf', () => {
  test("each live texts registration's key, with the appIds of the registrations holding it: an OAuth secret isn't one, and a removed registration frees its key", async () => {
    const { binding, asked } = connectionBinding(
      [
        registration('app-texts', { apiKey: 'ACME_TELNYX_KEY' }),
        registration('app-google', { clientSecret: 'ACME_GOOGLE_CLIENT_SECRET' }),
        registration('app-gone', { apiKey: 'ACME_OLD_TELNYX_KEY', removed: true }),
      ],
      100,
    );
    const keys = await connectionKeysOf(binding).of(tenantId);
    expect([...keys]).toEqual([['ACME_TELNYX_KEY', ['app-texts']]]);
    expect(asked.every((a) => a.includeRemoved !== true)).toBe(true);
  });

  test('every page is read: a key on the last page is found', async () => {
    const { binding, asked } = connectionBinding(
      [
        registration('app-google', { clientSecret: 'ACME_GOOGLE_CLIENT_SECRET' }),
        registration('app-gone', { apiKey: 'ACME_OLD_TELNYX_KEY', removed: true }),
        registration('app-github', { clientSecret: 'ACME_GITHUB_CLIENT_SECRET' }),
        registration('app-texts', { apiKey: 'ACME_TELNYX_KEY' }),
      ],
      1,
    );
    const keys = await connectionKeysOf(binding).of(tenantId);
    expect([...keys]).toEqual([['ACME_TELNYX_KEY', ['app-texts']]]);
    expect(asked.map((a) => a.cursor)).toEqual([undefined, '1', '2']);
  });

  test("another tenant's registrations are not read", async () => {
    const { binding } = connectionBinding(
      [registration('app-texts', { apiKey: 'ACME_TELNYX_KEY' })],
      100,
    );
    expect((await connectionKeysOf(binding).of(randomUUID() as TenantId)).size).toBe(0);
  });

  test("without a connection binding, no secret is a registration's key", async () => {
    expect((await connectionKeysOf(undefined).of(tenantId)).size).toBe(0);
  });
});

describe('refuseSecretNames: reserved names, then provider keys, then connection keys', () => {
  const providerKeys: ProviderKeys = {
    of: async () => new Map([['ANTHROPIC_API_KEY', 'anthropic']]),
  };
  function countingKeys(): { keys: ConnectionKeys; reads: number[] } {
    const reads: number[] = [];
    return {
      keys: {
        of: async () => {
          reads.push(1);
          return new Map([['ACME_TELNYX_KEY', ['app-texts']]]);
        },
      },
      reads,
    };
  }

  test("a texts registration's key is refused, naming the secret and the registration, from one read of the keys", async () => {
    const { keys, reads } = countingKeys();
    const refusal = await refuseSecretNames(
      providerKeys,
      tenantId,
      ['ACME_SHOP_KEY', 'ACME_TELNYX_KEY'],
      'a tool',
      { keys },
    );
    expect(refusal).toEqual({
      code: 'connection-key-refused',
      message:
        '`ACME_TELNYX_KEY` is the account key of connection app registration "app-texts": a tool never names it, since that key reaches the whole provider account. Use a key of its own: a new API key from the provider, stored under its own name. A copy of this one under another name reaches the same account',
      secret: 'ACME_TELNYX_KEY',
      appId: 'app-texts',
    });
    expect(reads).toHaveLength(1);
  });

  test('a reserved name is refused first, then a provider key, then a connection key', async () => {
    const { keys } = countingKeys();
    const all = ['ACME_TELNYX_KEY', 'ANTHROPIC_API_KEY', 'kindgi.internal'];
    expect(await refuseSecretNames(providerKeys, tenantId, all, 'a tool', { keys })).toMatchObject({
      code: 'reserved-name-prefix',
      secret: 'kindgi.internal',
    });
    expect(
      await refuseSecretNames(providerKeys, tenantId, all.slice(0, 2), 'a tool', { keys }),
    ).toMatchObject({ code: 'provider-key-refused', secret: 'ANTHROPIC_API_KEY' });
    expect(
      await refuseSecretNames(providerKeys, tenantId, all.slice(0, 1), 'a tool', { keys }),
    ).toMatchObject({ code: 'connection-key-refused', secret: 'ACME_TELNYX_KEY' });
  });

  test('a registration names its own key; another registration does not', async () => {
    const { keys } = countingKeys();
    expect(
      await refuseSecretNames(providerKeys, tenantId, ['ACME_TELNYX_KEY'], 'a connection app', {
        keys,
        ownAppId: 'app-texts',
      }),
    ).toBeUndefined();
    expect(
      await refuseSecretNames(providerKeys, tenantId, ['ACME_TELNYX_KEY'], 'a connection app', {
        keys,
        ownAppId: 'app-other',
      }),
    ).toMatchObject({ code: 'connection-key-refused', appId: 'app-texts' });
  });

  test('a key two live registrations hold is refused to each of them, naming the other', async () => {
    const { binding } = connectionBinding(
      [
        registration('app-texts', { apiKey: 'ACME_TELNYX_KEY' }),
        registration('app-texts-2', { apiKey: 'ACME_TELNYX_KEY' }),
      ],
      1,
    );
    const keys = connectionKeysOf(binding);
    expect([...(await keys.of(tenantId))]).toEqual([
      ['ACME_TELNYX_KEY', ['app-texts', 'app-texts-2']],
    ]);
    expect(
      await refuseSecretNames(providerKeys, tenantId, ['ACME_TELNYX_KEY'], 'a connection app', {
        keys,
        ownAppId: 'app-texts',
      }),
    ).toMatchObject({ code: 'connection-key-refused', appId: 'app-texts-2' });
    expect(
      await refuseSecretNames(providerKeys, tenantId, ['ACME_TELNYX_KEY'], 'a connection app', {
        keys,
        ownAppId: 'app-texts-2',
      }),
    ).toMatchObject({ code: 'connection-key-refused', appId: 'app-texts' });
  });

  test('without connection keys, a name is not checked against them', async () => {
    expect(
      await refuseSecretNames(providerKeys, tenantId, ['ACME_TELNYX_KEY'], 'a tool'),
    ).toBeUndefined();
    expect(
      await refuseSecretNames(providerKeys, tenantId, ['ACME_TELNYX_KEY'], 'a tool', {
        keys: undefined,
      }),
    ).toBeUndefined();
  });
});
