// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi skills sync` — refresh a scaffolded pack's skills from the SDK
 * skills bundled into the CLI, in each of `SKILL_FOLDERS`: `.claude/skills/`
 * and `.agents/skills/` hold the same copies, one per coding agent's way
 * of finding them.
 *
 * A skill is a folder: its `SKILL.md` (the entry, which coding agents
 * load) and the files the entry links, which an agent reads only for its
 * case. A copy is the skill's files in one of the pack's folders.
 *
 * Update semantics with version + hash tracking, for each folder's copy:
 *
 *  - **Added** — the copy has no `SKILL.md`. Copy the skill in.
 *  - **Updated** — a bundled file differs from the copy's, or is
 *    missing from it, or a file an earlier sync wrote is no longer
 *    bundled (it's removed). Written only if the user hasn't edited
 *    the copy.
 *  - **Unchanged** — every bundled file matches the copy's. No write.
 *  - **Skipped (modified)** — a file of the copy was edited since the
 *    last install; the user's edits would be lost. The whole copy is
 *    skipped by default; `--force` overwrites.
 *  - **Local-only** — a skill in the folder that the bundle doesn't
 *    ship. User-authored (or removed from a newer bundle). Left
 *    untouched.
 *
 * A file the user added to a copy's folder is theirs: it's never read,
 * written or removed, unless a later bundle ships a file by that name.
 * That file then differs from the bundle's, with no hash recorded, so it
 * counts as an edit.
 *
 * Sync state lives in `.claude/skills/.kindgi-manifest.json`, for both
 * folders — records what version of each skill was installed, and the
 * hash of each of its files. Commit this file to git so teammates see
 * the same installed state.
 *
 * A pack gets the skills written for its language: each skill lists
 * them in its frontmatter (`pack_languages: [node, python, java, scala]`); a
 * skill without the field teaches the TypeScript surface (`[node]`).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { type KindgiConfig, type PackLanguage, packLanguage } from '@kindgi/handler-runtime';

import { FORMATTER_IGNORE_PATTERNS, patchPrettierignore } from '../init/gitignore-patcher.js';
import { type OutputFormat, renderJson } from '../output.js';
import { loadPackConfig } from '../pack-config.js';
import { type SaidLine, note, warning } from '../progress-lines.js';
import { commandResultFromThrown, stringFlag } from './helpers.js';
import { defaultSdkSkillsRoot } from './init.js';
import type { Command, CommandResult, LeafCommand } from './types.js';

interface ManifestEntry {
  /** Per-skill content version (author-maintained). Sync uses this + hash. */
  readonly installedVersion: string;
  /** SDK release version this skill was shipped with. Informational. */
  readonly installedSdkVersion: string;
  /** The hash of the copy's `SKILL.md`. */
  readonly installedHash: string;
  /**
   * The hash of each file the copy was installed with, by name, `SKILL.md`
   * among them. A manifest from before skills had more files has none: it
   * reads as `SKILL.md` alone, at `installedHash`, which is what was
   * installed then.
   */
  readonly installedFiles: Readonly<Record<string, string>>;
}

/** A skill's entry: the file coding agents load, and the one that names its version. */
const ENTRY = 'SKILL.md';

/**
 * The folders a pack's skills are copied into, from its root. Claude Code
 * reads `.claude/skills/`; Codex and Gemini CLI read `.agents/skills/`
 * (Cursor and VS Code's Copilot read either).
 */
export const SKILL_FOLDERS = ['.claude/skills', '.agents/skills'] as const;
export type SkillFolder = (typeof SKILL_FOLDERS)[number];

/**
 * Version 2, entries with `installedFiles` or without: a CLI from before the
 * field reads the rest of an entry (`installedHash` is still the entry's) and
 * drops the field when it writes.
 */
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
  /** The bundled skill's files, `SKILL.md` first; none for a local-only skill. */
  readonly files?: readonly string[];
  /** Files an earlier sync wrote that the bundle no longer ships, removed from the copy. */
  readonly removed?: readonly string[];
  readonly reason?: string;
}

