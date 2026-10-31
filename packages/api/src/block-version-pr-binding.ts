// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { ProjectId, TenantId } from '@kindgi/types';

/**
 * A pull request Kindgi opened to bring a block version back into a
 * project's pack files: a draft on the pack's repository, through the
 * project's repo connection, made when the version was pinned in the
 * project or added as its latest.
 */
export interface BlockVersionPullRequest {
  readonly number: number;
  readonly url: string;
  /** As the repository says now: a binding may keep it a short while (a minute) before asking again. */
  readonly state: 'open' | 'merged' | 'closed';
}

export interface BlockVersionPullRequestInput {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly blockId: string;
  readonly version: string;
}

/**
 * The pull requests opened for block versions (`GET
 * /v1/blocks/:blockId/runs-in` reads them for "In your files"). Absent:
 * the runtime opens none, and a row says only what the project's
 * deployments say.
 */
export interface BlockVersionPullRequestBinding {
  /**
   * The newest pull request opened for this version of the block in the
   * project, with its state. `null`: none was opened. A state that can't
   * be read now (the connection is gone, or the repository doesn't
   * answer) is the one last read. A throw leaves the row without
   * "In your files"; the route logs only the error's name, so a binding
   * logs its own detail, with nothing secret in it.
   */
  forVersion(input: BlockVersionPullRequestInput): Promise<BlockVersionPullRequest | null>;
}
