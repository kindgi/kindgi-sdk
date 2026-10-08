// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi init` in an existing Maven app (a `pom.xml`, no `package.json` or
 * `pyproject.toml`, or `--template=java`): the app becomes a Java pack.
 *
 *   - `kindgi.config.json` — the pack's id (the app's `artifactId`,
 *     normalized, or `--pack-id`) and version, with discovery under any
 *     `kindgi` package (`src/main/java/**\/kindgi/tools/**\/*.java`, …), so the
 *     app's own `tools` packages are never swept in;
 *   - the Kindgi skills for Java packs, and `.gitignore` entries for the dev
 *     token and env files.
 *
 * `pom.xml` isn't edited: the next steps print the `com.kindgi:kindgi-pack`
 * dependency to add (an app's pom has its own structure — a parent, BOMs,
 * profiles — that an edit could get wrong).
 */

import { chmod, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PACK_ID_REGEX } from '../commands/init.js';
import { syncSkills } from '../commands/skills.js';
import type { CommandResult } from '../commands/types.js';
import { renderJson } from '../output.js';
import { binDisplay } from '../package-manager.js';
import { CLI_VERSION } from '../version-info.js';
import {
  KINDGI_PACK_ON_MAVEN_CENTRAL,
  type KindgiJavaSource,
  resolveKindgiJavaSource,
} from './dependency-specs.js';
import { patchGitignore } from './gitignore-patcher.js';

const DEFAULT_VERSION = '0.1.0';
const FOLDERS = ['tools', 'guardrails', 'agents', 'flows'] as const;

export interface RunInitJavaAugmentInputs {
  readonly targetDir: string;
  /** Where the java template's `kindgiw` wrappers are. */
  readonly templatesRoot: string;
  readonly skillsRoot?: string;
  readonly packIdOverride?: string;
  /** Overwrite an existing `kindgi.config.json` and the skills. */
  readonly force: boolean;
  /** Test seam: where kindgi-pack comes from. */
  readonly javaSource?: KindgiJavaSource;
}

/** The pom's own `artifactId` and `version` (not its parent's). */
export function readPomIdentity(pom: string): {
  readonly artifactId?: string;
  readonly version?: string;
} {
  // The parent block names the parent's coordinates: drop it first.
  const own = pom.replace(/<parent>[\s\S]*?<\/parent>/, '').replace(/<dependencies>[\s\S]*$/, '');
  const artifactId = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(own)?.[1];
  const version = /<version>\s*([^<\s]+)\s*<\/version>/.exec(own)?.[1];
  return {
    ...(artifactId !== undefined && { artifactId }),
    ...(version !== undefined && !version.includes('${') && { version }),
  };
}

/** An artifactId as a pack id: lowercase, hyphens for anything else, starting with a letter. */
export function packIdOf(artifactId: string): string {
  return artifactId
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '');
}

/** The dependency an app's pom.xml adds for kindgi-pack. */
export function kindgiPackDependency(version: string): string {
  return [
    '<dependency>',
    '  <groupId>com.kindgi</groupId>',
    '  <artifactId>kindgi-pack</artifactId>',
    `  <version>${version}</version>`,
    '</dependency>',
  ].join('\n');
}

