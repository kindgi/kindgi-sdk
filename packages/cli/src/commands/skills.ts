// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi skills sync` — refresh a scaffolded pack's skills from the SDK
 * skills bundled into the CLI, in each of `SKILL_FOLDERS`: `.claude/skills/`
 * and `.agents/skills/` hold the same copies, one per coding agent's way
 * of finding them.
 *
 * Update semantics with version + hash tracking, for each folder's copy:
 *
 *  - **Added** — bundled skill not present locally. Copy in.
 *  - **Updated** — bundled skill differs from what was last installed
 *    (higher `library_version` OR different content hash). Copy in,
 *    only if the user hasn't locally modified their copy.
 *  - **Unchanged** — bundled skill matches the last installed
 *    version + hash. No write.
 *  - **Skipped (modified)** — local copy has been edited since last
 *    install; the user's edits would be lost. Skipped by default;
 *    `--force` overwrites.
 *  - **Local-only** — a skill in the folder that the bundle doesn't
 *    ship. User-authored (or removed from a newer bundle). Left
 *    untouched.
 *
 * Sync state lives in `.claude/skills/.kindgi-manifest.json`, for both
 * folders — records what version + hash of each skill was installed.
 * Commit this file to git so teammates see the same installed state.
 *
 * A pack gets the skills written for its language: each skill lists
 * them in its frontmatter (`pack_languages: [node, python, java, scala]`); a
 * skill without the field teaches the TypeScript surface (`[node]`).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { type KindgiConfig, type PackLanguage, packLanguage } from '@kindgi/handler-runtime';

import { FORMATTER_IGNORE_PATTERNS, patchPrettierignore } from '../init/gitignore-patcher.js';
import { type OutputFormat, renderJson } from '../output.js';
import { loadPackConfig } from '../pack-config.js';
import { commandResultFromThrown, stringFlag } from './helpers.js';
import { defaultSdkSkillsRoot } from './init.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

interface ManifestEntry {
  /** Per-skill content version (author-maintained). Sync uses this + hash. */
  readonly installedVersion: string;
  /** SDK release version this skill was shipped with. Informational. */
  readonly installedSdkVersion: string;
  readonly installedHash: string;
}

/**
 * The folders a pack's skills are copied into, from its root. Claude Code
 * reads `.claude/skills/`; Codex and Gemini CLI read `.agents/skills/`
 * (Cursor and VS Code's Copilot read either).
 */
export const SKILL_FOLDERS = ['.claude/skills', '.agents/skills'] as const;
export type SkillFolder = (typeof SKILL_FOLDERS)[number];

interface Manifest {
  readonly v: 2;
  /** `.claude/skills/`'s copies. */
  readonly skills: Readonly<Record<string, ManifestEntry>>;
  /**
   * `.agents/skills/`'s copies. Optional, so a CLI from before that folder
   * still reads the manifest (and drops the field when it writes); a copy
   * with no entry here is judged by its `skills` entry, which the same sync
   * wrote. Not always: after an older CLI's sync, which moves only
   * `.claude/skills/` on, an `.agents/skills/` copy left behind reads as
   * edited and is kept until `--force`. Nothing is overwritten; it's only
   * reported as an edit.
   */
  readonly agentsSkills?: Readonly<Record<string, ManifestEntry>>;
}

const MANIFEST_VERSION = 2 as const;
const MANIFEST_PATH = join(SKILL_FOLDERS[0], '.kindgi-manifest.json');

/** What `folder`'s copies were installed as. */
function installedIn(
  manifest: Manifest,
  folder: SkillFolder,
): Readonly<Record<string, ManifestEntry>> {
  return folder === '.claude/skills'
    ? manifest.skills
    : { ...manifest.skills, ...manifest.agentsSkills };
}

/**
 * Per-skill sync outcome — reported back to the user + stored on the
 * command result so JSON-mode callers get a machine-readable summary.
 */
