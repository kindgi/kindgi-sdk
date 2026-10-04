// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Augment-mode scaffolder — writes Kindgi files ALONGSIDE an existing
 * Node.js project. Called from `runInit` when `detectInitMode` returns
 * `mode: 'augment'`.
 *
 * What augment mode writes:
 *   - `kindgi.config.ts` at project root — `kindgi.config.mts` when the
 *     app is CommonJS (no `"type": "module"`), plus a one-line
 *     `kindgi/package.json` marking `kindgi/` as ES modules, so Node
 *     never reparses Kindgi's files with a warning (pack id derived from
 *     `package.json` `name`, discovery paths point at `kindgi/**`)
 *   - `kindgi/agents/.gitkeep`
 *   - `kindgi/tools/.gitkeep`
 *   - `kindgi/guardrails/.gitkeep`
 *   - `kindgi/flows/.gitkeep`
 *   - `.claude/skills/kindgi-<name>/SKILL.md` for each shipped skill —
 *     merge-not-overwrite: skips files that already exist so user
 *     customizations survive
 *   - `package.json`: `@kindgi/sdk` (dependency) + `@kindgi/cli`
 *     (devDependency), specs from `resolveKindgiDependencySpecs` — the
 *     project runs its own pinned `kindgi` — and `zod` (dependency, the
 *     fresh templates' range), which every primitive's schemas use. An
 *     app's own `zod` is kept; one before zod 4 is reported.
 *   - `.gitignore`: Kindgi's local-state patterns
 *   - in a pnpm app, `pnpm-workspace.yaml` (the workspace root's, or a new
 *     one): a decision for esbuild's install script, `allowBuilds.esbuild:
 *     false` (esbuild works without it), without which pnpm 11+ refuses to
 *     install `@kindgi/cli` (`pnpm-workspace-patcher.ts`)
 *
 * What augment mode does NOT write:
 *   - env files — `kindgi dev` reads the project's own `.env` /
 *     `.env.local`; nothing needs creating
 *   - `tsconfig.json`, `vitest.config.ts`, `.nvmrc`, `AGENTS.md`,
 *     `README.md` — the surrounding repo owns these; we don't touch them
 *
 * @related packages/cli/src/init/mode-detect.ts (the branch)
 * @related packages/cli/src/commands/init.ts (the caller)
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { KINDGI_CONFIG_FILENAMES } from '@kindgi/handler-runtime';
import semver from 'semver';

import { PACK_ID_REGEX } from '../commands/init.js';
import { syncSkills } from '../commands/skills.js';
import type { CommandResult } from '../commands/types.js';
import { renderJson } from '../output.js';
import {
  type PackageManager,
  binDisplay,
  detectPackageManager,
  installCommand,
} from '../package-manager.js';
import { type KindgiDependencySpecs, resolveKindgiDependencySpecs } from './dependency-specs.js';
import { patchGitignore, patchPrettierignore } from './gitignore-patcher.js';
import { type WantedDependency, patchPackageJson } from './package-json-patcher.js';
import {
  ESBUILD,
  ESBUILD_DECISION,
  patchPnpmWorkspace,
  pnpmWorkspaceFileFor,
} from './pnpm-workspace-patcher.js';
import {
  type Substitutions,
  collectTemplateFiles,
  substitute,
  templateTarget,
} from './template-files.js';

const DEFAULT_PACK_ID_FALLBACK = 'kindgi-pack';
const DEFAULT_PACK_VERSION_FALLBACK = '0.1.0';

const AUGMENT_SUBDIRS = ['agents', 'tools', 'guardrails', 'flows'] as const;

export interface RunInitAugmentInputs {
  readonly targetDir: string;
  /**
   * Optional root containing shipped skill folders (each with a
   * `SKILL.md`). If undefined, no skills are copied. Production
   * wiring passes `defaultSdkSkillsRoot()`; tests inject a fixture
   * dir.
   */
  readonly skillsRoot?: string;
  /** Override the derived pack id (e.g. when name normalization can't produce a valid PACK_ID). */
  readonly packIdOverride?: string;
  /**
   * Overwrite existing `kindgi.config.ts` + shipped skill files under
   * `.claude/skills/kindgi-<name>/SKILL.md`. Non-force default:
   * refuse when `kindgi.config.ts` exists; merge (skip) any
   * pre-existing skill files.
   */
  readonly force: boolean;
  /** `--link-local`: link the Kindgi checkout even when the target is inside its workspace. */
  readonly linkLocal?: boolean;
  /**
   * `--template`: `sample` adds the sample pack's primitives (tools, a
   * guardrail, an agent, a flow) under `kindgi/`, read from
   * `templatesRoot`. Default `minimal`: the config and empty folders.
   */
  readonly template?: 'minimal' | 'sample';
  readonly templatesRoot?: string;
  /** Test seams. */
  readonly ioOverrides?: AugmentIOOverrides;
  readonly packageManager?: PackageManager;
  readonly dependencySpecs?: KindgiDependencySpecs;
}

export interface AugmentIOOverrides {
  readonly readFile?: (path: string) => Promise<string>;
  readonly writeFile?: (path: string, contents: string) => Promise<void>;
  readonly mkdir?: (path: string) => Promise<void>;
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly listDir?: (path: string) => Promise<readonly string[]>;
}

/**
 * Derive a `PACK_ID_REGEX`-valid id from a `package.json` name. Rules:
 *   - `my-app` -> `my-app`
 *   - `@acme/legal` -> `acme.legal`
 *   - `@ACME/Legal` -> `acme.legal`  (lowercased)
 *   - `my_app` -> error (underscores not allowed; explicit override required)
 *   - `x` (single char, valid) -> `x`
 */
export function derivePackId(
  name: string,
):
  | { readonly kind: 'ok'; readonly id: string }
  | { readonly kind: 'err'; readonly message: string } {
  if (name === '') {
    return {
      kind: 'err',
      message: 'package.json name is empty. Pass `--pack-id=<id>` explicitly.',
    };
  }
  const lower = name.toLowerCase();
  // Scoped: `@scope/pkg` → `scope.pkg`
  const scopedMatch = lower.match(/^@([^/]+)\/(.+)$/);
  const candidate = scopedMatch !== null ? `${scopedMatch[1]}.${scopedMatch[2]}` : lower;
  if (!PACK_ID_REGEX.test(candidate)) {
    return {
      kind: 'err',
      message: `Cannot derive a valid pack id from package.json name "${name}" (candidate: "${candidate}").\nPack ids must match ${PACK_ID_REGEX.source} — lowercase kebab, optionally dot-namespaced.\nPass \`--pack-id=<id>\` to override, e.g. \`--pack-id=my-pack\`.\n`,
    };
  }
  return { kind: 'ok', id: candidate };
}

