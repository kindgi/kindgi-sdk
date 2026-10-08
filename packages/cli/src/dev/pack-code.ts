// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * How `kindgi dev` builds, indexes and runs a pack's code — by its
 * language (`packLanguage` of the pack's config).
 *
 *   - node:   esbuild bundles, the TypeScript indexer in a Node child, the
 *             Node pack service (`@kindgi/handler-runtime`).
 *   - python: no bundling, `python -m kindgi.pack index` and
 *             `python -m kindgi.pack serve` with the pack's own interpreter.
 *   - java:   Maven compiles the pack (`java-builder.ts`), then
 *             `com.kindgi.pack.Main index` and `… serve` (through the
 *             launcher, `kindgi-pack-java`) with the pack's JDK.
 *
 * All run under the pack's environment (`devPackEnv`) and behind the same
 * supervisor and front, so the api-server never knows which it is.
 */

import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackLanguage } from '@kindgi/handler-runtime';

import { devJavaDir } from './paths.js';

/**
 * The pack's code: its language, and how to run it — for Python the
 * interpreter (an argv prefix), for Java the JDK and the build.
 */
export type PackCode =
  | { readonly language: 'node' }
  | { readonly language: 'python'; readonly python: readonly [string, ...string[]] }
  | JavaPackCode;

/** A Java pack's code: the JDK that runs it, the Maven that builds it, where the build's files go. */
export interface JavaPackCode {
  readonly language: 'java';
  /** The JDK's `java`: `<javaHome>/bin/java`, or `java` on `PATH`. */
  readonly java: string;
  /** The JDK's home, passed on as `JAVA_HOME` (Maven's and the launcher's JDK); absent: `java` on `PATH`. */
  readonly javaHome?: string;
  /** Maven, as an argv prefix: `dev.maven`, else the pack's wrapper (`sh mvnw`), else `mvn`. */
  readonly maven: readonly [string, ...string[]];
  /** Where the build's files go (`devJavaDir`): the classpath `@argfile`, the launcher. */
  readonly workDir: string;
  /**
   * `MAVEN_ARGS` and `MAVEN_OPTS` from the host, for Maven only (a machine's
   * own `-s settings.xml`, a proxy): never in the pack's environment.
   */
  readonly mavenEnv?: Readonly<Record<string, string>>;
}

/** The `@argfile` passing a Java pack's classpath to `java` (written by its builder). */
export function javaArgsFile(code: JavaPackCode): string {
  return join(code.workDir, 'java.args');
}

/** The launcher (`kindgi-pack-java`) extracted from the pack's kindgi-pack jar. */
export function javaLauncher(code: JavaPackCode): string {
  return join(code.workDir, 'kindgi-pack-java');
}

/** The environment a Java pack's children run with: the pack's, plus its JDK as `JAVA_HOME`. */
export function javaEnv(
  code: JavaPackCode,
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return code.javaHome === undefined ? env : { ...env, JAVA_HOME: code.javaHome };
}

export const NODE_PACK_CODE: PackCode = { language: 'node' };

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly message: string };

/**
 * The interpreter that runs a Python pack:
 *
 *   1. `dev.python` in the config — a path, or an argv such as
 *      `["uv", "run", "python"]`;
 *   2. the pack's own virtualenv, `.venv/bin/python`;
 *   3. `python3` on `PATH`.
 */
export async function resolvePackPython(
  packDir: string,
  config: Readonly<Record<string, unknown>> | undefined,
): Promise<Outcome<readonly [string, ...string[]]>> {
  const dev = config?.dev;
  const configured =
    dev !== null && typeof dev === 'object' ? (dev as Record<string, unknown>).python : undefined;
  if (configured !== undefined) {
    const argv = typeof configured === 'string' ? [configured] : configured;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((part): part is string => typeof part === 'string' && part !== '')
    ) {
      return {
        kind: 'err',
        message:
          '`dev.python` must be an interpreter path or a non-empty command list (e.g. ["uv", "run", "python"]).',
      };
    }
    return { kind: 'ok', value: argv as unknown as readonly [string, ...string[]] };
  }
  for (const candidate of [
    join(packDir, '.venv', 'bin', 'python'),
    join(packDir, '.venv', 'Scripts', 'python.exe'),
  ]) {
    try {
      await access(candidate);
      return { kind: 'ok', value: [candidate] };
    } catch {
      // next
    }
  }
  return { kind: 'ok', value: ['python3'] };
}

