// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The `PackBuilder` of a Scala pack. sbt compiles the pack through its
 * server (`sbt --client`), so a save compiles without starting a JVM: the
 * first build starts the server and loads the build, the next ones take
 * about a second. Each build runs `compile; export Runtime/fullClasspath`
 * and writes the exported classpath as the `@argfile`, with the launcher
 * extracted from the pack's kindgi-pack jar (`jvm-run-files.ts`), as a Java
 * pack's build does. A change to the build (`*.sbt`, `project/`) reloads it
 * first.
 *
 * The server: when none was running for the pack, `kindgi dev` owns the one
 * its first build starts. It sets the server's idle timeout, so a server
 * whose `kindgi dev` crashed stops by itself, and it shuts the server down
 * when dev stops. A server that was already running (an IDE's) is used as
 * it is and left running.
 *
 * Errors come back located `file:line:col`, from Scala 3's
 * (`-- [E007] Type Mismatch Error: /abs/File.scala:10:31`) and Scala 2's
 * (`/abs/File.scala:10:32: type mismatch;`) reports. A build with errors
 * leaves the previous pack service and index in place.
 */

import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { watch as watchEventsReal } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { delimiter, isAbsolute, join, relative } from 'node:path';

import { runProcess, writeJvmRunFiles } from './jvm-run-files.js';
import { type ScalaPackCode, javaEnv } from './pack-code.js';
import type { PackBuild, PackBuilder } from './runners.js';
import {
  DEFAULT_SCAN_INTERVAL_MS,
  type ScanBackstop,
  scanSignature,
  startScanBackstop,
} from './scan-backstop.js';
import { SHARE_WATCH_BY_DEFAULT, type WatchEvents, directoryWatches } from './shared-watch.js';

const SKIPPED_DIRS = ['target', 'node_modules', 'build', 'out', 'project/project'];
const DEFAULT_DEBOUNCE_MS = 150;

/** How long a server `kindgi dev` started waits idle before it stops by itself. */
export const OWNED_SERVER_IDLE_TIMEOUT = 'FiniteDuration(1, "hour")';

/** The setting that makes a server `kindgi dev` started stop by itself when idle. */
const SET_IDLE_TIMEOUT = `set Global / serverIdleTimeout := Some(scala.concurrent.duration.${OWNED_SERVER_IDLE_TIMEOUT})`;

/** How long `kindgi dev` waits for its sbt server to shut down. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

/** What each build runs: compile, then print the runtime classpath. */
const BUILD_COMMANDS = 'compile; export Runtime/fullClasspath';

export interface ScalaPackBuilderOptions {
  readonly packDir: string;
  readonly code: ScalaPackCode;
  /** The pack's environment (sbt and `java` run with it, plus `JAVA_HOME`). */
  readonly env: () => Promise<Readonly<Record<string, string>>>;
  readonly debounceMs?: number;
  /** How often the sources are also scanned (`fs.watch` can miss events). */
  readonly scanIntervalMs?: number;
  /** Test seam: `node:fs.watch` (a watch of its own, when not `share`). */
  readonly watchFs?: typeof watch;
  /** Share the pack directory's watch with its other watchers (default: on macOS). */
  readonly share?: boolean;
  /** Test seam: `node:fs/promises`'s `watch`, which a shared watch uses. */
  readonly watchEvents?: WatchEvents;
  /** Test seam: what the sources are now (`scalaSourcesSignature`). */
  readonly scanSources?: () => Promise<string>;
  /** Test seam: whether an sbt server answers for the pack (`sbtServerRunning`). */
  readonly serverRunning?: (packDir: string) => Promise<boolean>;
}

/** Whether `relPath` (relative to the pack root) is part of the build: `*.sbt` at the root, or `project/`. */
export function isSbtBuildChange(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/);
  if (segments.length === 1) return relPath.endsWith('.sbt');
  return (
    segments[0] === 'project' &&
    segments.length === 2 &&
    /\.(sbt|scala|properties)$/.test(segments[1] ?? '')
  );
}

