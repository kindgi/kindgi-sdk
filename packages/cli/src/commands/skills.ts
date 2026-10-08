// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi skills sync` — refresh a scaffolded pack's `.claude/skills/`
 * from the SDK skills bundled into the CLI.
 *
 * Update semantics with version + hash tracking:
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
 *  - **Local-only** — a skill in `.claude/skills/` that the bundle
 *    doesn't ship. User-authored (or removed from a newer bundle).
 *    Left untouched.
 *
 * Sync state lives in `.claude/skills/.kindgi-manifest.json` — records
 * what version + hash of each skill was installed. Commit this file
 * to git so teammates see the same installed state.
 *
 * A pack gets the skills written for its language: each skill lists
 * them in its frontmatter (`pack_languages: [node, python, java, scala]`); a
 * skill without the field teaches the TypeScript surface (`[node]`).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { type KindgiConfig, type PackLanguage, packLanguage } from '@kindgi/handler-runtime';

import { renderJson } from '../output.js';
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

interface Manifest {
  readonly v: 2;
  readonly skills: Readonly<Record<string, ManifestEntry>>;
}

const MANIFEST_VERSION = 2 as const;
const MANIFEST_BASENAME = '.kindgi-manifest.json';

/**
 * Per-skill sync outcome — reported back to the user + stored on the
 * command result so JSON-mode callers get a machine-readable summary.
 */
export interface SkillSyncOutcome {
  readonly name: string;
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
}

const sync: LeafCommand = {
  kind: 'leaf',
  name: 'sync',
  description: 'Refresh .claude/skills/ from the CLI-bundled SDK skills.',
  usage: 'kindgi skills sync [--path=<dir>] [--force] [--dry-run]',
  optionSpec: {
    path: {
      type: 'string',
      description:
        'The pack root, whose `.claude/skills/` is refreshed. Default: the current directory.',
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
      const report = await syncSkills({ skillsRoot, targetDir, language, force, dryRun });
      return {
        kind: 'ok',
        rendered: renderJson(report, ctx.globals.format),
        ...(shouldRenderSummaryOnStderr(ctx) && { stderr: renderSummary(report) }),
      };
    } catch (err) {
      return commandResultFromThrown(err, ctx, 'skills sync');
    }
  },
};

