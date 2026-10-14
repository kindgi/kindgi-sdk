// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  DeploymentEndpoint,
  PackSuspension,
  RecordDeploymentProblemBody,
  SetPackEndpointBody,
  SetPackSuspendedBody,
  SystemDeploymentPage,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

/** A deployment as whatever runs its pack service needs it; `reason` in the `retire` list only. */
export type SystemDeploymentEntry = SystemDeploymentPage['data'][number];
export type { SystemDeploymentPage };
export type PackEndpointSpec = SetPackEndpointBody;
export type DeploymentEndpointProblemSpec = RecordDeploymentProblemBody;
export type PackSuspensionSpec = SetPackSuspendedBody;
export type { PackSuspension };

/** Which deployments to list: those that need a pack service, or those whose service should go. */
export type SystemDeploymentsWanted = 'missing' | 'retire';

/**
 * Per-deployment routing, on a runtime serving many tenants: whatever runs
 * each deployment's own pack service (an orchestrator, holding
 * `system:deployments`) lists the deployments that need one or should lose
 * theirs, and records where each runs. Support suspends a pack under
 * `system:suspend`. Any other caller gets 403 (`system-principal-required`,
 * `system-scope-missing`).
 */
export interface SystemDeploymentsClient {
  /**
   * One page across tenants, oldest first. Name each service
   * `packServiceName(tenantId, deploymentId)` (`@kindgi/api`).
   *
   * @wire `GET /v1/system/deployments`
   */
  list(
    endpoint: SystemDeploymentsWanted,
    page?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<SystemDeploymentPage>;
  /**
   * Records where the deployment's pack service runs, once the server's
   * checks pass; its endpoint is then `ready`. A refusal names the check
   * (`endpoint-url-invalid`, `endpoint-host-not-allowed`,
   * `endpoint-name-mismatch`, `endpoint-unreachable`,
   * `endpoint-info-mismatch`, `image-not-allowed`) and is recorded as the
   * endpoint's problem.
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint`
   */
  setEndpoint(
    tenantId: string,
    deploymentId: string,
    spec: PackEndpointSpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<DeploymentEndpoint>;
  /**
   * Clears the endpoint before its service is deleted: calls fail closed.
   *
   * @wire `DELETE /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint`
   */
  clearEndpoint(
    tenantId: string,
    deploymentId: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<DeploymentEndpoint>;
  /**
   * Records why a deployment waiting for its pack service has none yet
   * (pending, or cleared and listed as needing one again after a
   * suspension is lifted), as one of the fixed codes.
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/endpoint/problem`
   */
  recordProblem(
    tenantId: string,
    deploymentId: string,
    spec: DeploymentEndpointProblemSpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<DeploymentEndpoint>;
  /**
   * Suspends the deployment's pack, or restores it (`system:suspend`).
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/suspended`
   */
  setSuspended(
    tenantId: string,
    deploymentId: string,
    spec: PackSuspensionSpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<PackSuspension>;
}

export function makeSystemDeploymentsClient(transport: Transport): SystemDeploymentsClient {
  const seg = (s: string): string => encodeURIComponent(s);
  const key = (options?: { readonly idempotencyKey?: string }) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};
  return {
    async list(endpoint, page) {
      return transport.request<SystemDeploymentPage>({
        method: 'GET',
        path: '/v1/system/deployments',
        query: {
          endpoint,
          ...(page?.cursor !== undefined && { cursor: page.cursor }),
          ...(page?.limit !== undefined && { limit: page.limit }),
        },
      });
    },
    async setEndpoint(tenantId, deploymentId, spec, options) {
      return transport.request<DeploymentEndpoint>({
        method: 'PUT',
        path: `/v1/system/tenants/${seg(tenantId)}/deployments/${seg(deploymentId)}/endpoint`,
        body: spec,
        ...key(options),
      });
    },
    async clearEndpoint(tenantId, deploymentId, options) {
      return transport.request<DeploymentEndpoint>({
        method: 'DELETE',
        path: `/v1/system/tenants/${seg(tenantId)}/deployments/${seg(deploymentId)}/endpoint`,
        ...key(options),
      });
    },
    async recordProblem(tenantId, deploymentId, spec, options) {
      return transport.request<DeploymentEndpoint>({
        method: 'PUT',
        path: `/v1/system/tenants/${seg(tenantId)}/deployments/${seg(deploymentId)}/endpoint/problem`,
        body: spec,
        ...key(options),
      });
    },
    async setSuspended(tenantId, deploymentId, spec, options) {
      return transport.request<PackSuspension>({
        method: 'PUT',
        path: `/v1/system/tenants/${seg(tenantId)}/deployments/${seg(deploymentId)}/suspended`,
        body: spec,
        ...key(options),
      });
    },
  };
}
