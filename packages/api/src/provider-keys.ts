// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { toolSecretNames } from '@kindgi/tools';
import type { Cursor, TenantId } from '@kindgi/types';

import { type MCPEndpointRegistryBinding, mcpEndpointSecretNames } from './mcp-endpoint-binding.js';
import type { ProviderRegistryBinding } from './provider-binding.js';
import type { SecretBinding } from './secrets-binding.js';
import type { ToolRegistryBinding } from './tool-binding.js';
import type { WebhookEndpointBinding } from './webhook-endpoint-binding.js';

/**
 * A model provider's key is used by its provider only: no tool, MCP
 * endpoint or webhook endpoint may name a secret that a provider
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

/** What may name a secret, in the words a refusal uses. */
export type SecretUser = 'a tool' | 'an MCP endpoint' | 'a webhook endpoint';

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

/** Something that uses a secret by name: a tool (its current version), or an endpoint. */
export interface SecretUse {
  readonly kind: 'tool' | 'mcp-endpoint' | 'webhook-endpoint';
  readonly id: string;
  readonly version?: string;
}

/** What may use a secret, where it's registered. */
export interface SecretUsersDeps {
  readonly tools?: ToolRegistryBinding;
  readonly mcpEndpoints?: MCPEndpointRegistryBinding;
  readonly webhookEndpoints?: WebhookEndpointBinding;
}

/** A page's worth, and how many pages at most: past that, the call-time refusal still holds. */
const PAGE = 100;
const MAX_PAGES = 100;

async function* pages<T>(
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
 * tool whose current version declares or sends it, and each MCP or
 * webhook endpoint that names it. (A tool's older version an agent still
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
  return out;
}

/** The first secret in `names` that's a model provider's key, refused for `user`. */
export async function refuseProviderKeys(
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
    set: (input) => binding.set(input),
    rotate: (input) => binding.rotate(input),
    revoke: (input) => binding.revoke(input),
    // Says how `set` writes, and `set` passes through: so does it.
    ...(binding.writesAppEnvFiles !== undefined && {
      writesAppEnvFiles: binding.writesAppEnvFiles,
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
  'set',
  'rotate',
  'revoke',
  'resolve',
  'getVersion',
  'writesAppEnvFiles',
] as const satisfies readonly (keyof SecretBinding)[];
type Unguarded = Exclude<keyof SecretBinding, (typeof GUARDED_MEMBERS)[number]>;
// `true` while every member is listed; an unlisted one makes it its name, and this fails.
export const EVERY_SECRET_MEMBER_GUARDED: [Unguarded] extends [never] ? true : Unguarded = true;
