// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi init` in an existing Python app — the Python counterpart of the
 * augment scaffolder. Called from `runInit` when `detectInitMode` returns
 * augment mode for a `pyproject.toml`.
 *
 * What it writes:
 *   - `pyproject.toml`, edited in place (`pyproject-patcher.ts`, each edit
 *     verified by re-parsing):
 *       - the `[tool.kindgi]` tables, appended — the pack id from
 *         `[project].name` (PEP 503-normalized), discovery under `kindgi/`,
 *         and for a Poetry app `dev.python = ["poetry", "run", "python"]`;
 *       - `kindgi` in `[project].dependencies`, and — for a uv app, while
 *         the SDK is unpublished — a `[tool.uv.sources]` entry for the
 *         Kindgi checkout's `sdks/python` (a uv app also gets Kindgi's
 *         `[tool.uv] required-version` unless it sets its own). An app whose dependencies can't be
 *         edited that way (Poetry 1, dynamic dependencies) gets the command
 *         to run instead.
 *   - `kindgi/{tools,guardrails,agents,flows}/.gitkeep`
 *   - `.claude/skills/` — the skills written for Python packs
 *   - `.gitignore` — Kindgi's local-state patterns
 *
 * The app's own code, env files, lockfile and virtualenv are left alone:
 * the next steps say to `uv sync` (or the app's equivalent).
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { IMAGE_UV_VERSION, PACK_UV_REQUIRED_VERSION } from '../build/python-image.js';
import { satisfiesSpecifiers } from '../build/version-specifier.js';
import { PACK_ID_REGEX } from '../commands/init.js';
import { syncSkills } from '../commands/skills.js';
import type { CommandResult } from '../commands/types.js';
import { renderJson } from '../output.js';
import { type BinRunner, binDisplay } from '../package-manager.js';
import { CLI_VERSION } from '../version-info.js';
import { agentAccessRows, patchAgentAccess } from './agent-access.js';
import {
  type KindgiPythonSource,
  kindgiCliRequirement,
  kindgiRequirementFor,
  resolveKindgiPythonSource,
} from './dependency-specs.js';
import { patchGitignore } from './gitignore-patcher.js';
import {
  type PyprojectInfo,
  addProjectDependency,
  addTableKey,
  addUvSource,
  appendTables,
  normalizeName,
  readPyproject,
} from './pyproject-patcher.js';

const SUBDIRS = ['agents', 'tools', 'guardrails', 'flows'] as const;
const DEFAULT_VERSION = '0.1.0';

/** How the app installs its dependencies — for the next steps. */
export type PythonInstaller = 'uv' | 'poetry' | 'pip';

export interface RunInitPythonAugmentInputs {
  readonly targetDir: string;
  /** The CLI's home folder: a repository rooted there gets no settings from init (`agent-access.ts`). */
  readonly home?: string;
  readonly skillsRoot?: string;
  readonly packIdOverride?: string;
  /** Overwrite locally edited skills. */
  readonly force: boolean;
  /** This CLI is the PyPI one (`kindgi-cli`): the app runs it from its own environment. */
  readonly pypi?: boolean;
  /** Test seams. */
  readonly pythonSource?: KindgiPythonSource;
  readonly fileExists?: (path: string) => Promise<boolean>;
}

export async function runInitPythonAugment(
  inputs: RunInitPythonAugmentInputs,
): Promise<CommandResult> {
  const fail = (message: string): CommandResult => ({
    kind: 'error',
    stderr: `${message}\n`,
    exitCode: 1,
  });
  const exists = inputs.fileExists ?? fileExists;
  const pyprojectPath = join(inputs.targetDir, 'pyproject.toml');
  const original = await readFile(pyprojectPath, 'utf8');
  const read = readPyproject(original);
  if (read.kind === 'err') return fail(`${pyprojectPath}: ${read.message}`);
  const info = read.info;
  if (info.isPack) {
    return fail(
      `${pyprojectPath} already has a [tool.kindgi] table — this app is a Kindgi pack. Run \`${binDisplay(inputs.pypi === true ? 'uv' : 'path', 'kindgi', ['dev'])}\` here.`,
    );
  }
  const packId = resolvePackId(info, inputs.packIdOverride);
  if (packId.kind === 'err') return fail(packId.message);
  const version = info.version ?? DEFAULT_VERSION;
  const installer = await detectInstaller(inputs.targetDir, info, exists);
  const source = inputs.pythonSource ?? (await resolveKindgiPythonSource());
  if (source.kind === 'error') return fail(source.message);

  // Every pyproject edit is made and verified before anything is written.
  const edited = editPyproject(original, { info, packId: packId.id, version, installer, source });
  if (edited.kind === 'err') return fail(`${pyprojectPath}: ${edited.message}`);

  const created: string[] = [];
  const skipped: string[] = [];
  await writeFile(pyprojectPath, edited.text, 'utf8');
  created.push(`${pyprojectPath} (${edited.changes.join('; ')})`);
  for (const sub of SUBDIRS) {
    const keep = join(inputs.targetDir, 'kindgi', sub, '.gitkeep');
    if (await exists(keep)) {
      skipped.push(keep);
    } else {
      await mkdir(dirname(keep), { recursive: true });
      await writeFile(keep, '', 'utf8');
      created.push(keep);
    }
  }
  if (inputs.skillsRoot !== undefined) {
    const report = await syncSkills({
      skillsRoot: inputs.skillsRoot,
      targetDir: inputs.targetDir,
      language: 'python',
      force: inputs.force,
      dryRun: false,
    });
    for (const o of report.outcomes) {
      const target = join(inputs.targetDir, '.claude', 'skills', o.name, 'SKILL.md');
      if (o.status === 'added' || o.status === 'updated') created.push(target);
      else if (o.status !== 'local-only') skipped.push(target);
    }
  }
  const gitignorePath = join(inputs.targetDir, '.gitignore');
  const gitignore = await patchGitignore(gitignorePath);
  if (gitignore.kind === 'error') {
    return fail(`Failed to patch ${gitignorePath}: ${gitignore.message ?? 'unknown error'}`);
  }
  if (gitignore.kind === 'patched') {
    created.push(`${gitignorePath} (patched: +${gitignore.appended.join(', +')})`);
  }
  // Keep the coding agent out of the files that hold keys (`agent-access.ts`).
  const access = agentAccessRows(
    inputs.targetDir,
    await patchAgentAccess(inputs.targetDir, {
      ...(inputs.home !== undefined && { home: inputs.home }),
    }),
  );
  created.push(...access.created);
  skipped.push(...access.skipped);

  const nextSteps = [
    ...pythonAugmentNextSteps(
      installer,
      edited.dependencyAdded,
      source,
      inputs.pypi === true,
      info.hasKindgiCli,
    ),
    ...uvVersionNote(info.uvRequiredVersion),
  ];
  const summary = {
    kind: 'augment',
    language: 'python',
    targetDir: inputs.targetDir,
    packId: packId.id,
    packVersion: version,
    installer,
    kindgi: source,
    created,
    skipped,
    warnings: access.warnings,
    nextSteps,
  };
  return {
    kind: 'ok',
    rendered: {
      stdout: renderJson(summary, 'json').stdout,
      stderr: [
        '',
        `  Kindgi added to ${inputs.targetDir} (a Python pack in the app).`,
        `  Pack id: ${packId.id}    Version: ${version}`,
        `  Wrote ${created.length} file${created.length === 1 ? '' : 's'}; skipped ${skipped.length}.`,
        ...access.outside.map((line) => `  ✓ ${line}`),
        ...access.warnings.map((warning) => `  ⚠ ${warning}`),
        '',
        '  Next steps:',
        ...nextSteps.map((step) => `    ${step}`),
        '',
        '',
      ].join('\n'),
    },
  };
}

function resolvePackId(
  info: PyprojectInfo,
  override: string | undefined,
):
  | { readonly kind: 'ok'; readonly id: string }
  | { readonly kind: 'err'; readonly message: string } {
  if (override !== undefined && override !== '') {
    return PACK_ID_REGEX.test(override)
      ? { kind: 'ok', id: override }
      : {
          kind: 'err',
          message: `Invalid --pack-id: ${override}. Must match ${PACK_ID_REGEX.source}.`,
        };
  }
  if (info.name === undefined) {
    return {
      kind: 'err',
      message:
        'pyproject.toml has no [project].name (or [tool.poetry].name) to name the pack. Pass `--pack-id=<id>`.',
    };
  }
  const candidate = normalizeName(info.name);
  return PACK_ID_REGEX.test(candidate)
    ? { kind: 'ok', id: candidate }
    : {
        kind: 'err',
        message: `Cannot derive a pack id from the project name "${info.name}" (candidate "${candidate}"); pack ids match ${PACK_ID_REGEX.source}. Pass \`--pack-id=<id>\`.`,
      };
}

/**
 * The app's installer: uv when it says so (a `uv.lock`, `[tool.uv]`, the
 * `uv_build` backend), Poetry likewise, pip for a `requirements.txt` app —
 * otherwise uv, Kindgi's own toolchain.
 */
async function detectInstaller(
  dir: string,
  info: PyprojectInfo,
  exists: (path: string) => Promise<boolean>,
): Promise<PythonInstaller> {
  if (info.usesUv || (await exists(join(dir, 'uv.lock')))) return 'uv';
  if (info.usesPoetry || (await exists(join(dir, 'poetry.lock')))) return 'poetry';
  if (await exists(join(dir, 'requirements.txt'))) return 'pip';
  return 'uv';
}

interface EditInputs {
  readonly info: PyprojectInfo;
  readonly packId: string;
  readonly version: string;
  readonly installer: PythonInstaller;
  readonly source: Exclude<KindgiPythonSource, { kind: 'error' }>;
}

type EditOutcome =
  | {
      readonly kind: 'ok';
      readonly text: string;
      readonly changes: readonly string[];
      /** `kindgi` is (now) one of the project's dependencies. */
      readonly dependencyAdded: boolean;
    }
  | { readonly kind: 'err'; readonly message: string };

function editPyproject(original: string, inputs: EditInputs): EditOutcome {
  let text = original;
  const changes: string[] = [];
  let dependencyAdded = inputs.info.hasKindgiDependency;
  if (inputs.info.dependencyStyle === 'pep621' && !inputs.info.hasKindgiDependency) {
    const requirement = kindgiRequirementFor(inputs.source);
    const dep = addProjectDependency(text, requirement);
    if (dep.kind === 'ok') {
      text = dep.text;
      dependencyAdded = true;
      changes.push(`+${requirement} in [project].dependencies`);
    }
  }
  // uv settings only for an app uv installs — Poetry and pip ignore
  // `[tool.uv]`; their next steps install the SDK by path instead.
  const usesUv = inputs.installer === 'uv';
  // The uv versions the pack works with: the app's own when it sets them
  // (`kindgi build` checks they include the image's uv), else Kindgi's.
  if (usesUv && inputs.info.uvRequiredVersion === undefined) {
    const uvVersion = addTableKey(
      text,
      'tool.uv',
      'required-version',
      JSON.stringify(PACK_UV_REQUIRED_VERSION),
    );
    if (uvVersion.kind === 'err') {
      return {
        kind: 'err',
        message: `could not add [tool.uv] required-version: ${uvVersion.message}`,
      };
    }
    text = uvVersion.text;
    changes.push(`+[tool.uv] required-version = "${PACK_UV_REQUIRED_VERSION}"`);
  }
  if (usesUv && dependencyAdded && inputs.source.kind === 'local-checkout') {
    const uv = addUvSource(
      text,
      'kindgi',
      `{ path = ${JSON.stringify(inputs.source.path)}, editable = true }`,
    );
    if (uv.kind === 'err')
      return { kind: 'err', message: `could not add [tool.uv.sources] kindgi: ${uv.message}` };
    text = uv.text;
    changes.push("+[tool.uv.sources] kindgi (the Kindgi checkout's Python SDK)");
  }
  const poetryDev = inputs.installer === 'poetry';
  const tables = appendTables(text, kindgiTables(inputs.packId, inputs.version, poetryDev), {
    tool: {
      kindgi: {
        pack: { id: inputs.packId, version: inputs.version },
        discovery: Object.fromEntries(SUBDIRS.map((s) => [s, `kindgi/${s}/**/*.py`])),
        ...(poetryDev && { dev: { python: ['poetry', 'run', 'python'] } }),
      },
    },
  });
  if (tables.kind === 'err')
    return { kind: 'err', message: `could not add [tool.kindgi]: ${tables.message}` };
  changes.push('+[tool.kindgi]');
  return { kind: 'ok', text: tables.text, changes, dependencyAdded };
}

/** The appended `[tool.kindgi]` tables. */
export function kindgiTables(packId: string, version: string, poetry: boolean): string {
  const dev = poetry
    ? [
        '[tool.kindgi.dev]',
        'python = ["poetry", "run", "python"]   # the interpreter that runs the pack',
      ]
    : [
        '# [tool.kindgi.dev]',
        '# python = ["uv", "run", "python"]   # default: .venv/bin/python, else python3',
      ];
  return [
    '# The Kindgi pack, added by `kindgi init`: its tools, guardrails, agents and',
    "# flows live under kindgi/ (the app's own packages import by name there).",
    '[tool.kindgi.pack]',
    `id = ${JSON.stringify(packId)}`,
    `version = ${JSON.stringify(version)}`,
    '',
    '[tool.kindgi.discovery]',
    ...SUBDIRS.map((s) => `${s} = "kindgi/${s}/**/*.py"`),
    '',
    ...dev,
    '',
  ].join('\n');
}

/** What to run next, for the app's installer. */
export function pythonAugmentNextSteps(
  installer: PythonInstaller,
  dependencyAdded: boolean,
  source: Exclude<KindgiPythonSource, { kind: 'error' }>,
  pypi = false,
  /** The app lists kindgi-cli already: no step to add it. */
  cliListed = false,
): readonly string[] {
  // From the PyPI CLI, the app runs it from its own environment, and lists it.
  const runner: BinRunner = !pypi
    ? 'path'
    : installer === 'uv'
      ? 'uv'
      : installer === 'poetry'
        ? 'poetry'
        : 'venv';
  const cli = `"${kindgiCliRequirement(CLI_VERSION)}"`;
  const addCli =
    !pypi || cliListed
      ? []
      : [
          `Add the CLI to the app's dev dependencies: ${
            installer === 'uv'
              ? `uv add --dev ${cli}`
              : installer === 'poetry'
                ? `poetry add --group dev ${cli}`
                : `pip install ${cli} (and list it with the app's dev requirements)`
          }`,
        ];
  const sdk = source.kind === 'local-checkout' ? source.path : undefined;
  // Quoted: the range has `<` and `>`, which a shell would read as redirects.
  const requirement = `"${kindgiRequirementFor(source)}"`;
  const install = dependencyAdded
    ? installer === 'uv'
      ? 'Install: uv sync'
      : installer === 'poetry'
        ? `Install: ${sdk === undefined ? 'poetry install' : `poetry add --editable ${sdk}`}`
        : `Install: ${sdk === undefined ? 'pip install -e .' : `pip install -e ${sdk} && pip install -e .`}`
    : `Add the SDK to the app's dependencies: ${
        installer === 'uv'
          ? sdk === undefined
            ? `uv add ${requirement}`
            : `uv add --editable ${sdk}`
          : installer === 'poetry'
            ? sdk === undefined
              ? `poetry add ${requirement}`
              : `poetry add --editable ${sdk}`
            : sdk === undefined
              ? `pip install ${requirement} (and list it with the app’s requirements)`
              : `pip install -e ${sdk}`
      }`;
  return [
    install,
    ...addCli,
    `Boot the dev server: ${binDisplay(runner, 'kindgi', ['dev'])}`,
    'Write tools, guardrails and agents under kindgi/ — see .claude/skills/kindgi-python-getting-started/SKILL.md',
    'Secrets: kindgi dev reads your .env and .env.local; tools read them from os.environ',
    `Model provider: until you register one, agents under kindgi dev answer with its dev-echo fallback (canned replies) — e.g. ${binDisplay(runner, 'kindgi', ['providers', 'register', '--preset=anthropic'])} (ANTHROPIC_API_KEY in .env)`,
  ];
}

/** A next step when the app's own uv range leaves out the uv that builds Kindgi images. */
function uvVersionNote(required: string | undefined): readonly string[] {
  if (required === undefined || satisfiesSpecifiers(IMAGE_UV_VERSION, required) !== false)
    return [];
  return [
    `uv: the app's required-version ("${required}") excludes uv ${IMAGE_UV_VERSION}, which builds Kindgi's images — \`kindgi build\` refuses until it includes it (e.g. "${PACK_UV_REQUIRED_VERSION}")`,
  ];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
