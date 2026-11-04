// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { toolSecretNames } from '@kindgi/tools';
import type { Cursor, TenantId } from '@kindgi/types';

import type { ConnectionBinding } from './connection-binding.js';
import { type MCPEndpointRegistryBinding, mcpEndpointSecretNames } from './mcp-endpoint-binding.js';
import type { ProviderRegistryBinding } from './provider-binding.js';
import { RESERVED_SECRET_NAME_PREFIX, type SecretBinding } from './secrets-binding.js';
import type { ToolRegistryBinding } from './tool-binding.js';
import type { TriggerRegistryBinding } from './trigger-binding.js';
import type { WebhookEndpointBinding } from './webhook-endpoint-binding.js';

/**
 * A model provider's key is used by its provider only: no tool, MCP
 * endpoint, webhook endpoint or webhook trigger may name a secret that a provider
 * registration of the tenant references (by name, whatever its env). The
 * runtime refuses to hand one out; these checks refuse it earlier, where
 * the name is written, with the same words.
 */
export interface ProviderKeys {
  /** Each secret a provider registration of the tenant references, by name, with the provider's id. */
  of(tenantId: TenantId): Promise<ReadonlyMap<string, string>>;
}

export function providerKeysOf(registry: ProviderRegistryBinding | undefined): ProviderKeys {
  return {
    async of(tenantId) {
      const out = new Map<string, string>();
      if (registry === undefined) return out;
      for (const entry of await registry.resolveForRuntime({ tenantId })) {
        if (entry.secretRef !== undefined) out.set(entry.secretRef.name, entry.metadata.id);
      }
      return out;
    },
  };
}

/**
 * A texts registration's key (`token.apiKey`) reaches the whole provider
 * account, so it's used by its registration only: no tool, MCP endpoint,
 * webhook endpoint, webhook trigger, model provider or other connection app
 * registration may name a secret that a live token registration of the
 * tenant references. These checks refuse it where the name is written.
 */
export interface ConnectionKeys {
  /**
   * Each secret a live token registration of the tenant references
   * (`token.apiKey.name`), with the `appId` of every live registration that
   * names it, in listing order: two creates that raced can both hold one key.
   */
  of(tenantId: TenantId): Promise<ReadonlyMap<string, readonly string[]>>;
}

/**
 * Reads every page of `binding.listApps`, which lists live registrations
 * only: a removed one frees its key. A binding's `listApps` must carry
 * `token` on a token registration's record, or its key isn't seen.
 */
export function connectionKeysOf(binding: ConnectionBinding | undefined): ConnectionKeys {
  return {
    async of(tenantId) {
      const out = new Map<string, string[]>();
      // Without a connection binding there's no registration whose key could clash.
      if (binding === undefined) return out;
      for await (const app of pages((cursor) =>
        binding.listApps({ tenantId, limit: PAGE, ...(cursor !== undefined && { cursor }) }),
      )) {
        if (app.token === undefined) continue;
        const name = app.token.apiKey.name;
        const appIds = out.get(name);
        if (appIds === undefined) out.set(name, [app.appId]);
        else appIds.push(app.appId);
      }
      return out;
    },
  };
}

/** What may name a secret, in the words a refusal uses. */
export type SecretUser =
  | 'a tool'
  | 'an MCP endpoint'
  | 'a webhook endpoint'
  | 'a webhook trigger'
  | 'a connection app'
  | 'a model provider';

/** Why `name` can't be used by `user`: it's model provider `providerId`'s key. */
export function providerKeyRefusal(
  name: string,
  providerId: string,
  user: SecretUser,
): {
  readonly code: 'provider-key-refused';
  readonly message: string;
  readonly secret: string;
  readonly providerId: string;
} {
  return {
    code: 'provider-key-refused',
    message: `\`${name}\` is the key of model provider "${providerId}": ${user} never gets a model provider's key. If it needs to call a model itself, store the key under its own name (the same value is fine) and use that name`,
    secret: name,
    providerId,
  };
}

/** Why `name` can't be used by `user`: it's connection app registration `appId`'s account key. */
export function connectionKeyRefusal(
  name: string,
  appId: string,
  user: SecretUser,
): {
  readonly code: 'connection-key-refused';
  readonly message: string;
  readonly secret: string;
  readonly appId: string;
} {
  return {
    code: 'connection-key-refused',
    message: `\`${name}\` is the account key of connection app registration "${appId}": ${user} never names it, since that key reaches the whole provider account. Use a key of its own: a new API key from the provider, stored under its own name. A copy of this one under another name reaches the same account`,
    secret: name,
    appId,
  };
}

/**
 * Something that uses a secret by name: a tool (its current version), an
 * endpoint, a webhook trigger, or a connection app registration.
 */
