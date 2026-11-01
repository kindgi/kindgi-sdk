// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi suggested-changes pull <id> [--pr]`: a suggested change's block
 * versions into the pack's block files, as `kindgi blocks pull` writes the
 * versions that run. With `--pr`, in the pack's git repository: a new
 * branch, a commit of the block files alone, a push, and a pull request
 * opened with `gh` (or, without it, where to open one). Then the
 * corrections it fixes that are still `open` are `being-fixed`, linked to
 * the pull request.
 *
 * The pull request says fixed words and numbers only, as the runtime's own
 * pull requests for a block version do: never the suggested change's
 * `why`, nor a correction's words. git and gh run with their arguments,
 * never through a shell, and get no token: each signs in its own way.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { KindgiApiError, type KindgiClient, type SuggestedChange } from '@kindgi/client';
import { type IndexedBlock, writePackBlock } from '@kindgi/handler-runtime';
import semver from 'semver';

import { stableStringify } from '../build/envelope.js';
import type { CommandContext } from '../context.js';
import { repoOf } from '../deploy/source.js';
import { UsageError } from '../errors.js';
import { type Rendered, renderJson } from '../output.js';
import { resolveProjectRef } from '../project-ref.js';
import { gitCaller, gitEnv, uncommittedFiles } from '../uncommitted-files.js';
import { type PulledBlock, packBlocksAt } from './blocks.js';
import { consoleUrlOf } from './console.js';
import { packDirOf } from './environments.js';
import { requiredPositional, runSdkRendered, stringFlag } from './helpers.js';
import type { LeafCommand } from './types.js';

type BlockChange = Extract<SuggestedChange['changes'][number], { readonly kind: 'block' }>;

/** A block change to write: the pack's block, the version, and its files. */
interface Pull {
  readonly blockId: string;
  readonly to: string;
  readonly block: IndexedBlock;
  /** The block's file and, for a prompt that keeps one, its template file: relative to the pack. */
  readonly files: readonly string[];
  /** When the file is at the version the change is built on: that version's content, which the file must still hold. */
  readonly expected?: Readonly<Record<string, unknown>>;
}

/** The statuses whose version can be pulled: checked, and not withdrawn. */
const PULLABLE: ReadonlySet<SuggestedChange['status']> = new Set([
  'ready',
  'waiting-for-second-person',
  'pinned',
  'added-as-latest',
]);

const NO_GIT =
  "--pr runs git, and there's no `git` on your PATH: install git, or pull without --pr to only write the files.";

/** Why a suggested change in this status can't be pulled. */
function notPullable(s: SuggestedChange): string {
  if (s.status === 'checking') {
    return `${s.id} is still being checked: pull it once it's \`ready\` (\`kindgi suggested-changes get ${s.id}\` shows its check).`;
  }
  if (s.status === 'check-failed') {
    return `${s.id}'s check failed, so how it does isn't known: check it again first (\`kindgi suggested-changes check ${s.id} --wait\`).`;
  }
  return `${s.id} was withdrawn: there's nothing to pull.`;
}

/** Its block changes, each with its version; refused for a deploy's change, which has code. */
function blockChangesOf(s: SuggestedChange): readonly (BlockChange & { readonly to: string })[] {
  if (s.changes.some((c) => c.kind === 'code')) {
    throw new Error(
      `${s.id} is a deploy's change: its code is in the deploy's image, not in a block, so there's nothing to write into the pack.`,
    );
  }
  const blocks = s.changes.filter((c): c is BlockChange => c.kind === 'block');
  if (blocks.length === 0) throw new Error(`${s.id} changes no block: there's nothing to pull.`);
  return blocks.map((c) => {
    if (c.to === undefined) {
      throw new Error(`${s.id} has no version of ${c.blockId} yet: there's nothing to pull.`);
    }
    return { ...c, to: c.to };
  });
}

/**
 * The pack's block for a change. Refused when the pack has none, when its
 * file isn't older than the change's version, and when it holds a version
 * newer than the one the change is built on, or that version with other
 * content: writing would drop those edits.
 */