/**
 * Render the augment-mode `kindgi.config.ts` file. Compact — no
 * `environments` block (user fills that in when ready to deploy;
 * `kindgi dev` doesn't need it).
 */
export function renderAugmentConfig(inputs: {
  readonly packId: string;
  readonly packVersion: string;
  readonly packName: string;
}): string {
  return `// Kindgi pack config — added by \`kindgi init\` (augment mode).
// The pack lives alongside your existing code; discovery paths below
// scope Kindgi to \`kindgi/**\` so authoring stays isolated from the
// surrounding app's code.

const config = {
  pack: {
    id: '${inputs.packId}',
    version: '${inputs.packVersion}',
    description: 'Kindgi pack embedded in ${inputs.packName}.',
  },
  discovery: {
    tools: 'kindgi/tools/**/*.ts',
    guardrails: 'kindgi/guardrails/**/*.ts',
    agents: 'kindgi/agents/**/*.ts',
    flows: 'kindgi/flows/**/*.ts',
  },
  // ---------------------------------------------------------------
  // Environments — fill in when you're ready to push a build off the
  // laptop. See the minimal template's kindgi.config.ts for the full
  // shape (endpoint / build / registry / signingKey / tenantId per
  // environment). Local \`kindgi dev\` doesn't read this block.
  // ---------------------------------------------------------------
  environments: {},
} as const;

export default config;
`;
}