export const skillsCommand: Command = {
  kind: 'group',
  name: 'skills',
  description: "Manage the pack's `.claude/skills/` directory.",
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

  const skillsDir = join(targetDir, '.claude', 'skills');
  const manifestPath = join(skillsDir, MANIFEST_BASENAME);
  const manifest = await readManifest(manifestPath);

  const bundledNames = await listBundledSkills(skillsRoot, language);
  const localNames = await listSkillDirs(skillsDir);

  const outcomes: SkillSyncOutcome[] = [];
  const nextEntries: Record<string, ManifestEntry> = { ...manifest.skills };

  for (const name of bundledNames) {
    const bundledPath = join(skillsRoot, name, 'SKILL.md');
    const bundledBytes = await readFile(bundledPath);
    const bundledHash = hashBytes(bundledBytes);
    const bundledText = bundledBytes.toString('utf8');
    const bundledVersion = parseFrontmatterField(bundledText, 'version');
    const bundledSdkVersion = parseFrontmatterField(bundledText, 'sdk_version');

    const localPath = join(skillsDir, name, 'SKILL.md');
    const localExists = await pathExists(localPath);

    if (!localExists) {
      if (!dryRun) await writeSkill(localPath, bundledBytes);
      nextEntries[name] = {
        installedVersion: bundledVersion,
        installedSdkVersion: bundledSdkVersion,
        installedHash: bundledHash,
      };
      outcomes.push({
        name,
        status: 'added',
        toVersion: bundledVersion,
        sdkVersion: bundledSdkVersion,
      });
      continue;
    }

    const localBytes = await readFile(localPath);
    const localHash = hashBytes(localBytes);
    const priorEntry = manifest.skills[name];

    // Content already matches bundle — nothing to do.
    if (localHash === bundledHash) {
      nextEntries[name] = {
        installedVersion: bundledVersion,
        installedSdkVersion: bundledSdkVersion,
        installedHash: bundledHash,
      };
      outcomes.push({
        name,
        status: 'unchanged',
        toVersion: bundledVersion,
        sdkVersion: bundledSdkVersion,
      });
      continue;
    }

    // Local differs from bundle. Determine if the user modified the
    // local copy or if the bundle simply advanced.
    const userModified = priorEntry === undefined || priorEntry.installedHash !== localHash;

    if (userModified && !force) {
      outcomes.push({
        name,
        status: 'skipped-modified',
        ...(priorEntry?.installedVersion !== undefined && {
          fromVersion: priorEntry.installedVersion,
        }),
        toVersion: bundledVersion,
        sdkVersion: bundledSdkVersion,
        reason: 'Local edits detected; --force to overwrite.',
      });
      continue;
    }

    if (!dryRun) await writeSkill(localPath, bundledBytes);
    const outcome: SkillSyncOutcome = {
      name,
      status: 'updated',
      toVersion: bundledVersion,
      sdkVersion: bundledSdkVersion,
      ...(priorEntry?.installedVersion !== undefined && {
        fromVersion: priorEntry.installedVersion,
      }),
      ...(force && userModified && { reason: 'Overwrote local edits (--force)' }),
    };
    nextEntries[name] = {
      installedVersion: bundledVersion,
      installedSdkVersion: bundledSdkVersion,
      installedHash: bundledHash,
    };
    outcomes.push(outcome);
  }

  const bundledSet = new Set(bundledNames);
  for (const name of localNames) {
    if (bundledSet.has(name)) continue;
    outcomes.push({ name, status: 'local-only' });
  }

  if (!dryRun) {
    await writeManifest(manifestPath, { v: MANIFEST_VERSION, skills: nextEntries });
  }

  return {
    targetDir: relative(process.cwd(), targetDir) || '.',
    packLanguage: language,
    outcomes,
    dryRun,
    force,
  };
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
    const parsedRec = parsed as { v?: unknown; skills?: unknown };
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
    const out: Record<string, ManifestEntry> = {};
    for (const [k, v] of Object.entries(skillsField as Record<string, unknown>)) {
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
    return { v: MANIFEST_VERSION, skills: out };
  } catch {
    return { v: MANIFEST_VERSION, skills: {} };
  }
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

function shouldRenderSummaryOnStderr(ctx: {
  readonly globals: { readonly format: unknown };
}): boolean {
  return ctx.globals.format !== 'json';
}

export interface SkillDriftReport {
  /** Skills present in the SDK bundle but not yet copied into `.claude/skills/`. */
  readonly missing: readonly string[];
  /** Skills where installed version differs from the bundled version. */
  readonly outdated: readonly {
    readonly name: string;
    readonly from: string;
    readonly to: string;
  }[];
}

/**
 * Cheap drift check for `kindgi dev` boot. Compares the pack's
 * installed skills (via `.claude/skills/.kindgi-manifest.json`)
 * against the SDK-bundled skill versions from the CLI's shipped
 * skills root.
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
  const skillsDir = join(inputs.targetDir, '.claude', 'skills');
  const manifestPath = join(skillsDir, MANIFEST_BASENAME);
  const manifest = await readManifest(manifestPath);
  const bundledNames = await listBundledSkills(inputs.skillsRoot, inputs.language);

  const missing: string[] = [];
  const outdated: { name: string; from: string; to: string }[] = [];

  for (const name of bundledNames) {
    let bundledText: string;
    try {
      bundledText = (await readFile(join(inputs.skillsRoot, name, 'SKILL.md'))).toString('utf8');
    } catch {
      continue;
    }
    const bundledVersion = parseFrontmatterField(bundledText, 'version');
    const installed = manifest.skills[name];
    if (installed === undefined) {
      // Skill exists in the bundle but was never synced. Might not
      // yet exist on disk either — either way, the pack is behind.
      const localExists = await pathExists(join(skillsDir, name, 'SKILL.md'));
      if (!localExists) missing.push(name);
      else outdated.push({ name, from: 'untracked', to: bundledVersion });
      continue;
    }
    if (installed.installedVersion !== bundledVersion) {
      outdated.push({ name, from: installed.installedVersion, to: bundledVersion });
    }
  }

  return { missing, outdated };
}

function renderSummary(report: SkillSyncReport): string {
  const counts: Record<SkillSyncOutcome['status'], number> = {
    added: 0,
    updated: 0,
    unchanged: 0,
    'skipped-modified': 0,
    'local-only': 0,
  };
  for (const o of report.outcomes) counts[o.status] += 1;
  const lines: string[] = [
    `Synced ${report.targetDir}/.claude/skills/${report.dryRun ? ' (dry-run)' : ''}`,
    '',
  ];
  const sdkVersions = new Set<string>();
  for (const o of report.outcomes) {
    if (o.sdkVersion !== undefined && o.sdkVersion !== 'unknown') sdkVersions.add(o.sdkVersion);
    const symbol =
      o.status === 'added'
        ? '+'
        : o.status === 'updated'
          ? '↑'
          : o.status === 'unchanged'
            ? '='
            : o.status === 'skipped-modified'
              ? '!'
              : '·';
    const version =
      o.fromVersion !== undefined && o.toVersion !== undefined && o.fromVersion !== o.toVersion
        ? ` @${o.fromVersion}→${o.toVersion}`
        : o.toVersion !== undefined
          ? ` @${o.toVersion}`
          : '';
    lines.push(`  ${symbol} ${o.name}${version}${o.reason !== undefined ? ` — ${o.reason}` : ''}`);
  }
  lines.push('');
  lines.push(
    `${counts.added} added, ${counts.updated} updated, ${counts.unchanged} unchanged, ` +
      `${counts['skipped-modified']} skipped-modified, ${counts['local-only']} local-only`,
  );
  if (sdkVersions.size === 1) {
    lines.push(`SDK release: ${[...sdkVersions][0]}`);
  } else if (sdkVersions.size > 1) {
    lines.push(`SDK releases: ${[...sdkVersions].sort().join(', ')} (mixed)`);
  }
  lines.push('');
  return lines.join('\n');
}