/**
 * The JDK and the Maven that run and build a Java pack:
 *
 *   - the JDK: `dev.javaHome` in the config, else `JAVA_HOME`, else `java`
 *     on `PATH`;
 *   - Maven: `dev.maven` (an argv, such as `["mvn", "-s", "settings.xml"]`),
 *     else the pack's wrapper (`mvnw`, run with `sh`), else `mvn` on `PATH`.
 *
 * A Java pack's service starts through a POSIX shell script (the launcher
 * keeps its token out of the JVM's environment): on Windows, `kindgi dev`
 * runs it under WSL.
 */
export async function resolvePackJava(
  packDir: string,
  config: Readonly<Record<string, unknown>> | undefined,
  hostEnv: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<Outcome<JavaPackCode>> {
  if (platform === 'win32') {
    return {
      kind: 'err',
      message:
        "a Java pack's service starts through a POSIX shell script (kindgi-pack-java), so on Windows run kindgi dev under WSL.",
    };
  }
  const dev = config?.dev;
  const settings = dev !== null && typeof dev === 'object' ? (dev as Record<string, unknown>) : {};
  const configuredHome = settings.javaHome;
  if (
    configuredHome !== undefined &&
    (typeof configuredHome !== 'string' || configuredHome === '')
  ) {
    return { kind: 'err', message: '`dev.javaHome` must be the path of a JDK (17 or later).' };
  }
  const javaHome =
    (configuredHome as string | undefined) ??
    (hostEnv.JAVA_HOME !== undefined && hostEnv.JAVA_HOME !== '' ? hostEnv.JAVA_HOME : undefined);
  const configuredMaven = settings.maven;
  let maven: readonly [string, ...string[]];
  if (configuredMaven !== undefined) {
    const argv = typeof configuredMaven === 'string' ? [configuredMaven] : configuredMaven;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((part): part is string => typeof part === 'string' && part !== '')
    ) {
      return {
        kind: 'err',
        message:
          '`dev.maven` must be a command or a non-empty command list (e.g. ["mvn", "-s", "settings.xml"]).',
      };
    }
    maven = argv as unknown as readonly [string, ...string[]];
  } else if (await isFile(join(packDir, 'mvnw'))) {
    maven = ['sh', join(packDir, 'mvnw')];
  } else {
    maven = ['mvn'];
  }
  const mavenEnv: Record<string, string> = {};
  for (const name of ['MAVEN_ARGS', 'MAVEN_OPTS'] as const) {
    const value = hostEnv[name];
    if (value !== undefined && value !== '') mavenEnv[name] = value;
  }
  return {
    kind: 'ok',
    value: {
      language: 'java',
      java: javaHome === undefined ? 'java' : join(javaHome, 'bin', 'java'),
      ...(javaHome !== undefined && { javaHome }),
      maven,
      workDir: devJavaDir(packDir),
      ...(Object.keys(mavenEnv).length > 0 && { mavenEnv }),
    },
  };
}

