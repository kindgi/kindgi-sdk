// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What the deploy routes give the check against what runs
 * (`deploy-check.ts`), and the answer when it stops: `POST /v1/deployments`,
 * `POST /v1/deployments/check` and a promotion that pins.
 */

import { ref } from '@kindgi/authz';
import type { AgentId, ProjectId, TenantId, UserId } from '@kindgi/types';
import type { Context } from 'hono';

import type { BlockUseBinding } from '../block-binding.js';
import type { BlockVersionPullRequestBinding } from '../block-version-pr-binding.js';
import type { DeployCheckDeps, DeployCheckStop } from '../deploy-check.js';
import { statusFor, toWireError } from '../errors.js';
import type { IdentityDirectoryBinding } from '../identity-directory-binding.js';
import type { ItemProjectsBinding } from '../item-projects-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import type { DeploymentsRouterBindings } from './deployments.js';

/**
 * What the check reads besides the agents' pins and Latest. Absent, or
 * without `agentPins`: a deploy isn't checked, as before, and
 * `POST /v1/deployments/check` answers `501 runs-in-unsupported`.
 */
export interface DeployCheckBindings {
  /** The agent versions that pin each block, and the block version each pins. */
  readonly blockUse: BlockUseBinding;
  /** Each agent's projects. Absent: its own project, from the agent registry. */
  readonly itemProjects?: ItemProjectsBinding;
  /** People's names, for who pinned or added the newer version. */
  readonly identityDirectory?: IdentityDirectoryBinding;
  /** The pull requests opened for block versions: a stop names the open one for the newer version. */
  readonly pullRequests?: BlockVersionPullRequestBinding;
}

/** The check's reads for this request: every project counts, and the caller's rights decide what a stop names. */
export function deployCheckDeps(
  c: Context<AppEnv>,
  bindings: Pick<DeploymentsRouterBindings, 'agentPins' | 'deployCheck' | 'agentRegistry'>,
  authorizer: Authorizer | undefined,
): DeployCheckDeps {
  const check = bindings.deployCheck;
  const directory = check?.identityDirectory;
  const pullRequests = check?.pullRequests;
  const tenantId = c.get('tenantId') as TenantId;
  return {
    ...(bindings.agentPins !== undefined && { agentPins: bindings.agentPins }),
    ...(check !== undefined && { blockUse: check.blockUse }),
    projectsOf: (tenant, agentId) => projectsOf(bindings, tenant, agentId),
    canRead: async (projectId) =>
      authorizer === undefined ||
      (await authorizer.can(c, 'read', ref('project', projectId as unknown as string))),
    ...(directory !== undefined && {
      displayName: async (userId: string) =>
        (await directory.getUser({ tenantId, userId: userId as unknown as UserId }))?.displayName,
    }),
    ...(pullRequests !== undefined && {
      pullRequest: async (projectId: ProjectId, blockId: string, version: string) => {
        try {
          const pr = await pullRequests.forVersion({ tenantId, projectId, blockId, version });
          // An open one only: the stop says to merge it.
          return pr?.state === 'open' ? { url: pr.url } : undefined;
        } catch (cause) {
          c.get('log').warn('A block version pull request could not be read', {
            blockId,
            version,
            projectId: projectId as unknown as string,
            // The name only: a message can quote what the repository answered.
            error: cause instanceof Error ? cause.name : typeof cause,
          });
          return undefined;
        }
      },
    }),
  };
}

/**
 * Every project an agent runs in, whoever asks: the item-projects
 * binding's, else its own project from the agent registry. None: an
 * agent that isn't there yet, such as one a first deploy brings.
 */
async function projectsOf(
  bindings: Pick<DeploymentsRouterBindings, 'deployCheck' | 'agentRegistry'>,
  tenantId: TenantId,
  agentId: string,
): Promise<readonly ProjectId[]> {
  const itemProjects = bindings.deployCheck?.itemProjects;
  if (itemProjects !== undefined) {
    return (await itemProjects.projectsOf({ tenantId, kind: 'agent', id: agentId })) ?? [];
  }
  const agents = bindings.agentRegistry;
  if (agents === undefined) return [];
  const page = await agents.listVersions({
    tenantId,
    agentId: agentId as unknown as AgentId,
    limit: 1,
    includeTombstoned: true,
  });
  const projectId = page.data[0]?.projectId;
  return projectId !== undefined ? [projectId] : [];
}

/** `409 deploy-would-put-back-older-blocks`, each block in `details.blocks`. */
export function olderBlocksRefusal(
  c: Context<AppEnv>,
  stops: readonly DeployCheckStop[],
  what: 'deploy' | 'promotion',
): Response {
  const list = stops
    .map((s) => `${s.blockId} (${s.inFiles} in the files, ${s.runs.version} runs now)`)
    .join(', ');
  const fix =
    what === 'deploy'
      ? 'Bring the newer versions into the files and deploy again'
      : 'Promote a build whose files have the newer versions';
  c.status(statusFor('deploy-would-put-back-older-blocks') as never);
  return c.json(
    toWireError(
      {
        code: 'deploy-would-put-back-older-blocks',
        message: `This ${what} would put back older versions of blocks than run now: ${list}. ${fix}, or name each block in \`replace\`, with a reason.`,
        blocks: stops.map(stopToWire),
      },
      c.get('requestId'),
    ),
  );
}

function stopToWire(s: DeployCheckStop): Record<string, unknown> {
  const { runs } = s;
  return {
    blockId: s.blockId,
    inFiles: s.inFiles,
    runs: {
      version: runs.version,
      ...(runs.projectId !== undefined && { projectId: runs.projectId as unknown as string }),
      ...(runs.follows !== undefined && { follows: runs.follows }),
      ...(runs.segment !== undefined && {
        segment: runs.segment.map(({ key, value }) => ({ key, value })),
      }),
      ...(runs.by !== undefined && { by: runs.by }),
      ...(runs.at !== undefined && { at: runs.at }),
    },
    ...(s.pr !== undefined && { pr: { url: s.pr.url } }),
  };
}
