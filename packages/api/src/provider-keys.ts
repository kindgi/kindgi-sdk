// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { toolSecretNames } from '@kindgi/tools';
import type { Cursor, TenantId } from '@kindgi/types';

import type { ConnectionBinding } from './connection-binding.js';
import type { DestinationBinding } from './destination-binding.js';
import type { IdentityProviderBinding, ProviderConfig } from './identity-provider-binding.js';
import { type MCPEndpointRegistryBinding, mcpEndpointSecretNames } from './mcp-endpoint-binding.js';
import type { ProviderRegistryBinding } from './provider-binding.js';
import {
  RESERVED_SECRET_NAME_PREFIX,
  type ResolveContext,
  type SecretBinding,
} from './secrets-binding.js';
import type { ToolRegistryBinding } from './tool-binding.js';
import type { TriggerRegistryBinding } from './trigger-binding.js';
import type { WebhookEndpointBinding } from './webhook-endpoint-binding.js';

/**
 * A model provider's key is used by its provider only: no tool, MCP
 * endpoint, webhook endpoint, webhook trigger or destination may name a secret that a provider
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
 * webhook endpoint, webhook trigger, model provider, pack's env or other
 * connection app registration may name a secret that a live token
 * registration of the tenant references. These checks refuse it where the
 * name is written, and `guardSecretKeys` where it's read.
 */
export interface ConnectionKeys {
  /**
   * The `appId` of every live registration of the tenant whose texts key
   * (`token.apiKey.name`) is `name`, in listing order: two creates that
   * raced can both hold one key. Read afresh on every call.
   */
  holders(tenantId: TenantId, name: string): Promise<readonly string[]>;
}

/**
 * From `binding.keyHolders`, a point read. A binding without it is listed
 * on every call: each page of `listApps`, with no cap, which lists live
 * registrations only, so a removed one frees its key. A binding's
 * `listApps` must carry `token` on a token registration's record, or its
 * key isn't seen.
 */
export function connectionKeysOf(binding: ConnectionBinding | undefined): ConnectionKeys {
  return {
    async holders(tenantId, name) {
      // Without a connection binding there's no registration whose key could clash.
      if (binding === undefined) return [];
      if (binding.keyHolders !== undefined) return binding.keyHolders({ tenantId, name });
      const out: string[] = [];
      for await (const app of pages(
        (cursor) =>
          binding.listApps({ tenantId, limit: PAGE, ...(cursor !== undefined && { cursor }) }),
        Number.POSITIVE_INFINITY,
      )) {
        if (app.token?.apiKey.name === name) out.push(app.appId);
      }
      return out;
    },
  };
}

/**
 * An identity provider's secret (an OIDC client secret, a SAML service
 * provider key) is what signs the tenant's people in, so it's used by
 * sign-in only: no tool, MCP endpoint, webhook endpoint, webhook trigger,
 * connection app registration, model provider or pack's env may name a
 * secret that an identity provider of the tenant references (by name,
 * whatever its env). These checks refuse it where the name is written, and
 * `guardSecretKeys` where it's read.
 */
export interface IdentityProviderKeys {
  /** Each secret an identity provider of the tenant references, by name, with the provider's id. */
  of(tenantId: TenantId): Promise<ReadonlyMap<string, string>>;
}

/** From the tenant's identity providers, listed on every call. */
export function identityProviderKeysOf(
  binding: IdentityProviderBinding | undefined,
): IdentityProviderKeys {
  return {
    async of(tenantId) {
      const out = new Map<string, string>();
      if (binding === undefined) return out;
      for (const provider of (await binding.list({ tenantId })).data) {
        for (const name of identityProviderSecretNames(provider)) {
          if (!out.has(name)) out.set(name, provider.providerId);
        }
      }
      return out;
    },
  };
}

/**
 * The names of the secrets an identity provider references: an OIDC
 * provider's client secret, a SAML provider's signing and decryption keys.
 * A reference is `<name>`, or `<env>/<name>` for another environment's, and
 * a name counts whatever its environment, as a model provider's key does.
 */
export function identityProviderSecretNames(config: ProviderConfig): string[] {
  const refs =
    config.kind === 'oidc'
      ? [config.clientSecretRef]
      : [config.spSigningKeyRef, config.spDecryptionKeyRef];
  return refs.flatMap((ref) => {
    if (ref === undefined) return [];
    const trimmed = ref.trim();
    return [trimmed.slice(trimmed.indexOf('/') + 1)];
  });
}

