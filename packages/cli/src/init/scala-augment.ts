// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi init` in an existing sbt app (a `build.sbt`, no `package.json`,
 * `pyproject.toml` or `pom.xml`, or `--template=scala`): the app becomes a
 * Scala pack.
 *
 *   - `kindgi.config.json` — the pack's id (the build's `name`, normalized,
 *     or `--pack-id`) and version, with discovery under any `kindgi`
 *     package (`src/main/scala/**\/kindgi/tools/**\/*.scala`, …), so the
 *     app's own `tools` packages are never swept in;
 *   - the `kindgiw` wrappers that run the CLI it pins, and `.gitignore`
 *     entries for the dev token and env files.
 *
 * `build.sbt` isn't edited: the next steps print the
 * `"com.kindgi" %% "kindgi-pack-scala"` dependency to add (an app's build
 * has its own structure — subprojects, a `project/Dependencies.scala` —
 * that an edit could get wrong).
 */

import { chmod, copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PACK_ID_REGEX } from '../commands/init.js';
import { syncSkills } from '../commands/skills.js';
import type { CommandResult } from '../commands/types.js';
import { renderJson } from '../output.js';
import { binDisplay } from '../package-manager.js';
import { CLI_VERSION } from '../version-info.js';
import { type AgentAccessRows, agentAccessRows, patchAgentAccess } from './agent-access.js';
import {
  JVM_PREVIEW,
  type KindgiJavaSource,
  resolveKindgiJavaSource,
  sbtLocalResolver,
} from './dependency-specs.js';
import { patchGitignore } from './gitignore-patcher.js';
import { packIdOf } from './java-augment.js';

const DEFAULT_VERSION = '0.1.0';
const FOLDERS = ['tools', 'guardrails', 'agents', 'flows'] as const;

export interface RunInitScalaAugmentInputs {
  readonly targetDir: string;
  /** Where the java template's `kindgiw` wrappers are. */
  readonly templatesRoot: string;
  /** The skills bundled into the CLI; the ones written for Scala packs are copied. */
  readonly skillsRoot?: string;
  readonly packIdOverride?: string;
  /** Overwrite an existing `kindgi.config.json` and the wrappers. */
  readonly force: boolean;
  /** Test seam: where kindgi-pack comes from (kindgi-pack-scala is its sibling). */
  readonly javaSource?: KindgiJavaSource;
}

/** The build's own `name` and `version` (`name := "…"`, or `ThisBuild / version := "…"`). */
export function readSbtIdentity(build: string): {
  readonly name?: string;
  readonly version?: string;
} {
  const setting = (key: string): string | undefined =>
    new RegExp(`(?:^|\\n)\\s*(?:ThisBuild\\s*/\\s*)?${key}\\s*:=\\s*"([^"]+)"`).exec(build)?.[1];
  const name = setting('name');
  const version = setting('version');
  return { ...(name !== undefined && { name }), ...(version !== undefined && { version }) };
}

/** The line an app's build.sbt adds for kindgi-pack-scala. */
export function kindgiPackScalaDependency(version: string): string {
  return `libraryDependencies += "com.kindgi" %% "kindgi-pack-scala" % "${version}"`;
}

/** Whether the build declares kindgi-pack-scala: in build.sbt, or a project/*.scala it reads. */
async function declaresKindgiPackScala(targetDir: string, build: string): Promise<boolean> {
  const sources = [build];
  for (const name of (await readdir(join(targetDir, 'project')).catch(() => [] as string[])).filter(
    (f) => f.endsWith('.scala'),
  )) {
    sources.push(await readFile(join(targetDir, 'project', name), 'utf8').catch(() => ''));
  }
  return sources.some((text) => /"com\.kindgi"\s*%%\s*"kindgi-pack-scala"/.test(text));
}