export interface SkillSyncOutcome {
  readonly name: string;
  /** The folder this copy is in: each folder's copy has its own outcome. */
  readonly folder: SkillFolder;
  readonly status: 'added' | 'updated' | 'unchanged' | 'skipped-modified' | 'local-only';
  readonly fromVersion?: string;
  readonly toVersion?: string;
  /** SDK release version the bundled skill was shipped with (informational). */
  readonly sdkVersion?: string;
  readonly reason?: string;
}

export interface SkillSyncReport {
  readonly targetDir: string;
  /** The pack's language — only skills written for it are synced. */
  readonly packLanguage: PackLanguage;
  readonly outcomes: readonly SkillSyncOutcome[];
  readonly dryRun: boolean;
  readonly force: boolean;
  /** What `kindgi skills sync` did to the pack's `.prettierignore`, when it changed it or couldn't. */
  readonly prettierignore?: FormatterIgnoreOutcome;
}

/**
 * The skills' folders added to a `.prettierignore` the pack already has, so
 * the formatter never rewrites a copy (the next sync would keep it as
 * edited). An app that got Kindgi before `.agents/skills/` existed has only
 * the `.claude/skills/` line. No file is created, and `--dry-run` reads none.
 */
export type FormatterIgnoreOutcome =
  | { readonly path: string; readonly status: 'patched'; readonly appended: readonly string[] }
  | { readonly path: string; readonly status: 'error'; readonly message: string };

const sync: LeafCommand = {
  kind: 'leaf',
  name: 'sync',
  description: 'Refresh .claude/skills/ and .agents/skills/ from the CLI-bundled SDK skills.',
  usage: 'kindgi skills sync [--path=<dir>] [--force] [--dry-run]',
  optionSpec: {
    path: {
      type: 'string',
      description:
        'The pack root, whose `.claude/skills/` and `.agents/skills/` are refreshed. Default: the current directory.',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite skills you edited locally. By default they are kept.',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report what would change without writing anything.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    try {
      const pathArg = stringFlag(ctx, 'path');
      const targetDir = resolveTargetDir(ctx.cwd, pathArg);
      const skillsRoot = defaultSdkSkillsRoot();
      if (skillsRoot === undefined) {
        return {
          kind: 'error',
          stderr:
            'kindgi skills sync: could not locate bundled SDK skills. This is either a ' +
            'broken CLI install (missing dist/sdk-skills/) or the CLI was built without ' +
            'the copy-build-assets step.\n',
          exitCode: 1,
        };
      }
      const config = await loadPackConfig(ctx, targetDir);
      if (config.kind === 'invalid') {
        return { kind: 'error', stderr: `kindgi skills sync: ${config.message}\n`, exitCode: 1 };
      }
      const language = config.kind === 'ok' ? packLanguage(config.config as KindgiConfig) : 'node';
      const force = ctx.options.force === true;
      const dryRun = ctx.options['dry-run'] === true;
      const synced = await syncSkills({ skillsRoot, targetDir, language, force, dryRun });
      const prettierignore = dryRun ? undefined : await patchFormatterIgnore(targetDir, synced);
      const report = prettierignore === undefined ? synced : { ...synced, prettierignore };
      const json = renderJson(report, ctx.globals.format);
      return {
        kind: 'ok',
        rendered: {
          stdout: json.stdout,
          stderr: shouldRenderSummaryOnStderr(ctx) ? renderSummary(report) : json.stderr,
        },
      };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'skills sync');
    }
  },
};

export const skillsCommand: Command = {
  kind: 'group',
  name: 'skills',
  description: "Manage the pack's skills, in `.claude/skills/` and `.agents/skills/`.",
  subcommands: [sync],
};

// -----------------------------------------------------------------------
// Sync engine
// -----------------------------------------------------------------------

