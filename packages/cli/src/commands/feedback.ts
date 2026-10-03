// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi feedback` — capture framework-level feedback (bugs, friction,
 * design observations) as one running `FEEDBACK.md` file at the pack
 * root.
 *
 * Design principle: keep it simple. One file, one running list, human-
 * readable at a glance. Individual entries carry inline metadata
 * (id, hash, kind, severity, sdk, cli, date, authored_by) — no YAML
 * frontmatter, no directory of separate files. Claude Code (or the
 * human) can edit `FEEDBACK.md` directly to mark items fixed or
 * remove them; the CLI's job is limited to appending consistently.
 *
 * ## Entry shape (appended by `kindgi feedback write`)
 *
 * ```md
 * ## <title>
 *
 * - **id:** YYYY-MM-DD.N
 * - **hash:** feedback-<8-hex>
 * - **kind:** bug | friction | question | design
 * - **severity:** blocker | high | medium | low
 * - **date:** <ISO 8601>
 * - **sdk:** <ver> · **cli:** <ver> · **by:** claude-code | human | mixed
 *
 * <body>
 *
 * ---
 * ```
 *
 * `id` is `<YYYY-MM-DD>.<N>` — the date the entry was written plus a
 * per-day counter. Pack-local, chronological, human-friendly.
 *
 * `hash` is `feedback-<8-hex>` — a deterministic function of
 * `<kind>:<normalized-title>` (lowercase, whitespace-collapsed,
 * punctuation-stripped). Two peers filing the same normalized
 * content produce the same hash, so p2p sync + framework-side
 * clustering work without a central authority.
 *
 * To mark fixed, add `> **Fixed:** <note>` right after the header;
 * to remove, delete the section including the trailing `---`.
 *
 * ## Invocation modes
 *
 *  - **Interactive** (default when no body given): opens `$EDITOR`
 *    with a template.
 *  - **`--body=@<file>`** or **`--body-stdin`**: non-interactive —
 *    right for AI-driven invocation (Claude Code piping a report).
 *  - Every mode requires `--title` + `--kind`.
 *
 * ## Not in scope for v1
 *
 *  - Hosted submission (`kindgi feedback submit`) — waits for
 *    Kindgi Hosted.
 *  - Cross-pack de-duplication — framework-side manual reconcile for
 *    now.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderJson } from '../output.js';
import { resolveSdkPackageRoot } from '../sdk-package.js';
import { commandResultFromThrown, stringFlag } from './helpers.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

export type FeedbackKind = 'bug' | 'friction' | 'question' | 'design';
export type FeedbackSeverity = 'blocker' | 'high' | 'medium' | 'low';

const KINDS: readonly FeedbackKind[] = ['bug', 'friction', 'question', 'design'];
const SEVERITIES: readonly FeedbackSeverity[] = ['blocker', 'high', 'medium', 'low'];

export interface FeedbackWriteReport {
  readonly path: string;
  readonly id: string;
  readonly hash: string;
  readonly title: string;
  readonly kind: FeedbackKind;
  readonly severity: FeedbackSeverity;
  readonly bodyBytes: number;
}

const submit: LeafCommand = {
  kind: 'leaf',
  name: 'submit',
  description: 'Submit feedback reports to Kindgi (not available yet).',
  usage: 'kindgi feedback submit',
  run: async (): Promise<CommandResult> => ({
    kind: 'error',
    stderr:
      'kindgi feedback submit is not yet wired.\n' +
      'Feedback entries currently live in FEEDBACK.md at the pack root — commit it to share with ' +
      'the framework maintainers, or send it to them directly.\n',
    exitCode: 1,
  }),
};

