// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The values a deployment needs set in a project before it serves there:
 * each tool's secrets and env, each agent's model key, and the pack's own
 * env. A promotion checks them at its target and refuses while one isn't
 * ready (`409 promotion-values-not-ready`), so a promoted build never
 * starts in an environment that can't run it. Each value is read where a
 * run reads it, never its value: whether it's set, and where.
 */

import type { Scope } from '@kindgi/platform';
import type { ProjectId, TenantId } from '@kindgi/types';

import type { ProviderRuntimeEntry } from './provider-binding.js';

/** Where a value is set, as a run looks for it: the project, else its org, else the tenant. */
export type DeploymentValueScope = 'project' | 'org' | 'tenant';

/**
 * Why a value isn't ready:
 * - `missing`: a required value set nowhere a run looks;
 * - `secret-not-yet`: a pack env name set only as a secret, which isn't
 *   given into a pack service's environment yet;
 * - `ambiguous`: a pack env name set both as a secret and as a plain value;
 * - `revoked`: a model key revoked where a run looks first, so a run
 *   refuses (`secret-revoked`) rather than read a wider one.
 */
export type DeploymentValueProblem = 'missing' | 'secret-not-yet' | 'ambiguous' | 'revoked';

/** One value a deployment needs in a project. Never the value itself. */
export interface DeploymentValue {
  /** The secret's or env variable's name; for a model key, the key's secret name. */
  readonly name: string;
  readonly kind: 'secret' | 'env' | 'model-key' | 'pack-env';
  /** What needs it: a tool version, an agent version, a model provider, or the pack's service. */
  readonly neededBy: {
    readonly type: 'tool' | 'agent' | 'provider' | 'pack';
    readonly id: string;
    readonly version?: string;
  };
  /** Where a run finds it, when it's set. */
  readonly foundAt?: DeploymentValueScope;
  /** Why it isn't ready; absent when it is. */
  readonly problem?: DeploymentValueProblem;
}

/**
 * Where a model provider's key is for a run in a project: the first scope
 * that holds it (the project, else its org, else the tenant), else the
 * tenant's, where it would be set. The run reads exactly this place, and
 * the values check asks the same function, so the two never disagree.
 */
export interface ModelKeyLocation {
  readonly scope: Scope;
  readonly envName: string;
  readonly name: string;
  /**
   * When the key at `scope` was revoked. A run doesn't fall back to a wider
   * scope past a revoked key: it refuses (`secret-revoked`). A hard-revoked
   * key is erased, so it's at no scope: the wider one answers, for the run
   * and for this lookup alike.
   */
  readonly revokedAt?: string;
}

/**
 * Looks a provider's model key up for a run (`ModelKeyLocation`). The
 * runtime supplies it; without one, every key is the tenant's.
 */
export type ModelKeyLookup = (
  registration: ProviderRuntimeEntry,
  where: { readonly tenantId: TenantId; readonly projectId?: ProjectId },
) => Promise<ModelKeyLocation>;
