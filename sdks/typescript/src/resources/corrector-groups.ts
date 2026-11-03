// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor } from '@kindgi/types';

import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type {
  CorrectorGroup,
  CorrectorGroupScope,
  CreateCorrectorGroupInput,
  UpdateCorrectorGroupInput,
} from '../types.js';

/**
 * Corrector groups resource: the deployment's named kinds of person who corrects
 * ("expert", "user", ...), each with a weight, scoped to the workspace, a
 * project, or an agent in a project.
 */
export interface CorrectorGroupsClient {
  /**
   * Create a group. Names are unique among the live groups of a scope
   * (`409 corrector-group-name-taken`).
   *
   * @wire `POST /v1/corrector-groups` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1corrector-groups/post`.
   */
  create(
    input: CreateCorrectorGroupInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<CorrectorGroup>;

  /**
   * Live groups, newest first. `scope` narrows to one scope.
   *
   * @wire `GET /v1/corrector-groups` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1corrector-groups/get`.
   */
  list(filter?: CorrectorGroupFilter): Promise<ListPage<CorrectorGroup>>;

  /**
   * One group, also a retired one (`unregisteredAt` set).
   *
   * @wire `GET /v1/corrector-groups/{correctorGroupId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1corrector-groups~1{correctorGroupId}/get`.
   */
  get(correctorGroupId: string): Promise<CorrectorGroup>;

  /**
   * Change a live group's weight, description or who may assert it.
   *
   * @wire `PATCH /v1/corrector-groups/{correctorGroupId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1corrector-groups~1{correctorGroupId}/patch`.
   */
  update(
    correctorGroupId: string,
    input: UpdateCorrectorGroupInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<CorrectorGroup>;

  /**
   * Retire a group: no new corrections may name it.
   *
   * @wire `POST /v1/corrector-groups/{correctorGroupId}/unregister` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1corrector-groups~1{correctorGroupId}~1unregister/post`.
   */
  unregister(
    correctorGroupId: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
}

export interface CorrectorGroupFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
  readonly scope?: CorrectorGroupScope;
}

function scopeQuery(scope: CorrectorGroupScope): Record<string, string> {
  if (scope.kind === 'tenant') return { scopeKind: 'tenant' };
  if (scope.kind === 'project') return { scopeKind: 'project', projectId: scope.projectId };
  return { scopeKind: 'agent', projectId: scope.projectId, agentId: scope.agentId };
}

export function makeCorrectorGroupsClient(transport: Transport): CorrectorGroupsClient {
  const withKey = (options?: { readonly idempotencyKey?: string }) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};

  return {
    async create(input, options) {
      return transport.request<CorrectorGroup>({
        method: 'POST',
        path: '/v1/corrector-groups',
        body: input,
        ...withKey(options),
      });
    },

    async list(filter) {
      const page = await transport.request<WirePage<CorrectorGroup>>({
        method: 'GET',
        path: '/v1/corrector-groups',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.scope !== undefined && scopeQuery(filter.scope)),
        },
      });
      return listPage(page);
    },

    async get(correctorGroupId) {
      return transport.request<CorrectorGroup>({
        method: 'GET',
        path: `/v1/corrector-groups/${encodeURIComponent(correctorGroupId)}`,
      });
    },

    async update(correctorGroupId, input, options) {
      return transport.request<CorrectorGroup>({
        method: 'PATCH',
        path: `/v1/corrector-groups/${encodeURIComponent(correctorGroupId)}`,
        body: input,
        ...withKey(options),
      });
    },

    async unregister(correctorGroupId, options) {
      await transport.request<{ readonly correctorGroupId: string; readonly unregistered: true }>({
        method: 'POST',
        path: `/v1/corrector-groups/${encodeURIComponent(correctorGroupId)}/unregister`,
        body: {},
        discardResponse: true,
        ...withKey(options),
      });
    },
  };
}