async function pullOf(
  client: KindgiClient,
  packDir: string,
  pattern: string,
  blocks: readonly IndexedBlock[],
  change: BlockChange & { readonly to: string },
): Promise<Pull> {
  const block = blocks.find((b) => b.id === change.blockId);
  if (block === undefined) {
    throw new UsageError(
      `${change.blockId} isn't among the pack's blocks (${pattern}): run this in the pack that has it, or pass --path=<dir>.`,
    );
  }
  if (!semver.gt(change.to, block.version)) {
    throw new Error(
      `${block.modulePath} holds ${block.id} ${block.version} now, not older than the suggested change's ${change.to}: there's nothing to pull.`,
    );
  }
  if (semver.gt(block.version, change.from)) {
    throw new Error(
      `${block.modulePath} holds ${block.id} ${block.version}, newer than the ${change.from} the suggested change is built on: pulling it would drop ${block.version}'s edits. Make the change again on what the pack holds.`,
    );
  }
  const template = await templateFileOf(packDir, block);
  const files = template === undefined ? [block.modulePath] : [block.modulePath, template];
  const pull = { blockId: block.id, to: change.to, block, files };
  if (semver.lt(block.version, change.from)) return pull;
  return { ...pull, expected: await unchangedSince(client, pull, change.from) };
}

/** The content of the version the change is built on, refused when the pack's files hold other content at it. */
async function unchangedSince(
  client: KindgiClient,
  pull: Pick<Pull, 'block' | 'files'>,
  from: string,
): Promise<Readonly<Record<string, unknown>>> {
  const { block, files } = pull;
  const expected = (await client.blocks.versions.get(block.id, from)).content as Readonly<
    Record<string, unknown>
  >;
  if (stableStringify(block.content) !== stableStringify(expected)) {
    const held =
      files.length === 1
        ? `${block.modulePath} holds`
        : `${block.modulePath} and its template ${files[1]} hold`;
    throw new Error(
      `${held} ${block.id} ${block.version} with edits that aren't in the ${from} the suggested change is built on: pulling it would drop them. Make the change again on what the pack holds, or undo the edits.`,
    );
  }
  return expected;
}

/** A prompt's template file, where `readPackBlocks` reads it: relative to its block's file. */
async function templateFileOf(packDir: string, block: IndexedBlock): Promise<string | undefined> {
  if (block.kind !== 'prompt') return undefined;
  const raw = JSON.parse(await readFile(path.join(packDir, block.modulePath), 'utf8')) as {
    readonly content?: { readonly templateFile?: unknown };
  };
  const file = raw.content?.templateFile;
  return typeof file === 'string'
    ? path.posix.normalize(path.posix.join(path.posix.dirname(block.modulePath), file))
    : undefined;
}

/** Each version written into its file, in order, into `wrote`: what's written when a later one fails. */
async function writeAll(
  client: KindgiClient,
  packDir: string,
  pattern: string,
  pulls: readonly Pull[],
  wrote: PulledBlock[] = [],
): Promise<PulledBlock[]> {
  const contents = await Promise.all(
    pulls.map(async (p) => (await client.blocks.versions.get(p.blockId, p.to)).content),
  );
  for (const [i, p] of pulls.entries()) {
    const outcome = await writePackBlock(packDir, pattern, {
      id: p.blockId,
      version: p.to,
      content: contents[i] as Readonly<Record<string, unknown>>,
      ...(p.expected !== undefined && { expected: p.expected }),
    });
    if (outcome.kind === 'err') {
      throw new Error(
        `Couldn't write ${p.blockId} ${p.to} into ${p.block.modulePath}: ${outcome.message}`,
      );
    }
    wrote.push({
      blockId: p.blockId,
      from: outcome.replaced,
      to: p.to,
      file: outcome.file,
      ...(outcome.templateFile !== undefined && { templateFile: outcome.templateFile }),
    });
  }
  return wrote;
}

