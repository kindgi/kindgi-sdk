// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Timestamp } from '@kindgi/types';
import type {
  ApiTokenPage as ApiTokenPageWire,
  ApiToken as ApiTokenWire,
  MintPublicRunTokenBody,
  MintPublicRunTokenResult,
  MintTokenResult,
} from '../generated/api.js';

import { type ListPage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type { ApiToken, ApiTokenCreated, ApiTokenId, ApiTokenSpec } from '../types.js';

/**
 * Tokens resource: API keys and public run tokens.
 *
 * An API key is a machine credential: a service account in its tenant,
 * with a role (`admin` | `member`) and an explicit list of capabilities.
 * Managing keys needs a tenant admin. `create` is the only place a
 * secret ever leaves the server: persist it immediately.
 */
export interface TokensClient {
  /**
   * Mint an API key. Returns `{ meta, secret }`; persist `secret`
   * immediately, since no later read returns it. Only capabilities the
   * caller holds can be granted.
   *
   * @wire `POST /v1/tokens` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1tokens/post`.
   */
  create(
    spec?: ApiTokenSpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ApiTokenCreated>;

  /**
   * List the tenant's API keys, newest first, revoked ones included.
   * Never returns secrets.
   *
   * @wire `GET /v1/tokens` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1tokens/get`.
   */
  list(filter?: TokenFilter): Promise<ListPage<ApiToken>>;

  /**
   * Read one API key. Never returns the secret.
   *
   * @wire `GET /v1/tokens/{tokenId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1tokens~1{tokenId}/get`.
   */
  get(id: ApiTokenId): Promise<ApiToken>;

  /**
   * Revoke an API key: from the next request on, it gets
   * `auth/unauthenticated`.
   *
   * @wire `POST /v1/tokens/{tokenId}/revoke` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1tokens~1{tokenId}~1revoke/post`.
   */
  revoke(id: ApiTokenId, options?: { readonly idempotencyKey?: string }): Promise<void>;

  /**
   * Mint a public run token: short-lived and read-only, for a browser to
   * follow these runs (and their descendants) with `subscribeToRun` or
   * `GET /v1/runs/{runId}`. Call it from your backend, e.g. when the
   * browser's token is about to expire.
   *
   * @wire `POST /v1/tokens/public` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1tokens~1public/post`.
   */
  createPublic(
    input: MintPublicRunTokenInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<PublicRunToken>;
}

export type MintPublicRunTokenInput = MintPublicRunTokenBody;
export type PublicRunToken = MintPublicRunTokenResult;

/** Paging for `tokens.list`: page size, and the cursor a previous page returned. */
export interface TokenFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
}

function fromWire(wire: ApiTokenWire): ApiToken {
  return {
    id: wire.tokenId as unknown as ApiTokenId,
    role: wire.role,
    capabilities: wire.capabilities,
    ...(wire.label !== undefined && { label: wire.label }),
    ...(wire.projectId !== undefined && {
      projectId: wire.projectId as unknown as import('@kindgi/types').ProjectId,
    }),
    ...(wire.createdBy !== undefined && { createdBy: wire.createdBy }),
    createdAt: wire.createdAt as unknown as Timestamp,
    ...(wire.lastUsedAt !== undefined && { lastUsedAt: wire.lastUsedAt as unknown as Timestamp }),
    ...(wire.expiresAt !== undefined && { expiresAt: wire.expiresAt as unknown as Timestamp }),
    ...(wire.revokedAt !== undefined && { revokedAt: wire.revokedAt as unknown as Timestamp }),
  };
}

export function makeTokensClient(transport: Transport): TokensClient {
  return {
    async create(spec, options) {
      const body: Record<string, unknown> = {};
      if (spec?.role !== undefined) body.role = spec.role;
      if (spec?.capabilities !== undefined) body.capabilities = spec.capabilities;
      if (spec?.label !== undefined) body.label = spec.label;
      if (spec?.expiresAt !== undefined) body.expiresAt = spec.expiresAt as unknown as string;
      if (spec?.projectId !== undefined) body.projectId = spec.projectId as unknown as string;
      const wire = await transport.request<MintTokenResult>({
        method: 'POST',
        path: '/v1/tokens',
        body,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
      const { token, ...record } = wire;
      return { meta: fromWire(record), secret: token };
    },

    async list(filter) {
      const page = await transport.request<ApiTokenPageWire>({
        method: 'GET',
        path: '/v1/tokens',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
        },
      });
      return listPage({ ...page, data: page.data.map(fromWire) });
    },

    async get(id) {
      const wire = await transport.request<ApiTokenWire>({
        method: 'GET',
        path: `/v1/tokens/${encodeURIComponent(id as unknown as string)}`,
      });
      return fromWire(wire);
    },

    async createPublic(input, options) {
      return transport.request<PublicRunToken>({
        method: 'POST',
        path: '/v1/tokens/public',
        body: input,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },

    async revoke(id, options) {
      await transport.request<{ readonly tokenId: string; readonly revoked: true }>({
        method: 'POST',
        path: `/v1/tokens/${encodeURIComponent(id as unknown as string)}/revoke`,
        body: {},
        discardResponse: true,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },
  };
}