/** Whether a change to `relPath` (relative to the pack root) is a change to the pack's code or build. */
export function isScalaSourceChange(relPath: string): boolean {
  const normalized = relPath.split(/[\\/]/).join('/');
  const segments = normalized.split('/');
  if (
    segments.slice(0, -1).some((s) => s.startsWith('.') || SKIPPED_DIRS.includes(s)) ||
    SKIPPED_DIRS.some((d) => d.includes('/') && normalized.startsWith(`${d}/`))
  ) {
    return false;
  }
  const name = segments[segments.length - 1] ?? '';
  if (name.startsWith('.')) return false;
  return isSbtBuildChange(normalized) || (segments[0] === 'src' && segments[1] === 'main');
}

/** The sources and build files a build reads, with their mtimes and sizes (`scan-backstop.ts`). */
export function scalaSourcesSignature(packDir: string): Promise<string> {
  return scanSignature({
    folders: [{ abs: packDir, rel: '' }],
    includes: isScalaSourceChange,
    skipDir: (name) => name.startsWith('.') || SKIPPED_DIRS.includes(name),
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: sbt's output carries ANSI escapes.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Scala 3: `[error] -- [E007] Type Mismatch Error: /abs/File.scala:10:31 ---`. */
const SCALA3_HEADER = /^\[error\] -- (?:\[E\d+\] )?(.*?): (.+\.(?:scala|java)):(\d+):(\d+)\b.*$/;
/** Scala 2 (and javac through sbt): `[error] /abs/File.scala:10:32: type mismatch;`. */
const SCALA2_HEADER = /^\[error\] (\/.+\.(?:scala|java)):(\d+):(\d+): (.*)$/;

/**
 * A Scala 3 report's message: the `|` lines after its header, skipping the
 * quoted source (`10 |`) and the caret, up to a blank `|` or the hint.
 */
function scala3Message(lines: readonly string[], header: number): string[] {
  const message: string[] = [];
  for (let j = header + 1; j < lines.length; j++) {
    const m = /^\[error\]\s+(\d+\s*)?\|(.*)$/.exec(lines[j] ?? '');
    if (m === null) break;
    const text = (m[2] ?? '').trim();
    if (m[1] !== undefined || /^\^+$/.test(text)) continue;
    if (text === '') {
      if (message.length > 0) break;
      continue;
    }
    if (text.startsWith('longer explanation available')) break;
    message.push(text.replace(/\s+/g, ' '));
  }
  return message;
}

/** A Scala 2 report's continuation lines, up to the quoted source line (the one before the caret). */
function scala2Message(lines: readonly string[], header: number): string[] {
  const more: string[] = [];
  for (let j = header + 1; j < lines.length; j++) {
    const body = /^\[error\] (.*)$/.exec(lines[j] ?? '')?.[1];
    if (body === undefined || SCALA2_HEADER.test(lines[j] ?? '')) break;
    if (/^\s*\^\s*$/.test(body)) {
      more.pop();
      break;
    }
    more.push(body.trim().replace(/\s+/g, ' '));
  }
  return more;
}

/**
 * The compiler's errors in sbt's output, `file:line:col: message` with the
 * file relative to the pack root; the last lines of the output when sbt
 * failed some other way.
 */
export function sbtErrors(
  output: string,
  packDirs: string | readonly string[],
  exitCode: number | null,
): string[] {
  const roots = typeof packDirs === 'string' ? [packDirs] : packDirs;
  const located = (file: string): string => {
    if (!isAbsolute(file)) return file;
    const inside = roots
      .map((root) => relative(root, file))
      .find((r) => !r.startsWith('..') && !isAbsolute(r));
    return (inside ?? file).split(/[\\/]/).join('/');
  };
  const lines = output
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trimEnd());
  const errors: string[] = [];
  lines.forEach((line, i) => {
    const three = SCALA3_HEADER.exec(line);
    if (three !== null) {
      const [, kind = '', file = '', row = '0', col = '0'] = three;
      const message = scala3Message(lines, i);
      const said = message.length > 0 ? `: ${message.join('; ')}` : '';
      errors.push(`${located(file)}:${row}:${col}: ${kind}${said}`);
      return;
    }
    const two = SCALA2_HEADER.exec(line);
    if (two !== null) {
      const [, file = '', row = '0', col = '0', first = ''] = two;
      const message = [first.trim(), ...scala2Message(lines, i)].filter((m) => m !== '');
      errors.push(`${located(file)}:${row}:${col}: ${message.join(' ')}`);
    }
  });
  if (errors.length > 0) return [...new Set(errors)];
  const tail = lines
    .filter((l) => l !== '' && !/^\[(info|success)\]/.test(l) && !l.startsWith('>'))
    .slice(-8);
  return [`the pack's sbt build failed (exit ${exitCode}):`, ...tail.map((l) => `    ${l}`)];
}

/**
 * The classpath `export Runtime/fullClasspath` printed: its plain line (no
 * `[info]`-style prefix) naming jars or class directories. Undefined when
 * the output has none.
 */
export function exportedClasspath(output: string): string[] | undefined {
  const lines = output
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (line === '' || line.startsWith('[') || line.startsWith('>')) continue;
    const entries = line.split(delimiter).filter((p) => p !== '');
    if (entries.length > 0 && entries.every((p) => isAbsolute(p))) return entries;
  }
  return undefined;
}

/**
 * Whether an sbt server answers for the pack: `project/target/active.json`
 * names its socket (`local://…`) or port (`tcp://…`), and something accepts
 * a connection there.
 */
export async function sbtServerRunning(packDir: string): Promise<boolean> {
  let uri: string;
  try {
    uri =
      (
        JSON.parse(await readFile(join(packDir, 'project', 'target', 'active.json'), 'utf8')) as {
          uri?: string;
        }
      ).uri ?? '';
  } catch {
    return false;
  }
  const local = /^local:\/\/(.+)$/.exec(uri)?.[1];
  const tcp = /^tcp:\/\/([^:/]+):(\d+)/.exec(uri);
  if (local === undefined && tcp === null) return false;
  return new Promise((resolve) => {
    const socket =
      local !== undefined
        ? createConnection({ path: local })
        : createConnection({ host: tcp?.[1] ?? '127.0.0.1', port: Number(tcp?.[2]) });
    const done = (alive: boolean): void => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function createScalaPackBuilder(options: ScalaPackBuilderOptions): PackBuilder {
  const { packDir, code } = options;
  const watchFs = options.watchFs ?? watch;
  const scan = options.scanSources ?? (() => scalaSourcesSignature(packDir));
  const serverRunning = options.serverRunning ?? sbtServerRunning;
  /** Whether this builder started the pack's sbt server (decided at the first build). */
  let ownsServer: boolean | undefined;
  /** Whether the server's settings need (re)applying: a new server, or a reload. */
  let fresh = true;
  let buildChanged = false;
  let watcher: FSWatcher | undefined;
  let unsubscribe: (() => void) | undefined;
  let backstop: ScanBackstop | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sbtEnv = async (): Promise<Readonly<Record<string, string>>> => ({
    ...javaEnv(code, await options.env()),
    ...code.sbtEnv,
  });

  function client(command: string, env: Readonly<Record<string, string>>, timeoutMs?: number) {
    const [program, ...prefix] = code.sbt;
    return runProcess(program, [...prefix, '--client', command], env, packDir, timeoutMs);
  }

  /**
   * What the server needs before a build: a reload when the build changed
   * (or when it isn't ours, which may predate the files), and, on a server
   * this builder started, its idle timeout (again after a reload, or when
   * the old one stopped and the build will start another).
   */
  async function serverSteps(): Promise<string[]> {
    await checkServer();
    const reload = buildChanged && (!fresh || !ownsServer);
    const idleTimeout = ownsServer === true && (fresh || buildChanged);
    return [...(reload ? ['reload'] : []), ...(idleTimeout ? [SET_IDLE_TIMEOUT] : [])];
  }

  /** Whose server it is (at the first build), and whether ours stopped since. */
  async function checkServer(): Promise<void> {
    if (ownsServer === undefined) {
      ownsServer = !(await serverRunning(packDir));
      if (!ownsServer) buildChanged = true;
    } else if (ownsServer && !(await serverRunning(packDir))) {
      fresh = true;
    }
  }

  async function build(): Promise<PackBuild> {
    const env = await sbtEnv();
    await mkdir(code.workDir, { recursive: true });
    const sbt = await client([...(await serverSteps()), BUILD_COMMANDS].join('; '), env);
    if (sbt.code !== 0) {
      const roots = [packDir, await realpath(packDir).catch(() => packDir)];
      return { kind: 'err', errors: sbtErrors(`${sbt.stdout}\n${sbt.stderr}`, roots, sbt.code) };
    }
    fresh = false;
    buildChanged = false;
    const classpath = exportedClasspath(sbt.stdout);
    if (classpath === undefined) {
      return {
        kind: 'err',
        errors: ['sbt printed no classpath (`export Runtime/fullClasspath`):', sbt.stdout.trim()],
      };
    }
    const errors = await writeJvmRunFiles({
      code,
      packDir,
      env: javaEnv(code, await options.env()),
      classpath,
      missingKindgiPack:
        'com.kindgi.pack isn\'t on the pack\'s classpath: add "com.kindgi" %% "kindgi-pack-scala" to build.sbt\'s libraryDependencies.',
    });
    return errors.length > 0 ? { kind: 'err', errors } : { kind: 'ok', bundleMap: {} };
  }

  return {
    build,
    async watch(onBuild) {
      if (watcher !== undefined || unsubscribe !== undefined) return;
      const schedule = (rel?: string): void => {
        if (rel !== undefined && isSbtBuildChange(rel.split(/[\\/]/).join('/')))
          buildChanged = true;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          void (backstop?.mark() ?? Promise.resolve()).then(build).then(onBuild);
        }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
      };
      if (options.share ?? SHARE_WATCH_BY_DEFAULT) {
        unsubscribe = directoryWatches(options.watchEvents ?? watchEventsReal).subscribe(
          packDir,
          (rel) => {
            if (rel !== undefined && isScalaSourceChange(rel)) schedule(rel);
          },
          // A rescan can't say what changed: reload, to be sure the build is current.
          () => {
            buildChanged = true;
            schedule();
          },
        );
      } else {
        watcher = watchFs(packDir, { recursive: true }, (_event, filename) => {
          if (filename === null || !isScalaSourceChange(filename.toString())) return;
          schedule(filename.toString());
        });
      }
      backstop = await startScanBackstop({
        scan,
        intervalMs: options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
        onChange: () => {
          buildChanged = true;
          schedule();
        },
      });
    },
    // New or removed files need no entry list: sbt compiles what is there.
    syncEntries: () => Promise.resolve(false),
    async dispose() {
      if (timer !== undefined) clearTimeout(timer);
      backstop?.stop();
      backstop = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      watcher?.close();
      watcher = undefined;
      if (ownsServer === true && (await serverRunning(packDir))) {
        await client('shutdown', await sbtEnv(), SHUTDOWN_TIMEOUT_MS);
        // The client returns before the server has stopped: wait for it, so dev never outlives it.
        const until = Date.now() + SHUTDOWN_TIMEOUT_MS;
        while (Date.now() < until && (await serverRunning(packDir))) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    },
  };
}
