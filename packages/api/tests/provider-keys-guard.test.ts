// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `guardProviderKeys`: what hands secrets to tools and endpoints never
 * gets a model provider's key. `resolve` answers `provider-key-refused`,
 * `getVersion` throws it, and every other secret, and every other method,
 * reaches the store as before. `connectionKeysOf` and `refuseSecretNames`:
 * a texts registration's account key is its registration's only.
 * `guardSecretKeys`: the same at call time, for both kinds of key.
 * `identityProviderKeysOf`: an identity provider's secret is sign-in's only,
 * refused to every other user at write time and at call time.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Cursor, EnvName, TenantId } from '@kindgi/types';

import {
  connectionKeysOf,
  guardProviderKeys,
  guardSecretKeys,
  identityProviderKeysOf,
  identityProviderSecretNames,
  refuseIdentityProviderKeyNames,
} from '../src/index.js';
import type {
  ConnectionAppRecord,
  ConnectionBinding,
  ConnectionKeys,
  EnvNamesInput,
  IdentityProviderBinding,
  IdentityProviderKeys,
  ProviderConfig,
  ProviderKeys,
  ResolveContext,
  SecretBinding,
  SecretUser,
} from '../src/index.js';
import {
  PAGE,
  refuseConnectionKeyNames,
  refuseSecretNames,
  usersOfSecret,
} from '../src/provider-keys.js';

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

/**
 * More live registrations than the old cap read (100 pages of `PAGE`),
 * with the texts one last.
 */
function pastTheOldCap(): ReturnType<typeof connectionBinding> {
  const apps = [
    ...Array.from({ length: PAGE * 100 }, (_, i) =>
      registration(`app-google-${i}`, { clientSecret: 'ACME_GOOGLE_CLIENT_SECRET' }),
    ),
    registration('app-texts', { apiKey: 'ACME_TELNYX_KEY' }),
  ];
  return connectionBinding(apps, PAGE);
}

/** `connectionKeyRefusal`'s words. */
const TEXTS_REFUSED = (user: SecretUser, appId = 'app-texts', name = 'ACME_TELNYX_KEY') =>
  `\`${name}\` is the account key of connection app registration "${appId}": ${user} never names it, since that key reaches the whole provider account. Use a key of its own: a new API key from the provider, stored under its own name. A copy of this one under another name reaches the same account`;

describe('connectionKeysOf', () => {
  test("the live texts registrations holding a key: an OAuth secret isn't one, and a removed registration frees its key", async () => {
    const { binding, asked } = connectionBinding(
      [
        registration('app-texts', { apiKey: 'ACME_TELNYX_KEY' }),
        registration('app-google', { clientSecret: 'ACME_GOOGLE_CLIENT_SECRET' }),
        registration('app-gone', { apiKey: 'ACME_OLD_TELNYX_KEY', removed: true }),
      ],
      100,
    );
    const keys = connectionKeysOf(binding);
    expect(await keys.holders(tenantId, 'ACME_TELNYX_KEY')).toEqual(['app-texts']);
    expect(await keys.holders(tenantId, 'ACME_GOOGLE_CLIENT_SECRET')).toEqual([]);
    expect(await keys.holders(tenantId, 'ACME_OLD_TELNYX_KEY')).toEqual([]);
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
    expect(await connectionKeysOf(binding).holders(tenantId, 'ACME_TELNYX_KEY')).toEqual([
      'app-texts',
    ]);
    expect(asked.map((a) => a.cursor)).toEqual([undefined, '1', '2']);
  });

  test('with no keyHolders on the binding, the listing has no cap: a key past 100 pages is found', async () => {
    const { binding, asked } = pastTheOldCap();
    expect(await connectionKeysOf(binding).holders(tenantId, 'ACME_TELNYX_KEY')).toEqual([
      'app-texts',
    ]);
    expect(asked).toHaveLength(101);
  });

  test("a binding's keyHolders answers it, and nothing is listed", async () => {
    const asked: unknown[] = [];
    const binding = {
      keyHolders: async (input: { tenantId: TenantId; name: string }) => {
        asked.push(input);
        return ['app-texts'];
      },
      listApps: async () => {
        throw new Error('listed');
      },
    } as unknown as ConnectionBinding;
    expect(await connectionKeysOf(binding).holders(tenantId, 'ACME_TELNYX_KEY')).toEqual([
      'app-texts',
    ]);
    expect(asked).toEqual([{ tenantId, name: 'ACME_TELNYX_KEY' }]);
  });

  test("another tenant's registrations are not read", async () => {
    const { binding } = connectionBinding(
      [registration('app-texts', { apiKey: 'ACME_TELNYX_KEY' })],
      100,
    );
    expect(
      await connectionKeysOf(binding).holders(randomUUID() as TenantId, 'ACME_TELNYX_KEY'),
    ).toEqual([]);
  });

  test("without a connection binding, no secret is a registration's key", async () => {
    expect(await connectionKeysOf(undefined).holders(tenantId, 'ACME_TELNYX_KEY')).toEqual([]);
  });
});