export interface SecretUse {
  readonly kind:
    | 'tool'
    | 'mcp-endpoint'
    | 'webhook-endpoint'
    | 'webhook-trigger'
    | 'connection-app';
  readonly id: string;
  readonly version?: string;
}

/** What may use a secret, where it's registered. */
export interface SecretUsersDeps {
  readonly tools?: ToolRegistryBinding;
  readonly mcpEndpoints?: MCPEndpointRegistryBinding;
  readonly webhookEndpoints?: WebhookEndpointBinding;
  /** Webhook triggers, by the secret they verify deliveries with (`hmacSecretName`). */
  readonly triggers?: TriggerRegistryBinding;
}

/** A page's worth, and how many pages at most: past that, the call-time refusal still holds. */
export const PAGE = 100;
const MAX_PAGES = 100;

export async function* pages<T>(
  read: (cursor: Cursor | undefined) => Promise<{
    readonly data: readonly T[];
    readonly nextCursor?: Cursor;
  }>,
): AsyncGenerator<T> {
  let cursor: Cursor | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await read(cursor);
    yield* page.data;
    if (page.nextCursor === undefined) return;
    cursor = page.nextCursor;
  }
}

/**
 * Everything registered in the tenant that uses the secret `name`: each
 * tool whose current version declares or sends it, each MCP or webhook
 * endpoint that names it, and each webhook trigger that verifies with it. (A tool's older version an agent still
 * pins is refused at call time, and the runtime's boot warning names it.)
 */
export async function usersOfSecret(
  deps: SecretUsersDeps,
  tenantId: TenantId,
  name: string,
): Promise<SecretUse[]> {
  const out: SecretUse[] = [];
  if (deps.tools !== undefined) {
    const tools = deps.tools;
    for await (const t of pages((cursor) =>
      tools.list({ tenantId, limit: PAGE, ...(cursor !== undefined && { cursor }) }),
    )) {
      if (toolSecretNames(t).includes(name)) {
        out.push({ kind: 'tool', id: t.id as unknown as string, version: t.version });
      }
    }
  }
  if (deps.mcpEndpoints !== undefined) {
    const mcp = deps.mcpEndpoints;
    for await (const e of pages((cursor) =>
      mcp.list({ tenantId, limit: PAGE, ...(cursor !== undefined && { cursor }) }),
    )) {
      if (mcpEndpointSecretNames(e).includes(name)) {
        out.push({ kind: 'mcp-endpoint', id: e.endpointId });
      }
    }
  }
  if (deps.webhookEndpoints !== undefined) {
    const hooks = deps.webhookEndpoints;
    for await (const e of pages((cursor) =>
      hooks.list({ tenantId, limit: PAGE, ...(cursor !== undefined && { cursor }) }),
    )) {
      if (e.secretRef.name === name) {
        out.push({ kind: 'webhook-endpoint', id: e.endpointId as unknown as string });
      }
    }
  }
  if (deps.triggers !== undefined) {
    const triggers = deps.triggers;
    for await (const t of pages((cursor) =>
      triggers.list({
        tenantId,
        kind: 'webhook',
        limit: PAGE,
        ...(cursor !== undefined && { cursor }),
      }),
    )) {
      if (t.kind === 'webhook' && t.hmacSecretName === name) {
        out.push({ kind: 'webhook-trigger', id: t.triggerId as unknown as string });
      }
    }
  }
  return out;
}

/** Why `name` can't be used by `user`: it's one of Kindgi's own, reserved names. */
function reservedNameRefusal(
  name: string,
  user: SecretUser,
): {
  readonly code: 'reserved-name-prefix';
  readonly message: string;
  readonly secret: string;
} {
  return {
    code: 'reserved-name-prefix',
    message: `\`${name}\` uses the reserved "${RESERVED_SECRET_NAME_PREFIX}" prefix: ${user} never names one. Those names are Kindgi's own; store the secret under a name of its own and use that`,
    secret: name,
  };
}

/** The first secret in `names` that's a model provider's key, refused for `user`. */
async function refuseProviderKeys(
  keys: ProviderKeys | undefined,
  tenantId: TenantId,
  names: readonly string[],
  user: SecretUser,
): Promise<ReturnType<typeof providerKeyRefusal> | undefined> {
  if (keys === undefined || names.length === 0) return undefined;
  const owned = await keys.of(tenantId);
  for (const name of names) {
    const providerId = owned.get(name);
    if (providerId !== undefined) return providerKeyRefusal(name, providerId, user);
  }
  return undefined;
}

/**
 * The first secret in `names` that's a texts registration's account key,
 * refused for `user`, naming a registration other than `ownAppId`: its own key
 * is its to name, unless another live registration holds it too.
 */
