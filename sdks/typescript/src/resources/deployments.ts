// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Deployments — signed OCI image deployments.
 *
 * @wire /v1/deployments/*  (packages/api/src/routes/deployments.ts)
 * @generated Wire shapes from `../generated/api.js`.
 *
 * Register a deployment by handing in a signed Ed25519 envelope over
 * `{ imageDigest, artifactVersion, indexHash, tenantId, publishedAt }`.
 * Server verifies signature against the tenant trust-list, pulls the
 * image, validates + upserts every packed primitive (tools, guardrails,
 * agents, flows), and appends an immutable ledger row. All-or-nothing.
 *
 * Promote a deployment to the next environment of its environment order:
 * the exact build moves, with the edits of its agents and flows; `check`
 * says what would move and which values aren't ready there, writing
 * nothing.
 */

import type {
  DeploymentCollectionPage,
  DeploymentPromotion,
  DeploymentPromotionBody,
  DeploymentPromotionCheck,
  DeploymentPromotionCheckBody,
  DeploymentRecord,
  DeploymentRegistrationBody,
  DeploymentSecretsSyncRequest,
  DeploymentSecretsSyncResponse,
  DeploymentValueList,
  PackEnvNameStatus,
  PackEnvNames,
  DeploymentValue as WireDeploymentValue,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type Deployment = DeploymentRecord;
export type DeploymentPage = DeploymentCollectionPage;
export type RegisterDeploymentInput = DeploymentRegistrationBody;
export type SyncSecretsInput = DeploymentSecretsSyncRequest;
export type SyncSecretsResult = DeploymentSecretsSyncResponse;
export type { PackEnvNameStatus, PackEnvNames };
export type DeploymentValue = WireDeploymentValue;
export type DeploymentValues = DeploymentValueList;

export interface DeploymentValuesClient {
  /**
   * What the deployment needs set in a project before it serves there,
   * names only, never a value: each tool's secrets and env values, a
   * model key for each agent version it ships or carries, then the pack
   * service's env. Each says what needs it, where a run finds it
   * (`foundAt`) and why it isn't ready (`problem`). Without `projectId`,
   * the deployment's own project. Takes `admin` on the project.
   *
   * @wire GET /v1/deployments/:deploymentId/values
   */
  list(deploymentId: string, options?: { readonly projectId?: string }): Promise<DeploymentValues>;
}
export type PromoteDeploymentInput = DeploymentPromotionBody;
export type CheckDeploymentPromotionInput = DeploymentPromotionCheckBody;
export type { DeploymentPromotion, DeploymentPromotionCheck };

export interface ListDeploymentsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly imageRefPrefix?: string;
  readonly signerKeyId?: string;
  /** One environment's deployments; the Default project also finds those that name no project. */
  readonly projectId?: string;
  /** One pack's deployments. */
  readonly packId?: string;
}

export interface DeploymentsClient {
  /** @wire POST /v1/deployments — register + verify + upsert primitives */
  register(
    input: RegisterDeploymentInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<Deployment>;
  /** @wire GET /v1/deployments */
  list(filter?: ListDeploymentsFilter): Promise<DeploymentPage>;
  /** @wire GET /v1/deployments/:deploymentId */
  get(deploymentId: string): Promise<Deployment>;
  /**
   * Sync a deploy-scoped secret set for this deployment. Idempotent
   * per (deploymentId, secret-name-set).
   *
   * @wire POST /v1/deployments/:deploymentId/secrets
   */
  syncSecrets(
    deploymentId: string,
    input: SyncSecretsInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<SyncSecretsResult>;
  /** The values a deployment needs in a project. */
  readonly values: DeploymentValuesClient;
  /**
   * Where each name the deployment's pack declares is set, on a server that
   * gives each pack service the env its pack declares; never a value. 501
   * `pack-env-not-served` where pack services take their env from how
   * they're run.
   *
   * @wire GET /v1/deployments/:deploymentId/pack-env
   */
  packEnv(deploymentId: string): Promise<PackEnvNames>;
  /**
   * Promote a deployment to the next environment of its order: the target
   * gets a deployment of its own with the same build. A target that has
   * the build already answers its deployment.
   *
   * @wire POST /v1/deployments/:deploymentId/promotions
   */
  promote(deploymentId: string, input: PromoteDeploymentInput): Promise<DeploymentPromotion>;
  /**
   * What a promotion would move, and each value not ready in the target.
   * Writes nothing.
   *
   * @wire POST /v1/deployments/:deploymentId/promotions/check
   */
  promoteCheck(
    deploymentId: string,
    input: CheckDeploymentPromotionInput,
  ): Promise<DeploymentPromotionCheck>;
}

export function makeDeploymentsClient(transport: Transport): DeploymentsClient {
  return {
    async register(input, options) {
      return transport.request<Deployment>({
        method: 'POST',
        path: '/v1/deployments',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<DeploymentPage>({
        method: 'GET',
        path: '/v1/deployments',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.imageRefPrefix !== undefined && { imageRefPrefix: filter.imageRefPrefix }),
          ...(filter?.signerKeyId !== undefined && { signerKeyId: filter.signerKeyId }),
          ...(filter?.projectId !== undefined && { projectId: filter.projectId }),
          ...(filter?.packId !== undefined && { packId: filter.packId }),
        },
      });
    },
    async get(deploymentId) {
      return transport.request<Deployment>({
        method: 'GET',
        path: `/v1/deployments/${encodeURIComponent(deploymentId)}`,
      });
    },
    async syncSecrets(deploymentId, input, options) {
      return transport.request<SyncSecretsResult>({
        method: 'POST',
        path: `/v1/deployments/${encodeURIComponent(deploymentId)}/secrets`,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async packEnv(deploymentId) {
      return transport.request<PackEnvNames>({
        method: 'GET',
        path: `/v1/deployments/${encodeURIComponent(deploymentId)}/pack-env`,
      });
    },
    async promote(deploymentId, input) {
      return transport.request<DeploymentPromotion>({
        method: 'POST',
        path: `/v1/deployments/${encodeURIComponent(deploymentId)}/promotions`,
        body: input,
      });
    },
    async promoteCheck(deploymentId, input) {
      return transport.request<DeploymentPromotionCheck>({
        method: 'POST',
        path: `/v1/deployments/${encodeURIComponent(deploymentId)}/promotions/check`,
        body: input,
      });
    },
    values: {
      async list(deploymentId, options) {
        return transport.request<DeploymentValues>({
          method: 'GET',
          path: `/v1/deployments/${encodeURIComponent(deploymentId)}/values`,
          query: {
            ...(options?.projectId !== undefined && { projectId: options.projectId }),
          },
        });
      },
    },
  };
}