describe('refuseSecretNames: reserved names, then provider keys, then connection keys', () => {
  const providerKeys: ProviderKeys = {
    of: async () => new Map([['ANTHROPIC_API_KEY', 'anthropic']]),
  };
  function countingKeys(): { keys: ConnectionKeys; reads: string[] } {
    const reads: string[] = [];
    return {
      keys: {
        holders: async (_tenantId, name) => {
          reads.push(name);
          return name === 'ACME_TELNYX_KEY' ? ['app-texts'] : [];
        },
      },
      reads,
    };
  }

  test("a texts registration's key is refused, naming the secret and the registration, from one read per name up to it", async () => {
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
    expect(reads).toEqual(['ACME_SHOP_KEY', 'ACME_TELNYX_KEY']);
  });

  test('a key past 100 pages of registrations is refused at write time too', async () => {
    const { binding } = pastTheOldCap();
    expect(
      await refuseSecretNames(providerKeys, tenantId, ['ACME_TELNYX_KEY'], 'a tool', {
        keys: connectionKeysOf(binding),
      }),
    ).toMatchObject({ code: 'connection-key-refused', appId: 'app-texts' });
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
    expect(await keys.holders(tenantId, 'ACME_TELNYX_KEY')).toEqual(['app-texts', 'app-texts-2']);
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

describe('refuseConnectionKeyNames: connection keys only', () => {
  const keys: ConnectionKeys = {
    holders: async (_tenantId, name) =>
      name === 'ACME_TELNYX_KEY' ? ['app-texts'] : name === 'ACME_SMS_KEY' ? ['app-sms'] : [],
  };

  test("a texts registration's key is refused in the words for its user; a reserved name and a provider's key aren't its to refuse", async () => {
    expect(
      await refuseConnectionKeyNames(
        keys,
        tenantId,
        ['kindgi.internal', 'ANTHROPIC_API_KEY', 'ACME_TELNYX_KEY'],
        "a pack's env",
      ),
    ).toEqual({
      code: 'connection-key-refused',
      message: TEXTS_REFUSED("a pack's env"),
      secret: 'ACME_TELNYX_KEY',
      appId: 'app-texts',
    });
    expect(
      await refuseConnectionKeyNames(
        keys,
        tenantId,
        ['kindgi.internal', 'ANTHROPIC_API_KEY'],
        "a pack's env",
      ),
    ).toBeUndefined();
  });

  test('the first name held, in the order given, is the one refused', async () => {
    expect(
      await refuseConnectionKeyNames(
        keys,
        tenantId,
        ['ACME_SMS_KEY', 'ACME_TELNYX_KEY'],
        "a pack's env",
      ),
    ).toMatchObject({ secret: 'ACME_SMS_KEY', appId: 'app-sms' });
  });

  test('without connection keys, nothing is refused', async () => {
    expect(
      await refuseConnectionKeyNames(undefined, tenantId, ['ACME_TELNYX_KEY'], "a pack's env"),
    ).toBeUndefined();
  });
});

describe('guardSecretKeys: both kinds of key, at call time', () => {
  const providerKeys: ProviderKeys = {
    of: async (t) => new Map(t === tenantId ? [['ANTHROPIC_API_KEY', 'anthropic']] : []),
  };
  /** The holders of each name, read afresh on every call. */
  function holding(entries: [string, string[]][] = [['ACME_TELNYX_KEY', ['app-texts']]]) {
    const held = new Map(entries);
    const reads: string[] = [];
    const connectionKeys: ConnectionKeys = {
      holders: async (t, name) => {
        reads.push(name);
        return t === tenantId ? (held.get(name) ?? []) : [];
      },
    };
    return { held, reads, connectionKeys };
  }
  const read = (name: string, context: ResolveContext = resolveContext) => ({
    scope,
    envName,
    name,
    resolveContext: context,
  });
  const refused = (user: SecretUser, appId = 'app-texts', name = 'ACME_TELNYX_KEY') => ({
    kind: 'err',
    error: {
      code: 'connection-key-refused',
      message: TEXTS_REFUSED(user, appId, name),
      name,
      appId,
    },
  });

  test.each(['a tool', 'an MCP endpoint', 'a webhook endpoint', 'a webhook trigger'] as const)(
    "%s: a texts registration's key is refused, naming it and the registration, and the store isn't asked",
    async (user) => {
      const { binding, asked } = store();
      const { connectionKeys } = holding();
      const guarded = guardSecretKeys(binding, { providerKeys, connectionKeys }, user);
      expect(await guarded.resolve(read('ACME_TELNYX_KEY'))).toEqual(refused(user));
      await expect(
        guarded.getVersion({ scope, envName, name: 'ACME_TELNYX_KEY', versionId: 1 }),
      ).rejects.toThrow(
        /^connection-key-refused: `ACME_TELNYX_KEY` is the account key of connection app registration "app-texts"/,
      );
      expect(asked).toEqual([]);
    },
  );

  test('any other secret, and every other method, reach the store', async () => {
    const { binding, asked } = store();
    const { connectionKeys } = holding();
    const guarded = guardSecretKeys(binding, { providerKeys, connectionKeys }, 'a tool');
    expect(await guarded.resolve(read('SEARCH_KEY'))).toEqual({
      kind: 'ok',
      value: { name: 'SEARCH_KEY', versionId: 1, value: 'value-of-SEARCH_KEY' },
    });
    await guarded.get({ scope, envName, name: 'ACME_TELNYX_KEY' });
    await guarded.getVersion({ scope, envName, name: 'SEARCH_KEY', versionId: 1 });
    expect(asked).toEqual(['resolve SEARCH_KEY', 'get ACME_TELNYX_KEY', 'getVersion SEARCH_KEY']);
  });

  test("a name that's both a provider's key and a texts key is refused as the provider's, as at write time", async () => {
    const { binding } = store();
    const { connectionKeys } = holding([['ANTHROPIC_API_KEY', ['app-texts']]]);
    const r = await guardSecretKeys(binding, { providerKeys, connectionKeys }, 'a tool').resolve(
      read('ANTHROPIC_API_KEY'),
    );
    expect(r).toMatchObject({ kind: 'err', error: { code: 'provider-key-refused' } });
  });

  test('a model provider, with connection keys only, reads its own key and is refused a texts key', async () => {
    const { binding } = store();
    const { connectionKeys } = holding();
    const guarded = guardSecretKeys(binding, { connectionKeys }, 'a model provider');
    expect((await guarded.resolve(read('ANTHROPIC_API_KEY'))).kind).toBe('ok');
    expect(await guarded.resolve(read('ACME_TELNYX_KEY'))).toEqual(refused('a model provider'));
  });

  test('guardProviderKeys is the same guard with provider keys only: a texts key passes it', async () => {
    const { binding } = store();
    const guarded = guardProviderKeys(binding, providerKeys, 'a tool');
    expect((await guarded.resolve(read('ACME_TELNYX_KEY'))).kind).toBe('ok');
    expect(await guarded.resolve(read('ANTHROPIC_API_KEY'))).toMatchObject({
      kind: 'err',
      error: { code: 'provider-key-refused' },
    });
  });

  test("another tenant's texts key is that tenant's: this one may use the name", async () => {
    const { binding } = store();
    const { connectionKeys } = holding();
    const r = await guardSecretKeys(binding, { connectionKeys }, 'a tool').resolve({
      ...read('ACME_TELNYX_KEY'),
      scope: { kind: 'tenant', tenantId: randomUUID() as TenantId },
    });
    expect(r.kind).toBe('ok');
  });

  describe('a connection app', () => {
    const own = (appId?: string): ResolveContext => ({
      caller: 'connections',
      ...(appId !== undefined && { appId }),
    });

    test('reads its own key; a registration that holds none, or says none, is refused', async () => {
      const { binding, asked } = store();
      const { connectionKeys } = holding();
      const guarded = guardSecretKeys(
        binding,
        { providerKeys, connectionKeys },
        'a connection app',
      );
      expect((await guarded.resolve(read('ACME_TELNYX_KEY', own('app-texts')))).kind).toBe('ok');
      expect(await guarded.resolve(read('ACME_TELNYX_KEY', own('app-google')))).toEqual(
        refused('a connection app'),
      );
      expect(await guarded.resolve(read('ACME_TELNYX_KEY', own()))).toEqual(
        refused('a connection app'),
      );
      expect(asked).toEqual(['resolve ACME_TELNYX_KEY']);
    });

    test('a key two live registrations hold is refused to each of them, naming the other', async () => {
      const { binding } = store();
      const { connectionKeys } = holding([['ACME_TELNYX_KEY', ['app-texts', 'app-texts-2']]]);
      const guarded = guardSecretKeys(
        binding,
        { providerKeys, connectionKeys },
        'a connection app',
      );
      expect(await guarded.resolve(read('ACME_TELNYX_KEY', own('app-texts')))).toEqual(
        refused('a connection app', 'app-texts-2'),
      );
      expect(await guarded.resolve(read('ACME_TELNYX_KEY', own('app-texts-2')))).toEqual(
        refused('a connection app', 'app-texts'),
      );
    });

    test.each([
      'dispatch',
      'deploy-sync',
      'admin-cli',
      'boot-bridge',
      'webhook-receiver',
      'pack-env',
    ] as const)(
      "the holder's appId counts only with caller connections: with %s it is refused",
      async (caller) => {
        const { binding } = store();
        const { connectionKeys } = holding();
        const guarded = guardSecretKeys(binding, { connectionKeys }, 'a connection app');
        expect(
          await guarded.resolve(read('ACME_TELNYX_KEY', { caller, appId: 'app-texts' })),
        ).toEqual(refused('a connection app'));
      },
    );

    test("getVersion carries no reader, so even the holder's key is refused there", async () => {
      const { binding } = store();
      const { connectionKeys } = holding();
      await expect(
        guardSecretKeys(binding, { connectionKeys }, 'a connection app').getVersion({
          scope,
          envName,
          name: 'ACME_TELNYX_KEY',
          versionId: 1,
        }),
      ).rejects.toThrow(/^connection-key-refused: /);
    });
  });

  test("the holder's appId never opens the key to any other user", async () => {
    const { binding } = store();
    const { connectionKeys } = holding();
    for (const user of ['a tool', 'a webhook trigger', 'a model provider'] as const) {
      const guarded = guardSecretKeys(binding, { connectionKeys }, user);
      for (const caller of ['dispatch', 'connections'] as const) {
        expect(
          await guarded.resolve(read('ACME_TELNYX_KEY', { caller, appId: 'app-texts' })),
        ).toEqual(refused(user));
      }
    }
  });

  test('holders are read on every call, with no cache: a registration landing after the name was written, and its removal, take effect at once', async () => {
    const { binding } = store();
    const { held, reads, connectionKeys } = holding([]);
    const guarded = guardSecretKeys(binding, { connectionKeys }, 'a tool');
    expect((await guarded.resolve(read('ACME_TELNYX_KEY'))).kind).toBe('ok');
    held.set('ACME_TELNYX_KEY', ['app-texts']);
    expect(await guarded.resolve(read('ACME_TELNYX_KEY'))).toEqual(refused('a tool'));
    held.delete('ACME_TELNYX_KEY');
    expect((await guarded.resolve(read('ACME_TELNYX_KEY'))).kind).toBe('ok');
    expect(reads).toEqual(['ACME_TELNYX_KEY', 'ACME_TELNYX_KEY', 'ACME_TELNYX_KEY']);
  });

  test('a key past 100 pages of registrations is refused at call time', async () => {
    const { binding: secrets } = store();
    const { binding } = pastTheOldCap();
    const guarded = guardSecretKeys(
      secrets,
      { connectionKeys: connectionKeysOf(binding) },
      'a tool',
    );
    expect(await guarded.resolve(read('ACME_TELNYX_KEY'))).toEqual(refused('a tool'));
  });
});

describe("an identity provider's secret: sign-in's only", () => {
  const SIGN_IN_REFUSED = (user: SecretUser, name = 'ACME_OKTA_SECRET', id = 'acme-okta') =>
    `\`${name}\` is the secret of identity provider "${id}": ${user} never names it, since it signs the tenant's people in. If one app registration serves both, give it a second secret of its own (a second client secret), store that under its own name and use that name`;
  const OKTA = {
    providerId: 'acme-okta',
    kind: 'oidc',
    clientSecretRef: ' production/ACME_OKTA_SECRET ',
  } as unknown as ProviderConfig;
  const ADFS = {
    providerId: 'acme-adfs',
    kind: 'saml',
    spSigningKeyRef: 'ACME_SP_SIGNING_KEY',
    spDecryptionKeyRef: 'ACME_SP_DECRYPTION_KEY',
  } as unknown as ProviderConfig;
  const GOOGLE = { providerId: 'acme-google', kind: 'oidc' } as unknown as ProviderConfig;
  function signIn(providers: readonly ProviderConfig[] = [OKTA, ADFS, GOOGLE]) {
    const lists: TenantId[] = [];
    const binding = {
      list: async (input: { tenantId: TenantId }) => {
        lists.push(input.tenantId);
        return { data: input.tenantId === tenantId ? providers : [] };
      },
    } as unknown as IdentityProviderBinding;
    return { binding, lists, keys: identityProviderKeysOf(binding) };
  }
  const held: IdentityProviderKeys = {
    of: async (t) => new Map(t === tenantId ? [['ACME_OKTA_SECRET', 'acme-okta']] : []),
  };

  test("the names an identity provider references: an OIDC client secret, a SAML provider's signing and decryption keys, another environment's by its name", () => {
    expect(identityProviderSecretNames(OKTA)).toEqual(['ACME_OKTA_SECRET']);
    expect(identityProviderSecretNames(ADFS)).toEqual([
      'ACME_SP_SIGNING_KEY',
      'ACME_SP_DECRYPTION_KEY',
    ]);
    expect(identityProviderSecretNames(GOOGLE)).toEqual([]);
  });

  test("identityProviderKeysOf: each name to the provider that references it, from the tenant's own providers", async () => {
    const { keys: of, lists } = signIn();
    expect(await of.of(tenantId)).toEqual(
      new Map([
        ['ACME_OKTA_SECRET', 'acme-okta'],
        ['ACME_SP_SIGNING_KEY', 'acme-adfs'],
        ['ACME_SP_DECRYPTION_KEY', 'acme-adfs'],
      ]),
    );
    const other = randomUUID() as TenantId;
    expect(await of.of(other)).toEqual(new Map());
    expect(lists).toEqual([tenantId, other]);
  });

  test('without sign-in, no secret is an identity provider\'s', async () => {
    expect(await identityProviderKeysOf(undefined).of(tenantId)).toEqual(new Map());
  });

  test('refuseIdentityProviderKeyNames: the first name held is refused in the words for its user; sign-in itself, or no keys, is never refused', async () => {
    expect(
      await refuseIdentityProviderKeyNames(held, tenantId, ['SEARCH_KEY', 'ACME_OKTA_SECRET'], 'a tool'),
    ).toEqual({
      code: 'identity-provider-key-refused',
      message: SIGN_IN_REFUSED('a tool'),
      secret: 'ACME_OKTA_SECRET',
      identityProviderId: 'acme-okta',
    });
    expect(
      await refuseIdentityProviderKeyNames(held, tenantId, ['ACME_OKTA_SECRET'], 'an identity provider'),
    ).toBeUndefined();
    expect(
      await refuseIdentityProviderKeyNames(undefined, tenantId, ['ACME_OKTA_SECRET'], 'a tool'),
    ).toBeUndefined();
  });

  test('refuseSecretNames asks it last: a reserved name, a provider key and a connection key come first', async () => {
    const providerKeys: ProviderKeys = {
      of: async () => new Map([['ANTHROPIC_API_KEY', 'anthropic']]),
    };
    const connectionKeys: ConnectionKeys = {
      holders: async (_t, name) => (name === 'ACME_TELNYX_KEY' ? ['app-texts'] : []),
    };
    const all = ['ACME_OKTA_SECRET', 'ACME_TELNYX_KEY', 'ANTHROPIC_API_KEY', 'kindgi.internal'];
    const refuse = (names: string[]) =>
      refuseSecretNames(providerKeys, tenantId, names, 'a tool', { keys: connectionKeys }, held);
    expect(await refuse(all)).toMatchObject({ code: 'reserved-name-prefix' });
    expect(await refuse(all.slice(0, 3))).toMatchObject({ code: 'provider-key-refused' });
    expect(await refuse(all.slice(0, 2))).toMatchObject({ code: 'connection-key-refused' });
    expect(await refuse(all.slice(0, 1))).toMatchObject({
      code: 'identity-provider-key-refused',
      secret: 'ACME_OKTA_SECRET',
      identityProviderId: 'acme-okta',
    });
    expect(
      await refuseSecretNames(providerKeys, tenantId, ['ACME_OKTA_SECRET'], 'a tool'),
    ).toBeUndefined();
  });

  test.each([
    'a tool',
    'an MCP endpoint',
    'a webhook endpoint',
    'a webhook trigger',
    'a connection app',
    'a model provider',
    "a pack's env",
  ] as const)("guardSecretKeys, %s: refused at call time, naming it and its provider, and the store isn't asked", async (user) => {
    const { binding, asked } = store();
    const guarded = guardSecretKeys(binding, { identityProviderKeys: signIn().keys }, user);
    expect(
      await guarded.resolve({ scope, envName, name: 'ACME_SP_SIGNING_KEY', resolveContext }),
    ).toEqual({
      kind: 'err',
      error: {
        code: 'identity-provider-key-refused',
        message: SIGN_IN_REFUSED(user, 'ACME_SP_SIGNING_KEY', 'acme-adfs'),
        name: 'ACME_SP_SIGNING_KEY',
        identityProviderId: 'acme-adfs',
      },
    });
    await expect(
      guarded.getVersion({ scope, envName, name: 'ACME_OKTA_SECRET', versionId: 1 }),
    ).rejects.toThrow(/^identity-provider-key-refused: `ACME_OKTA_SECRET` is the secret of identity provider "acme-okta"/);
    expect(asked).toEqual([]);
  });

  test("guardSecretKeys: sign-in reads its providers' secrets, and is still refused a model provider's key and a texts key", async () => {
    const { binding, asked } = store();
    const guarded = guardSecretKeys(
      binding,
      {
        providerKeys: keys,
        connectionKeys: { holders: async (_t, name) => (name === 'ACME_TELNYX_KEY' ? ['app-texts'] : []) },
        identityProviderKeys: signIn().keys,
      },
      'an identity provider',
    );
    const read = (name: string) => guarded.resolve({ scope, envName, name, resolveContext });
    expect((await read('ACME_OKTA_SECRET')).kind).toBe('ok');
    expect((await read('ACME_SP_DECRYPTION_KEY')).kind).toBe('ok');
    expect(await read('ANTHROPIC_API_KEY')).toMatchObject({
      kind: 'err',
      error: { code: 'provider-key-refused' },
    });
    expect(await read('ACME_TELNYX_KEY')).toMatchObject({
      kind: 'err',
      error: { code: 'connection-key-refused' },
    });
    expect(asked).toEqual(['resolve ACME_OKTA_SECRET', 'resolve ACME_SP_DECRYPTION_KEY']);
  });

  test("guardSecretKeys: another tenant's identity provider secret is that tenant's, and providers are read on every call", async () => {
    const { binding } = store();
    const { keys: of, lists } = signIn();
    const guarded = guardSecretKeys(binding, { identityProviderKeys: of }, 'a tool');
    const other = randomUUID() as TenantId;
    expect(
      (
        await guarded.resolve({
          scope: { kind: 'tenant', tenantId: other },
          envName,
          name: 'ACME_OKTA_SECRET',
          resolveContext,
        })
      ).kind,
    ).toBe('ok');
    await guarded.resolve({ scope, envName, name: 'SEARCH_KEY', resolveContext });
    expect(lists).toEqual([other, tenantId]);
  });
});
