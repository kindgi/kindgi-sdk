// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Transport } from '../transport.js';
import type { Deployment, RegisterDeploymentInput } from './deployments.js';

/**
 * Signed builds registered into one project of a tenant, with a system key
 * holding `system:hosted-builds` itself (`kindgi:system` doesn't stand in
 * for it). Each is the tenant's deploy under the project-only key scope:
 * `deployments.register`'s body and answers, the body's `projectId`
 * required.
 */
export interface SystemHostedBuildsClient {
  /** @wire `POST /v1/system/tenants/:tenantId/deployments`. */
  register(
    tenantId: string,
    input: RegisterDeploymentInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<Deployment>;
}

export function makeSystemHostedBuildsClient(transport: Transport): SystemHostedBuildsClient {
  return {
    async register(tenantId, input, options) {
      return transport.request<Deployment>({
        method: 'POST',
        path: `/v1/system/tenants/${encodeURIComponent(tenantId)}/deployments`,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