async function refuseConnectionKeys(
  keys: ConnectionKeys | undefined,
  ownAppId: string | undefined,
  tenantId: TenantId,
  names: readonly string[],
  user: SecretUser,
): Promise<ReturnType<typeof connectionKeyRefusal> | undefined> {
  if (keys === undefined || names.length === 0) return undefined;
  const owned = await keys.of(tenantId);
  for (const name of names) {
    const other = owned.get(name)?.find((appId) => appId !== ownAppId);
    if (other !== undefined) return connectionKeyRefusal(name, other, user);
  }
  return undefined;
}

/**
 * The first secret in `names` that `user` can't name: one under the reserved
 * `kindgi.` prefix, then a model provider's key, then a texts registration's
 * account key (`connections.keys`) that a registration other than
 * `connections.ownAppId` holds. Every registration that names secrets checks
 * them here, so none gets one check without the others.
 */
export async function refuseSecretNames(
  keys: ProviderKeys | undefined,
  tenantId: TenantId,
  names: readonly string[],
  user: SecretUser,
  connections?: {
    readonly keys?: ConnectionKeys | undefined;
    /** The registration being changed (a `PATCH`'s `:appId`): its own key is its to name. */
    readonly ownAppId?: string | undefined;
  },
): Promise<
  | ReturnType<typeof reservedNameRefusal>
  | ReturnType<typeof providerKeyRefusal>
  | ReturnType<typeof connectionKeyRefusal>
  | undefined
> {
  const reserved = names.find((name) => name.startsWith(RESERVED_SECRET_NAME_PREFIX));
  if (reserved !== undefined) return reservedNameRefusal(reserved, user);
  return (
    (await refuseProviderKeys(keys, tenantId, names, user)) ??
    refuseConnectionKeys(connections?.keys, connections?.ownAppId, tenantId, names, user)
  );
}

/**
 * `binding` for `user`, which never gets a model provider's key: `resolve`
 * answers `provider-key-refused` for one, and `getVersion` throws it. What
 * reads names only (`list`, `get`, `listVersions`) and the writes pass
 * through. Hand it to whatever gives secrets to tools and endpoints; a
 * provider's adapter keeps `binding` itself.
 */
export function guardProviderKeys(
  binding: SecretBinding,
  keys: ProviderKeys,
  user: SecretUser,
): SecretBinding {
  const refusal = async (tenantId: TenantId, name: string) => {
    const providerId = (await keys.of(tenantId)).get(name);
    return providerId === undefined ? undefined : providerKeyRefusal(name, providerId, user);
  };
  const guarded: SecretBinding = {
    list: (input) => binding.list(input),
    get: (input) => binding.get(input),
    listVersions: (input) => binding.listVersions(input),
    // Says which cursors the lists issued, and the lists pass through: so does it.
    ...(binding.issuedCursor !== undefined && {
      issuedCursor: binding.issuedCursor.bind(binding),
    }),
    set: (input) => binding.set(input),
    rotate: (input) => binding.rotate(input),
    revoke: (input) => binding.revoke(input),
    // Says how `set` writes, and `set` passes through: so does it.
    ...(binding.writesAppEnvFiles !== undefined && {
      writesAppEnvFiles: binding.writesAppEnvFiles,
    }),
    // Says which names `set` refuses, and `set` passes through: so does it.
    ...(binding.nameRefusal !== undefined && {
      nameRefusal: (name: string) => binding.nameRefusal?.(name),
    }),
    // Env names only: nothing a key could be read from.
    ...(binding.listEnvNames !== undefined && {
      listEnvNames: binding.listEnvNames.bind(binding),
    }),
    async resolve(input) {
      const refused = await refusal(input.scope.tenantId, input.name);
      if (refused === undefined) return binding.resolve(input);
      return {
        kind: 'err',
        error: {
          code: refused.code,
          message: refused.message,
          name: refused.secret,
          providerId: refused.providerId,
        },
      };
    },
    async getVersion(input) {
      const refused = await refusal(input.scope.tenantId, input.name);
      if (refused !== undefined) throw new Error(`${refused.code}: ${refused.message}`);
      return binding.getVersion(input);
    },
  };
  return guarded;
}

/**
 * Every `SecretBinding` member `guardProviderKeys` handles. A member added
 * to `SecretBinding`, an optional one too, doesn't compile below until it's
 * listed here: someone decides whether the guard covers it.
 */
const GUARDED_MEMBERS = [
  'list',
  'get',
  'listVersions',
  'issuedCursor',
  'set',
  'rotate',
  'revoke',
  'resolve',
  'getVersion',
  'writesAppEnvFiles',
  'nameRefusal',
  'listEnvNames',
] as const satisfies readonly (keyof SecretBinding)[];
type Unguarded = Exclude<keyof SecretBinding, (typeof GUARDED_MEMBERS)[number]>;
// `true` while every member is listed; an unlisted one makes it its name, and this fails.
export const EVERY_SECRET_MEMBER_GUARDED: [Unguarded] extends [never] ? true : Unguarded = true;