const write: LeafCommand = {
  kind: 'leaf',
  name: 'write',
  description:
    'Append a framework-friction entry to FEEDBACK.md at the pack root (Claude Code diagnostic → durable input for maintainers).',
  usage:
    'kindgi feedback write --kind=<bug|friction|question|design> --title=<short> ' +
    '[--severity=<blocker|high|medium|low>] [--body=@<file> | --body-stdin | --interactive] ' +
    '[--authored-by=<claude-code|human|mixed>] [--path=<pack-dir>]',
  optionSpec: {
    kind: {
      type: 'string',
      description: "The entry's kind: `bug`, `friction`, `question` or `design`. Required.",
    },
    severity: {
      type: 'string',
      description: "The entry's severity: `blocker`, `high`, `medium` (default) or `low`.",
    },
    title: { type: 'string', description: "A short title: the entry's heading. Required." },
    body: {
      type: 'string',
      description: "The entry's body: the text itself, or `@<file>` to read it from a file.",
    },
    'body-stdin': { type: 'boolean', description: "Read the entry's body from stdin." },
    interactive: {
      type: 'boolean',
      description:
        'Write the body in `$EDITOR`: the default when neither `--body` nor `--body-stdin` is given.',
    },
    'authored-by': {
      type: 'string',
      description: 'Who wrote the entry: `human` (default), `claude-code` or `mixed`.',
    },
    path: {
      type: 'string',
      description: 'The pack root, where `FEEDBACK.md` is. Default: the current directory.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    try {
      const kindArg = stringFlag(ctx, 'kind');
      if (kindArg === undefined)
        throw new Error('--kind=<bug|friction|question|design> is required');
      if (!(KINDS as readonly string[]).includes(kindArg)) {
        throw new Error(`--kind must be one of: ${KINDS.join(', ')} (got "${kindArg}")`);
      }
      const kind = kindArg as FeedbackKind;

      const title = stringFlag(ctx, 'title');
      if (title === undefined || title.trim() === '')
        throw new Error('--title=<short> is required');

      const severityArg = stringFlag(ctx, 'severity') ?? 'medium';
      if (!(SEVERITIES as readonly string[]).includes(severityArg)) {
        throw new Error(
          `--severity must be one of: ${SEVERITIES.join(', ')} (got "${severityArg}")`,
        );
      }
      const severity = severityArg as FeedbackSeverity;

      const authoredByArg = stringFlag(ctx, 'authored-by') ?? 'human';
      if (!['claude-code', 'human', 'mixed'].includes(authoredByArg)) {
        throw new Error(
          `--authored-by must be claude-code, human, or mixed (got "${authoredByArg}")`,
        );
      }
      const authoredBy = authoredByArg;

      const packDir = resolveTargetDir(ctx.cwd, stringFlag(ctx, 'path'));
      const bodySpec = stringFlag(ctx, 'body');
      const bodyStdin = ctx.options['body-stdin'] === true;
      const interactive = ctx.options.interactive === true;

      let body: string;
      if (bodySpec !== undefined) {
        body = await readBodyFromSpec(bodySpec);
      } else if (bodyStdin) {
        body = await readStdin();
      } else if (interactive || (bodySpec === undefined && !bodyStdin)) {
        body = await runInteractiveEditor(buildTemplateBody({ kind, severity, title, authoredBy }));
      } else {
        body = '';
      }

      const report = await writeFeedbackReport({
        packDir,
        kind,
        severity,
        title,
        authoredBy,
        body,
      });

      // Emit the confirmation line to stderr immediately so an
      // interactive user sees the write happened while the JSON goes
      // to stdout (respecting the CLI's format convention).
      process.stderr.write(
        `✓ appended entry ${report.id} to ${report.path}\n  To mark items fixed, add \`> **Fixed:** <note>\` right after their header.\n  Commit FEEDBACK.md to share with the framework maintainers.\n`,
      );
      return {
        kind: 'ok',
        rendered: renderJson(report, ctx.globals.format),
      };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'feedback write');
    }
  },
};

