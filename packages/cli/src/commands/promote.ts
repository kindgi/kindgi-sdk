// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi promote --from=<env> --to=<env>`: move a build to the next
 * environment of its environment order. The same image moves, signed once,
 * with the edits made since to its agents and flows; nothing is built.
 *
 * It asks the runtime what would move first (`promotions/check`) and prints
 * it: the pack, the build's digest, each agent, flow, tool and guardrail,
 * the carried edits marked, and the edits that stay behind. Then the values
 * the build needs in the target that aren't ready, each with the command
 * that sets it; while one isn't, it stops there and exits 1. Then it
 * promotes, and prints the deployment the target got. `--check` stops
 * before the write.
 *
 * Without `--deployment`, the build is this pack's deployment serving in
 * `--from`: it must be just one.
 */

import { KindgiApiError } from '@kindgi/client';
import type { Deployment, DeploymentPromotion, DeploymentPromotionCheck } from '@kindgi/client';

import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { type Column, type Rendered, renderJson, renderTable } from '../output.js';
import { loadPackConfig } from '../pack-config.js';
import { projectOfEnv } from './build.js';
import { packDirOf, resolveRefs } from './environments.js';
import { runSdkRendered, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

type Answer = Rendered & { readonly exitCode?: number };
type DeploymentValue = DeploymentPromotionCheck['values'][number];
type Moves = DeploymentPromotionCheck['moves'];
type LeftBehind = NonNullable<DeploymentPromotionCheck['leftBehind']>;

/** Where a promotion goes from and to: the pack config's names, their projects, and the pack. */
interface Route {
  readonly from: string;
  readonly to: string;
  readonly fromProjectId: string;
  readonly toProjectId: string;
  readonly packId: string | undefined;
}

async function routeOf(ctx: CommandContext): Promise<Route> {
  const from = stringFlag(ctx, 'from');
  const to = stringFlag(ctx, 'to');
  if (from === undefined || to === undefined) {
    throw new UsageError(
      'Name both environments from your pack config, e.g. `kindgi promote --from=staging --to=prod`.',
    );
  }
  const loaded = await loadPackConfig(ctx, packDirOf(ctx));
  if (loaded.kind === 'missing') {
    throw new UsageError(
      `No pack config here (${loaded.message}). Run this in a pack, or pass --path=<the pack root>.`,
    );
  }
  if (loaded.kind === 'invalid') {
    throw new UsageError(`Couldn't read the pack config: ${loaded.message}`);
  }
  const refs = [from, to].map((name) => {
    const ref = projectOfEnv(loaded.config, name);
    if (ref === undefined) {
      throw new UsageError(
        `Your kindgi.config.ts names no project for environment "${name}". Add \`environments.${name}.project\`.`,
      );
    }
    return ref;
  });
  const [fromProjectId, toProjectId] = (await resolveRefs(ctx, refs)) as [string, string];
  const packId = (loaded.config.pack as { readonly id?: unknown } | undefined)?.id;
  return {
    from,
    to,
    fromProjectId,
    toProjectId,
    packId: typeof packId === 'string' && packId !== '' ? packId : undefined,
  };
}

/**
 * Why a deployment no longer serves, as the promotion reads it: its pack
 * service was taken down and isn't wanted back (`retired`). `undefined`: it
 * serves, or will again (a `cleared` one carries `waiting` then, never
 * `retired`).
 */
function retiredReason(d: Deployment): string | undefined {
  return d.endpoint?.status === 'cleared' ? d.endpoint.retired : undefined;
}

/** This pack's deployments in the project, newest first, every page: those serving, and those not. */
async function servingIn(ctx: CommandContext, projectId: string, packId: string) {
  const serving: Deployment[] = [];
  const retired: Deployment[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await ctx
      .client()
      .deployments.list({ projectId, packId, ...(cursor !== undefined && { cursor }) });
    // A runtime from before these filters ignores them and lists every deployment.
    if (page.projectId !== projectId || page.packId !== packId) {
      throw new Error(
        "`kindgi promote` needs a runtime on Kindgi 0.1.8.1 or later: this one doesn't list deployments by environment and pack.",
      );
    }
    for (const d of page.data) (retiredReason(d) === undefined ? serving : retired).push(d);
    if (page.hasMore !== true || page.nextCursor === undefined || page.nextCursor === '') break;
    cursor = page.nextCursor;
  }
  return { serving, retired };
}

const CANDIDATE_COLUMNS: readonly Column<Deployment>[] = [
  { header: 'DEPLOYMENT', get: (d) => d.deploymentId },
  { header: 'ACTIVATED', get: (d) => d.activatedAt },
  { header: 'VERSION', get: (d) => d.artifactVersion },
  { header: 'DIGEST', get: (d) => d.imageDigest },
];

/** `--deployment`, else the one deployment of this pack serving in `--from`: else why not. */
async function sourceOf(
  ctx: CommandContext,
  route: Route,
): Promise<{ readonly deploymentId: string } | { readonly answer: Answer }> {
  const given = stringFlag(ctx, 'deployment');
  if (given !== undefined) return { deploymentId: given };
  if (route.packId === undefined) {
    throw new UsageError(
      "Your kindgi.config.ts names no pack (`pack.id`), so its deployment in the environment can't be found: pass --deployment=<id>.",
    );
  }
  const { serving, retired } = await servingIn(ctx, route.fromProjectId, route.packId);
  const [only] = serving;
  if (only !== undefined && serving.length === 1) return { deploymentId: only.deploymentId };
  if (only === undefined) {
    const [newest] = retired;
    const why =
      newest === undefined
        ? ''
        : ` The newest, ${newest.deploymentId}, was taken down (${retiredReason(newest)}).`;
    return {
      answer: {
        stdout: '',
        stderr: `No deployment of ${route.packId} serves in ${route.from}.${why} Deploy it there first, or pass --deployment=<id>.\n`,
        exitCode: 1,
      },
    };
  }
  return {
    answer: {
      stdout: '',
      stderr: `${serving.length} deployments of ${route.packId} serve in ${route.from}, newest first. Pick one with --deployment=<id>:\n${renderTable(serving, CANDIDATE_COLUMNS).stdout}`,
      exitCode: 2,
    },
  };
}

interface MoveRow {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
  readonly note: string;
}

const MOVE_COLUMNS: readonly Column<MoveRow>[] = [
  { header: 'KIND', get: (r) => r.kind },
  { header: 'ID', get: (r) => r.id },
  { header: 'VERSION', get: (r) => r.version },
  { header: '', get: (r) => r.note },
];

/** What moves, and what stays behind: the lines `kindgi promote` prints before anything moves. */
export function movesText(
  moves: Moves,
  leftBehind: LeftBehind | undefined,
  route: Pick<Route, 'from' | 'to'>,
): string {
  const rows: MoveRow[] = [
    ...moves.agents.map((v) => movedRow('agent', v, route)),
    ...moves.flows.map((v) => movedRow('flow', v, route)),
    ...moves.tools.map((v) => ({ kind: 'tool', id: v.id, version: v.version ?? '', note: '' })),
    ...moves.guardrails.map((v) => ({ kind: 'guardrail', id: v.id, version: '', note: '' })),
  ];
  const pack = moves.packId !== undefined ? `pack ${moves.packId}, ` : '';
  const lines = [
    `What moves from ${route.from} to ${route.to} (${pack}build ${moves.imageDigest}):`,
    renderTable(rows, MOVE_COLUMNS).stdout.trimEnd(),
  ];
  if (leftBehind !== undefined && leftBehind.length > 0) {
    lines.push(`Stays in ${route.from}:`);
    for (const v of leftBehind) {
      lines.push(
        `  ${v.kind} ${v.id} ${v.version}: an edit of ${v.from}, which this build doesn't ship. It moves with a build of ${v.from}.`,
      );
    }
  }
  lines.push(
    `Test sets don't move: ${route.to} reads the ones made in ${route.from}, as it reads those of every environment before it in the order.`,
  );
  return `${lines.join('\n')}\n`;
}

function movedRow(kind: string, v: Moves['agents'][number], route: Pick<Route, 'from'>): MoveRow {
  return {
    kind,
    id: v.id,
    version: v.version ?? '',
    note: v.carried === true ? `carried: an edit made in ${route.from} since the build` : '',
  };
}

/** Where the values are set: the target environment and its project. */
interface ValueTarget {
  readonly env: string;
  readonly projectId: string;
}

/** The values not ready in the target, a line each with how to set it. */
export function valuesText(values: readonly DeploymentValue[], target: ValueTarget): string {
  if (values.length === 0) return `Every value it needs is set in ${target.env}.\n`;
  const lines = [`Not ready in ${target.env}:`];
  for (const v of values) lines.push(`  ${valueLine(v, target)}`);
  return `${lines.join('\n')}\n`;
}

function valueLine(v: DeploymentValue, target: ValueTarget): string {
  const what = `${v.name} (${v.kind}, for ${neededByText(v.neededBy)})`;
  const secretSet = `\`kindgi secrets set ${v.name} --env=${target.env} --scope=project:${target.projectId}\``;
  // The pack config maps the environment to its project, so `--env` says where.
  const envSet = `\`kindgi env set ${v.name} <value> --env=${target.env}\``;
  const isSecret = v.kind === 'secret' || v.kind === 'model-key';
  const isEnv = v.kind === 'env' || v.kind === 'pack-env';
  switch (v.problem) {
    case 'missing':
      if (isSecret) return `${what}: set nowhere a run looks. Set it with ${secretSet}.`;
      if (isEnv) return `${what}: set nowhere a run looks. Set it with ${envSet}.`;
      return `${what}: set nowhere a run looks.`;
    case 'revoked':
      return `${what}: revoked where a run reads it${v.foundAt !== undefined ? ` (the ${v.foundAt})` : ''}, and a run doesn't read past a revoked secret. Set a new value with ${secretSet}.`;
    case 'secret-not-yet':
      return `${what}: set only as a secret, which a pack service isn't given in its environment: a tool reads it per call (\`ctx.secrets\`).`;
    case 'ambiguous':
      return `${what}: set both as a secret and as a plain value. Remove one, so it's clear which the pack service gets.`;
    default:
      // A reason a later runtime names: said by its code.
      return `${what}: not ready (${v.problem ?? 'no reason given'}).`;
  }
}

function neededByText(n: DeploymentValue['neededBy']): string {
  const version = n.version !== undefined ? ` ${n.version}` : '';
  if (n.type === 'pack') return "the pack's service";
  return `${n.type} ${n.id}${version}`;
}

/** The deployment the target got. */
export function resultText(result: DeploymentPromotion, to: string): string {
  const id = result.deployment.deploymentId;
  return result.created
    ? `Promoted: deployment ${id} in ${to}.\n`
    : `${to} has this build already, as deployment ${id}: nothing new was deployed. The carried edits are recorded with it.\n`;
}

/** The values a `409 promotion-values-not-ready` names; `undefined` for any other error. */
function valuesRefused(err: unknown): readonly DeploymentValue[] | undefined {
  if (!(err instanceof KindgiApiError)) return undefined;
  const e = err.error;
  if (e.code !== 'conflict' || e.serverCode !== 'promotion-values-not-ready') return undefined;
  const values = e.fields?.values;
  return Array.isArray(values) ? (values as DeploymentValue[]) : undefined;
}

async function promoteBuild(ctx: CommandContext): Promise<Answer> {
  const route = await routeOf(ctx);
  const source = await sourceOf(ctx, route);
  if ('answer' in source) return source.answer;
  const { deploymentId } = source;
  const target = { env: route.to, projectId: route.toProjectId };
  // Prose unless a format is asked for (`--json`, `--raw`, `--quiet`), as `kindgi egress` does.
  const json = ctx.globals.formatRequested && ctx.globals.format !== 'table';
  const deployments = ctx.client().deployments;

  const check = await deployments.promoteCheck(deploymentId, { toProjectId: route.toProjectId });
  const ready = check.values.length === 0;
  if (ctx.options.check === true || !ready) {
    const exit = ready ? {} : { exitCode: 1 };
    if (json) return { ...renderJson({ deploymentId, check }, ctx.globals.format), ...exit };
    return {
      stdout: `Deployment ${deploymentId}.\n${movesText(check.moves, check.leftBehind, route)}${valuesText(check.values, target)}`,
      stderr: '',
      ...exit,
    };
  }

  const head = `Deployment ${deploymentId}.\n${movesText(check.moves, check.leftBehind, route)}`;
  const reason = stringFlag(ctx, 'reason');
  let result: DeploymentPromotion;
  try {
    result = await deployments.promote(deploymentId, {
      toProjectId: route.toProjectId,
      ...(reason !== undefined && { reason }),
    });
  } catch (err) {
    // A value went missing since the check.
    const values = valuesRefused(err);
    if (values === undefined || json) throw err;
    return { stdout: `${head}${valuesText(values, target)}`, stderr: '', exitCode: 1 };
  }
  if (json) return renderJson({ deploymentId, check, promotion: result }, ctx.globals.format);
  return { stdout: `${head}${valuesText([], target)}${resultText(result, route.to)}`, stderr: '' };
}

const promote: LeafCommand = {
  kind: 'leaf',
  name: 'promote',
  description:
    "Move a build to the next environment of its environment order, staging to prod, say: the same signed image, with the edits made since to its agents and flows. Prints what moves, then each value the build needs there that isn't set, with the command that sets it; exits 1 while one isn't. `--check` stops before moving anything.",
  usage:
    'kindgi promote --from=<env> --to=<env> [--deployment=<id>] [--reason=<text>] [--check] [--path=<dir>]',
  optionSpec: {
    from: {
      type: 'string',
      description: 'The environment the build serves in, by its name in your pack config.',
    },
    to: {
      type: 'string',
      description: 'The next environment of the order, by its name in your pack config.',
    },
    deployment: {
      type: 'string',
      description:
        "The deployment to promote. Default: this pack's one deployment serving in --from.",
    },
    reason: { type: 'string', description: 'Why, kept on the audit record.' },
    check: {
      type: 'boolean',
      description: 'What would move, and the values not set in --to. Changes nothing.',
    },
    path: { type: 'string', description: 'The pack root. Default: the current directory.' },
  },
  run: (ctx) => runSdkRendered(ctx, 'promote', () => promoteBuild(ctx)),
};

export const promoteCommand: Command = promote;