const defaultIO: Required<AugmentIOOverrides> = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: async (path, contents) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  },
  mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
  fileExists: async (path) => {
    try {
      const s = await stat(path);
      return s.isFile();
    } catch {
      return false;
    }
  },
  listDir: async (path) => {
    const { readdir } = await import('node:fs/promises');
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  },
};

interface AugmentSummary {
  readonly kind: 'augment';
  readonly targetDir: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly packageManager: PackageManager;
  readonly dependencies: KindgiDependencySpecs;
  readonly created: readonly string[];
  readonly skipped: readonly string[];
  /** What init left for the user to decide (an app's older Zod, a denied build). */
  readonly warnings: readonly string[];
  readonly nextSteps: readonly string[];
}

export async function runInitAugment(inputs: RunInitAugmentInputs): Promise<CommandResult> {
  const io: Required<AugmentIOOverrides> = { ...defaultIO, ...inputs.ioOverrides };

  const pkgJsonPath = join(inputs.targetDir, 'package.json');
  const readResult = await readSourcePackageJson(io, pkgJsonPath);
  if (readResult.kind === 'err') {
    return { kind: 'error', stderr: readResult.stderr, exitCode: 1 };
  }
  const pkgJson = readResult.pkg;

  const rawName = typeof pkgJson.name === 'string' ? pkgJson.name : '';
  const packName = rawName === '' ? DEFAULT_PACK_ID_FALLBACK : rawName;
  const packVersion =
    typeof pkgJson.version === 'string' && pkgJson.version !== ''
      ? pkgJson.version
      : DEFAULT_PACK_VERSION_FALLBACK;

  const packIdResult = resolvePackId(rawName, inputs.packIdOverride);
  if (packIdResult.kind === 'err') {
    return { kind: 'error', stderr: packIdResult.stderr, exitCode: 1 };
  }
  const packId = packIdResult.id;

  const existing = await findExistingConfig(io, inputs.targetDir);
  if (existing !== undefined && !inputs.force) {
    return {
      kind: 'error',
      stderr: `${existing} already exists.\nRe-run with --force to overwrite the pack config (skills are always merged, not overwritten, unless --force is also set).\n`,
      exitCode: 1,
    };
  }
  // A CommonJS app (no `"type": "module"`) would make Node reparse a
  // `.ts` config / primitive as ESM with a warning on every run.
  const esmApp = pkgJson.type === 'module';
  const configPath =
    existing ?? join(inputs.targetDir, esmApp ? 'kindgi.config.ts' : 'kindgi.config.mts');

  // Resolve how the project will depend on Kindgi BEFORE writing
  // anything, so a failure leaves the repo untouched.
  const deps = await resolveProjectDeps(inputs);
  if (deps.kind === 'err') return { kind: 'error', stderr: deps.stderr, exitCode: 1 };

  const filesWritten = await writeAugmentFiles({
    io,
    targetDir: inputs.targetDir,
    configPath,
    packId,
    packVersion,
    packName,
    skillsRoot: inputs.skillsRoot,
    force: inputs.force,
    esmApp,
  });
  const created = [...filesWritten.created];
  const skipped = [...filesWritten.skipped];

  const sample = inputs.template === 'sample' && inputs.templatesRoot !== undefined;
  if (sample) {
    const primitives = await writeSamplePrimitives({
      io,
      sampleDir: join(inputs.templatesRoot as string, 'sample'),
      targetDir: inputs.targetDir,
      substitutions: { PACK_NAME: packName, PACK_ID: packId, PACK_VERSION: packVersion },
      force: inputs.force,
    });
    created.push(...primitives.created);
    skipped.push(...primitives.skipped);
  }

  const patchResult = await applyAugmentPatches({
    targetDir: inputs.targetDir,
    pkgJsonPath,
    specs: deps.specs,
    packageManager: deps.packageManager,
    // Every primitive's schemas are Zod. An app with Zod keeps its own.
    extraDependencies: [ZOD_DEPENDENCY],
  });
  if (patchResult.kind === 'err') {
    return { kind: 'error', stderr: patchResult.stderr, exitCode: 1 };
  }
  created.push(...patchResult.created);
  skipped.push(...patchResult.skipped);
  const warnings = [...zodWarnings(pkgJson), ...patchResult.warnings];

  const nextSteps = augmentNextSteps(deps.packageManager, sample ? packId : undefined);

  const summary: AugmentSummary = {
    kind: 'augment',
    targetDir: inputs.targetDir,
    packId,
    packVersion,
    packageManager: deps.packageManager,
    dependencies: deps.specs,
    created,
    skipped,
    warnings,
    nextSteps,
  };

  const rendered = renderJson(summary, 'json');

  return {
    kind: 'ok',
    rendered: {
      stdout: rendered.stdout,
      stderr: [
        '',
        `  Kindgi added to ${inputs.targetDir} (augment mode).`,
        `  Pack id: ${packId}    Version: ${packVersion}`,
        `  Wrote ${created.length} file${created.length === 1 ? '' : 's'}; skipped ${skipped.length}.`,
        ...warnings.map((warning) => `  ⚠ ${warning}`),
        '',
        '  Next steps:',
        ...nextSteps.map((step) => `    ${step}`),
        '',
        '',
      ].join('\n'),
    },
  };
}