// ------------------------------------------------------------
// git and gh.
// ------------------------------------------------------------

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `cmd args` in `cwd`, with no shell: its output and exit code, or `missing` when it isn't on PATH. */
function runTool(
  ctx: CommandContext,
  cmd: 'git' | 'gh',
  args: readonly string[],
  cwd: string,
): Promise<Ran | 'missing'> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd,
      // gh asks nothing: a question it would ask is an error instead.
      // git reads the pack's own repository, in English (`saidLine` reads it).
      env: cmd === 'git' ? gitEnv(ctx.env) : { ...ctx.env, GH_PROMPT_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') resolve('missing');
      else reject(err);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** A URL without the user and password some remotes carry. */
function withoutCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1');
}

/**
 * What a tool says went wrong, without credentials: git's first `fatal:` or
 * `error:` line (the advice after it says nothing about this pack), else
 * the last line it printed.
 */
function saidLine(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const said =
    lines.find((l) => l.startsWith('fatal: ') || l.startsWith('error: ')) ??
    lines[lines.length - 1];
  return said === undefined ? undefined : withoutCredentials(said);
}

/** git's output; an Error saying `what` failed, and git's last line, when it fails. */
async function git(
  ctx: CommandContext,
  cwd: string,
  args: readonly string[],
  what: string,
): Promise<string> {
  const ran = await runTool(ctx, 'git', args, cwd);
  if (ran === 'missing') throw new Error(NO_GIT);
  if (ran.code !== 0) {
    throw new Error(`${what}: ${saidLine(ran.stderr) ?? `git exited with ${ran.code}`}`);
  }
  return ran.stdout;
}

/** Whether git answers 0; `false` for any other answer. */
async function gitSays(
  ctx: CommandContext,
  cwd: string,
  args: readonly string[],
): Promise<boolean> {
  const ran = await runTool(ctx, 'git', args, cwd);
  if (ran === 'missing') throw new Error(NO_GIT);
  return ran.code === 0;
}

/** Where `--pr` works: the branch checked out, the remote, and the name the pull request gives. */
interface Repo {
  readonly base: string;
  readonly remote: string;
  readonly userName: string;
}

/**
 * Checked before anything is written: the pack is in a git repository, its
 * block files have no changes that aren't committed, there's a commit and a
 * branch checked out, git has a user name, there's a remote to push to, and
 * the new branch is neither here nor on the remote.
 */
async function repoFor(
  ctx: CommandContext,
  packDir: string,
  branch: string,
  files: readonly string[],
): Promise<Repo> {
  await committedIn(ctx, packDir, files);
  const base = await baseOf(ctx, packDir);
  const userName = await userNameOf(ctx, packDir);
  const remote = await remoteOf(ctx, packDir);
  await newBranch(ctx, packDir, remote, branch);
  return { base, remote, userName };
}

/** How long `--pr` waits on each git command that reads the block files' status. */
const STATUS_TIMEOUT_MS = 30_000;

/** The pack is in a git repository, and git has committed the block files as they are. */
async function committedIn(
  ctx: CommandContext,
  packDir: string,
  files: readonly string[],
): Promise<void> {
  if ((await runTool(ctx, 'git', ['--version'], packDir)) === 'missing') throw new Error(NO_GIT);
  const inGit = await uncommittedFiles(packDir, files, gitCaller(ctx.env), STATUS_TIMEOUT_MS);
  if (inGit.kind === 'not-in-git') {
    throw new Error(
      `The pack (${packDir}) isn't in a git repository: --pr makes a branch and a commit there. Without --pr, it only writes the files.`,
    );
  }
  if (inGit.kind === 'unknown') {
    throw new Error(
      "git couldn't say whether the pack's block files have changes that aren't committed: check that `git status` works in the pack, then run this again.",
    );
  }
  if (inGit.uncommitted.length > 0) {
    throw new Error(
      `These block files have changes that aren't committed: ${inGit.uncommitted.join(', ')}. Commit or undo them first: --pr commits only the new version.`,
    );
  }
}