export async function runInitScalaAugment(
  inputs: RunInitScalaAugmentInputs,
): Promise<CommandResult> {
  const fail = (message: string): CommandResult => ({
    kind: 'error',
    stderr: `${message}\n`,
    exitCode: 1,
  });
  let build: string;
  try {
    build = await readFile(join(inputs.targetDir, 'build.sbt'), 'utf8');
  } catch {
    return fail(
      `No build.sbt at ${inputs.targetDir}. Adding Kindgi to a Scala app works with sbt; for a separate Scala pack: kindgi init <pack-name> --template=scala --new-repo`,
    );
  }
  const configPath = join(inputs.targetDir, 'kindgi.config.json');
  if ((await exists(configPath)) && !inputs.force) {
    return fail(
      `${configPath} already exists — this app is a Kindgi pack. Run \`${binDisplay('kindgiw', 'kindgi', ['dev'])}\` here (or --force to write it again).`,
    );
  }
  const identity = readSbtIdentity(build);
  const packId = resolvePackId(inputs.packIdOverride, identity.name);
  if (packId.kind === 'err') return fail(packId.message);
  const version = identity.version ?? DEFAULT_VERSION;
  const source = inputs.javaSource ?? (await resolveKindgiJavaSource());
  if (source.kind === 'error') return fail(source.message);

  const written = await writePackFiles(inputs, configPath, packId.value, version);
  if (written.kind === 'err') return fail(written.message);
  const { created, skipped, access } = written;

  const hasDependency = await declaresKindgiPackScala(inputs.targetDir, build);
  const nextSteps = [
    ...installSteps(source),
    ...(hasDependency
      ? []
      : [
          `Add to build.sbt:\n      ${[kindgiPackScalaDependency(source.version), sbtLocalResolver(source)].filter(Boolean).join('\n      ')}`,
        ]),
    "Put tools in a `kindgi.tools` package under your own (e.g. com.acme.app.kindgi.tools), guardrails in `kindgi.guardrails`, agents in `kindgi.agents`, flows in `kindgi.flows`: a file's primitives are the vals of an object named like it",
    `${binDisplay('kindgiw', 'kindgi', ['dev'])}  # the CLI the pack pins (kindgi.config.json "cli"): boots Kindgi locally + compiles and runs the pack through sbt, recompiling on save`,
  ];
  const summary = {
    kind: 'augment',
    language: 'scala',
    targetDir: inputs.targetDir,
    packId: packId.value,
    packVersion: version,
    kindgiPack: source,
    preview: true,
    dependencyInBuild: hasDependency,
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
        `  Kindgi added to ${inputs.targetDir} (a Scala pack in the app; preview).`,
        `  ${JVM_PREVIEW}`,
        `  Pack id: ${packId.value}    Version: ${version}`,
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

/** `kindgi.config.json`, the wrappers and the `.gitignore` entries: what was written, what was kept. */
async function writePackFiles(
  inputs: RunInitScalaAugmentInputs,
  configPath: string,
  packId: string,
  version: string,
): Promise<
  | {
      readonly kind: 'ok';
      readonly created: string[];
      readonly skipped: string[];
      readonly access: AgentAccessRows;
    }
  | { readonly kind: 'err'; readonly message: string }
> {
  const created: string[] = [];
  const skipped: string[] = [];
  const discovery = Object.fromEntries(
    FOLDERS.map((folder) => [folder, `src/main/scala/**/kindgi/${folder}/**/*.scala`]),
  );
  const config = { language: 'scala', cli: CLI_VERSION, pack: { id: packId, version }, discovery };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  created.push(configPath);
  for (const wrapper of ['kindgiw', 'kindgiw.cmd']) {
    const dest = join(inputs.targetDir, wrapper);
    if ((await exists(dest)) && !inputs.force) {
      skipped.push(dest);
      continue;
    }
    await copyFile(join(inputs.templatesRoot, 'java', wrapper), dest);
    if (wrapper === 'kindgiw') await chmod(dest, 0o755);
    created.push(dest);
  }
  await writeSkills(inputs, created, skipped);
  const gitignorePath = join(inputs.targetDir, '.gitignore');
  const gitignore = await patchGitignore(gitignorePath);
  if (gitignore.kind === 'error') {
    return {
      kind: 'err',
      message: `Failed to patch ${gitignorePath}: ${gitignore.message ?? 'unknown error'}`,
    };
  }
  if (gitignore.kind === 'patched') {
    created.push(`${gitignorePath} (patched: +${gitignore.appended.join(', +')})`);
  }
  // Keep the coding agent out of the files that hold keys (`agent-access.ts`).
  const access = agentAccessRows(inputs.targetDir, await patchAgentAccess(inputs.targetDir));
  created.push(...access.created);
  skipped.push(...access.skipped);
  return { kind: 'ok', created, skipped, access };
}

/** The skills written for Scala packs, into `.claude/skills/`, as `kindgi skills sync` writes them. */
async function writeSkills(
  inputs: RunInitScalaAugmentInputs,
  created: string[],
  skipped: string[],
): Promise<void> {
  if (inputs.skillsRoot === undefined) return;
  const report = await syncSkills({
    skillsRoot: inputs.skillsRoot,
    targetDir: inputs.targetDir,
    language: 'scala',
    force: inputs.force,
    dryRun: false,
  });
  for (const o of report.outcomes) {
    const target = join(inputs.targetDir, '.claude', 'skills', o.name, 'SKILL.md');
    if (o.status === 'added' || o.status === 'updated') created.push(target);
    else if (o.status !== 'local-only') skipped.push(target);
  }
}

/** `--pack-id`, else the build's name as a pack id. */
function resolvePackId(
  override: string | undefined,
  name: string | undefined,
):
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'err'; readonly message: string } {
  if (override !== undefined && override !== '') {
    return PACK_ID_REGEX.test(override)
      ? { kind: 'ok', value: override }
      : {
          kind: 'err',
          message: `Invalid --pack-id: ${override}. Must match ${PACK_ID_REGEX.source}.`,
        };
  }
  const candidate = name === undefined ? '' : packIdOf(name);
  if (PACK_ID_REGEX.test(candidate)) return { kind: 'ok', value: candidate };
  return {
    kind: 'err',
    message:
      name === undefined
        ? 'build.sbt has no `name := "…"` to name the pack. Pass `--pack-id=<id>`.'
        : `Cannot derive a pack id from the build's name "${name}" (candidate "${candidate}"); pack ids match ${PACK_ID_REGEX.source}. Pass \`--pack-id=<id>\`.`,
  };
}

/** From a checkout: build kindgi-pack and kindgi-pack-scala first. From Maven Central: nothing to do. */
function installSteps(source: KindgiJavaSource): string[] {
  if (source.kind !== 'local-checkout') return [];
  return [
    `(cd ${source.path} && ./mvnw -q -pl kindgi-pack -am install -DskipTests)  # kindgi-pack ${source.version} into your local Maven repository`,
    `(cd ${join(source.path, '..', 'scala')} && sbt +publishLocal)  # kindgi-pack-scala ${source.version} into your local Ivy repository`,
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
