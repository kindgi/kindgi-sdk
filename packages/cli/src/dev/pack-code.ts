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
 *   - scala:  sbt compiles the pack through its server (`scala-builder.ts`),
 *             then the same as Java: kindgi-pack indexes and serves it.
 *
 * All run under the pack's environment (`devPackEnv`) and behind the same
 * supervisor and front, so the api-server never knows which it is.
 */

import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackLanguage } from '@kindgi/handler-runtime';

import { devJvmDir } from './paths.js';

/**
 * The pack's code: its language, and how to run it — for Python the
 * interpreter (an argv prefix), for Java the JDK and the build.
 */
export type PackCode =
  | { readonly language: 'node' }
  | { readonly language: 'python'; readonly python: readonly [string, ...string[]] }
  | JvmPackCode;

/** A JVM pack's code: Java's (built by Maven) or Scala's (built by sbt). */
export type JvmPackCode = JavaPackCode | ScalaPackCode;

/** Whether the pack's code runs on the JVM: kindgi-pack indexes and serves it. */
export function isJvmPackCode(code: PackCode | undefined): code is JvmPackCode {
  return code?.language === 'java' || code?.language === 'scala';
}

/** What every JVM pack's code has: the JDK that runs it, and where its build's files go. */
interface JvmRuntime {
  /** The JDK's `java`: `<javaHome>/bin/java`, or `java` on `PATH`. */
  readonly java: string;
  /** The JDK's home, passed on as `JAVA_HOME` (the build tool's and the launcher's JDK); absent: `java` on `PATH`. */
  readonly javaHome?: string;
  /** Where the build's files go (`devJvmDir`): the classpath `@argfile`, the launcher. */
  readonly workDir: string;
}

/** A Scala pack's code: the JDK that runs it, the sbt that builds it, where the build's files go. */
export interface ScalaPackCode extends JvmRuntime {
  readonly language: 'scala';
  /** sbt, as an argv prefix: `dev.sbt`, else `sbt` on `PATH`. Builds go through its server (`--client`). */
  readonly sbt: readonly [string, ...string[]];
  /** `SBT_OPTS` from the host, for sbt only (a machine's own proxy or memory settings). */
  readonly sbtEnv?: Readonly<Record<string, string>>;
}

/** A Java pack's code: the JDK that runs it, the Maven that builds it, where the build's files go. */
export interface JavaPackCode extends JvmRuntime {
  readonly language: 'java';
  /** Maven, as an argv prefix: `dev.maven`, else the pack's wrapper (`sh mvnw`), else `mvn`. */
  readonly maven: readonly [string, ...string[]];
  /**
   * `MAVEN_ARGS` and `MAVEN_OPTS` from the host, for Maven only (a machine's
   * own `-s settings.xml`, a proxy): never in the pack's environment.
   */
  readonly mavenEnv?: Readonly<Record<string, string>>;
}

/** The `@argfile` passing a JVM pack's classpath to `java` (written by its builder). */
export function javaArgsFile(code: JvmPackCode): string {
  return join(code.workDir, 'java.args');
}

/** The launcher (`kindgi-pack-java`) extracted from the pack's kindgi-pack jar. */
export function javaLauncher(code: JvmPackCode): string {
  return join(code.workDir, 'kindgi-pack-java');
}

/** The environment a JVM pack's children run with: the pack's, plus its JDK as `JAVA_HOME`. */
export function javaEnv(
  code: JvmPackCode,
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
  const runtime = resolveJvmRuntime('java', packDir, config, hostEnv, platform);
  if (runtime.kind === 'err') return runtime;
  const configuredMaven = devSettings(config).maven;
  let maven: readonly [string, ...string[]];
  if (configuredMaven !== undefined) {
    const argv = commandArgv(configuredMaven);
    if (argv === undefined) {
      return {
        kind: 'err',
        message:
          '`dev.maven` must be a command or a non-empty command list (e.g. ["mvn", "-s", "settings.xml"]).',
      };
    }
    maven = argv;
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
      ...runtime.value,
      maven,
      ...(Object.keys(mavenEnv).length > 0 && { mavenEnv }),
    },
  };
}