// ---------------------------------------------------------------------
// Extracted helpers — keep runInitAugment under the complexity ceiling.
// ---------------------------------------------------------------------

/** The first `kindgi.config.*` already at the root, if any. */
async function findExistingConfig(
  io: Required<AugmentIOOverrides>,
  targetDir: string,
): Promise<string | undefined> {
  for (const name of KINDGI_CONFIG_FILENAMES) {
    const path = join(targetDir, name);
    if (await io.fileExists(path)) return path;
  }
  return undefined;
}

type ProjectDeps =
  | {
      readonly kind: 'ok';
      readonly packageManager: PackageManager;
      readonly specs: KindgiDependencySpecs;
    }
  | { readonly kind: 'err'; readonly stderr: string };

async function resolveProjectDeps(inputs: RunInitAugmentInputs): Promise<ProjectDeps> {
  const packageManager = inputs.packageManager ?? (await detectPackageManager(inputs.targetDir));
  if (inputs.dependencySpecs !== undefined) {
    return { kind: 'ok', packageManager, specs: inputs.dependencySpecs };
  }
  const resolved = await resolveKindgiDependencySpecs({
    targetDir: inputs.targetDir,
    packageManager,
    ...(inputs.linkLocal === true && { forceLocal: true }),
  });
  if (resolved.kind === 'error') return { kind: 'err', stderr: `${resolved.message}\n` };
  return { kind: 'ok', packageManager, specs: resolved.specs };
}

/**
 * What to run next — in the project's own package manager, with its own
 * `kindgi`. With the sample's `packId`, how to try its agent too.
 */