export async function syncSkills(inputs: {
  readonly skillsRoot: string;
  readonly targetDir: string;
  readonly language: PackLanguage;
  readonly force: boolean;
  readonly dryRun: boolean;
}): Promise<SkillSyncReport> {
  const { skillsRoot, targetDir, language, force, dryRun } = inputs;

  const manifestPath = join(targetDir, MANIFEST_PATH);
  const manifest = await readManifest(manifestPath);
  const bundled = await readBundledSkills(skillsRoot, language);
  const bundledSet = new Set(bundled.map((skill) => skill.name));

  const outcomes: SkillSyncOutcome[] = [];
  const next: Record<SkillFolder, Record<string, ManifestEntry>> = {
    '.claude/skills': { ...manifest.skills },
    '.agents/skills': { ...manifest.agentsSkills },
  };

  for (const folder of SKILL_FOLDERS) {
    const skillsDir = join(targetDir, folder);
    const installed = installedIn(manifest, folder);
    for (const skill of bundled) {
      const synced = await syncCopy({
        skill,
        folder,
        path: join(skillsDir, skill.name, 'SKILL.md'),
        prior: installed[skill.name],
        force,
        dryRun,
      });
      outcomes.push(synced.outcome);
      if (synced.installed !== undefined) next[folder][skill.name] = synced.installed;
    }
    for (const name of await listSkillDirs(skillsDir)) {
      if (!bundledSet.has(name)) outcomes.push({ name, folder, status: 'local-only' });
    }
  }

  if (!dryRun) {
    await writeManifest(manifestPath, {
      v: MANIFEST_VERSION,
      skills: next['.claude/skills'],
      agentsSkills: next['.agents/skills'],
    });
  }

  return {
    targetDir: relative(process.cwd(), targetDir) || '.',
    packLanguage: language,
    outcomes,
    dryRun,
    force,
  };
}

/** A bundled skill's SKILL.md, with what the manifest records of it. */
interface BundledSkill {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly entry: ManifestEntry;
}

async function readBundledSkills(
  root: string,
  language: PackLanguage,
): Promise<readonly BundledSkill[]> {
  const skills: BundledSkill[] = [];
  for (const name of await listBundledSkills(root, language)) {
    const bytes = await readFile(join(root, name, 'SKILL.md'));
    const text = bytes.toString('utf8');
    skills.push({
      name,
      bytes,
      entry: {
        installedVersion: parseFrontmatterField(text, 'version'),
        installedSdkVersion: parseFrontmatterField(text, 'sdk_version'),
        installedHash: hashBytes(bytes),
      },
    });
  }
  return skills;
}

/**
 * Brings one folder's copy of `skill` up to the bundle, unless it was
 * edited since `prior` (what was last installed there) and `force` is
 * off. `installed` is what the copy is now, for the manifest; `undefined`
 * keeps the entry it had.
 */
async function syncCopy(inputs: {
  readonly skill: BundledSkill;
  readonly folder: SkillFolder;
  readonly path: string;
  readonly prior: ManifestEntry | undefined;
  readonly force: boolean;
  readonly dryRun: boolean;
}): Promise<{ readonly outcome: SkillSyncOutcome; readonly installed?: ManifestEntry }> {
  const { skill, folder, path, prior, force, dryRun } = inputs;
  const which = { name: skill.name, folder };
  const to = {
    toVersion: skill.entry.installedVersion,
    sdkVersion: skill.entry.installedSdkVersion,
  };

  if (!(await pathExists(path))) {
    if (!dryRun) await writeSkill(path, skill.bytes);
    return { outcome: { ...which, status: 'added', ...to }, installed: skill.entry };
  }

  const localHash = hashBytes(await readFile(path));
  // Content already matches bundle — nothing to do.
  if (localHash === skill.entry.installedHash) {
    return { outcome: { ...which, status: 'unchanged', ...to }, installed: skill.entry };
  }

  // Local differs from bundle. Determine if the user modified the
  // local copy or if the bundle simply advanced.
  const userModified = prior === undefined || prior.installedHash !== localHash;
  const from = prior !== undefined && { fromVersion: prior.installedVersion };

  if (userModified && !force) {
    return {
      outcome: {
        ...which,
        status: 'skipped-modified',
        ...from,
        ...to,
        reason: 'Local edits detected; --force to overwrite.',
      },
    };
  }

  if (!dryRun) await writeSkill(path, skill.bytes);
  return {
    outcome: {
      ...which,
      status: 'updated',
      ...to,
      ...from,
      ...(force && userModified && { reason: 'Overwrote local edits (--force)' }),
    },
    installed: skill.entry,
  };
}

