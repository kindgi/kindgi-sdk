// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  AgentPinScope,
  PublishReleaseGateBody,
  ReleaseGate,
  ReleaseGatePage,
} from '../generated/api.js';
import type { Transport } from '../transport.js';
import { scopeQuery } from './agents.js';

/**
 * Release gates: what an agent version must show before it is pinned for
 * a scope. One gate per agent and scope; the caller names the gate and
 * its semver versions. Writes need `admin` on the workspace.
 */
export interface ReleaseGatesClient {
  /**
   * Each release gate's latest active version. `filter.includeRetired =
   * true` lists a retired gate too, as its highest version with
   * `unregisteredAt`.
   *
   * @wire GET /v1/release-gates
   */
  list(filter?: ReleaseGateFilter): Promise<ReleaseGatePage>;
  /**
   * The release gate's latest active version.
   *
   * @wire GET /v1/release-gates/:releaseGateId
   */
  get(releaseGateId: string): Promise<ReleaseGate>;
  /**
   * Register a release gate, or a new version of one. `409
   * release-gate-scope-taken` when another gate checks the agent for the
   * scope (`details.heldBy`); `409 release-gate-scope-changed` when a new
   * version names another agent or scope.
   *
   * @wire POST /v1/release-gates
   */
  publish(
    input: PublishReleaseGateInput,
    options?: { idempotencyKey?: string },
  ): Promise<ReleaseGate>;
  readonly versions: ReleaseGateVersionsClient;
}

export interface ReleaseGateVersionsClient {
  /** @wire GET /v1/release-gates/:releaseGateId/versions — oldest first, unregistered ones too */
  list(releaseGateId: string): Promise<ReleaseGatePage>;
  /** @wire GET /v1/release-gates/:releaseGateId/versions/:version */
  get(releaseGateId: string, version: string): Promise<ReleaseGate>;
  /** @wire POST /v1/release-gates/:releaseGateId/versions/:version/unregister */
  unregister(releaseGateId: string, version: string): Promise<ReleaseGate>;
  /** @wire POST /v1/release-gates/:releaseGateId/versions/:version/reinstate */
  reinstate(releaseGateId: string, version: string): Promise<ReleaseGate>;
}

export interface ReleaseGateFilter {
  readonly agentId?: string;
  /** Only the release gate of exactly this scope. */
  readonly scope?: AgentPinScope;
  readonly limit?: number;
  readonly cursor?: string;
  /**
   * `true` lists retired gates too (every version unregistered), each as
   * its highest version with `unregisteredAt`. Default: gates with an
   * active version only.
   */
  readonly includeRetired?: boolean;
}

export type PublishReleaseGateInput = PublishReleaseGateBody;

export function makeReleaseGatesClient(transport: Transport): ReleaseGatesClient {
  const seg = (s: string) => encodeURIComponent(s);
  return {
    async list(filter) {
      return transport.request<ReleaseGatePage>({
        method: 'GET',
        path: '/v1/release-gates',
        query: {
          ...(filter?.agentId !== undefined && { agentId: filter.agentId }),
          ...(filter?.scope !== undefined && scopeQuery(filter.scope)),
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.includeRetired === true && { includeRetired: 'true' }),
        },
      });
    },
    async get(releaseGateId) {
      return transport.request<ReleaseGate>({
        method: 'GET',
        path: `/v1/release-gates/${seg(releaseGateId)}`,
      });
    },
    async publish(input, options) {
      return transport.request<ReleaseGate>({
        method: 'POST',
        path: '/v1/release-gates',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    versions: {
      async list(releaseGateId) {
        return transport.request<ReleaseGatePage>({
          method: 'GET',
          path: `/v1/release-gates/${seg(releaseGateId)}/versions`,
        });
      },
      async get(releaseGateId, version) {
        return transport.request<ReleaseGate>({
          method: 'GET',
          path: `/v1/release-gates/${seg(releaseGateId)}/versions/${seg(version)}`,
        });
      },
      async unregister(releaseGateId, version) {
        return transport.request<ReleaseGate>({
          method: 'POST',
          path: `/v1/release-gates/${seg(releaseGateId)}/versions/${seg(version)}/unregister`,
        });
      },
      async reinstate(releaseGateId, version) {
        return transport.request<ReleaseGate>({
          method: 'POST',
          path: `/v1/release-gates/${seg(releaseGateId)}/versions/${seg(version)}/reinstate`,
        });
      },
    },
  };
}