/** Where `outcome`'s copy keeps the bundled skill's files, in the pack at `targetDir`. */
export function skillCopyPaths(targetDir: string, outcome: SkillSyncOutcome): string[] {
  return (outcome.files ?? []).map((file) => join(targetDir, outcome.folder, outcome.name, file));
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

interface SyncInputs {
  readonly skillsRoot: string;
  readonly targetDir: string;
  readonly language: PackLanguage;
  readonly force: boolean;
  readonly dryRun: boolean;
}

export async function syncSkills(inputs: SyncInputs): Promise<SkillSyncReport> {
  const manifest = await readManifest(join(inputs.targetDir, MANIFEST_PATH));
  return (await syncFrom(manifest, { ...inputs, keepRemoved: false })).report;
}

/**
 * A bundled skill's copy that `kindgi dev` leaves out, because it was
 * removed by hand: the copy (the manifest says it was installed), or its
 * whole folder.
 */
export interface LeftOutSkill {
  readonly name: string;
  readonly folder: SkillFolder;
  readonly folderGone: boolean;
  /** What the manifest says was installed there; none for a skill new to the folder. */
  readonly fromVersion?: string;
  readonly toVersion: string;
}

/**
 * The sync, from `manifest`. With `keepRemoved` (`kindgi dev`), what was
 * removed by hand stays removed (`LeftOutSkill`), and the manifest is
 * written only when it changes: a copy was written, or one that already
 * matches is recorded, so a later upgrade doesn't take it for an edit.
 */
async function syncFrom(
  manifest: Manifest,
  inputs: SyncInputs & { readonly keepRemoved: boolean },
): Promise<{ readonly report: SkillSyncReport; readonly leftOut: readonly LeftOutSkill[] }> {
  const { skillsRoot, targetDir, language, force, dryRun, keepRemoved } = inputs;

  const bundled = await readBundledSkills(skillsRoot, language);
  const bundledSet = new Set(bundled.map((skill) => skill.name));

  const outcomes: SkillSyncOutcome[] = [];
  const leftOut: LeftOutSkill[] = [];
  const next: Record<SkillFolder, Record<string, ManifestEntry>> = {
    '.claude/skills': { ...manifest.skills },
    '.agents/skills': { ...manifest.agentsSkills },
  };

  for (const folder of SKILL_FOLDERS) {
    const skillsDir = join(targetDir, folder);
    const installed = installedIn(manifest, folder);
    const folderGone = keepRemoved && !(await pathExists(skillsDir));
    for (const skill of bundled) {
      const dir = join(skillsDir, skill.name);
      const prior = installed[skill.name];
      const path = join(dir, ENTRY);
      const left = await leftOutCopy({ skill, folder, path, prior, folderGone, keepRemoved });
      if (left !== undefined) {
        leftOut.push(left);
        continue;
      }
      const synced = await syncCopy({ skill, folder, dir, prior, force, dryRun });
      outcomes.push(synced.outcome);
      if (synced.installed !== undefined) next[folder][skill.name] = synced.installed;
    }
    outcomes.push(...(await localOnly(skillsDir, folder, bundledSet)));
  }

  if (!dryRun) {
    await writeManifest(
      join(targetDir, MANIFEST_PATH),
      { v: MANIFEST_VERSION, skills: next['.claude/skills'], agentsSkills: next['.agents/skills'] },
      { onlyIfChanged: keepRemoved },
    );
  }

  const report: SkillSyncReport = {
    targetDir: relative(process.cwd(), targetDir) || '.',
    packLanguage: language,
    outcomes,
    dryRun,
    force,
  };
  return { report, leftOut };
}

/** The skills in `folder` that aren't bundled: the pack's own. */
async function localOnly(
  skillsDir: string,
  folder: SkillFolder,
  bundled: ReadonlySet<string>,
): Promise<SkillSyncOutcome[]> {
  const names = (await listSkillDirs(skillsDir)).filter((name) => !bundled.has(name));
  return names.map((name) => ({ name, folder, status: 'local-only' }));
}

/**
 * `skill`'s copy in `folder`, when `kindgi dev` leaves it out: its folder is
 * gone, or the copy is, though the manifest says it was installed (`prior`).
 */
async function leftOutCopy(inputs: {
  readonly skill: BundledSkill;
  readonly folder: SkillFolder;
  readonly path: string;
  readonly prior: ManifestEntry | undefined;
  readonly folderGone: boolean;
  readonly keepRemoved: boolean;
}): Promise<LeftOutSkill | undefined> {
  const { skill, folder, prior, folderGone } = inputs;
  const removed = folderGone || (inputs.keepRemoved && prior !== undefined);
  if (!removed || (!folderGone && (await pathExists(inputs.path)))) return undefined;
  return {
    name: skill.name,
    folder,
    folderGone,
    ...(prior !== undefined && { fromVersion: prior.installedVersion }),
    toVersion: skill.entry.installedVersion,
  };
}

function wroteCopy(outcome: SkillSyncOutcome): boolean {
  return outcome.status === 'added' || outcome.status === 'updated';
}

/** What `kindgi dev` did to the pack's framework skills as it started. */
export type DevSkillsRefresh =
  /** No manifest, or none it can read: nothing written, and the drift in words. */
  | { readonly kind: 'no-manifest'; readonly drift: string | undefined }
  | {
      readonly kind: 'refreshed';
      readonly report: SkillSyncReport;
      readonly leftOut: readonly LeftOutSkill[];
    };

/**
 * `kindgi dev`'s refresh of the framework skills as it starts, so an
 * upgraded CLI's skills reach the pack: the sync without `--force`. Edited
 * copies are kept, as the sync keeps them. A copy or a folder that was
 * removed by hand stays removed, and the `.prettierignore` is patched only
 * when a copy was written. Without a manifest it can read (no sync ever
 * ran, or `.claude/skills/` is gone), nothing is written.
 */
export async function refreshSkillsForDev(inputs: {
  readonly skillsRoot: string;
  readonly targetDir: string;
  readonly language: PackLanguage;
}): Promise<DevSkillsRefresh> {
  const manifest = await readManifestIfAny(join(inputs.targetDir, MANIFEST_PATH));
  if (manifest === undefined) {
    return { kind: 'no-manifest', drift: describeSkillDrift(await detectSkillDrift(inputs)) };
  }
  const synced = await syncFrom(manifest, {
    ...inputs,
    force: false,
    dryRun: false,
    keepRemoved: true,
  });
  const prettierignore = synced.report.outcomes.some(wroteCopy)
    ? await patchFormatterIgnore(inputs.targetDir, synced.report)
    : undefined;
  const report =
    prettierignore === undefined ? synced.report : { ...synced.report, prettierignore };
  return { kind: 'refreshed', report, leftOut: synced.leftOut };
}

/**
 * The refresh in lines for `kindgi dev`: what it wrote, and each kind of
 * copy left behind the bundle, with the command that moves it on. None
 * when nothing was written and nothing is behind. A copy behind the bundle
 * is a warning, and so is the heading over it.
 */
export function describeDevSkillsRefresh(
  refresh: DevSkillsRefresh,
  commands: { readonly sync: string; readonly force: string },
): SaidLine[] {
  if (refresh.kind === 'no-manifest') {
    return refresh.drift === undefined
      ? []
      : [
          warning(`  ⚠ Framework skills: ${refresh.drift}.`),
          warning(`    Run \`${commands.sync}\` to pull the latest.`),
        ];
  }
  const { outcomes, prettierignore } = refresh.report;
  const named = (status: SkillSyncOutcome['status']) =>
    new Set(outcomes.filter((o) => o.status === status).map((o) => o.name));
  const updated = named('updated');
  const added = [...named('added')].filter((name) => !updated.has(name));
  const wrote = [
    ...(updated.size > 0 ? [`${updated.size} updated`] : []),
    ...(added.length > 0 ? [`${added.length} added`] : []),
  ];
  const behind = behindLines(refresh, commands);
  const lines = [...behind.lines.map(warning), ...formatterIgnoreLines(prettierignore)];
  if (wrote.length > 0) {
    const heading = `  ✓ Framework skills: ${wrote.join(', ')}.`;
    return [{ text: heading, problem: lines.some((line) => line.problem) }, ...lines];
  }
  return behind.count > 0
    ? [warning(`  ⚠ Framework skills: ${behind.count} out of date.`), ...lines]
    : [];
}

/**
 * The copies the refresh left behind the bundle, a line per kind: edited
 * (kept), deleted, and in a folder that's gone. `count` is by skill.
 */
function behindLines(
  refresh: Extract<DevSkillsRefresh, { kind: 'refreshed' }>,
  commands: { readonly sync: string; readonly force: string },
): { readonly lines: readonly string[]; readonly count: number } {
  const edited = refresh.report.outcomes.filter(
    (o) => o.status === 'skipped-modified' && o.fromVersion !== o.toVersion,
  );
  const left = refresh.leftOut.filter((s) => s.fromVersion !== s.toVersion);
  const deleted = left.filter((s) => !s.folderGone);
  const gone = [...new Set(left.filter((s) => s.folderGone).map((s) => `${s.folder}/`))];
  const skills = (copies: readonly { readonly name: string }[]) =>
    new Set(copies.map((c) => c.name)).size;
  const lines: string[] = [];
  const editedCount = skills(edited);
  if (editedCount > 0) {
    const [are, them] = editedCount === 1 ? ['is', 'it'] : ['are', 'them'];
    lines.push(
      `    · ${editedCount} you edited ${are} kept: \`${commands.force}\` replaces ${them}.`,
    );
  }
  const deletedCount = skills(deleted);
  if (deletedCount > 0) {
    const them = deletedCount === 1 ? 'it' : 'them';
    lines.push(`    · ${deletedCount} you deleted: \`${commands.sync}\` brings ${them} back.`);
  }
  if (gone.length > 0) {
    const [are, them] = gone.length === 1 ? ['is', 'it'] : ['are', 'them'];
    lines.push(
      `    · ${gone.join(' and ')} ${are} gone: \`${commands.sync}\` brings ${them} back.`,
    );
  }
  return { lines, count: skills([...edited, ...left]) };
}

/** What the refresh did to the pack's `.prettierignore`, when it changed it or couldn't. */
function formatterIgnoreLines(outcome: FormatterIgnoreOutcome | undefined): SaidLine[] {
  if (outcome?.status === 'patched') {
    return [note(`    · Added ${outcome.appended.join(' and ')} to ${outcome.path}.`)];
  }
  if (outcome?.status === 'error') {
    return [
      warning(`    · Couldn't add the skills' folders to ${outcome.path}: ${outcome.message}`),
    ];
  }
  return [];
}

/** A bundled skill: its files, by name, with what the manifest records of it. */
interface BundledSkill {
  readonly name: string;
  /** `SKILL.md` first, then the rest by name. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly entry: ManifestEntry;
}

async function readBundledSkills(
  root: string,
  language: PackLanguage,
): Promise<readonly BundledSkill[]> {
  const skills: BundledSkill[] = [];
  for (const name of await listBundledSkills(root, language)) {
    const dir = join(root, name);
    const entry = await readFile(join(dir, ENTRY));
    const files = new Map<string, Uint8Array>([[ENTRY, entry]]);
    for (const file of await filesBesideEntry(dir)) {
      files.set(file, await readFile(join(dir, file)));
    }
    const text = entry.toString('utf8');
    skills.push({
      name,
      files,
      entry: {
        installedVersion: parseFrontmatterField(text, 'version'),
        installedSdkVersion: parseFrontmatterField(text, 'sdk_version'),
        installedHash: hashBytes(entry),
        installedFiles: Object.fromEntries(
          [...files].map(([file, bytes]) => [file, hashBytes(bytes)]),
        ),
      },
    });
  }
  return skills;
}

/**
 * A skill folder's files besides `SKILL.md`, by name. Flat: a folder in
 * it, or a dotfile, isn't the skill's.
 */
async function filesBesideEntry(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name !== ENTRY)
    .map((e) => e.name)
    .sort();
}

/**
 * Brings one folder's copy of `skill` up to the bundle, unless it was
 * edited since `prior` (what was last installed there) and `force` is
 * off. `installed` is what the copy is now, for the manifest; `undefined`
 * keeps the entry it had.
 *
 * A file is edited when the copy's differs from both the bundle's and
 * what was installed: one the bundle no longer ships counts too, and one
 * that was never installed (the manifest doesn't name it) counts unless it
 * matches the bundle's. A file that's missing is written; it's no edit.
 */
async function syncCopy(inputs: {
  readonly skill: BundledSkill;
  readonly folder: SkillFolder;
  readonly dir: string;
  readonly prior: ManifestEntry | undefined;
  readonly force: boolean;
  readonly dryRun: boolean;
}): Promise<{ readonly outcome: SkillSyncOutcome; readonly installed?: ManifestEntry }> {
  const { skill, folder, dir, prior, force, dryRun } = inputs;
  const which = { name: skill.name, folder, files: [...skill.files.keys()] };
  const to = {
    toVersion: skill.entry.installedVersion,
    sdkVersion: skill.entry.installedSdkVersion,
  };
  const bundled = skill.entry.installedFiles;
  const recorded = prior?.installedFiles ?? {};

  const local = new Map<string, string | undefined>();
  for (const file of new Set([...skill.files.keys(), ...Object.keys(recorded)])) {
    local.set(file, await hashFile(join(dir, file)));
  }
  const stale = [...skill.files].filter(([file]) => local.get(file) !== bundled[file]);
  const dropped = Object.keys(recorded).filter(
    (file) => !skill.files.has(file) && local.get(file) !== undefined,
  );
  // Content already matches bundle — nothing to do.
  if (stale.length === 0 && dropped.length === 0) {
    return { outcome: { ...which, status: 'unchanged', ...to }, installed: skill.entry };
  }

  // A copy without its entry is gone: it's added. Otherwise determine if
  // the user edited the copy or the bundle simply advanced.
  const added = local.get(ENTRY) === undefined;
  const userModified = [...local].some(
    ([file, hash]) => hash !== undefined && hash !== bundled[file] && hash !== recorded[file],
  );
  const from = !added && prior !== undefined && { fromVersion: prior.installedVersion };

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

  if (!dryRun) {
    for (const [file, bytes] of stale) await writeSkillFile(join(dir, file), bytes);
    for (const file of dropped) await unlink(join(dir, file));
  }
  return {
    outcome: {
      ...which,
      status: added ? 'added' : 'updated',
      ...to,
      ...from,
      ...(dropped.length > 0 && { removed: dropped }),
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

/** The manifest, or an empty one when there's none it can read. */
async function readManifest(path: string): Promise<Manifest> {
  return (await readManifestIfAny(path)) ?? { v: MANIFEST_VERSION, skills: {} };
}

/** The manifest; `undefined` when there's none, or none it can read. */
async function readManifestIfAny(path: string): Promise<Manifest | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const parsedRec = parsed as { v?: unknown; skills?: unknown; agentsSkills?: unknown };
    // Accept both v:1 (legacy, no installedSdkVersion) and v:2. On
    // next write the manifest gets rewritten as v:2 with sdk_version
    // populated from bundle. Any other version → treat as none.
    if (parsedRec.v !== 1 && parsedRec.v !== 2) return undefined;
    const skillsField = parsedRec.skills;
    if (typeof skillsField !== 'object' || skillsField === null) return undefined;
    return {
      v: MANIFEST_VERSION,
      skills: readEntries(skillsField),
      agentsSkills: readEntries(parsedRec.agentsSkills),
    };
  } catch {
    return undefined;
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
      const installedHash = (v as { installedHash: string }).installedHash;
      out[k] = {
        installedVersion: (v as { installedVersion: string }).installedVersion,
        installedSdkVersion: typeof sdkVer === 'string' ? sdkVer : 'unknown',
        installedHash,
        installedFiles: {
          ...readInstalledFiles((v as { installedFiles?: unknown }).installedFiles),
          [ENTRY]: installedHash,
        },
      };
    }
  }
  return out;
}

/**
 * An entry's `installedFiles`, each a file's name in the skill's folder and
 * its hash. A name that isn't one plain file name (`../x`, `a/b`, `.x`) is
 * dropped, so a manifest can't point the sync outside the copy.
 */
function readInstalledFiles(field: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof field !== 'object' || field === null) return out;
  for (const [file, hash] of Object.entries(field as Record<string, unknown>)) {
    if (SKILL_FILE_NAME.test(file) && typeof hash === 'string') out[file] = hash;
  }
  return out;
}

/** A file's name in a skill's folder: no path, no dotfile. */
const SKILL_FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

async function writeManifest(
  path: string,
  manifest: Manifest,
  options: { readonly onlyIfChanged: boolean },
): Promise<void> {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.onlyIfChanged && (await readFile(path, 'utf8').catch(() => undefined)) === text) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
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

/** The hash of the file at `path`; `undefined` when there's none. */
async function hashFile(path: string): Promise<string | undefined> {
  try {
    return hashBytes(await readFile(path));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
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

async function writeSkillFile(path: string, bytes: Uint8Array): Promise<void> {
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
 * Cheap drift check for `kindgi dev` boot, when there's no manifest to
 * refresh from (`refreshSkillsForDev`). Compares the pack's
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
  const removed = o.removed !== undefined ? ` (removed ${o.removed.join(', ')})` : '';
  const reason = o.reason !== undefined ? ` — ${o.reason}` : '';
  return `  ${STATUS_SYMBOLS[o.status]} ${o.name}${version}${removed}${reason}`;
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