export function augmentNextSteps(pm: PackageManager, samplePackId?: string): readonly string[] {
  const setSecret = binDisplay(pm, 'kindgi', [
    'secrets',
    'set',
    '<NAME>',
    '--env=local',
    '--scope=tenant',
  ]);
  return [
    `Install: ${installCommand(pm)}`,
    `Boot the dev server: ${binDisplay(pm, 'kindgi', ['dev'])}`,
    `Secrets: kindgi dev reads your .env and .env.local — keys there are available, or run ${setSecret}`,
    `Model provider: agents answer with the dev-echo fallback until you register one — e.g. ${binDisplay(pm, 'kindgi', ['providers', 'register', '--preset=anthropic'])} (ANTHROPIC_API_KEY in .env); more in .claude/skills/kindgi-authoring-providers/SKILL.md`,
    ...(samplePackId === undefined
      ? []
      : [
          `Try the sample agent: ${binDisplay(pm, 'kindgi', ['runs', 'start', `--agent=${samplePackId}.echo-agent`, `--input='{"userMessage":"hi"}'`])}`,
        ]),
  ];
}

/** The sample's primitive folders, as augment mode lays them out under `kindgi/`. */
const SAMPLE_PRIMITIVE_DIRS = ['agents', 'flows', 'guardrails', 'tools'] as const;

/** Zod, at the fresh templates' range (their `package.json.tmpl`). */
export const ZOD_DEPENDENCY = { name: 'zod', spec: '^4.0.0', section: 'dependencies' } as const;

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/**
 * The app's own Zod is kept; one whose range excludes zod 4 is reported,
 * since Kindgi's schemas, examples and skills are zod 4. A spec that isn't
 * a semver range (`catalog:`, `workspace:*`, a tag) is taken on trust.
 */
export function zodWarnings(pkg: Readonly<Record<string, unknown>>): readonly string[] {
  for (const section of DEPENDENCY_SECTIONS) {
    const deps = pkg[section];
    if (deps === null || typeof deps !== 'object') continue;
    const spec = (deps as Record<string, unknown>)[ZOD_DEPENDENCY.name];
    if (typeof spec !== 'string') continue;
    if (semver.validRange(spec) === null || semver.intersects(spec, ZOD_DEPENDENCY.spec)) {
      return [];
    }
    return [
      `zod: the app has zod ${spec} (${section}), left as is. Kindgi's tools, examples and skills use zod 4 — upgrade to zod ${ZOD_DEPENDENCY.spec} before writing Kindgi primitives.`,
    ];
  }
  return [];
}

/**
 * Copy the sample pack's primitives into `kindgi/<kind>/`, rendered as a
 * fresh sample pack renders them. The sample's tests stay out: the app
 * has its own test setup. A file already there is kept unless `force`.
 */
async function writeSamplePrimitives(args: {
  readonly io: Required<AugmentIOOverrides>;
  readonly sampleDir: string;
  readonly targetDir: string;
  readonly substitutions: Substitutions;
  readonly force: boolean;
}): Promise<{ readonly created: readonly string[]; readonly skipped: readonly string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const kind of SAMPLE_PRIMITIVE_DIRS) {
    const files = await collectTemplateFiles(join(args.sampleDir, kind));
    for (const rel of files.sort()) {
      if (/\.test\.ts(\.tmpl)?$/.test(rel)) continue;
      const dest = join(args.targetDir, 'kindgi', kind, templateTarget(rel));
      if (!args.force && (await args.io.fileExists(dest))) {
        skipped.push(dest);
        continue;
      }
      const raw = await args.io.readFile(join(args.sampleDir, kind, rel));
      await args.io.writeFile(
        dest,
        rel.endsWith('.tmpl') ? substitute(raw, args.substitutions) : raw,
      );
      created.push(dest);
    }
  }
  return { created, skipped };
}

type ReadPkgResult =
  | { readonly kind: 'ok'; readonly pkg: Record<string, unknown> }
  | { readonly kind: 'err'; readonly stderr: string };

async function readSourcePackageJson(
  io: Required<AugmentIOOverrides>,
  pkgJsonPath: string,
): Promise<ReadPkgResult> {
  let raw: string;
  try {
    raw = await io.readFile(pkgJsonPath);
  } catch (err) {
    return { kind: 'err', stderr: `Failed to read ${pkgJsonPath}: ${(err as Error).message}\n` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'err',
      stderr: `Failed to parse ${pkgJsonPath}: ${(err as Error).message}\n`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'err', stderr: `${pkgJsonPath} is not a JSON object.\n` };
  }
  return { kind: 'ok', pkg: parsed as Record<string, unknown> };
}