/**
 * Adds the skills' folders to the pack's `.prettierignore`, when it has one
 * (`FormatterIgnoreOutcome`). `undefined` when there's none, or every line
 * is there already.
 */
async function patchFormatterIgnore(
  targetDir: string,
  report: SkillSyncReport,
): Promise<FormatterIgnoreOutcome | undefined> {
  const path = join(report.targetDir, '.prettierignore');
  const patched = await patchPrettierignore(join(targetDir, '.prettierignore'));
  if (patched.kind === 'patched') return { path, status: 'patched', appended: patched.appended };
  if (patched.kind === 'error') {
    return { path, status: 'error', message: patched.message ?? `couldn't patch ${path}` };
  }
  return undefined;
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function resolveTargetDir(cwd: string, pathArg: string | undefined): string {
  if (pathArg === undefined) return cwd;
  return resolve(cwd, pathArg);
}

async function readManifest(path: string): Promise<Manifest> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return { v: MANIFEST_VERSION, skills: {} };
    }
    const parsedRec = parsed as { v?: unknown; skills?: unknown; agentsSkills?: unknown };
    // Accept both v:1 (legacy, no installedSdkVersion) and v:2. On
    // next write the manifest gets rewritten as v:2 with sdk_version
    // populated from bundle. Any other version → treat as empty.
    if (parsedRec.v !== 1 && parsedRec.v !== 2) {
      return { v: MANIFEST_VERSION, skills: {} };
    }
    const skillsField = parsedRec.skills;
    if (typeof skillsField !== 'object' || skillsField === null) {
      return { v: MANIFEST_VERSION, skills: {} };
    }
    return {
      v: MANIFEST_VERSION,
      skills: readEntries(skillsField),
      agentsSkills: readEntries(parsedRec.agentsSkills),
    };
  } catch {
    return { v: MANIFEST_VERSION, skills: {} };
  }
}

/** A manifest field's well-formed entries; anything else counts as none. */
function readEntries(field: unknown): Record<string, ManifestEntry> {
  const out: Record<string, ManifestEntry> = {};
  if (typeof field !== 'object' || field === null) return out;
  for (const [k, v] of Object.entries(field as Record<string, unknown>)) {
    if (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as { installedVersion?: unknown }).installedVersion === 'string' &&
      typeof (v as { installedHash?: unknown }).installedHash === 'string'
    ) {
      const sdkVer = (v as { installedSdkVersion?: unknown }).installedSdkVersion;
      out[k] = {
        installedVersion: (v as { installedVersion: string }).installedVersion,
        installedSdkVersion: typeof sdkVer === 'string' ? sdkVer : 'unknown',
        installedHash: (v as { installedHash: string }).installedHash,
      };
    }
  }
  return out;
}

async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function listSkillDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const names: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      const skillMd = join(root, e.name, 'SKILL.md');
      if (await pathExists(skillMd)) names.push(e.name);
    }
    names.sort();
    return names;
  } catch {
    return [];
  }
}

/** Every pack language, by name: a new one fails to compile here until skills can name it. */
const PACK_LANGUAGES: Readonly<Record<PackLanguage, true>> = {
  node: true,
  python: true,
  java: true,
  scala: true,
};

/** The bundled skills written for packs in `language` (`pack_languages`). */
async function listBundledSkills(root: string, language: PackLanguage): Promise<string[]> {
  const names: string[] = [];
  for (const name of await listSkillDirs(root)) {
    const text = await readFile(join(root, name, 'SKILL.md'), 'utf8');
    if (skillPackLanguages(text).includes(language)) names.push(name);
  }
  return names;
}