/** The pack code for a language, with the interpreter or the JDK resolved. */
export async function resolvePackCode(
  language: PackLanguage,
  packDir: string,
  config: Readonly<Record<string, unknown>> | undefined,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Outcome<PackCode>> {
  if (language === 'node') return { kind: 'ok', value: NODE_PACK_CODE };
  if (language === 'java') return resolvePackJava(packDir, config, hostEnv);
  const python = await resolvePackPython(packDir, config);
  if (python.kind === 'err') return python;
  return { kind: 'ok', value: { language: 'python', python: python.value } };
}

/**
 * Check the pack's Python can run pack code (`import kindgi.pack`), with the
 * pack's environment and from the pack's directory — so a missing
 * virtualenv or package is one clear line at boot instead of an indexer
 * failure.
 */
export async function checkPackPython(
  python: readonly [string, ...string[]],
  env: Readonly<Record<string, string>>,
  packDir?: string,
): Promise<Outcome<string>> {
  const [program, ...prefix] = python;
  const script =
    'import sys, kindgi.pack, kindgi; print(sys.version.split()[0], kindgi.__version__)';
  const { code, stdout, stderr, spawnError } = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    spawnError?: string;
  }>((resolve) => {
    const child = spawn(program, [...prefix, '-c', script], {
      env,
      ...(packDir !== undefined && { cwd: packDir }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.once('error', (cause) =>
      resolve({ code: null, stdout: out, stderr: err, spawnError: cause.message }),
    );
    child.once('close', (exit) => resolve({ code: exit, stdout: out, stderr: err }));
  });
  const shown = python.join(' ');
  if (spawnError !== undefined) {
    return { kind: 'err', message: `the pack's Python (${shown}) did not start: ${spawnError}` };
  }
  if (code !== 0) {
    const last = stderr.trim().split('\n').pop() ?? '';
    const shadow = packDir === undefined ? undefined : join(packDir, 'kindgi', '__init__.py');
    if (shadow !== undefined && (await isFile(shadow))) {
      return {
        kind: 'err',
        message: [
          `the pack's Python (${shown}) cannot import kindgi: ${last}`,
          `    ${shadow} makes the pack's kindgi/ folder a Python package named kindgi, which hides the kindgi SDK.`,
          "    Delete that __init__.py — kindgi/ only holds the pack's files; Kindgi imports them itself.",
        ].join('\n'),
      };
    }
    const lines = [
      `the pack's Python (${shown}) cannot import kindgi: ${last}`,
      "    Install the Kindgi Python SDK into the pack's environment (e.g. `uv add kindgi`, or `pip install kindgi`),",
      '    or point `dev.python` in [tool.kindgi] at an interpreter that has it.',
    ];
    return { kind: 'err', message: lines.join('\n') };
  }
  const [pythonVersion, kindgiVersion] = stdout.trim().split(/\s+/);
  return {
    kind: 'ok',
    value: `Python ${pythonVersion ?? '?'} · kindgi ${kindgiVersion ?? '?'} (${shown})`,
  };
}

/** The oldest JDK a Java pack runs on (kindgi-pack's baseline). */
export const MIN_JAVA_MAJOR = 17;

/**
 * Check a Java pack's JDK (17 or later) and its Maven start, with the pack's
 * environment — so a missing JDK or Maven is one clear line at boot instead
 * of a build failure. Whether the pack has kindgi-pack shows at its first
 * build.
 */
export async function checkPackJava(
  code: JavaPackCode,
  env: Readonly<Record<string, string>>,
  packDir?: string,
): Promise<Outcome<string>> {
  const childEnv = javaEnv(code, env);
  const java = await run(code.java, ['-version'], childEnv, packDir);
  if (java.spawnError !== undefined) {
    return {
      kind: 'err',
      message: [
        `the pack's JDK (${code.java}) did not start: ${java.spawnError}`,
        `    Install a JDK ${MIN_JAVA_MAJOR} or later (e.g. Eclipse Temurin), and set JAVA_HOME to it,`,
        '    or point `dev.javaHome` in kindgi.config.json at one.',
      ].join('\n'),
    };
  }
  const version = /version "([^"]+)"/.exec(`${java.stderr}\n${java.stdout}`)?.[1];
  const major = version === undefined ? undefined : javaMajor(version);
  if (major === undefined || major < MIN_JAVA_MAJOR) {
    return {
      kind: 'err',
      message: [
        `the pack's JDK (${code.java}) is ${version ?? 'of an unknown version'}; a Java pack needs ${MIN_JAVA_MAJOR} or later.`,
        '    Set JAVA_HOME to a newer JDK, or point `dev.javaHome` in kindgi.config.json at one.',
      ].join('\n'),
    };
  }
  const [program, ...prefix] = code.maven;
  const maven = await run(
    program,
    [...prefix, '--version'],
    { ...childEnv, ...code.mavenEnv },
    packDir,
  );
  const shownMaven = code.maven.join(' ');
  if (maven.spawnError !== undefined || maven.code !== 0) {
    const detail =
      maven.spawnError ?? (maven.stderr.trim() || maven.stdout.trim()).split('\n').pop();
    return {
      kind: 'err',
      message: [
        `the pack's Maven (${shownMaven}) did not run: ${detail ?? ''}`,
        '    Add the Maven wrapper to the pack (mvn wrapper:wrapper), install Maven 3.9 or later,',
        '    or point `dev.maven` in kindgi.config.json at one.',
      ].join('\n'),
    };
  }
  const mavenVersion = /Apache Maven (\S+)/.exec(maven.stdout)?.[1] ?? '?';
  return {
    kind: 'ok',
    value: `Java ${version} · Maven ${mavenVersion} (${code.javaHome ?? code.java}; ${shownMaven})`,
  };
}

/** `17.0.6` → 17; `1.8.0_392` → 8. */
export function javaMajor(version: string): number | undefined {
  const parts = version.split(/[.+_-]/);
  const first = Number(parts[0]);
  if (!Number.isInteger(first)) return undefined;
  return first === 1 ? Number(parts[1]) : first;
}

function run(
  program: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, [...args], {
      env,
      ...(cwd !== undefined && { cwd }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.once('error', (cause) =>
      resolve({ code: null, stdout: out, stderr: err, spawnError: cause.message }),
    );
    child.once('close', (exit) => resolve({ code: exit, stdout: out, stderr: err }));
  });
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