/** The branch checked out, which the pull request goes into. */
async function baseOf(ctx: CommandContext, packDir: string): Promise<string> {
  if (!(await gitSays(ctx, packDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))) {
    throw new Error(
      "The pack's git repository has no commit yet: commit the pack first, so the pull request has a branch to go into.",
    );
  }
  const head = await runTool(ctx, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], packDir);
  const base = head === 'missing' || head.code !== 0 ? '' : head.stdout.trim();
  if (base === '') {
    throw new Error(
      'HEAD is detached: check out the branch the pull request goes into, then run this again.',
    );
  }
  return base;
}

/** git's user.name, which the pull request names. */
async function userNameOf(ctx: CommandContext, packDir: string): Promise<string> {
  const name = await runTool(ctx, 'git', ['config', 'user.name'], packDir);
  const userName = name === 'missing' || name.code !== 0 ? '' : name.stdout.trim();
  if (userName === '') {
    throw new Error(
      'git has no user.name: set yours (`git config user.name "<your name>"`). The commit and the pull request name you.',
    );
  }
  return userName;
}

/** The remote the branch is pushed to: origin, else the only one. */
async function remoteOf(ctx: CommandContext, packDir: string): Promise<string> {
  const remotes = (await git(ctx, packDir, ['remote'], "Couldn't list the git remotes"))
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r !== '');
  const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '';
  if (remote === undefined || remote === '') {
    throw new Error(
      remotes.length === 0
        ? "The pack's git repository has no remote to push the branch to: add one (`git remote add origin <url>`)."
        : `The pack's git repository has several remotes, and none is called origin (${remotes.join(', ')}): --pr pushes to origin.`,
    );
  }
  return remote;
}