export const feedbackCommand: Command = {
  kind: 'group',
  name: 'feedback',
  description:
    'Report framework friction Claude Code diagnosed — bugs, wire schema gaps, misleading errors, UX cliffs.',
  subcommands: [write, submit],
};

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function resolveTargetDir(cwd: string, pathArg: string | undefined): string {
  if (pathArg === undefined) return cwd;
  return isAbsolute(pathArg) ? pathArg : resolve(cwd, pathArg);
}

/**
 * `--body` accepts two forms: `@<path>` reads the file at path;
 * anything else is treated as literal content (convenient for
 * AI-driven callers piping a short body inline).
 */
async function readBodyFromSpec(spec: string): Promise<string> {
  if (spec.startsWith('@')) {
    return await readFile(spec.slice(1), 'utf8');
  }
  return spec;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function runInteractiveEditor(seed: string): Promise<string> {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
  const tmpPath = join(
    tmpdir(),
    `kindgi-feedback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`,
  );
  await writeFile(tmpPath, seed, 'utf8');
  await new Promise<void>((resolve_, reject) => {
    const child = spawn(editor, [tmpPath], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve_();
      else reject(new Error(`Editor exited with code ${code}`));
    });
    child.on('error', reject);
  });
  return await readFile(tmpPath, 'utf8');
}

interface FeedbackWriteInput {
  readonly packDir: string;
  readonly kind: FeedbackKind;
  readonly severity: FeedbackSeverity;
  readonly title: string;
  readonly authoredBy: string;
  readonly body: string;
}

const FEEDBACK_FILENAME = 'FEEDBACK.md';
const FEEDBACK_HEADER =
  '# Kindgi framework feedback\n\n' +
  'Running list of bugs, friction, questions, and design observations ' +
  'hit while building this pack against Kindgi/`@kindgi/sdk`. Each ' +
  'entry carries two identifiers: `id: YYYY-MM-DD.N` (pack-local, ' +
  'chronological) and `hash: feedback-<hex>` (deterministic function ' +
  'of the normalized title — same hash across packs = same issue). ' +
  'Append new entries with `kindgi feedback write`. Mark items fixed ' +
  'with a `> **Fixed:** <note>` line right after the header; remove ' +
  'items by deleting the whole section (including the trailing ' +
  '`---`).\n\n' +
  '---\n\n';

/**
 * Append a new entry to `FEEDBACK.md` at the pack root. Creates the
 * file with a header block if it doesn't yet exist.
 *
 * Each entry is stamped with `id: YYYY-MM-DD.N` where N is a per-day
 * counter scoped to the pack. Cross-pack framework operations
 * reference entries by this id; the framework side reconciles
 * semantically-identical reports manually.
 */
export async function writeFeedbackReport(input: FeedbackWriteInput): Promise<FeedbackWriteReport> {
  const path = join(input.packDir, FEEDBACK_FILENAME);
  const versions = readOwnVersions();
  const now = new Date();
  const iso = now.toISOString();
  const dateOnly = iso.slice(0, 10);

  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    // File doesn't exist yet — will create with header below.
  }
  const withHeader = existing === '' ? FEEDBACK_HEADER : existing;
  const nextN = nextDayCounter(withHeader, dateOnly);
  const id = `${dateOnly}.${nextN}`;
  const hash = computeFeedbackHash(input.kind, input.title);

  const entry = renderEntry({
    id,
    hash,
    kind: input.kind,
    severity: input.severity,
    title: input.title,
    authoredBy: input.authoredBy,
    createdAt: iso,
    sdk: versions.sdk,
    cli: versions.cli,
    body: input.body,
  });
  const separator = withHeader.endsWith('\n\n') ? '' : withHeader.endsWith('\n') ? '\n' : '\n\n';
  const nextContent = `${withHeader}${separator}${entry}`;
  await writeFile(path, nextContent, 'utf8');

  return {
    path,
    id,
    hash,
    title: input.title,
    kind: input.kind,
    severity: input.severity,
    bodyBytes: Buffer.byteLength(entry, 'utf8'),
  };
}