type PackIdResult =
  | { readonly kind: 'ok'; readonly id: string }
  | { readonly kind: 'err'; readonly stderr: string };

function resolvePackId(rawName: string, override: string | undefined): PackIdResult {
  if (override !== undefined && override !== '') {
    if (!PACK_ID_REGEX.test(override)) {
      return {
        kind: 'err',
        stderr: `Invalid --pack-id: ${override}. Must match ${PACK_ID_REGEX.source}.\n`,
      };
    }
    return { kind: 'ok', id: override };
  }
  const derived = derivePackId(rawName);
  if (derived.kind === 'err') return { kind: 'err', stderr: derived.message };
  return { kind: 'ok', id: derived.id };
}

interface WriteAugmentFilesInputs {
  readonly io: Required<AugmentIOOverrides>;
  readonly targetDir: string;
  readonly configPath: string;
  /** The app is `"type": "module"` — no ESM marker needed under `kindgi/`. */
  readonly esmApp: boolean;
  readonly packId: string;
  readonly packVersion: string;
  readonly packName: string;
  readonly skillsRoot: string | undefined;
  readonly force: boolean;
}

interface WriteAugmentFilesResult {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Write the deterministic parts of the augment scaffold: config,
 * subdirs, skills (merge/force respected). Returns the (created,
 * skipped) split so the caller can still append patcher results.
 */
async function writeAugmentFiles(args: WriteAugmentFilesInputs): Promise<WriteAugmentFilesResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  // Config.
  await args.io.writeFile(
    args.configPath,
    renderAugmentConfig({
      packId: args.packId,
      packVersion: args.packVersion,
      packName: args.packName,
    }),
  );
  created.push(args.configPath);

  // Subdirs.
  for (const sub of AUGMENT_SUBDIRS) {
    const gitkeep = join(args.targetDir, 'kindgi', sub, '.gitkeep');
    await args.io.writeFile(gitkeep, '');
    created.push(gitkeep);
  }