/** What may name a secret, in the words a refusal uses. */
export type SecretUser =
  | 'a tool'
  | 'an MCP endpoint'
  | 'a webhook endpoint'
  | 'a webhook trigger'
  | 'a connection app'
  | 'a destination'
  | 'a model provider'
  | "a pack's env"
  | 'an identity provider';

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
  // An identity provider never calls a model: its own secret has a name of its own.
  const instead =
    user === 'an identity provider'
      ? "Store the identity provider's own secret under its own name and use that name"
      : 'If it needs to call a model itself, store the key under its own name (the same value is fine) and use that name';
  return {
    code: 'provider-key-refused',
    message: `\`${name}\` is the key of model provider "${providerId}": ${user} never gets a model provider's key. ${instead}`,
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

/** Why `name` can't be used by `user`: it's identity provider `identityProviderId`'s secret. */
export function identityProviderKeyRefusal(
  name: string,
  identityProviderId: string,
  user: SecretUser,
): {
  readonly code: 'identity-provider-key-refused';
  readonly message: string;
  readonly secret: string;
  readonly identityProviderId: string;
} {
  return {
    code: 'identity-provider-key-refused',
    message: `\`${name}\` is the secret of identity provider "${identityProviderId}": ${user} never names it, since it signs the tenant's people in. If one app registration serves both, give it a second secret of its own (a second client secret), store that under its own name and use that name`,
    secret: name,
    identityProviderId,
  };
}

/**
 * Something that uses a secret by name: a tool (its current version), an
 * endpoint, a webhook trigger, a connection app registration, or a
 * destination.
 */
export interface SecretUse {
  readonly kind:
    | 'tool'
    | 'mcp-endpoint'
    | 'webhook-endpoint'
    | 'webhook-trigger'
    | 'connection-app'
    | 'destination';
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
  /** Destinations, by the secrets their `urlRef` and `secretRef` name. */
  readonly destinations?: DestinationBinding;
}

/**
 * A page's worth, and how many pages `usersOfSecret` reads at most. A key's
 * holders are read with no cap (`connectionKeysOf`).
 */
export const PAGE = 100;
const MAX_PAGES = 100;

export async function* pages<T>(
  read: (cursor: Cursor | undefined) => Promise<{
    readonly data: readonly T[];
    readonly nextCursor?: Cursor;
  }>,
  maxPages = MAX_PAGES,
): AsyncGenerator<T> {
  let cursor: Cursor | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await read(cursor);
    yield* page.data;
    if (page.nextCursor === undefined) return;
    cursor = page.nextCursor;
  }
}

