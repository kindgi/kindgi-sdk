// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { LiveScope, ProjectId, ScopeSegment, Semver, TenantId } from '@kindgi/types';

import type { LatestAnswer } from './latest-binding.js';
import type { AgentReleaseBindings, LivePin, LiveResolveInput } from './live-version-binding.js';

/** What an agent runs in a scope, and why: a pin that covers the scope, or Latest. */
export type WhatRuns =
  | { readonly follows: 'pin'; readonly version: Semver; readonly liveScope: LiveScope }
  | ({ readonly follows: 'latest' } & LatestAnswer);

/**
 * What runs for an agent in a scope (`LiveResolveInput`'s coordinates):
 * the most specific pin that covers it, else Latest for its project (a
 * segment's is its project's; with no project, the tenant's or org's).
 * `null` when neither has a version. A run picks its version the same way
 * once it names none and continues no conversation; every reader that
 * asks what an unpinned scope runs asks this.
 */
export async function whatRuns(
  releases: Pick<AgentReleaseBindings, 'live' | 'latest'>,
  q: LiveResolveInput,
): Promise<WhatRuns | null> {
  const pin = await releases.live.resolve(q);
  if (pin !== null) return { follows: 'pin', version: pin.version, liveScope: pin.scope };
  const latest = await releases.latest.latest({
    tenantId: q.tenantId,
    agentId: q.agentId,
    ...(q.projectId !== undefined && { projectId: q.projectId }),
  });
  return latest === null ? null : { follows: 'latest', ...latest };
}

/** What runs in one project (`whatRunsByProject`), and the segment pins inside it. */
export interface WhatRunsInProject {
  readonly projectId: ProjectId;
  /** `null` when no pin covers the project and it has no Latest. */
  readonly runs: WhatRuns | null;
  /** The pin that covers the project, when `runs` follows one: when it was set, and by which promotion. */
  readonly pin?: LivePin;
  /** The pins on segments inside the project, which their paths run instead. */
  readonly segments: readonly {
    readonly path: readonly ScopeSegment[];
    readonly version: Semver;
  }[];
}

/**
 * What runs for an agent in each of `projectIds`, in that order: `whatRuns`
 * for the project (a pin that covers it, its own, its org's or the
 * tenant's, else its Latest), with the segment pins inside it. One read of
 * the agent's pins and one of its Latest everywhere
 * (`LatestBinding.byProject`), then a pin lookup per project.
 */
export async function whatRunsByProject(
  releases: Pick<AgentReleaseBindings, 'live' | 'latest'>,
  q: { readonly tenantId: TenantId; readonly agentId: string },
  projectIds: readonly ProjectId[],
): Promise<readonly WhatRunsInProject[]> {
  if (projectIds.length === 0) return [];
  const [pins, latest] = await Promise.all([releases.live.list(q), releases.latest.byProject(q)]);
  const latestIn = new Map(latest.map(({ projectId, ...answer }) => [projectId, answer]));
  const rows: WhatRunsInProject[] = [];
  for (const projectId of projectIds) {
    const pin = await releases.live.resolve({ ...q, projectId });
    const own = latestIn.get(projectId);
    const runs: WhatRuns | null =
      pin !== null
        ? { follows: 'pin', version: pin.version, liveScope: pin.scope }
        : own === undefined
          ? null
          : { follows: 'latest', ...own };
    const covering = pin === null ? undefined : pins.find((p) => sameLiveScope(p.scope, pin.scope));
    const segments = pins.flatMap((p) =>
      p.scope.kind === 'segment' && p.scope.projectId === projectId
        ? [{ path: p.scope.path, version: p.version }]
        : [],
    );
    rows.push({ projectId, runs, ...(covering !== undefined && { pin: covering }), segments });
  }
  return rows;
}

function sameLiveScope(a: LiveScope, b: LiveScope): boolean {
  switch (a.kind) {
    case 'tenant':
      return b.kind === 'tenant';
    case 'org':
      return b.kind === 'org' && b.orgId === a.orgId;
    case 'project':
      return b.kind === 'project' && b.projectId === a.projectId;
    case 'segment':
      return (
        b.kind === 'segment' &&
        b.projectId === a.projectId &&
        b.path.length === a.path.length &&
        a.path.every((s, i) => s.key === b.path[i]?.key && s.value === b.path[i]?.value)
      );
  }
}
