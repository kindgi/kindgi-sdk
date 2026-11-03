// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type {
  ClaimOrchestratorRoundBody,
  DeploymentEndpoint,
  OrchestratorRound,
  PackSuspension,
  RecordDeploymentProblemBody,
  RecordPackEnvBody,
  SetPackEndpointBody,
  SetPackSuspendedBody,
  SystemDeploymentPage,
  SystemPackEnv,
  SystemPackEnvPage,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

/**
 * A deployment as whatever runs its pack service needs it; `warm` in the
 * `missing` and `ready` lists, `reason` in the `retire` list only.
 */
export type SystemDeploymentEntry = SystemDeploymentPage['data'][number];
export type { SystemDeploymentPage };
/** A deployment whose pack service runs on changed values, with the revision it runs (`appliedRevision`). */
export type SystemPackEnvEntry = SystemPackEnvPage['data'][number];
export type { SystemPackEnvPage };
export type PackEndpointSpec = SetPackEndpointBody;
export type DeploymentEndpointProblemSpec = RecordDeploymentProblemBody;
export type PackSuspensionSpec = SetPackSuspendedBody;
export type { PackSuspension };
/**
 * Where each name a deployment's pack declares is set, and the values when
 * nothing stands in the way: plain ones in `env`, and when asked for,
 * secrets in `secrets`.
 */
export type { SystemPackEnv };
export type PackEnvRecordSpec = RecordPackEnvBody;
export type OrchestratorRoundSpec = ClaimOrchestratorRoundBody;
export type { OrchestratorRound };

/**
 * Which deployments to list: those that need a pack service, those whose
 * service is ready and stays, or those whose service should go.
 */
export type SystemDeploymentsWanted = 'missing' | 'ready' | 'retire';

/**
 * Per-deployment routing (`KINDGI_PACK_ROUTING=per-deployment`), on a
 * runtime serving one tenant or many: whatever runs each deployment's own
 * pack service (an orchestrator, holding `system:deployments`) lists the
 * deployments that need one or should lose theirs, and records where each
 * runs, one pass at a time. Support suspends a pack under `system:suspend`.
 * Any other caller gets 403 (`system-principal-required`,
 * `system-scope-missing`).
 */
export interface SystemDeploymentsClient {
  /**
   * One page across tenants, oldest first. Name each service
   * `packServiceName(tenantId, deploymentId)` (`@kindgi/api`); keep an
   * instance of each `warm` one running.
   *
   * @wire `GET /v1/system/deployments`
   */
  list(
    endpoint: SystemDeploymentsWanted,
    page?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<SystemDeploymentPage>;
  /**
   * Claims the round for one pass, for `holdSeconds`, before it acts. A
   * claim is never renewed: the pass ends within its hold, or its claim
   * lapses. Another pass's live claim fails with 409
   * (`orchestrator-round-held`): this pass stops.
   *
   * @wire `POST /v1/system/deployments/round`
   */
  claimRound(spec: OrchestratorRoundSpec): Promise<OrchestratorRound>;
  /**
   * Ends the round `claimant` claimed, so the next pass claims it at once.
   *
   * @wire `POST /v1/system/deployments/round/end`
   */
  endRound(claimant: string): Promise<void>;
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
   * (`pending`, or `cleared` and `waiting`, as after a suspension is
   * lifted), as one of the fixed codes.
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
  /**
   * One page across tenants (`system:pack-env`): deployments with a `ready`
   * pack service whose declared env values changed since the revision it
   * runs, and weren't held back at this revision: ids, and the revision
   * each runs (`appliedRevision`, sent back with `recordPackEnv`). One held
   * at its revision for a cause the platform fixes is listed every time,
   * with its `held`. Never a value.
   *
   * @wire `GET /v1/system/pack-env`
   */
  listPackEnvChanged(page?: {
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<SystemPackEnvPage>;
  /**
   * What the deployment's pack service is to be given (`system:pack-env`):
   * where each declared name is set, its `revision`, and the plain values
   * (`env`) unless there's a `problem`. With `secrets: 'values'`, each name
   * set only as a secret too (`secrets`), for a key holding
   * `system:pack-env` itself. Each value given out is on the audit record,
   * a secret's before the answer.
   *
   * @wire `GET /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env`
   */
  getPackEnv(
    tenantId: string,
    deploymentId: string,
    options?: { readonly secrets?: 'values' },
  ): Promise<SystemPackEnv>;
  /**
   * Records the revision a `ready` pack service now runs, or, with `held`,
   * that this revision couldn't be given and the service keeps what it
   * runs. Compare-and-set on `appliedRevision` (`pack-env-conflict`).
   *
   * @wire `PUT /v1/system/tenants/{tenantId}/deployments/{deploymentId}/pack-env`
   */
  recordPackEnv(
    tenantId: string,
    deploymentId: string,
    spec: PackEnvRecordSpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<DeploymentEndpoint>;
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
    async claimRound(spec) {
      return transport.request<OrchestratorRound>({
        method: 'POST',
        path: '/v1/system/deployments/round',
        body: spec,
      });
    },
    async endRound(claimant) {
      return transport.request<void>({
        method: 'POST',
        path: '/v1/system/deployments/round/end',
        body: { claimant },
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
    async listPackEnvChanged(page) {
      return transport.request<SystemPackEnvPage>({
        method: 'GET',
        path: '/v1/system/pack-env',
        query: {
          ...(page?.cursor !== undefined && { cursor: page.cursor }),
          ...(page?.limit !== undefined && { limit: page.limit }),
        },
      });
    },
    async getPackEnv(tenantId, deploymentId, options) {
      return transport.request<SystemPackEnv>({
        method: 'GET',
        path: `/v1/system/tenants/${seg(tenantId)}/deployments/${seg(deploymentId)}/pack-env`,
        query: { ...(options?.secrets !== undefined && { secrets: options.secrets }) },
      });
    },
    async recordPackEnv(tenantId, deploymentId, spec, options) {
      return transport.request<DeploymentEndpoint>({
        method: 'PUT',
        path: `/v1/system/tenants/${seg(tenantId)}/deployments/${seg(deploymentId)}/pack-env`,
        body: spec,
        ...key(options),
      });
    },
  };
}