/**
 * The pack languages a SKILL.md is written for — its frontmatter's
 * `pack_languages: [node, python, java, scala]`. A skill without the field predates
 * it and teaches the TypeScript surface: `['node']`.
 */
export function skillPackLanguages(text: string): readonly PackLanguage[] {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  const list = frontmatter?.match(/^pack_languages:\s*\[([^\]\n]*)\]\s*$/m)?.[1];
  if (list === undefined) return ['node'];
  return list
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter((item): item is PackLanguage => Object.hasOwn(PACK_LANGUAGES, item));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
}

/**
 * Extract a named field from a SKILL.md's YAML frontmatter. Returns
 * `"unknown"` when the frontmatter is missing, malformed, or lacks
 * the requested field — sync still works, just without that stamp.
 * Used for both `version` (per-skill content) and `sdk_version` (the
 * SDK release the skill was shipped with).
 */
function parseFrontmatterField(text: string, field: string): string {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (match === null) return 'unknown';
  const frontmatter = match[1];
  if (frontmatter === undefined) return 'unknown';
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm');
  const versionMatch = frontmatter.match(re);
  return versionMatch !== null && versionMatch[1] !== undefined ? versionMatch[1] : 'unknown';
}

async function writeSkill(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

/** The summary is for people: shown unless the caller asked for JSON, or for quiet. */
function shouldRenderSummaryOnStderr(ctx: {
  readonly globals: { readonly format: OutputFormat; readonly formatRequested: boolean };
}): boolean {
  const { format, formatRequested } = ctx.globals;
  return !(formatRequested && (format === 'json' || format === 'quiet'));
}

export interface SkillDriftReport {
  /** Skills present in the SDK bundle with no copy yet in a folder. */
  readonly missing: readonly { readonly name: string; readonly folder: SkillFolder }[];
  /** Copies whose installed version differs from the bundled version. */
  readonly outdated: readonly {
    readonly name: string;
    readonly folder: SkillFolder;
    readonly from: string;
    readonly to: string;
  }[];
}

/**
 * Cheap drift check for `kindgi dev` boot. Compares the pack's
 * installed skills, in each of `SKILL_FOLDERS` (via
 * `.claude/skills/.kindgi-manifest.json`), against the SDK-bundled
 * skill versions from the CLI's shipped skills root.
 *
 * Read-only: never writes to disk, never mutates the manifest. If
 * anything fails (missing manifest, unreadable bundle) it returns
 * empty arrays — boot proceeds without a warning rather than
 * blocking on a check that can't run.
 */
export async function detectSkillDrift(inputs: {
  readonly skillsRoot: string;
  readonly targetDir: string;
  readonly language: PackLanguage;
}): Promise<SkillDriftReport> {
  const manifest = await readManifest(join(inputs.targetDir, MANIFEST_PATH));
  const bundledNames = await listBundledSkills(inputs.skillsRoot, inputs.language);

  const missing: { name: string; folder: SkillFolder }[] = [];
  const outdated: { name: string; folder: SkillFolder; from: string; to: string }[] = [];

  for (const name of bundledNames) {
    let bundledText: string;
    try {
      bundledText = (await readFile(join(inputs.skillsRoot, name, 'SKILL.md'))).toString('utf8');
    } catch {
      continue;
    }
    const bundledVersion = parseFrontmatterField(bundledText, 'version');
    for (const folder of SKILL_FOLDERS) {
      const local = join(inputs.targetDir, folder, name, 'SKILL.md');
      // A copy that's gone is behind, whatever the manifest says.
      if (!(await pathExists(local))) {
        missing.push({ name, folder });
        continue;
      }
      const installed = installedIn(manifest, folder)[name];
      if (installed === undefined) {
        outdated.push({ name, folder, from: 'untracked', to: bundledVersion });
      } else if (installed.installedVersion !== bundledVersion) {
        outdated.push({ name, folder, from: installed.installedVersion, to: bundledVersion });
      }
    }
  }

  return { missing, outdated };
}

/**
 * The drift in words for `kindgi dev` ("2 out of date, 1 not yet
 * installed"), by skill: one behind in both folders counts once.
 * `undefined` when nothing is behind.
 */
export function describeSkillDrift(drift: SkillDriftReport): string | undefined {
  const outdated = new Set(drift.outdated.map((d) => d.name)).size;
  const missing = new Set(drift.missing.map((d) => d.name)).size;
  const parts: string[] = [];
  if (outdated > 0) parts.push(`${outdated} out of date`);
  if (missing > 0) parts.push(`${missing} not yet installed`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

const STATUS_SYMBOLS: Readonly<Record<SkillSyncOutcome['status'], string>> = {
  added: '+',
  updated: '↑',
  unchanged: '=',
  'skipped-modified': '!',
  'local-only': '·',
};

/** One outcome's line: its symbol, name, version (or the move between two) and reason. */
function renderOutcome(o: SkillSyncOutcome): string {
  const version =
    o.fromVersion !== undefined && o.toVersion !== undefined && o.fromVersion !== o.toVersion
      ? ` @${o.fromVersion}→${o.toVersion}`
      : o.toVersion !== undefined
        ? ` @${o.toVersion}`
        : '';
  const reason = o.reason !== undefined ? ` — ${o.reason}` : '';
  return `  ${STATUS_SYMBOLS[o.status]} ${o.name}${version}${reason}`;
}

/** One folder's block: a line per outcome, then the folder's counts. */
function renderFolder(outcomes: readonly SkillSyncOutcome[], folder: SkillFolder): string[] {
  const counts: Record<SkillSyncOutcome['status'], number> = {
    added: 0,
    updated: 0,
    unchanged: 0,
    'skipped-modified': 0,
    'local-only': 0,
  };
  const lines = ['', `${folder}/`];
  for (const o of outcomes) {
    if (o.folder !== folder) continue;
    counts[o.status] += 1;
    lines.push(renderOutcome(o));
  }
  lines.push(
    `  ${counts.added} added, ${counts.updated} updated, ${counts.unchanged} unchanged, ` +
      `${counts['skipped-modified']} skipped-modified, ${counts['local-only']} local-only`,
  );
  return lines;
}

/** What sync did to the pack's `.prettierignore`, as lines; none when it left the file alone. */
function renderFormatterIgnore(outcome: FormatterIgnoreOutcome | undefined): string[] {
  if (outcome === undefined) return [];
  if (outcome.status === 'patched') {
    return [
      '',
      `Added ${outcome.appended.join(' and ')} to ${outcome.path}, so the formatter leaves the skills as they are.`,
    ];
  }
  return [
    '',
    `Couldn't add the skills' folders to ${outcome.path}: ${outcome.message}`,
    `  Add ${FORMATTER_IGNORE_PATTERNS.join(' and ')} to it yourself: a skill the formatter rewrites, the next sync keeps as edited.`,
  ];
}

function renderSummary(report: SkillSyncReport): string {
  const lines: string[] = [
    `Synced ${SKILL_FOLDERS.map((f) => `${report.targetDir}/${f}/`).join(' and ')}${report.dryRun ? ' (dry-run)' : ''}`,
    ...SKILL_FOLDERS.flatMap((folder) => renderFolder(report.outcomes, folder)),
    ...renderFormatterIgnore(report.prettierignore),
    '',
  ];
  const sdkVersions = new Set<string>();
  for (const o of report.outcomes) {
    if (o.sdkVersion !== undefined && o.sdkVersion !== 'unknown') sdkVersions.add(o.sdkVersion);
  }
  if (sdkVersions.size === 1) {
    lines.push(`SDK release: ${[...sdkVersions][0]}`);
  } else if (sdkVersions.size > 1) {
    lines.push(`SDK releases: ${[...sdkVersions].sort().join(', ')} (mixed)`);
  }
  lines.push('');
  return lines.join('\n');
}