/**
 * The JDK and the sbt that run and build a Scala pack:
 *
 *   - the JDK, as for a Java pack: `dev.javaHome`, else `JAVA_HOME`, else
 *     `java` on `PATH`;
 *   - sbt: `dev.sbt` (an argv, such as `["sbt", "-Dsbt.override.build.repos=true"]`),
 *     else `sbt` on `PATH`. Builds go through its server (`sbt --client`),
 *     so a save compiles without starting a JVM.
 */
export async function resolvePackScala(
  packDir: string,
  config: Readonly<Record<string, unknown>> | undefined,
  hostEnv: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Promise<Outcome<ScalaPackCode>> {
  const runtime = resolveJvmRuntime('scala', packDir, config, hostEnv, platform);
  if (runtime.kind === 'err') return runtime;
  const configuredSbt = devSettings(config).sbt;
  let sbt: readonly [string, ...string[]] = ['sbt'];
  if (configuredSbt !== undefined) {
    const argv = commandArgv(configuredSbt);
    if (argv === undefined) {
      return {
        kind: 'err',
        message:
          '`dev.sbt` must be a command or a non-empty command list (e.g. ["sbt", "-mem", "2048"]).',
      };
    }
    sbt = argv;
  }
  const sbtOpts = hostEnv.SBT_OPTS;
  return {
    kind: 'ok',
    value: {
      language: 'scala',
      ...runtime.value,
      sbt,
      ...(sbtOpts !== undefined && sbtOpts !== '' && { sbtEnv: { SBT_OPTS: sbtOpts } }),
    },
  };
}

/** A config's `dev` table, or an empty one. */
function devSettings(
  config: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const dev = config?.dev;
  return dev !== null && typeof dev === 'object' ? (dev as Record<string, unknown>) : {};
}

/** A configured command (a string, or a non-empty list of non-empty strings) as an argv; undefined when it's neither. */
function commandArgv(configured: unknown): readonly [string, ...string[]] | undefined {
  const argv = typeof configured === 'string' ? [configured] : configured;
  return Array.isArray(argv) &&
    argv.length > 0 &&
    argv.every((part): part is string => typeof part === 'string' && part !== '')
    ? (argv as unknown as readonly [string, ...string[]])
    : undefined;
}

/**
 * The JDK every JVM pack runs on: `dev.javaHome`, else `JAVA_HOME`, else
 * `java` on `PATH`. A JVM pack's service starts through a POSIX shell script
 * (the launcher keeps its token out of the JVM's environment): on Windows,
 * `kindgi dev` runs it under WSL.
 */
function resolveJvmRuntime(
  language: 'java' | 'scala',
  packDir: string,
  config: Readonly<Record<string, unknown>> | undefined,
  hostEnv: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Outcome<JvmRuntime> {
  const name = language === 'java' ? 'Java' : 'Scala';
  if (platform === 'win32') {
    return {
      kind: 'err',
      message: `a ${name} pack's service starts through a POSIX shell script (kindgi-pack-java), so on Windows run kindgi dev under WSL.`,
    };
  }
  const configuredHome = devSettings(config).javaHome;
  if (
    configuredHome !== undefined &&
    (typeof configuredHome !== 'string' || configuredHome === '')
  ) {
    return { kind: 'err', message: '`dev.javaHome` must be the path of a JDK (17 or later).' };
  }
  const javaHome =
    (configuredHome as string | undefined) ??
    (hostEnv.JAVA_HOME !== undefined && hostEnv.JAVA_HOME !== '' ? hostEnv.JAVA_HOME : undefined);
  return {
    kind: 'ok',
    value: {
      java: javaHome === undefined ? 'java' : join(javaHome, 'bin', 'java'),
      ...(javaHome !== undefined && { javaHome }),
      workDir: devJvmDir(packDir, language),
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
  if (language === 'scala') return resolvePackScala(packDir, config, hostEnv);
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

/** The oldest JDK a JVM pack runs on (kindgi-pack's baseline). */
export const MIN_JAVA_MAJOR = 17;

/**
 * Check a JVM pack's JDK (17 or later) and its build tool (Maven or sbt)
 * start, with the pack's environment — so a missing JDK or build tool is one
 * clear line at boot instead of a build failure. Whether the pack has
 * kindgi-pack shows at its first build.
 */
export async function checkPackJvm(
  code: JvmPackCode,
  env: Readonly<Record<string, string>>,
  packDir?: string,
): Promise<Outcome<string>> {
  const childEnv = javaEnv(code, env);
  const jdk = await checkJdk(code, childEnv, packDir);
  if (jdk.kind === 'err') return jdk;
  const tool =
    code.language === 'scala'
      ? await checkTool(code.sbt, ['--script-version'], { ...childEnv, ...code.sbtEnv }, packDir, {
          name: 'sbt',
          version: /(\d+\.\d+\.\d+\S*)/,
          setting: 'dev.sbt',
          install: 'Install sbt 1.10 or later (https://www.scala-sbt.org/download),',
        })
      : await checkTool(code.maven, ['--version'], { ...childEnv, ...code.mavenEnv }, packDir, {
          name: 'Maven',
          version: /Apache Maven (\S+)/,
          setting: 'dev.maven',
          install:
            'Add the Maven wrapper to the pack (mvn wrapper:wrapper), install Maven 3.9 or later,',
        });
  if (tool.kind === 'err') return tool;
  return {
    kind: 'ok',
    value: `Java ${jdk.value} · ${tool.value} (${code.javaHome ?? code.java}; ${(code.language === 'scala' ? code.sbt : code.maven).join(' ')})`,
  };
}

/** The pack's JDK starts and is 17 or later: its version. */
async function checkJdk(
  code: JvmPackCode,
  env: Readonly<Record<string, string>>,
  packDir: string | undefined,
): Promise<Outcome<string>> {
  const java = await run(code.java, ['-version'], env, packDir);
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
  if (version === undefined || major === undefined || major < MIN_JAVA_MAJOR) {
    return {
      kind: 'err',
      message: [
        `the pack's JDK (${code.java}) is ${version ?? 'of an unknown version'}; a ${code.language === 'java' ? 'Java' : 'Scala'} pack needs ${MIN_JAVA_MAJOR} or later.`,
        '    Set JAVA_HOME to a newer JDK, or point `dev.javaHome` in kindgi.config.json at one.',
      ].join('\n'),
    };
  }
  return { kind: 'ok', value: version };
}

/** The pack's build tool runs: its name and version (`Maven 3.9.9`, `sbt 1.12.15`). */
async function checkTool(
  argv: readonly [string, ...string[]],
  versionArgs: readonly string[],
  env: Readonly<Record<string, string>>,
  packDir: string | undefined,
  about: {
    readonly name: string;
    readonly version: RegExp;
    readonly setting: string;
    readonly install: string;
  },
): Promise<Outcome<string>> {
  const [program, ...prefix] = argv;
  const result = await run(program, [...prefix, ...versionArgs], env, packDir);
  if (result.spawnError !== undefined || result.code !== 0) {
    const detail =
      result.spawnError ?? (result.stderr.trim() || result.stdout.trim()).split('\n').pop();
    return {
      kind: 'err',
      message: [
        `the pack's ${about.name} (${argv.join(' ')}) did not run: ${detail ?? ''}`,
        `    ${about.install}`,
        `    or point \`${about.setting}\` in kindgi.config.json at one.`,
      ].join('\n'),
    };
  }
  return { kind: 'ok', value: `${about.name} ${about.version.exec(result.stdout)?.[1] ?? '?'}` };
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