/** The new branch is neither in the pack's repository nor where the push goes. */
async function newBranch(
  ctx: CommandContext,
  packDir: string,
  remote: string,
  branch: string,
): Promise<void> {
  if (await gitSays(ctx, packDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
    throw new Error(
      `The branch ${branch} is there already: a pull request for this version may be open. To make it again, delete the branch first (\`git branch -d ${branch}\`).`,
    );
  }
  // Asked where the push goes (a `pushInsteadOf` can differ from where fetches
  // go). `--exit-code`: 2 when it has no such branch.
  const pushUrl = (
    await git(
      ctx,
      packDir,
      ['remote', 'get-url', '--push', remote],
      `Couldn't read ${remote}'s push URL`,
    )
  ).trim();
  const onRemote = await runTool(
    ctx,
    'git',
    ['ls-remote', '--exit-code', '--heads', pushUrl, `refs/heads/${branch}`],
    packDir,
  );
  if (onRemote === 'missing') throw new Error(NO_GIT);
  if (onRemote.code === 0) {
    throw new Error(
      `${remote} has a branch ${branch} already: a pull request for this version may be open. To make it again, delete that branch on ${remote} first.`,
    );
  }
  if (onRemote.code !== 2) {
    throw new Error(
      `Couldn't ask ${remote} whether it has a branch ${branch}: ${saidLine(onRemote.stderr) ?? `git exited with ${onRemote.code}`}`,
    );
  }
}

/**
 * Where to open the pull request by hand: the URL the remote printed on
 * the push, or GitHub's compare page for a github.com remote.
 */
function openUrlOf(
  pushed: string,
  remoteUrl: string,
  base: string,
  branch: string,
): string | undefined {
  for (const line of pushed.split('\n')) {
    const url = /^remote:.*?(https?:\/\/\S+)/.exec(line.trim())?.[1];
    if (url !== undefined) return withoutCredentials(url);
  }
  const repo = repoOf(remoteUrl);
  if (repo?.startsWith('github.com/') !== true) return undefined;
  const ref = (name: string) => name.split('/').map(encodeURIComponent).join('/');
  return `https://${repo}/compare/${ref(base)}...${ref(branch)}?expand=1`;
}

// ------------------------------------------------------------
// The pull request's text.
// ------------------------------------------------------------

/** The most of a name the text shows. */
const NAME_MAX = 80;

/**
 * A name as plain text in a pull request's markdown, on one line and at
 * most `NAME_MAX` characters: no control or format characters (but the
 * zero-width joiner and non-joiner), nothing that becomes a link or a
 * mention, and its punctuation escaped.
 */
export function nameText(name: string): string {
  const line = name
    .replace(/(?![‌‍])\p{Cf}/gu, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim();
  const chars = [...line];
  const short = chars.length <= NAME_MAX ? line : `${chars.slice(0, NAME_MAX).join('').trimEnd()}…`;
  return short
    .replace(/[@#]|:\/\/|www\.|gh-(?=\d)/gi, (m) => `${m.slice(0, 1)}​${m.slice(1)}`)
    .replace(/[!-/:-@[-`{-~]/g, '\\$&');
}

type CheckSide = NonNullable<SuggestedChange['check']['with']>;

/** Who made it, how many corrections it fixes, and how its check did: fixed words and numbers. */
function fromText(s: SuggestedChange): string {
  const text: string[] = [];
  if (s.madeBy.kind === 'improve-run') {
    text.push(
      s.madeBy.scheduleId !== undefined ? 'From a scheduled Improve run.' : 'From an Improve run.',
    );
  } else if (s.madeBy.kind === 'person' || s.madeBy.kind === 'service') {
    text.push('From a suggested change made by hand.');
  }
  const fixes = s.fixes.length;
  if (fixes > 0) text.push(`It fixes ${fixes} ${fixes === 1 ? 'correction' : 'corrections'}.`);
  const tested = testSetText(s.check.with, s.check.now);
  if (tested !== undefined) text.push(tested);
  return text.join(' ');
}

/** `Test set: 25 of 27, up from 23.`; none before the check is done, or with nothing checked. */
function testSetText(
  side: CheckSide | undefined,
  before: CheckSide | undefined,
): string | undefined {
  if (side?.passing === undefined || side.of === undefined || side.of === 0) return undefined;
  return `Test set: ${side.passing} of ${side.of}${beforeText(side.passing, side.of, before)}.`;
}

/** `, up from 23`: how the version it's built on did; empty when it wasn't checked. */
function beforeText(passing: number, of: number, before: CheckSide | undefined): string {
  if (before?.passing === undefined || before.of === undefined) return '';
  if (before.of !== of) return `, ${before.passing} of ${before.of} before`;
  if (before.passing < passing) return `, up from ${before.passing}`;
  if (before.passing > passing) return `, down from ${before.passing}`;
  return ', as before';
}

/** The pull request's title, which is the commit's message too. */
export function titleOf(wrote: readonly PulledBlock[]): string {
  return `Kindgi: ${wrote.map((w) => `${w.blockId} v${w.to}`).join(', ')}, from a suggested change`;
}

/** The pull request's text: where it came from, the files, the link, and who made it. */
export function bodyOf(
  s: SuggestedChange,
  wrote: readonly PulledBlock[],
  link: string | undefined,
  userName: string,
): string {
  const from = fromText(s);
  const files = wrote.map((w) =>
    w.templateFile === undefined
      ? `\`${w.file}\` goes from ${w.blockId} v${w.from} to v${w.to}.`
      : `\`${w.file}\` and its template \`${w.templateFile}\` go from ${w.blockId} v${w.from} to v${w.to}.`,
  );
  return [
    ...(from === '' ? [] : [from, '']),
    ...files,
    '',
    ...(link === undefined ? [] : [`The suggested change, with its check: ${link}`, '']),
    `Made with \`kindgi suggested-changes pull\` by ${nameText(userName)}.`,
  ].join('\n');
}

/**
 * The suggested change in the console:
 * `<runtime>/console/projects/<project>/agents/<agent>/suggested-changes/<id>`,
 * a project path, which the console puts under the signed-in tenant.
 */
export function consoleLinkOf(
  apiUrl: string,
  s: { readonly id: string; readonly agentId: string; readonly projectId?: string | undefined },
): string | undefined {
  if (s.projectId === undefined) return undefined;
  const part = encodeURIComponent;
  return `${consoleUrlOf(apiUrl)}projects/${part(s.projectId)}/agents/${part(s.agentId)}/suggested-changes/${part(s.id)}`;
}

// ------------------------------------------------------------
// The corrections it fixes.
// ------------------------------------------------------------

interface Marked {
  /** Now `being-fixed`, linked to the pull request. */
  readonly beingFixed: string[];
  /** Not `open`, so left as they are. */
  readonly left: { readonly correctionId: string; readonly status: string }[];
  /** The runtime refused or failed these, and why. */
  readonly failed: { readonly correctionId: string; readonly error: string }[];
}

/** Each fixed correction still `open` set `being-fixed` with the pull request as its link. */
async function markBeingFixed(
  corrections: KindgiClient['corrections'],
  fixes: readonly string[],
  link: string,
): Promise<Marked> {
  const marked: Marked = { beingFixed: [], left: [], failed: [] };
  for (const correctionId of fixes) {
    try {
      const { status } = await corrections.get(correctionId);
      if (status !== 'open') {
        marked.left.push({ correctionId, status });
        continue;
      }
      await corrections.change(correctionId, { status: 'being-fixed', link });
      marked.beingFixed.push(correctionId);
    } catch (err) {
      if (!(err instanceof KindgiApiError)) throw err;
      marked.failed.push({ correctionId, error: err.message });
    }
  }
  return marked;
}

/**
 * The fixed corrections still `open`, for the lines that mark them once
 * the pull request is open. One that couldn't be read is named too.
 */
async function stillOpen(
  corrections: KindgiClient['corrections'],
  fixes: readonly string[],
): Promise<string[]> {
  const open: string[] = [];
  for (const correctionId of fixes) {
    try {
      if ((await corrections.get(correctionId)).status === 'open') open.push(correctionId);
    } catch (err) {
      if (!(err instanceof KindgiApiError)) throw err;
      // Not read: named anyway, and `corrections set` says what it finds.
      open.push(correctionId);
    }
  }
  return open;
}

// ------------------------------------------------------------
// The command.
// ------------------------------------------------------------

type Pulled = Rendered & { readonly exitCode?: number };

/** The suggested change, checked against `--project` and its status, with each block it pulls. */
async function pullsFor(
  ctx: CommandContext,
  client: KindgiClient,
  id: string,
  packDir: string,
): Promise<{
  readonly suggested: SuggestedChange;
  readonly pattern: string;
  readonly pulls: Pull[];
}> {
  const { pattern, blocks } = await packBlocksAt(ctx, packDir);
  const suggested = await client.suggestedChanges.get(id);
  const project = stringFlag(ctx, 'project');
  if (project !== undefined && (await resolveProjectRef(ctx, project)) !== suggested.projectId) {
    throw new UsageError(
      `${id} is for ${suggested.projectId === undefined ? 'no project' : `project ${suggested.projectId}`}, not ${project}.`,
    );
  }
  if (!PULLABLE.has(suggested.status)) throw new Error(notPullable(suggested));
  const pulls: Pull[] = [];
  for (const change of blockChangesOf(suggested)) {
    pulls.push(await pullOf(client, packDir, pattern, blocks, change));
  }
  return { suggested, pattern, pulls };
}

/** On a new branch from the one checked out: the block files written, then committed alone. */
async function commitOnBranch(
  ctx: CommandContext,
  client: KindgiClient,
  packDir: string,
  pattern: string,
  pulls: readonly Pull[],
  branch: string,
  base: string,
): Promise<{ readonly wrote: PulledBlock[]; readonly title: string; readonly commit: string }> {
  await git(ctx, packDir, ['checkout', '-b', branch], `Couldn't make the branch ${branch}`);
  const wrote: PulledBlock[] = [];
  let title: string;
  try {
    await writeAll(client, packDir, pattern, pulls, wrote);
    title = titleOf(wrote);
    await git(
      ctx,
      packDir,
      ['commit', '--message', title, '--', ...filesOf(wrote)],
      `Couldn't commit the block files on ${branch}`,
    );
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    throw new Error(`${err.message} ${leftOn(branch, base, filesOf(wrote))}`);
  }
  const commit = (
    await git(ctx, packDir, ['rev-parse', 'HEAD'], "Couldn't read the commit")
  ).trim();
  return { wrote, title, commit };
}

/** The block files written, each with its template file when it keeps one. */
function filesOf(wrote: readonly PulledBlock[]): string[] {
  return wrote.flatMap((w) => (w.templateFile === undefined ? [w.file] : [w.file, w.templateFile]));
}

/** Where a failure after `checkout -b` leaves the pack, and the way back. */
function leftOn(branch: string, base: string, written: readonly string[]): string {
  const back = `\`git switch ${base}\` goes back, then \`git branch -d ${branch}\` deletes the branch.`;
  if (written.length === 0) {
    return `You're on the new branch ${branch}, made from ${base}, with nothing written or committed: ${back}`;
  }
  const one = written.length === 1;
  return `You're on the new branch ${branch}, made from ${base}, where ${written.join(', ')} ${one ? 'is' : 'are'} written but not committed: \`git restore -- ${written.join(' ')}\` undoes ${one ? 'it' : 'them'}, ${back}`;
}

/** The branch pushed to the remote; what the push printed, where a remote may say how to open a pull request. */
async function pushBranch(
  ctx: CommandContext,
  packDir: string,
  remote: string,
  branch: string,
): Promise<string> {
  const pushed = await runTool(ctx, 'git', ['push', '--set-upstream', remote, branch], packDir);
  if (pushed === 'missing') throw new Error(NO_GIT);
  if (pushed.code !== 0) {
    throw new Error(
      `Couldn't push ${branch} to ${remote}: ${saidLine(pushed.stderr) ?? `git exited with ${pushed.code}`}. The commit is on ${branch}: push it yourself (\`git push --set-upstream ${remote} ${branch}\`), then open the pull request.`,
    );
  }
  return pushed.stderr;
}

/** The URL `gh pr create` printed: its last line that is one. */
function openedUrlOf(opened: Ran | 'missing'): string | undefined {
  if (opened === 'missing' || opened.code !== 0) return undefined;
  return opened.stdout
    .split('\n')
    .map((l) => l.trim())
    .reverse()
    .find((l) => /^https?:\/\/\S+$/.test(l));
}

/** What was done, as the JSON says it. */
interface Done {
  readonly suggestedChangeId: string;
  readonly wrote: readonly PulledBlock[];
  readonly branch: string;
  readonly base: string;
  readonly commit: string;
  readonly remote: string;
}

/**
 * No pull request: where to open one, and the lines that then mark what it
 * fixes. An error only when gh failed; without gh, the push was the job.
 */
async function notOpened(
  ctx: CommandContext,
  client: KindgiClient,
  packDir: string,
  suggested: SuggestedChange,
  done: Done,
  pushed: string,
  opened: Ran | 'missing',
): Promise<Pulled> {
  const { branch, base, remote } = done;
  const remoteUrl = (
    await git(ctx, packDir, ['remote', 'get-url', remote], "Couldn't read the remote's URL")
  ).trim();
  const openAt = openUrlOf(pushed, remoteUrl, base, branch);
  const where =
    openAt === undefined
      ? `open a pull request from ${branch} into ${base} on ${remote}`
      : `open the pull request at ${openAt}`;
  const why =
    opened === 'missing'
      ? "gh isn't installed, so no pull request was opened"
      : `gh couldn't open the pull request (${opened.code === 0 ? 'it printed no URL' : (saidLine(opened.stderr) ?? `gh exited with ${opened.code}`)})`;
  const open = await stillOpen(client.corrections, suggested.fixes);
  const rendered = renderJson(
    {
      ...done,
      pullRequest: { opened: false, ...(openAt !== undefined && { openAt }) },
      stillOpen: open,
    },
    ctx.globals.format,
  );
  const mark = open.map(
    (c) => `  kindgi corrections set ${c} --status=being-fixed --link=<the pull request's URL>\n`,
  );
  return {
    ...rendered,
    stderr: `${why}. ${branch} is pushed: ${where}.\n${mark.length === 0 ? '' : `Then mark what it fixes:\n${mark.join('')}`}${backLine(done)}`,
    ...(opened !== 'missing' && { exitCode: 1 }),
  };
}

/** The pull request is made: a correction the runtime didn't mark is said, not an error. */
async function opened(
  ctx: CommandContext,
  client: KindgiClient,
  suggested: SuggestedChange,
  done: Done,
  url: string,
): Promise<Pulled> {
  const corrections = await markBeingFixed(client.corrections, suggested.fixes, url);
  const rendered = renderJson(
    { ...done, pullRequest: { opened: true, url }, corrections },
    ctx.globals.format,
  );
  const left = corrections.failed.map(
    (f) =>
      `${f.correctionId} isn't marked being-fixed (${f.error}). Run this once it can be:\n  kindgi corrections set ${f.correctionId} --status=being-fixed --link=${url}\n`,
  );
  return { ...rendered, stderr: `${left.join('')}${backLine(done)}` };
}

/** It stays on the new branch, and says how to go back. */
function backLine(done: Done): string {
  return `You're on ${done.branch}: \`git switch ${done.base}\` goes back.\n`;
}

async function pullSuggestedChange(ctx: CommandContext): Promise<Pulled> {
  const id = requiredPositional(ctx, 0, 'suggested-change-id');
  const packDir = packDirOf(ctx);
  const client = ctx.client();
  const { suggested, pattern, pulls } = await pullsFor(ctx, client, id, packDir);
  if (ctx.options.pr !== true) {
    const wrote = await writeAll(client, packDir, pattern, pulls);
    return renderJson({ suggestedChangeId: id, wrote }, ctx.globals.format);
  }

  const first = pulls[0] as Pull;
  const branch = `kindgi/${first.blockId}-${first.to}`;
  const repo = await repoFor(
    ctx,
    packDir,
    branch,
    pulls.flatMap((p) => p.files),
  );
  const { wrote, title, commit } = await commitOnBranch(
    ctx,
    client,
    packDir,
    pattern,
    pulls,
    branch,
    repo.base,
  );
  const pushed = await pushBranch(ctx, packDir, repo.remote, branch);
  const done: Done = {
    suggestedChangeId: id,
    wrote,
    branch,
    base: repo.base,
    commit,
    remote: repo.remote,
  };
  const body = bodyOf(suggested, wrote, consoleLinkOf(ctx.apiUrl(), suggested), repo.userName);
  const ran = await runTool(
    ctx,
    'gh',
    ['pr', 'create', '--base', repo.base, '--head', branch, '--title', title, '--body', body],
    packDir,
  );
  const url = openedUrlOf(ran);
  return url === undefined
    ? notOpened(ctx, client, packDir, suggested, done, pushed, ran)
    : opened(ctx, client, suggested, done, url);
}

export const pull: LeafCommand = {
  kind: 'leaf',
  name: 'pull',
  description:
    "Write a suggested change's block version into the pack's block file, as `kindgi blocks pull` writes what runs: when it's newer than the file's, and the file holds no version newer than the one the change is built on. Allowed when `ready`, `waiting-for-second-person`, `pinned` or `added-as-latest`. With --pr, in the pack's git repository: a new branch `kindgi/<block>-<version>` from the one checked out, a commit of the block files alone, a push, and a pull request opened with `gh` (without gh, where to open one: its URL, when the remote gives one). The corrections it fixes that are still `open` are then `being-fixed`, linked to the pull request (needs `publish` on the agent, or `write` in the correction's project for an agent that several projects serve). The pull request says only fixed words and numbers: never the suggested change's why, nor a correction's words.",
  usage:
    'kindgi suggested-changes pull <suggested-change-id> [--pr] [--project=<id|slug>] [--path=<dir>]',
  optionSpec: {
    pr: {
      type: 'boolean',
      description:
        "Also make a branch, commit, push, and open a pull request; then mark the corrections it fixes `being-fixed`, linked to it. Refused when the pack isn't in git, or its block files have changes that aren't committed.",
    },
    project: {
      type: 'string',
      description: 'Refuse unless the suggested change is for this project (an id or slug).',
    },
    path: { type: 'string', description: 'The pack directory. Default: the current one.' },
  },
  run: (ctx) => runSdkRendered(ctx, 'suggested-changes pull', () => pullSuggestedChange(ctx)),
};
