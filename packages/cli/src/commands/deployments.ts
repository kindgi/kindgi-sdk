// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi deployments`: the deployments, and one of them with its pack
 * service as it is now. `kindgi deploy` reads that only while it waits, so
 * a pack service that later runs on the values it was last given (a value
 * changed and can't be given to it, or it didn't start with the newest:
 * `endpoint.packEnvProblem`) is said here: why, and what to do.
 */

import type { DeploymentsClient, PackEnvNames } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import {
  packEnvHeldText,
  packEnvRetryLine,
  packServiceProblemText,
  packServiceRetiredText,
} from '../deploy/pack-service-text.js';
import { type PackEnvHintTarget, packEnvProblemLines } from '../env/pack-env-hint.js';
import { renderJson } from '../output.js';
import { resolveProjectRef } from '../project-ref.js';
import {
  type TableSpec,
  filterIgnored,
  integerFlag,
  requiredPositional,
  runSdk,
  runSdkRendered,
  stringFlag,
} from './helpers.js';
import type { Command, LeafCommand, ParseArgsOption } from './types.js';

type DeploymentPage = Awaited<ReturnType<DeploymentsClient['list']>>;
type Deployment = Awaited<ReturnType<DeploymentsClient['get']>>;
type Endpoint = NonNullable<Deployment['endpoint']>;

const PAGE_FLAGS: Readonly<Record<string, ParseArgsOption>> = {
  limit: { type: 'string', description: 'The most to return (default 25, at most 100).' },
  cursor: {
    type: 'string',
    description: "Resume after this cursor, from the previous page's `nextCursor`.",
  },
};

function page(ctx: CommandContext): { limit?: number; cursor?: string } {
  const limit = integerFlag(ctx, 'limit');
  const cursor = stringFlag(ctx, 'cursor');
  return {
    ...(limit !== undefined && { limit }),
    ...(cursor !== undefined && { cursor }),
  };
}

const DEPLOYMENTS_TABLE: TableSpec<DeploymentPage, Deployment> = {
  rows: (p) => p.data,
  columns: [
    { header: 'DEPLOYMENT', get: (d) => d.deploymentId },
    { header: 'VERSION', get: (d) => d.artifactVersion },
    { header: 'PROJECT', get: (d) => d.projectId ?? '' },
    { header: 'ACTIVATED', get: (d) => d.activatedAt },
    { header: 'PACK SERVICE', get: (d) => packServiceCell(d.endpoint) },
  ],
};

/**
 * A pack service as one cell: `ready`, `ready, held: pack-env-update-failed`,
 * `pending: capacity-unavailable`, `cleared, waiting`, `cleared: superseded`.
 * Empty for a deployment without one (a server that runs no pack service
 * per deployment).
 */
function packServiceCell(endpoint: Endpoint | undefined): string {
  if (endpoint === undefined) return '';
  if (endpoint.status === 'ready') {
    return endpoint.packEnvProblem !== undefined
      ? `ready, held: ${endpoint.packEnvProblem.code}`
      : 'ready';
  }
  const state =
    endpoint.status === 'cleared' && endpoint.waiting === true
      ? 'cleared, waiting'
      : endpoint.status;
  const why = endpoint.problem?.code ?? endpoint.retired;
  return why !== undefined ? `${state}: ${why}` : state;
}

const list: LeafCommand = {
  kind: 'leaf',
  name: 'list',
  description:
    "List the deployments, the latest activated first. `--table` shows each one's pack service: ready (or held on the values it was last given, with the code), pending or cleared.",
  usage:
    'kindgi deployments list [--project=<id-or-slug>] [--pack=<pack-id>] [--image-ref-prefix=<ref>] [--signer-key-id=<id>] [--limit=<n>] [--cursor=<c>]',
  optionSpec: {
    project: {
      type: 'string',
      description:
        "Only one project's deployments, by its id or its slug. The Default project's include the deployments that name no project. A slug two orgs share is refused: pass the id. Needs a runtime on Kindgi 0.1.9 or later.",
    },
    pack: {
      type: 'string',
      description:
        "Only one pack's deployments, by its pack id (the image index's `packId`). Needs a runtime on Kindgi 0.1.9 or later.",
    },
    'image-ref-prefix': {
      type: 'string',
      description: 'Only deployments whose image reference starts with this.',
    },
    'signer-key-id': { type: 'string', description: 'Only deployments signed with this key.' },
    ...PAGE_FLAGS,
  },
  run: (ctx) =>
    runSdk(
      ctx,
      'deployments list',
      async () => {
        const projectRef = stringFlag(ctx, 'project');
        const projectId =
          projectRef !== undefined
            ? await resolveProjectRef(ctx, projectRef, '--project')
            : undefined;
        const packId = stringFlag(ctx, 'pack');
        const imageRefPrefix = stringFlag(ctx, 'image-ref-prefix');
        const signerKeyId = stringFlag(ctx, 'signer-key-id');
        const listed = await ctx.client().deployments.list({
          ...page(ctx),
          ...(projectId !== undefined && { projectId }),
          ...(packId !== undefined && { packId }),
          ...(imageRefPrefix !== undefined && { imageRefPrefix }),
          ...(signerKeyId !== undefined && { signerKeyId }),
        });
        // A runtime before these filters ignores them and lists them all, without saying so on the page.
        if (projectId !== undefined && listed.projectId !== projectId) {
          throw filterIgnored('project', '0.1.9');
        }
        if (packId !== undefined && listed.packId !== packId) {
          throw filterIgnored('pack', '0.1.9');
        }
        return listed;
      },
      DEPLOYMENTS_TABLE,
    ),
};

