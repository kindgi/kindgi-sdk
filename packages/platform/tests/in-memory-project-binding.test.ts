// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Wire the shared `runProjectBindingConformance` suite against the
 * in-memory reference adapter.
 */

import type { ProjectId, SigningKeyId, TenantId } from '@kindgi/types';

import { makeInMemoryProjectBinding } from '../src/in-memory/project-binding.js';
import {
  CONFORMANCE_MISSING_ORG,
  runProjectBindingConformance,
} from './project-binding.conformance.js';

runProjectBindingConformance(
  () => {
    // The tenant's limit where the binding reads it, as a runtime keeps it beside the tenant.
    const limits = new Map<TenantId, number>();
    // The promote-only builds deployed into each project, as the deployments' store keeps them.
    const held = new Map<string, { deploymentId: string; signerKeyId: SigningKeyId }>();
    const key = (tenantId: TenantId, projectId: ProjectId) => `${tenantId}::${projectId}`;
    return {
      ...makeInMemoryProjectBinding({
        productionLimit: (tenantId) => limits.get(tenantId),
        promoteOnlyDeployment: (tenantId, projectId) => held.get(key(tenantId, projectId)),
      }),
      setProductionLimit: (tenantId, limit) => {
        if (limit === undefined) limits.delete(tenantId);
        else limits.set(tenantId, limit);
        return Promise.resolve();
      },
      deployPromoteOnly: (tenantId, projectId, deployment) => {
        if (!held.has(key(tenantId, projectId))) held.set(key(tenantId, projectId), deployment);
        return Promise.resolve();
      },
    };
  },
  'InMemoryProjectBinding',
  {
    production: true,
    productionLimit: true,
    promoteOnlyBuilds: true,
    repoConnection: true,
    testProjects: true,
  },
);
// With an org check: every org but the missing one is the tenant's.
runProjectBindingConformance(
  () =>
    makeInMemoryProjectBinding({
      orgExists: (_tenantId, orgId) => orgId !== CONFORMANCE_MISSING_ORG,
    }),
  'InMemoryProjectBinding (checking orgs)',
  { checksOrgs: true },
);
// With the environment-order guard: a project put in an order can't be
// deleted or moved to another parent; a rename or slug change still works.
runProjectBindingConformance(
  () => {
    const orders = new Map<string, string>();
    const key = (tenantId: TenantId, projectId: ProjectId) => `${tenantId}::${projectId}`;
    return {
      ...makeInMemoryProjectBinding({
        environmentOrderOf: (tenantId, projectId) => orders.get(key(tenantId, projectId)),
      }),
      putInEnvironmentOrder: (tenantId, projectId) => {
        const orderId = `tenant:${tenantId}`;
        orders.set(key(tenantId, projectId), orderId);
        return Promise.resolve(orderId);
      },
      clearEnvironmentOrder: (tenantId, projectId) => {
        orders.delete(key(tenantId, projectId));
        return Promise.resolve();
      },
    };
  },
  'InMemoryProjectBinding (environment-order guard)',
  { checksEnvironmentOrders: true },
);