/**
 * Distributed identity for a feedback entry. Deterministic hash of
 * `<kind>:<normalized-title>` — same normalized content on peer A
 * and peer B produces the same hash, so p2p sync tools can cluster
 * without a central authority. Kept separate from `id` (which is
 * pack-local + chronological) because the two serve different
 * concerns.
 *
 * Normalization: lowercase, collapse whitespace, strip
 * non-alphanumeric characters (so trivial punctuation/casing
 * variations still cluster).
 */
function computeFeedbackHash(kind: FeedbackKind, title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const digest = createHash('sha256').update(`${kind}:${normalized}`).digest('hex').slice(0, 8);
  return `feedback-${digest}`;
}

/**
 * Find the highest per-day counter used on `dateOnly` in the given
 * file content and return N+1. Days with no prior entries start at 1.
 * Handles gaps (a manually-removed entry doesn't lower the counter).
 */
function nextDayCounter(content: string, dateOnly: string): number {
  let max = 0;
  // Match id lines: `- **id:** 2026-09-25.3`. Tolerates hand-edited
  // variants without the bullet-list prefix.
  const escapedDate = dateOnly.replace(/[.]/g, '\\.');
  const re = new RegExp(`\\*\\*id:\\*\\*\\s+${escapedDate}\\.(\\d+)`, 'g');
  let m: RegExpExecArray | null = re.exec(content);
  while (m !== null) {
    const n = Number.parseInt(m[1] as string, 10);
    if (Number.isFinite(n) && n > max) max = n;
    m = re.exec(content);
  }
  return max + 1;
}

function renderEntry(meta: {
  readonly id: string;
  readonly hash: string;
  readonly kind: FeedbackKind;
  readonly severity: FeedbackSeverity;
  readonly title: string;
  readonly authoredBy: string;
  readonly createdAt: string;
  readonly sdk: string;
  readonly cli: string;
  readonly body: string;
}): string {
  const body = meta.body.trim() === '' ? buildDefaultSections() : meta.body.trim();
  return `## ${meta.title}\n\n- **id:** ${meta.id}\n- **hash:** ${meta.hash}\n- **kind:** ${meta.kind}\n- **severity:** ${meta.severity}\n- **date:** ${meta.createdAt}\n- **sdk:** ${meta.sdk} · **cli:** ${meta.cli} · **by:** ${meta.authoredBy}\n\n${body}\n\n---\n`;
}

function buildTemplateBody(meta: {
  readonly kind: FeedbackKind;
  readonly severity: FeedbackSeverity;
  readonly title: string;
  readonly authoredBy: string;
}): string {
  void meta;
  return buildDefaultSections();
}

function buildDefaultSections(): string {
  return (
    '### Summary\n' +
    '<!-- one line — what is this report about? -->\n\n' +
    '### Observed\n' +
    '<!-- what happened, with file:line pointers when possible -->\n\n' +
    '### Expected\n' +
    '<!-- what should have happened -->\n\n' +
    '### Reproducer\n' +
    '<!-- commands, spec files, exact output -->\n\n' +
    '### Suggested fix\n' +
    "<!-- optional; leave blank if you don't have one -->"
  );
}

/**
 * Read the CLI's own `package.json` (for `cli_version`) — one level up
 * from `dist/commands/` (built) or `src/commands/` (source) — and the
 * SDK's `package.json` (for `sdk_version`), resolved by package name.
 * Returns `'unknown'` when either can't be resolved.
 */
function readOwnVersions(): { readonly sdk: string; readonly cli: string } {
  const cli = readPkgVersion(fileURLToPath(new URL('../../package.json', import.meta.url)));
  const sdkRoot = resolveSdkPackageRoot();
  const sdk = sdkRoot === undefined ? 'unknown' : readPkgVersion(join(sdkRoot, 'package.json'));
  return { sdk, cli };
}

function readPkgVersion(path: string): string {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