/**
 * Everything registered in the tenant that uses the secret `name`: each
 * tool whose current version declares or sends it, each MCP or webhook
 * endpoint that names it, each webhook trigger that verifies with it, and each destination that
 * names it. (A tool's older version an agent still
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
  if (deps.destinations !== undefined) {
    out.push(...(await destinationsUsing(deps.destinations, tenantId, name)));
  }
  return out;
}

/** Each destination whose `urlRef` or `secretRef` names the secret `name`. */
async function destinationsUsing(
  destinations: DestinationBinding,
  tenantId: TenantId,
  name: string,
): Promise<SecretUse[]> {
  const out: SecretUse[] = [];
  for await (const d of pages((cursor) =>
    destinations.list({ tenantId, limit: PAGE, ...(cursor !== undefined && { cursor }) }),
  )) {
    if (d.urlRef?.name === name || d.secretRef?.name === name) {
      out.push({ kind: 'destination', id: d.destinationId as unknown as string });
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
  if (keys === undefined) return undefined;
  for (const name of names) {
    const other = (await keys.holders(tenantId, name)).find((appId) => appId !== ownAppId);
    if (other !== undefined) return connectionKeyRefusal(name, other, user);
  }
  return undefined;
}

/**
 * The first secret in `names` that's a texts registration's account key,
 * refused for `user`: connection keys only, for what checks neither
 * reserved names nor providers' keys (a pack's env). No registration's own
 * key is passed over: that's the connections' guard's only.
 */
export function refuseConnectionKeyNames(
  keys: ConnectionKeys | undefined,
  tenantId: TenantId,
  names: readonly string[],
  user: SecretUser,
): Promise<ReturnType<typeof connectionKeyRefusal> | undefined> {
  return refuseConnectionKeys(keys, undefined, tenantId, names, user);
}

/**
 * The first secret in `names` that's an identity provider's, refused for
 * `user`: for what checks the other kinds its own way (a model provider's
 * key, a pack's env). Sign-in itself (`'an identity provider'`) names them.
 */
export async function refuseIdentityProviderKeyNames(
  keys: IdentityProviderKeys | undefined,
  tenantId: TenantId,
  names: readonly string[],
  user: SecretUser,
): Promise<ReturnType<typeof identityProviderKeyRefusal> | undefined> {
  if (keys === undefined || user === 'an identity provider' || names.length === 0) {
    return undefined;
  }
  const held = await keys.of(tenantId);
  for (const name of names) {
    const identityProviderId = held.get(name);
    if (identityProviderId !== undefined) {
      return identityProviderKeyRefusal(name, identityProviderId, user);
    }
  }
  return undefined;
}

/**
 * The first secret in `names` that `user` can't name: one under the reserved
 * `kindgi.` prefix, then a model provider's key, then a texts registration's
 * account key (`connections.keys`) that a registration other than
 * `connections.ownAppId` holds, then an identity provider's secret
 * (`identityProviders`), which only sign-in names. Every registration that
 * names secrets checks them here, so none gets one check without the others,
 * and so does a reader that checks a name ahead of a cache of its own values.
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
  identityProviders?: IdentityProviderKeys,
): Promise<
  | ReturnType<typeof reservedNameRefusal>
  | ReturnType<typeof providerKeyRefusal>
  | ReturnType<typeof connectionKeyRefusal>
  | ReturnType<typeof identityProviderKeyRefusal>
  | undefined
> {
  const reserved = names.find((name) => name.startsWith(RESERVED_SECRET_NAME_PREFIX));
  if (reserved !== undefined) return reservedNameRefusal(reserved, user);
  return (
    (await refuseProviderKeys(keys, tenantId, names, user)) ??
    (await refuseConnectionKeys(connections?.keys, connections?.ownAppId, tenantId, names, user)) ??
    refuseIdentityProviderKeyNames(identityProviders, tenantId, names, user)
  );
}

/**
 * `binding` for `user`, which never gets a model provider's key: as
 * `guardSecretKeys` with `providerKeys` only.
 */
export function guardProviderKeys(
  binding: SecretBinding,
  keys: ProviderKeys,
  user: SecretUser,
): SecretBinding {
  return guardSecretKeys(binding, { providerKeys: keys }, user);
}

/** The keys a guarded binding refuses: model providers', texts registrations', identity providers', or any of them. */
export interface SecretKeys {
  readonly providerKeys?: ProviderKeys;
  readonly connectionKeys?: ConnectionKeys;
  /** Refused to every user but sign-in (`'an identity provider'`). */
  readonly identityProviderKeys?: IdentityProviderKeys;
}

/**
 * `binding` for `user`, which never gets a key of `keys`: `resolve` answers
 * `provider-key-refused` for a model provider's key, then
 * `connection-key-refused` for a texts registration's, then
 * `identity-provider-key-refused` for an identity provider's secret, to
 * every user but sign-in (`refuseSecretNames`' order), and `getVersion`
 * throws it. What reads names only (`list`, `get`, `listVersions`) and the
 * writes pass through.
 *
 * A texts key's holders are read on every call, with no cache, so a
 * registration that lands after a name was written is refused at once. A
 * texts registration reads its own key only with `user` `'a connection
 * app'`, a read that says `caller: 'connections'` with its `appId`, and no
 * other live registration holding the key. `getVersion` names no reader,
 * so a texts key is refused there to every user.
 *
 * Hand it to whatever gives secrets out: tools, endpoints and webhook
 * triggers get every kind, the connections every kind with their reads'
 * `appId`, a model provider's adapter or a pack's env every kind but
 * `providerKeys`, and sign-in every kind (its own passes).
 */
export function guardSecretKeys(
  binding: SecretBinding,
  keys: SecretKeys,
  user: SecretUser,
): SecretBinding {
  const refusal = async (tenantId: TenantId, name: string, context?: ResolveContext) => {
    if (keys.providerKeys !== undefined) {
      const providerId = (await keys.providerKeys.of(tenantId)).get(name);
      if (providerId !== undefined) return providerKeyRefusal(name, providerId, user);
    }
    if (keys.connectionKeys !== undefined) {
      // The reader's own say: only the connections' reads count it.
      const reader =
        user === 'a connection app' && context?.caller === 'connections'
          ? context.appId
          : undefined;
      const holders = await keys.connectionKeys.holders(tenantId, name);
      const other = holders.find((appId) => appId !== reader);
      if (other !== undefined) return connectionKeyRefusal(name, other, user);
    }
    return refuseIdentityProviderKeyNames(keys.identityProviderKeys, tenantId, [name], user);
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
      const refused = await refusal(input.scope.tenantId, input.name, input.resolveContext);
      if (refused === undefined) return binding.resolve(input);
      return {
        kind: 'err',
        error:
          refused.code === 'provider-key-refused'
            ? {
                code: refused.code,
                message: refused.message,
                name: refused.secret,
                providerId: refused.providerId,
              }
            : refused.code === 'connection-key-refused'
              ? {
                  code: refused.code,
                  message: refused.message,
                  name: refused.secret,
                  appId: refused.appId,
                }
              : {
                  code: refused.code,
                  message: refused.message,
                  name: refused.secret,
                  identityProviderId: refused.identityProviderId,
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
 * Every `SecretBinding` member `guardSecretKeys` handles. A member added
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