  // In a CommonJS app, mark `kindgi/` as ES modules so primitives stay
  // plain `.ts`. Never overwrite one the author already has.
  if (!args.esmApp) {
    const marker = join(args.targetDir, 'kindgi', 'package.json');
    if (await args.io.fileExists(marker)) {
      skipped.push(marker);
    } else {
      await args.io.writeFile(marker, `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
      created.push(marker);
    }
  }

  // Skills — through `kindgi skills sync`'s own path, so the manifest
  // it keeps is written too (without it, `kindgi dev` reports every
  // freshly installed skill as out of date). Local edits are kept
  // unless --force.
  if (args.skillsRoot !== undefined) {
    const report = await syncSkills({
      skillsRoot: args.skillsRoot,
      targetDir: args.targetDir,
      language: 'node',
      force: args.force,
      dryRun: false,
    });
    for (const o of report.outcomes) {
      const target = join(args.targetDir, '.claude', 'skills', o.name, 'SKILL.md');
      if (o.status === 'added' || o.status === 'updated') created.push(target);
      else if (o.status !== 'local-only') skipped.push(target);
    }
  }

  return { created, skipped };
}

type PatchesResult =
  | {
      readonly kind: 'ok';
      readonly created: readonly string[];
      readonly skipped: readonly string[];
      readonly warnings: readonly string[];
    }
  | { readonly kind: 'err'; readonly stderr: string };

/**
 * Apply the file patchers (package.json, .gitignore, .prettierignore and,
 * for pnpm, pnpm-workspace.yaml) and turn their outcomes into (created,
 * skipped) rows and warnings for the summary. Extracted so
 * `runInitAugment` stays under the complexity ceiling.
 */
async function applyAugmentPatches(args: {
  readonly targetDir: string;
  readonly pkgJsonPath: string;
  readonly specs: KindgiDependencySpecs;
  readonly packageManager: PackageManager;
  readonly extraDependencies?: readonly WantedDependency[];
}): Promise<PatchesResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  const patchPkg = await patchPackageJson(args.pkgJsonPath, args.specs, args.extraDependencies);
  if (patchPkg.kind === 'error') {
    return { kind: 'err', stderr: `Failed to patch ${args.pkgJsonPath}: ${patchPkg.message}\n` };
  }
  if (patchPkg.kind === 'patched') {
    created.push(`${args.pkgJsonPath} (patched: +${patchPkg.added.join(', +')})`);
  } else {
    skipped.push(`${args.pkgJsonPath} (dependencies already declared)`);
  }

  const gitignorePath = join(args.targetDir, '.gitignore');
  const patchGit = await patchGitignore(gitignorePath);
  if (patchGit.kind === 'error') {
    return {
      kind: 'err',
      stderr: `Failed to patch ${gitignorePath}: ${patchGit.message ?? 'unknown error'}\n`,
    };
  }
  if (patchGit.kind === 'patched') {
    created.push(`${gitignorePath} (patched: +${patchGit.appended.join(', +')})`);
  } else {
    skipped.push(`${gitignorePath} (Kindgi patterns already present)`);
  }

  // The app's formatter must not rewrite the Kindgi-managed skills.
  const prettierignorePath = join(args.targetDir, '.prettierignore');
  const patchPrettier = await patchPrettierignore(prettierignorePath);
  if (patchPrettier.kind === 'error') {
    return {
      kind: 'err',
      stderr: `Failed to patch ${prettierignorePath}: ${patchPrettier.message}\n`,
    };
  }
  if (patchPrettier.kind === 'patched') {
    created.push(`${prettierignorePath} (patched: +${patchPrettier.appended.join(', +')})`);
  }

  if (args.packageManager === 'pnpm') {
    const workspace = await decideEsbuildInPnpm(args.targetDir);
    if (workspace.kind === 'err') return workspace;
    created.push(...workspace.created);
    skipped.push(...workspace.skipped);
    warnings.push(...workspace.warnings);
  }

  return { kind: 'ok', created, skipped, warnings };
}

/**
 * A decision for esbuild's install script (`allowBuilds.esbuild: false`) in
 * the `pnpm-workspace.yaml` pnpm reads for the app, unless it has one.
 */
async function decideEsbuildInPnpm(targetDir: string): Promise<PatchesResult> {
  const path = await pnpmWorkspaceFileFor(targetDir);
  const setting = `allowBuilds.${ESBUILD}`;
  const result = await patchPnpmWorkspace(path);
  const rows = { created: [] as string[], skipped: [] as string[], warnings: [] as string[] };
  switch (result.kind) {
    case 'error':
      return { kind: 'err', stderr: `Failed to patch ${path}: ${result.message}\n` };
    case 'created':
      rows.created.push(`${path} (created: ${setting}: ${ESBUILD_DECISION})`);
      break;
    case 'patched':
      rows.created.push(
        result.change === 'placeholder'
          ? `${path} (patched: ${setting} set to ${ESBUILD_DECISION}, replacing pnpm's placeholder)`
          : `${path} (patched: +${setting}: ${ESBUILD_DECISION})`,
      );
      break;
    case 'already-decided':
      rows.skipped.push(`${path} (${setting} already ${result.value})`);
      break;
    case 'refused':
      rows.skipped.push(`${path} (not edited: ${result.reason})`);
      rows.warnings.push(
        `pnpm: couldn't add ${setting}: ${ESBUILD_DECISION} to ${path} (${result.reason}). Add it by hand: without a decision for esbuild's install script, pnpm 11+ stops \`pnpm install\` with ERR_PNPM_IGNORED_BUILDS.`,
      );
      break;
  }
  return { kind: 'ok', ...rows };
}
