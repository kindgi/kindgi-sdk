// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentPinScope, ProjectId, ScopeSegment, Semver, TenantId } from '@kindgi/types';

import type {
  AgentPinBindings,
  AgentPinResolveInput,
  AgentPinnedVersion,
} from './agent-pin-binding.js';
import type { LatestAnswer } from './latest-binding.js';

/** What an agent runs in a scope, and why: a pin that covers the scope, or Latest. */
export type WhatRuns =
  | { readonly follows: 'pin'; readonly version: Semver; readonly pinnedScope: AgentPinScope }
  | ({ readonly follows: 'latest' } & LatestAnswer);

/**
 * What runs for an agent in a scope (`AgentPinResolveInput`'s coordinates):
 * the most specific pin that covers it, else Latest for its project (a
 * segment's is its project's; with no project, the tenant's or org's).
 * `null` when neither has a version. A run picks its version the same way
 * once it names none and continues no conversation; every reader that
 * asks what an unpinned scope runs asks this.
 */
export async function whatRuns(
  agentPins: Pick<AgentPinBindings, 'pinned' | 'latest'>,
  q: AgentPinResolveInput,
): Promise<WhatRuns | null> {
  const pin = await agentPins.pinned.resolve(q);
  if (pin !== null) return { follows: 'pin', version: pin.version, pinnedScope: pin.scope };
  const latest = await agentPins.latest.latest({
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
  /** The pin that covers the project, when `runs` follows one: when it was set, and by which pin change. */
  readonly pin?: AgentPinnedVersion;
  /** The pins on segments inside the project, which their paths run instead. */
  readonly segments: readonly {
    readonly path: readonly ScopeSegment[];
    readonly version: Semver;
    /** The segment's pin: when it was set, and by which pin change. */
    readonly pin: AgentPinnedVersion;
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
  agentPins: Pick<AgentPinBindings, 'pinned' | 'latest'>,
  q: { readonly tenantId: TenantId; readonly agentId: string },
  projectIds: readonly ProjectId[],
): Promise<readonly WhatRunsInProject[]> {
  if (projectIds.length === 0) return [];
  const [pins, latest] = await Promise.all([
    agentPins.pinned.list(q),
    agentPins.latest.byProject(q),
  ]);
  const latestIn = new Map(latest.map(({ projectId, ...answer }) => [projectId, answer]));
  const rows: WhatRunsInProject[] = [];
  for (const projectId of projectIds) {
    const pin = await agentPins.pinned.resolve({ ...q, projectId });
    const own = latestIn.get(projectId);
    const runs: WhatRuns | null =
      pin !== null
        ? { follows: 'pin', version: pin.version, pinnedScope: pin.scope }
        : own === undefined
          ? null
          : { follows: 'latest', ...own };
    const covering = pin === null ? undefined : pins.find((p) => samePinScope(p.scope, pin.scope));
    const segments = pins.flatMap((p) =>
      p.scope.kind === 'segment' && p.scope.projectId === projectId
        ? [{ path: p.scope.path, version: p.version, pin: p }]
        : [],
    );
    rows.push({ projectId, runs, ...(covering !== undefined && { pin: covering }), segments });
  }
  return rows;
}

function samePinScope(a: AgentPinScope, b: AgentPinScope): boolean {
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
