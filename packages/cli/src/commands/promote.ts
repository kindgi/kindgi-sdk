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
 * In a pack, `--from` and `--to` are its config's environment names, each
 * the project its `environments.<name>.project` names, and the promotion
 * goes where a deploy into `--from` goes; an order lives in one tenant on
 * one runtime, so both must name the same `endpoint` and `tenantId`.
 * Outside a pack they're project ids or slugs, on the CLI's own runtime.
 *
 * Without `--deployment`, the build is the deployment serving in `--from`
 * (in a pack, this pack's): it must be just one.
 *
 * A value not set in `--to` is printed with the command that sets it: at
 * the target project's scope, under the env the runtime serves (the
 * check's `envName`), in a pack too.
 */

import { KindgiApiError } from '@kindgi/client';
import type {
  Deployment,
  DeploymentPromotion,
  DeploymentPromotionCheck,
  KindgiClient,
  Pin,
} from '@kindgi/client';

import { deployApiAddress, sameAddress } from '../api-address.js';
import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { type Column, type Rendered, renderJson, renderTable } from '../output.js';
import { loadPackConfig } from '../pack-config.js';
import { type ProgressLines, progressLines } from '../progress-lines.js';
import { resolveProjectRefs } from '../project-ref.js';
import {
  type ApprovalWaited,
  WAIT_FLAG,
  type WaitingVersion,
  endedLine,
  stillOpenLine,
  unreadableLine,
  waitDeadline,
  waitFlag,
  waitForApproval,
  waitWords,
  waitingLine,
} from './approval-wait.js';
import { type EnvironmentConfig, projectOfEnv } from './build.js';
import { packDirOf } from './environments.js';
import { ANSWER_NO_EXIT_CODE, runSdkRendered, stringFlag } from './helpers.js';
import type { Command, LeafCommand } from './types.js';

type Answer = Rendered & { readonly exitCode?: number };
type DeploymentValue = DeploymentPromotionCheck['values'][number];
type Moves = DeploymentPromotionCheck['moves'];
type LeftBehind = NonNullable<DeploymentPromotionCheck['leftBehind']>;

/**
 * Where a promotion goes from and to, and the runtime it goes to. `from`
 * and `to`: the pack config's environment names, or outside a pack the
 * project ids or slugs given.
 */
interface Route {
  readonly from: string;
  readonly to: string;
  readonly fromProjectId: string;
  readonly toProjectId: string;
  readonly packId: string | undefined;
  /** In a pack: the deployment it takes is this pack's. */
  readonly inPack: boolean;
  readonly client: KindgiClient;
}

async function routeOf(ctx: CommandContext): Promise<Route> {
  const from = stringFlag(ctx, 'from');
  const to = stringFlag(ctx, 'to');
  if (from === undefined || to === undefined) {
    throw new UsageError(
      'Name both environments, e.g. `kindgi promote --from=staging --to=prod`: by their names in your pack config, or outside a pack by project id or slug.',
    );
  }
  const loaded = await loadPackConfig(ctx, packDirOf(ctx));
  if (loaded.kind === 'invalid') {
    throw new UsageError(`Couldn't read the pack config: ${loaded.message}`);
  }
  if (loaded.kind === 'missing') {
    const client = ctx.client();
    const [fromProjectId, toProjectId] = (await resolveProjectRefs(ctx, [from, to], client)) as [
      string,
      string,
    ];
    return { from, to, fromProjectId, toProjectId, packId: undefined, inPack: false, client };
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
  const environments = loaded.config.environments as
    | Readonly<Record<string, EnvironmentConfig>>
    | undefined;
  const client = clientOf(ctx, from, to, environments?.[from], environments?.[to]);
  const [fromProjectId, toProjectId] = (await resolveProjectRefs(ctx, refs, client)) as [
    string,
    string,
  ];
  const packId = (loaded.config.pack as { readonly id?: unknown } | undefined)?.id;
  return {
    from,
    to,
    fromProjectId,
    toProjectId,
    packId: typeof packId === 'string' && packId !== '' ? packId : undefined,
    inPack: true,
    client,
  };
}

/**
 * The runtime a promotion in a pack goes to: where a deploy into `--from`
 * goes, its `endpoint` else the CLI's own address, with the key for it.
 * An environment order lives in one tenant on one runtime, so `--from` and
 * `--to` must name the same `endpoint` and `tenantId`.
 */
function clientOf(
  ctx: CommandContext,
  from: string,
  to: string,
  fromEnv: EnvironmentConfig | undefined,
  toEnv: EnvironmentConfig | undefined,
): KindgiClient {
  for (const field of ['endpoint', 'tenantId'] as const) {
    const a = fromEnv?.[field];
    const b = toEnv?.[field];
    const same =
      a === undefined || b === undefined
        ? a === b
        : field === 'endpoint'
          ? sameAddress(a, b)
          : a === b;
    if (!same) {
      throw new UsageError(
        `environments.${from}.${field} is ${a ?? 'unset'}, and environments.${to}.${field} is ${b ?? 'unset'}: an environment order lives in one tenant on one runtime, and a promotion stays there. Give both the same ${field}.`,
      );
    }
  }
  const address = deployApiAddress(
    ctx.config,
    [{ url: fromEnv?.endpoint, where: `environments.${from}.endpoint` }],
    'kindgi promote',
  );
  if (address === undefined) {
    throw new UsageError(
      `kindgi promote could not resolve an API endpoint. Set environments.${from}.endpoint in kindgi.config.ts, pass --url <url>, or export KINDGI_API_URL.`,
    );
  }
  if (address.kind === 'refused') throw new UsageError(address.message);
  const token = address.config.token;
  if (token === undefined || token === '') {
    throw new UsageError(
      'kindgi promote could not resolve an API token. Pass --token <key>, export KINDGI_API_TOKEN, or run `kindgi auth login`.',
    );
  }
  return ctx.clientFor(address.url, token);
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

/**
 * The deployments in the project (of the pack, when given), newest first,
 * every page: those serving, and those not.
 */
async function servingIn(client: KindgiClient, projectId: string, packId: string | undefined) {
  const serving: Deployment[] = [];
  const retired: Deployment[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.deployments.list({
      projectId,
      ...(packId !== undefined && { packId }),
      ...(cursor !== undefined && { cursor }),
    });
    // A runtime from before these filters ignores them and lists every deployment.
    if (page.projectId !== projectId || page.packId !== packId) {
      throw new Error(
        "`kindgi promote` needs a runtime on Kindgi 0.1.9 or later: this one doesn't list deployments by environment and pack.",
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

/** Outside a pack, the deployments serving in a project can be of any pack. */
const PACK_COLUMN: Column<Deployment> = { header: 'PACK', get: (d) => d.packId ?? '' };

/** `--deployment`, else the one deployment serving in `--from` (in a pack, of this pack): else why not. */
async function sourceOf(
  ctx: CommandContext,
  route: Route,
): Promise<{ readonly deploymentId: string } | { readonly answer: Answer }> {
  const given = stringFlag(ctx, 'deployment');
  if (given !== undefined) return { deploymentId: given };
  if (route.inPack && route.packId === undefined) {
    throw new UsageError(
      "Your kindgi.config.ts names no pack (`pack.id`), so its deployment in the environment can't be found: pass --deployment=<id>.",
    );
  }
  const { serving, retired } = await servingIn(route.client, route.fromProjectId, route.packId);
  const of = route.packId !== undefined ? ` of ${route.packId}` : '';
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
        stderr: `No deployment${of} serves in ${route.from}.${why} Deploy it there first, or pass --deployment=<id>.\n`,
        exitCode: 1,
      },
    };
  }
  return {
    answer: {
      stdout: '',
      stderr: `${serving.length} deployments${of} serve in ${route.from}, newest first. Pick one with --deployment=<id>:\n${renderTable(serving, route.packId !== undefined ? CANDIDATE_COLUMNS : [PACK_COLUMN, ...CANDIDATE_COLUMNS]).stdout}`,
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
    `Test cases don't move: ${route.to} reads the ones made in ${route.from}, as it reads those of every environment before it in the order.`,
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

/**
 * Where the target's values are set: its name (`label`), the env they're
 * read under, and its project.
 */
interface ValueTarget {
  readonly label: string;
  readonly env: string;
  readonly projectId: string;
}

/**
 * A value goes at the target project's scope, under the env the runtime serves (`envName`), which
 * a run there reads values under: in a pack too, since `--env` is the runtime's env name, never an
 * environment's.
 */
function valueTargetOf(route: Route, envName: string | undefined): ValueTarget {
  return {
    label: route.to,
    env: envName ?? '<the env the runtime serves>',
    projectId: route.toProjectId,
  };
}

/** The values not ready in the target, a line each with how to set it. */
export function valuesText(values: readonly DeploymentValue[], target: ValueTarget): string {
  if (values.length === 0) return `Every value it needs is set in ${target.label}.\n`;
  const lines = [`Not ready in ${target.label}:`];
  for (const v of values) lines.push(`  ${valueLine(v, target)}`);
  return `${lines.join('\n')}\n`;
}

function valueLine(v: DeploymentValue, target: ValueTarget): string {
  const what = `${v.name} (${v.kind}, for ${neededByText(v.neededBy)})`;
  const secretSet = `\`kindgi secrets set ${v.name} --env=${target.env} --scope=project:${target.projectId}\``;
  // The project is named: `kindgi env set` without `--scope` writes a local file.
  const envSet = `\`kindgi env set ${v.name} <value> --scope=project:${target.projectId} --env=${target.env}\``;
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
    case 'no-provider':
      return `${what}: no model provider is registered, so a run has none to call. Register one with \`kindgi providers register --preset=<name>\` (\`kindgi providers presets\` lists them), then check again: its key is needed in ${target.label}.`;
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
  const head = result.created
    ? `Promoted: deployment ${id} in ${to}.\n`
    : `${to} has this build already, as deployment ${id}: nothing new was deployed. The carried edits are recorded with it.\n`;
  const live = result.live ?? [];
  const pin = (p: (typeof live)[number]) =>
    p.pinned
      ? `  ${p.id} ${p.version} — live`
      : `  ${p.id} ${p.version} — ${GATE_WORDS[p.gate?.status ?? ''] ?? 'held by the gate'}`;
  const liveText = live.length === 0 ? '' : `Live in ${to}:\n${live.map(pin).join('\n')}\n`;
  // `makeLive` also pins each flow version the promotion carries, for the target.
  const flows = result.pinnedFlows ?? [];
  const flowsText =
    flows.length === 0
      ? ''
      : `Flows pinned in ${to}:\n${flows.map((f) => `  ${f.id} ${f.version}`).join('\n')}\n`;
  return `${head}${liveText}${flowsText}`;
}

/** A carried version that isn't live, by its gate's status; any other is held by the gate. */
const GATE_WORDS: Readonly<Record<string, string>> = {
  'pending-approval': 'waiting for an approval',
  rejected: 'its approval was rejected',
  expired: 'its approval expired',
  superseded: 'approved, but superseded',
};

type LivePin = NonNullable<DeploymentPromotion['live']>[number];

/** A carried version waiting for an approval, as the wait's lines name it. */
function waitingVersion(pin: LivePin): WaitingVersion {
  return {
    agentId: pin.id,
    toVersion: pin.version,
    ...(pin.gate?.approvalId !== undefined && { approvalId: pin.gate.approvalId }),
  };
}

/**
 * `--wait`: wait for each carried version that waits for an approval, all
 * within one deadline, and stop at the first that doesn't go live. A
 * version held by a failed check can't go live, so then nothing waits.
 * The answer has each version as it ended, and `end` says when the wait
 * ended before every version did: stopped, or a promotion it couldn't read.
 */
async function waitForPins(
  ctx: CommandContext,
  client: KindgiClient,
  result: DeploymentPromotion,
  waitMs: number,
  out: ProgressLines,
): Promise<PinsWaited> {
  const live = result.live ?? [];
  const held = live.find((p) => !p.pinned && p.gate?.status !== 'pending-approval');
  if (held !== undefined) {
    out.problem(
      `Not waiting: ${held.id} ${held.version} is held by the gate, so not every version goes live.`,
    );
    return { result };
  }
  const waiting = live.filter((p) => !p.pinned);
  for (const p of waiting) out.line(waitingLine(waitingVersion(p), waitMs));
  const deadline = waitDeadline(ctx, waitMs);
  const ended = new Map<string, Pin>();
  for (const p of waiting) {
    const changeId = p.gate?.changeId;
    if (changeId === undefined) continue;
    const waited = await waitForApproval(
      ctx,
      undefined,
      () => client.agents.pinned.getChange(p.id, changeId),
      deadline,
    );
    if (waited.pin !== undefined) ended.set(changeId, waited.pin);
    const end = sayHowItEnded(waited, waitingVersion(p), waitMs, out);
    if (end === 'live') continue;
    return { result: withEnded(result, ended), ...(end !== 'not-live' && { end }) };
  }
  return { result: withEnded(result, ended) };
}

/** Say how one carried version's wait ended, unless it went live. */
function sayHowItEnded(
  waited: ApprovalWaited<Pin | undefined>,
  version: WaitingVersion,
  waitMs: number,
  out: ProgressLines,
): 'live' | 'not-live' | NonNullable<PinsWaited['end']> {
  switch (waited.kind) {
    case 'stopped':
      out.line(`Stopped waiting. ${stillOpenLine(version)}`);
      return 'stopped';
    case 'unreadable':
      out.problem(unreadableLine(version, waited.message));
      return 'unreadable';
    case 'still-waiting':
      out.problem(`Still waiting after ${waitWords(waitMs)}. ${stillOpenLine(version)}`);
      return 'not-live';
    case 'decided':
      if (waited.pin.status === 'pinned') return 'live';
      out.problem(endedLine(waited.pin));
      return 'not-live';
  }
}

interface PinsWaited {
  readonly result: DeploymentPromotion;
  readonly end?: 'stopped' | 'unreadable';
}

/** The exit of a wait that ended before every version did. */
const END_EXIT: Readonly<Record<NonNullable<PinsWaited['end']>, number>> = {
  stopped: 130,
  unreadable: 1,
};

/** `result` with each carried version a wait read as it ended. */
function withEnded(
  result: DeploymentPromotion,
  ended: ReadonlyMap<string, Pin>,
): DeploymentPromotion {
  if (result.live === undefined || ended.size === 0) return result;
  const live = result.live.map((pin): LivePin => {
    const gate = pin.gate;
    const change = gate !== undefined ? ended.get(gate.changeId) : undefined;
    if (gate === undefined || change?.status === undefined) return pin;
    return {
      ...pin,
      pinned: change.status === 'pinned',
      gate: { ...gate, status: change.status },
    };
  });
  return { ...result, live };
}

/** The values a `409 promotion-values-not-ready` names; `undefined` for any other error. */
function valuesRefused(err: unknown): readonly DeploymentValue[] | undefined {
  if (!(err instanceof KindgiApiError)) return undefined;
  const e = err.error;
  if (e.code !== 'conflict' || e.serverCode !== 'promotion-values-not-ready') return undefined;
  const values = e.fields?.values;
  return Array.isArray(values) ? (values as DeploymentValue[]) : undefined;
}

/** `--wait`, which goes only with `--make-live`, and not with `--check`. */
function promoteWaitFlag(ctx: CommandContext): number | undefined {
  const waitMs = waitFlag(ctx);
  if (waitMs !== undefined && (ctx.options.check === true || ctx.options['make-live'] !== true)) {
    throw new UsageError(
      '--wait waits for the versions --make-live makes live: it goes with --make-live, without --check',
    );
  }
  return waitMs;
}

/**
 * The promotion's answer: each carried version as it ended, after any
 * `--wait`, rendered by `render`. It exits 3 when one isn't live, 130
 * when the wait is stopped, and 1 when it couldn't read a promotion.
 */
async function promotedAnswer(
  ctx: CommandContext,
  client: KindgiClient,
  result: DeploymentPromotion,
  waitMs: number | undefined,
  render: (promotion: DeploymentPromotion) => string,
): Promise<Answer> {
  const out = progressLines(ctx.progress, ctx.globals.format === 'quiet');
  const waited: PinsWaited =
    waitMs === undefined ? { result } : await waitForPins(ctx, client, result, waitMs, out);
  const notLive = (waited.result.live ?? []).some((p) => !p.pinned);
  const exit =
    waited.end !== undefined ? END_EXIT[waited.end] : notLive ? ANSWER_NO_EXIT_CODE : undefined;
  return {
    stdout: render(waited.result),
    stderr: out.kept(),
    ...(exit !== undefined && { exitCode: exit }),
  };
}

async function promoteBuild(ctx: CommandContext): Promise<Answer> {
  const waitMs = promoteWaitFlag(ctx);
  const route = await routeOf(ctx);
  const source = await sourceOf(ctx, route);
  if ('answer' in source) return source.answer;
  const { deploymentId } = source;
  // Prose unless a format is asked for (`--json`, `--raw`, `--quiet`), as `kindgi egress` does.
  const json = ctx.globals.formatRequested && ctx.globals.format !== 'table';
  const deployments = route.client.deployments;

  const check = await deployments.promoteCheck(deploymentId, { toProjectId: route.toProjectId });
  const target = valueTargetOf(route, check.envName);
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
      ...(ctx.options['make-live'] === true && { makeLive: true }),
    });
  } catch (err) {
    // A value went missing since the check.
    const values = valuesRefused(err);
    if (values === undefined || json) throw err;
    return { stdout: `${head}${valuesText(values, target)}`, stderr: '', exitCode: 1 };
  }
  const render = json
    ? (promotion: DeploymentPromotion) =>
        renderJson({ deploymentId, check, promotion }, ctx.globals.format).stdout
    : (promotion: DeploymentPromotion) =>
        `${head}${valuesText([], target)}${resultText(promotion, route.to)}`;
  return await promotedAnswer(ctx, route.client, result, waitMs, render);
}

const promote: LeafCommand = {
  kind: 'leaf',
  name: 'promote',
  description:
    "Move a build to the next environment of its environment order, staging to prod, say: the same signed image, with the edits made since to its agents and flows. Prints what moves, then each value the build needs there that isn't set, with the command that sets it; exits 1 while one isn't. `--check` stops before moving anything. With `--make-live`, exits 3 when a carried version doesn't go live: held by the gate, or waiting for an approval (`--wait` waits for the decision). In a pack, --from and --to are its environment names; outside one, project ids or slugs.",
  usage:
    'kindgi promote --from=<env> --to=<env> [--deployment=<id>] [--reason=<text>] [--check] [--make-live [--wait[=<duration>]]] [--path=<dir>]',
  optionSpec: {
    from: {
      type: 'string',
      description:
        'The environment the build serves in: its name in your pack config, or outside a pack a project id or slug.',
    },
    to: {
      type: 'string',
      description:
        'The next environment of the order: its name in your pack config, or outside a pack a project id or slug.',
    },
    deployment: {
      type: 'string',
      description:
        'The deployment to promote. Default: the one deployment serving in --from (in a pack, of this pack).',
    },
    reason: { type: 'string', description: 'Why, kept on the audit record.' },
    check: {
      type: 'boolean',
      description: 'What would move, and the values not set in --to. Changes nothing.',
    },
    'make-live': {
      type: 'boolean',
      description:
        "Make every agent version the promotion carries live in --to, each through its scope's gate, and pin every flow version it carries there. Prints each, and any waiting on a gate; exits 3 when one doesn't go live.",
    },
    ...WAIT_FLAG,
    path: { type: 'string', description: 'The pack root. Default: the current directory.' },
  },
  run: (ctx) => runSdkRendered(ctx, 'promote', () => promoteBuild(ctx)),
};

export const promoteCommand: Command = promote;
