// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Promoting a deployment into the next environment of its order, and what
 * the routes that read a deployment's values share: the values check's
 * deps from the router's bindings (`valuesDepsFor`), and the versions
 * that move with a deployment (`carriedFor`).
 */

import type { Scope } from '@kindgi/platform';
import type { ProjectId } from '@kindgi/types';

import { type CarriedVersions, carriedVersions } from '../carried-versions.js';
import type { Deployment } from '../deployment-binding.js';
import type { DeploymentValuesDeps } from '../deployment-values.js';
import type { DeploymentsRouterBindings } from './deployments.js';

/**
 * The values check's deps (`deploymentValues`), from the router's
 * bindings: the env it serves, secrets, projects, tools and agents, with
 * `values` for the rest. `administers`: whether the caller administers a
 * scope, where a tool's secret is recorded only at one they do (as at a
 * promotion's target); absent, every scope (where a run finds it).
 */
export function valuesDepsFor(
  bindings: DeploymentsRouterBindings,
  administers?: (scope: Scope) => Promise<boolean>,
): DeploymentValuesDeps {
  return {
    ...bindings.values,
    ...(bindings.envName !== undefined && { envName: bindings.envName }),
    ...(bindings.secretsBinding !== undefined && { secrets: bindings.secretsBinding }),
    ...(bindings.projectBinding !== undefined && { projects: bindings.projectBinding }),
    ...(bindings.toolRegistry !== undefined && { tools: bindings.toolRegistry }),
    ...(bindings.agentRegistry !== undefined && { agents: bindings.agentRegistry }),
    ...(administers !== undefined && { administers }),
  };
}

/**
 * The project a deployment serves: the one it names, else the tenant's
 * Default (where a deploy naming none lands). `undefined` without a
 * project binding to find the Default.
 */
export async function servingProjectOf(
  bindings: Pick<DeploymentsRouterBindings, 'projectBinding'>,
  deployment: Deployment,
): Promise<ProjectId | undefined> {
  if (deployment.projectId !== undefined) return deployment.projectId;
  return (await bindings.projectBinding?.getDefault(deployment.tenantId))?.id;
}

/**
 * The versions that move with `deployment` to the next environment, and
 * the edits of its agents and flows that stay behind (`carriedVersions`),
 * as a run in the project it serves reaches them. Nothing, when that
 * project can't be found.
 */
export async function carriedFor(
  bindings: DeploymentsRouterBindings,
  deployment: Deployment,
): Promise<CarriedVersions> {
  const fromProjectId = await servingProjectOf(bindings, deployment);
  if (fromProjectId === undefined) return { carried: [], leftBehind: [] };
  return carriedVersions(
    {
      ...(bindings.agentRegistry !== undefined && { agents: bindings.agentRegistry }),
      ...(bindings.flowRegistry !== undefined && { flows: bindings.flowRegistry }),
      ...(bindings.referenceScope !== undefined && { reach: bindings.referenceScope }),
    },
    { tenantId: deployment.tenantId, fromProjectId, contents: deployment.contents },
  );
}
