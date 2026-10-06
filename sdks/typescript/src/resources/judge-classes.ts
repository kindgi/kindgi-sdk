// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor } from '@kindgi/types';

import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type {
  CreateJudgeClassInput,
  JudgeClass,
  JudgeClassScope,
  UpdateJudgeClassInput,
} from '../types.js';

/**
 * Judge classes resource: the deployment's named kinds of judge
 * ("expert", "user", ...), each with a weight, scoped to the tenant, a
 * project, or an agent in a project.
 */
export interface JudgeClassesClient {
  /**
   * Create a class. Names are unique among the live classes of a scope
   * (`409 judge-class-name-taken`).
   *
   * @wire `POST /v1/judge-classes` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1judge-classes/post`.
   */
  create(
    input: CreateJudgeClassInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<JudgeClass>;

  /**
   * Live classes, newest first. `scope` narrows to one scope.
   *
   * @wire `GET /v1/judge-classes` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1judge-classes/get`.
   */
  list(filter?: JudgeClassFilter): Promise<ListPage<JudgeClass>>;

  /**
   * One class, also a retired one (`unregisteredAt` set).
   *
   * @wire `GET /v1/judge-classes/{judgeClassId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1judge-classes~1{judgeClassId}/get`.
   */
  get(judgeClassId: string): Promise<JudgeClass>;

  /**
   * Change a live class's weight, description or who may assert it.
   *
   * @wire `PATCH /v1/judge-classes/{judgeClassId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1judge-classes~1{judgeClassId}/patch`.
   */
  update(
    judgeClassId: string,
    input: UpdateJudgeClassInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<JudgeClass>;

  /**
   * Retire a class: no new judgments may name it.
   *
   * @wire `POST /v1/judge-classes/{judgeClassId}/unregister` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1judge-classes~1{judgeClassId}~1unregister/post`.
   */
  unregister(judgeClassId: string, options?: { readonly idempotencyKey?: string }): Promise<void>;
}

export interface JudgeClassFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
  readonly scope?: JudgeClassScope;
}

function scopeQuery(scope: JudgeClassScope): Record<string, string> {
  if (scope.kind === 'tenant') return { scopeKind: 'tenant' };
  if (scope.kind === 'project') return { scopeKind: 'project', projectId: scope.projectId };
  return { scopeKind: 'agent', projectId: scope.projectId, agentId: scope.agentId };
}

export function makeJudgeClassesClient(transport: Transport): JudgeClassesClient {
  const withKey = (options?: { readonly idempotencyKey?: string }) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};

  return {
    async create(input, options) {
      return transport.request<JudgeClass>({
        method: 'POST',
        path: '/v1/judge-classes',
        body: input,
        ...withKey(options),
      });
    },

    async list(filter) {
      const page = await transport.request<WirePage<JudgeClass>>({
        method: 'GET',
        path: '/v1/judge-classes',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.scope !== undefined && scopeQuery(filter.scope)),
        },
      });
      return listPage(page);
    },

    async get(judgeClassId) {
      return transport.request<JudgeClass>({
        method: 'GET',
        path: `/v1/judge-classes/${encodeURIComponent(judgeClassId)}`,
      });
    },

    async update(judgeClassId, input, options) {
      return transport.request<JudgeClass>({
        method: 'PATCH',
        path: `/v1/judge-classes/${encodeURIComponent(judgeClassId)}`,
        body: input,
        ...withKey(options),
      });
    },

    async unregister(judgeClassId, options) {
      await transport.request<{ readonly judgeClassId: string; readonly unregistered: true }>({
        method: 'POST',
        path: `/v1/judge-classes/${encodeURIComponent(judgeClassId)}/unregister`,
        body: {},
        discardResponse: true,
        ...withKey(options),
      });
    },
  };
}
