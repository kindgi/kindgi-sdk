// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  GatePolicy,
  GatePolicyPage,
  LiveScope,
  PublishGatePolicyBody,
} from '../generated/api.js';
import type { Transport } from '../transport.js';
import { scopeQuery } from './agents.js';

/**
 * Gate policies (evals step 4b): what a promotion of an agent must show
 * before a version goes live for a scope. One policy per agent and scope;
 * the caller names the policy and its semver versions. Writes need
 * `admin` on the tenant.
 */
export interface GatePoliciesClient {
  /**
   * Each policy's latest active version.
   *
   * @wire GET /v1/gate-policies
   */
  list(filter?: GatePolicyFilter): Promise<GatePolicyPage>;
  /**
   * The policy's latest active version.
   *
   * @wire GET /v1/gate-policies/:policyId
   */
  get(policyId: string): Promise<GatePolicy>;
  /**
   * Register a policy, or a new version of one. `409
   * gate-policy-scope-taken` when another policy gates the agent for the
   * scope (`details.heldBy`); `409 gate-policy-scope-changed` when a new
   * version names another agent or scope.
   *
   * @wire POST /v1/gate-policies
   */
  publish(
    input: PublishGatePolicyInput,
    options?: { idempotencyKey?: string },
  ): Promise<GatePolicy>;
  readonly versions: GatePolicyVersionsClient;
}

export interface GatePolicyVersionsClient {
  /** @wire GET /v1/gate-policies/:policyId/versions — oldest first, unregistered ones too */
  list(policyId: string): Promise<GatePolicyPage>;
  /** @wire GET /v1/gate-policies/:policyId/versions/:version */
  get(policyId: string, version: string): Promise<GatePolicy>;
  /** @wire POST /v1/gate-policies/:policyId/versions/:version/unregister */
  unregister(policyId: string, version: string): Promise<GatePolicy>;
  /** @wire POST /v1/gate-policies/:policyId/versions/:version/reinstate */
  reinstate(policyId: string, version: string): Promise<GatePolicy>;
}

export interface GatePolicyFilter {
  readonly agentId?: string;
  /** Only the policy of exactly this scope. */
  readonly scope?: LiveScope;
  readonly limit?: number;
  readonly cursor?: string;
}

export type PublishGatePolicyInput = PublishGatePolicyBody;

export function makeGatePoliciesClient(transport: Transport): GatePoliciesClient {
  const seg = (s: string) => encodeURIComponent(s);
  return {
    async list(filter) {
      return transport.request<GatePolicyPage>({
        method: 'GET',
        path: '/v1/gate-policies',
        query: {
          ...(filter?.agentId !== undefined && { agentId: filter.agentId }),
          ...(filter?.scope !== undefined && scopeQuery(filter.scope)),
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
        },
      });
    },
    async get(policyId) {
      return transport.request<GatePolicy>({
        method: 'GET',
        path: `/v1/gate-policies/${seg(policyId)}`,
      });
    },
    async publish(input, options) {
      return transport.request<GatePolicy>({
        method: 'POST',
        path: '/v1/gate-policies',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    versions: {
      async list(policyId) {
        return transport.request<GatePolicyPage>({
          method: 'GET',
          path: `/v1/gate-policies/${seg(policyId)}/versions`,
        });
      },
      async get(policyId, version) {
        return transport.request<GatePolicy>({
          method: 'GET',
          path: `/v1/gate-policies/${seg(policyId)}/versions/${seg(version)}`,
        });
      },
      async unregister(policyId, version) {
        return transport.request<GatePolicy>({
          method: 'POST',
          path: `/v1/gate-policies/${seg(policyId)}/versions/${seg(version)}/unregister`,
        });
      },
      async reinstate(policyId, version) {
        return transport.request<GatePolicy>({
          method: 'POST',
          path: `/v1/gate-policies/${seg(policyId)}/versions/${seg(version)}/reinstate`,
        });
      },
    },
  };
}