export async function runInitJavaAugment(inputs: RunInitJavaAugmentInputs): Promise<CommandResult> {
  const fail = (message: string): CommandResult => ({
    kind: 'error',
    stderr: `${message}\n`,
    exitCode: 1,
  });
  const pomPath = join(inputs.targetDir, 'pom.xml');
  let pom: string;
  try {
    pom = await readFile(pomPath, 'utf8');
  } catch {
    return fail(
      `No pom.xml at ${inputs.targetDir}. Adding Kindgi to a Java app works with Maven; for a separate Java pack: kindgi init <pack-name> --template=java --new-repo`,
    );
  }
  const configPath = join(inputs.targetDir, 'kindgi.config.json');
  if ((await exists(configPath)) && !inputs.force) {
    return fail(
      `${configPath} already exists — this app is a Kindgi pack. Run \`${binDisplay('kindgiw', 'kindgi', ['dev'])}\` here (or --force to write it again).`,
    );
  }
  const identity = readPomIdentity(pom);
  let packId: string;
  if (inputs.packIdOverride !== undefined && inputs.packIdOverride !== '') {
    if (!PACK_ID_REGEX.test(inputs.packIdOverride)) {
      return fail(
        `Invalid --pack-id: ${inputs.packIdOverride}. Must match ${PACK_ID_REGEX.source}.`,
      );
    }
    packId = inputs.packIdOverride;
  } else {
    const candidate = identity.artifactId === undefined ? '' : packIdOf(identity.artifactId);
    if (!PACK_ID_REGEX.test(candidate)) {
      return fail(
        identity.artifactId === undefined
          ? 'pom.xml has no <artifactId> to name the pack. Pass `--pack-id=<id>`.'
          : `Cannot derive a pack id from the artifactId "${identity.artifactId}" (candidate "${candidate}"); pack ids match ${PACK_ID_REGEX.source}. Pass \`--pack-id=<id>\`.`,
      );
    }
    packId = candidate;
  }
  const version = identity.version ?? DEFAULT_VERSION;
  const source = inputs.javaSource ?? (await resolveKindgiJavaSource());
  if (source.kind === 'error') return fail(source.message);

  const created: string[] = [];
  const skipped: string[] = [];
  const discovery = Object.fromEntries(
    FOLDERS.map((folder) => [folder, `src/main/java/**/kindgi/${folder}/**/*.java`]),
  );
  const config = { language: 'java', cli: CLI_VERSION, pack: { id: packId, version }, discovery };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  created.push(configPath);
  // The wrappers that run the pinned CLI (`cli` above).
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

  if (inputs.skillsRoot !== undefined) {
    const report = await syncSkills({
      skillsRoot: inputs.skillsRoot,
      targetDir: inputs.targetDir,
      language: 'java',
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

  const hasDependency = /<artifactId>\s*kindgi-pack\s*<\/artifactId>/.test(pom);
  const nextSteps = [
    ...(source.kind === 'local-checkout'
      ? [
          `(cd ${source.path} && ./mvnw -q install -DskipTests)  # kindgi-pack ${source.version} into your local Maven repository`,
        ]
      : KINDGI_PACK_ON_MAVEN_CENTRAL
        ? []
        : [
            `# kindgi-pack ${source.version} isn't on Maven Central yet: build it from the Kindgi SDK repository (sdks/java: ./mvnw install)`,
          ]),
    ...(hasDependency
      ? []
      : [
          `Add to pom.xml's <dependencies>:\n${kindgiPackDependency(source.version)
            .split('\n')
            .map((l) => `      ${l}`)
            .join('\n')}`,
        ]),
    'Put tools in a `kindgi.tools` package under your own (e.g. com.acme.app.kindgi.tools), guardrails in `kindgi.guardrails`, agents in `kindgi.agents`, flows in `kindgi.flows`',
    `${binDisplay('kindgiw', 'kindgi', ['dev'])}  # the CLI the pack pins (kindgi.config.json "cli"): boots Kindgi locally + compiles and runs the pack with Maven, recompiling on save`,
  ];
  const summary = {
    kind: 'augment',
    language: 'java',
    targetDir: inputs.targetDir,
    packId,
    packVersion: version,
    kindgiPack: source,
    dependencyInPom: hasDependency,
    created,
    skipped,
    nextSteps,
  };
  return {
    kind: 'ok',
    rendered: {
      stdout: renderJson(summary, 'json').stdout,
      stderr: [
        '',
        `  Kindgi added to ${inputs.targetDir} (a Java pack in the app).`,
        `  Pack id: ${packId}    Version: ${version}`,
        `  Wrote ${created.length} file${created.length === 1 ? '' : 's'}; skipped ${skipped.length}.`,
        '',
        '  Next steps:',
        ...nextSteps.map((step) => `    ${step}`),
        '',
        '',
      ].join('\n'),
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
