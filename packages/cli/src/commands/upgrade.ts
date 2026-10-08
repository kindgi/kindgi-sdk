// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { chmod, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { KINDGI_JSON_CONFIG_FILENAME, findKindgiConfig } from '@kindgi/handler-runtime';

import { CLI_PIN_KEY, PINNABLE_VERSION, writeCliPin } from '../cli-pin.js';
import { renderJson } from '../output.js';
import { CLI_VERSION } from '../version-info.js';
import { defaultTemplatesRoot } from './init.js';
import type { CommandResult, LeafCommand } from './types.js';

/** The Java template's wrappers, written next to `kindgi.config.json` when missing. */
const WRAPPERS = ['kindgiw', 'kindgiw.cmd'] as const;

/** `<kindgi.version>…</kindgi.version>`: the property the java template's pom.xml uses. */
const POM_KINDGI_VERSION = /(<kindgi\.version>)\s*([^<\s]+)\s*(<\/kindgi\.version>)/;

/** `"com.kindgi" %% "kindgi-pack-scala" % "…"`: the dependency the scala template's build.sbt has. */
const SBT_KINDGI_VERSION = /("com\.kindgi"\s*%%\s*"kindgi-pack-scala"\s*%\s*")([^"]+)(")/;

/**
 * `kindgi upgrade`: moves a JVM pack's pin of the Kindgi CLI (`"cli"` in
 * `kindgi.config.json`, which `kindgiw` runs) to this CLI's version or
 * `--to`, and the kindgi-pack version its build declares with it: a Java
 * pack's `pom.xml` `kindgi.version` property, a Scala pack's `build.sbt`
 * `kindgi-pack-scala` dependency. Writes `kindgiw` and `kindgiw.cmd` when
 * the pack has none.
 */
export const upgradeCommand: LeafCommand = {
  kind: 'leaf',
  name: 'upgrade',
  description:
    "Move a Java or Scala pack's pin of the Kindgi CLI (\"cli\" in kindgi.config.json, which ./kindgiw runs) and its build's kindgi-pack version (pom.xml's kindgi.version, build.sbt's kindgi-pack-scala) to this CLI's version, or --to. A TypeScript or Python pack upgrades through its package manager.",
  usage: 'kindgi upgrade [--to=<version>] [--path=<dir>]',
  optionSpec: {
    to: {
      type: 'string',
      description: "The version to pin. Default: this CLI's.",
    },
    path: {
      type: 'string',
      description: 'The pack root. Default: the current directory.',
    },
  },
  run: async (ctx): Promise<CommandResult> => {
    const packDir = resolve(ctx.cwd, typeof ctx.options.path === 'string' ? ctx.options.path : '.');
    const target =
      typeof ctx.options.to === 'string' && ctx.options.to !== '' ? ctx.options.to : CLI_VERSION;
    if (!PINNABLE_VERSION.test(target)) {
      return { kind: 'error', stderr: `kindgi upgrade: not a version: ${target}\n`, exitCode: 2 };
    }
    const config = await findKindgiConfig(packDir);
    if (config === undefined) {
      return {
        kind: 'error',
        stderr: `kindgi upgrade: no pack at ${packDir} (no ${KINDGI_JSON_CONFIG_FILENAME}).\n`,
        exitCode: 1,
      };
    }
    if (config.format !== 'json') {
      const how =
        config.format === 'pyproject'
          ? `uv add --dev "kindgi-cli==${target}" (and "kindgi==${target}" in its dependencies)`
          : `your package manager: pnpm add -D @kindgi/cli@${target} (and @kindgi/sdk@${target})`;
      return {
        kind: 'error',
        stderr: `kindgi upgrade moves a Java or Scala pack's pin. This pack's CLI is a dependency: upgrade it with ${how}.\n`,
        exitCode: 1,
      };
    }
    const changes: string[] = [];
    const { previous } = await writeCliPin(config.path, target);
    changes.push(
      `${KINDGI_JSON_CONFIG_FILENAME} "${CLI_PIN_KEY}": ${previous ?? '(none)'} → ${target}`,
    );

    const scala = await isScalaPack(config.path);
    const pomNote = scala
      ? await moveSbtVersion(packDir, target, changes)
      : await movePomVersion(packDir, target, changes);

    for (const wrapper of WRAPPERS) {
      const dest = join(packDir, wrapper);
      if (await exists(dest)) continue;
      await copyFile(join(defaultTemplatesRoot(), 'java', wrapper), dest);
      if (wrapper === 'kindgiw') await chmod(dest, 0o755);
      changes.push(`wrote ${wrapper}`);
    }

    const stderr = [
      `✓ ${packDir} now runs the Kindgi CLI ${target}`,
      ...changes.map((c) => `  ${c}`),
      ...(pomNote === undefined ? [] : [`  ${pomNote}`]),
      '',
      'Run it as ./kindgiw <command> (kindgiw.cmd on Windows).',
      '',
    ].join('\n');
    return {
      kind: 'ok',
      rendered: {
        stdout: renderJson(
          {
            packDir,
            cli: target,
            previous: previous ?? null,
            changes,
            ...(pomNote && { note: pomNote }),
          },
          ctx.globals.format,
        ).stdout,
        stderr,
      },
    };
  },
};

/** A `kindgi.config.json` that says `"language": "scala"`. */
async function isScalaPack(configPath: string): Promise<boolean> {
  try {
    return (
      (JSON.parse(await readFile(configPath, 'utf8')) as { language?: unknown }).language ===
      'scala'
    );
  } catch {
    return false;
  }
}

/** Moves the pom's `kindgi.version` to `target`; what to do by hand when it can't. */
async function movePomVersion(
  packDir: string,
  target: string,
  changes: string[],
): Promise<string | undefined> {
  const pomPath = join(packDir, 'pom.xml');
  let pom: string;
  try {
    pom = await readFile(pomPath, 'utf8');
  } catch {
    return 'No pom.xml: set the com.kindgi:kindgi-pack version where your build declares it.';
  }
  const match = POM_KINDGI_VERSION.exec(pom);
  if (match === null) return `Set the com.kindgi:kindgi-pack version in pom.xml to ${target}.`;
  if (match[2] !== target) {
    await writeFile(pomPath, pom.replace(POM_KINDGI_VERSION, `$1${target}$3`), 'utf8');
    changes.push(`pom.xml kindgi.version: ${match[2]} → ${target}`);
  }
  return undefined;
}

/** Moves `build.sbt`'s kindgi-pack-scala version to `target`; what to do by hand when it can't. */
async function moveSbtVersion(
  packDir: string,
  target: string,
  changes: string[],
): Promise<string | undefined> {
  const buildPath = join(packDir, 'build.sbt');
  let build: string;
  try {
    build = await readFile(buildPath, 'utf8');
  } catch {
    return 'No build.sbt: set the kindgi-pack-scala version where your build declares it.';
  }
  const match = SBT_KINDGI_VERSION.exec(build);
  if (match === null) {
    return `Set the "com.kindgi" %% "kindgi-pack-scala" version where your build declares it (build.sbt, project/*.scala) to ${target}.`;
  }
  if (match[2] !== target) {
    await writeFile(buildPath, build.replace(SBT_KINDGI_VERSION, `$1${target}$3`), 'utf8');
    changes.push(`build.sbt kindgi-pack-scala: ${match[2]} → ${target}`);
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
