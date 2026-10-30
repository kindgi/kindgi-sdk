// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, Semver, TenantId } from '@kindgi/types';

import type { PromotionActor } from './live-version-binding.js';

/** Whose Latest: an agent, and the project asking. */
export interface LatestQuestion {
  readonly tenantId: TenantId;
  readonly agentId: string;
  /**
   * The project whose Latest it is (a segment scope asks for its
   * project). Absent for a tenant or org scope: then every version of the
   * agent counts, wherever it was made or shipped.
   */
  readonly projectId?: ProjectId;
}

/** A project's Latest, and what made it Latest there. */
export interface LatestAnswer {
  readonly version: Semver;
  /**
   * ISO-8601: when it became Latest there. The time of the newest
   * deployment into the project that ships it, or when a person published
   * it or added it as the latest version. Absent when nothing records a
   * time: a registry whose versions come from files, such as a pack's
   * under `kindgi dev`.
   */
  readonly since?: string;
  /** The deployment that made it Latest, when one did. */
  readonly deploymentId?: string;
  /** The person who published it or added it as the latest version, when one did. */
  readonly by?: PromotionActor;
}

/** One project's Latest (`LatestBinding.byProject`). */
export interface LatestInProject extends LatestAnswer {
  readonly projectId: ProjectId;
}

/**
 * Latest: the version a project runs when no pin covers it. It moves only
 * when a deployment into the project ships a version, or when a person
 * publishes a full version or adds one as the latest version. A version
 * made for a project's card (`AgentMadeFor` `project`) is never Latest by
 * itself, and a pin never moves Latest.
 *
 * Of the agent's active versions the project reaches, each one's time in
 * the project is the newest of: the newest deployment into the project
 * that ships it (or that carries it, when it's a `latest` version, one
 * from before 0.4.0, or one a person added); when a person made it
 * Latest (`latestAt`), in the project it was made in; and its publish
 * time, in the project it was made in, for a version from before 0.4.0.
 * Latest is the version with the newest time, a tie going to the higher
 * version. `null` when no version has a time there.
 *
 * The highest version, which numbers the next one, is the registry's
 * `get` (`AgentRegistryBinding`).
 */
export interface LatestBinding {
  latest(q: LatestQuestion): Promise<LatestAnswer | null>;
  /**
   * Latest in every project where a version of the agent has a time: one
   * row per project, by the same rule as `latest`, in no set order.
   */
  byProject(q: {
    readonly tenantId: TenantId;
    readonly agentId: string;
  }): Promise<readonly LatestInProject[]>;
}