const get: LeafCommand = {
  kind: 'leaf',
  name: 'get',
  description:
    "Show a deployment and its pack service now: whether it's ready, and when it runs on the values it was last given, why and what to do. --json prints the deployment as the API answers it.",
  usage: 'kindgi deployments get <deployment-id> [--json]',
  run: (ctx) =>
    runSdkRendered(ctx, 'deployments get', async () => {
      const id = requiredPositional(ctx, 0, 'deployment-id');
      const deployment = await ctx.client().deployments.get(id);
      if (ctx.globals.formatRequested && ctx.globals.format !== 'table') {
        return renderJson(deployment, ctx.globals.format);
      }
      const packEnv = namesInTheWay(deployment.endpoint) ? await readPackEnv(ctx, id) : undefined;
      return { stdout: deploymentText(deployment, packEnv), stderr: '' };
    }),
};

/**
 * Whether its pack service waits on, or is held by, its env: then where
 * each name is set says what to do.
 */
function namesInTheWay(endpoint: Endpoint | undefined): boolean {
  if (endpoint === undefined) return false;
  if (endpoint.status === 'ready') return endpoint.packEnvProblem !== undefined;
  return endpoint.problem?.code.startsWith('pack-env-') === true;
}

/** Where each name the deployment's pack declares is set; `undefined` when it can't be read. */
async function readPackEnv(ctx: CommandContext, id: string): Promise<PackEnvNames | undefined> {
  try {
    return await ctx.client().deployments.packEnv(id);
  } catch {
    return undefined;
  }
}

function deploymentText(d: Deployment, packEnv: PackEnvNames | undefined): string {
  // Where a value goes: the env the server reads them at, and the deployment's project.
  const target: PackEnvHintTarget | undefined = packEnv && {
    envName: packEnv.envName,
    ...(d.projectId !== undefined && { projectId: d.projectId }),
    hasProjectMapping: false,
  };
  const lines = [
    `Deployment ${d.deploymentId} (artifact ${d.artifactVersion}), activated ${d.activatedAt}`,
    `  Project: ${d.projectId ?? 'none named'}`,
    `  Image: ${d.imageRef}`,
    `  Ships: ${[
      counted(d.primitives.tools, 'tool'),
      counted(d.primitives.guardrails, 'guardrail'),
      counted(d.primitives.agents, 'agent'),
      counted(d.primitives.flows, 'flow'),
    ].join(', ')}`,
    ...(d.endpoint !== undefined ? packServiceLines(d.endpoint, packEnv, target) : []),
  ];
  return `${lines.join('\n')}\n`;
}

/** Its pack service's state, why when there's a reason, and what to do when its env is in the way. */
function packServiceLines(
  endpoint: Endpoint,
  packEnv: PackEnvNames | undefined,
  target: PackEnvHintTarget | undefined,
): string[] {
  const fixes = (extra: (t: PackEnvHintTarget) => string[]): string[] =>
    packEnv === undefined || target === undefined
      ? []
      : [...packEnvProblemLines(packEnv.data, target), ...extra(target)].map((l) => `      ${l}`);
  if (endpoint.status === 'ready') {
    const held = endpoint.packEnvProblem;
    if (held === undefined) return [`  Pack service: ready since ${endpoint.since}`];
    const why = packEnvHeldText(held.code);
    return [
      `  Pack service: ready since ${endpoint.since}, on the values it was last given`,
      `    ! Since ${held.since}: ${why !== undefined ? `${why} (${held.code})` : held.code}.`,
      ...fixes((t) => (held.code === 'pack-env-update-failed' ? [packEnvRetryLine(t)] : [])),
    ];
  }
  if (endpoint.status === 'cleared' && endpoint.waiting !== true) {
    const r = endpoint.retired;
    return [
      `  Pack service: cleared since ${endpoint.since}${r !== undefined ? `: ${packServiceRetiredText(r)} (${r})` : ''}`,
    ];
  }
  const state =
    endpoint.status === 'cleared'
      ? `cleared since ${endpoint.since}, waiting for one again`
      : `pending since ${endpoint.since}`;
  const problem = endpoint.problem;
  if (problem === undefined) return [`  Pack service: ${state}`];
  return [
    `  Pack service: ${state}: ${packServiceProblemText(problem.code)} (${problem.code})`,
    ...(problem.code.startsWith('pack-env-') ? fixes(() => []) : []),
  ];
}

/** `1 tool`, `3 tools`. */
function counted(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export const deploymentsCommand: Command = {
  kind: 'group',
  name: 'deployments',
  description:
    "See what's deployed: list, get. `get` shows a deployment's pack service now, and what to do when it runs on the values it was last given.",
  subcommands: [list, get],
};
