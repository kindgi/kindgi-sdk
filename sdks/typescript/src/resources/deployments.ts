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
 */

import type {
  DeploymentCollectionPage,
  DeploymentRecord,
  DeploymentRegistrationBody,
  DeploymentSecretsSyncRequest,
  DeploymentSecretsSyncResponse,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type Deployment = DeploymentRecord;
export type DeploymentPage = DeploymentCollectionPage;
export type RegisterDeploymentInput = DeploymentRegistrationBody;
export type SyncSecretsInput = DeploymentSecretsSyncRequest;
export type SyncSecretsResult = DeploymentSecretsSyncResponse;

export interface ListDeploymentsFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly imageRefPrefix?: string;
  readonly signerKeyId?: string;
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
  };
}
