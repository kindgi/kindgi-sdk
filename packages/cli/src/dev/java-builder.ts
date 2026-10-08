// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The `PackBuilder` of a Java pack. Maven compiles the pack
 * (`target/classes`) and, the first time and whenever `pom.xml` changes,
 * resolves its classpath. The build writes the classpath as an `@argfile`
 * (`java.args`), which the indexer and the pack service pass to `java`, so
 * their commands stay the same while the classpath changes; and it
 * extracts the launcher (`kindgi-pack-java`) from the pack's own
 * kindgi-pack jar, so the launcher always matches the service it starts.
 *
 * javac's errors come back located `file:line:col`, as the bundler's do for
 * a Node pack. A build with errors leaves the previous pack service and
 * index in place.
 *
 * The watch covers the pack's sources and resources (`src/main/**`) and
 * `pom.xml`, with a scan behind it (`scan-backstop.ts`): `fs.watch` can
 * drop events.
 */

import { spawn } from 'node:child_process';
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { watch as watchEventsReal } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative } from 'node:path';

import { type JavaPackCode, javaArgsFile, javaEnv, javaLauncher } from './pack-code.js';
import type { PackBuild, PackBuilder } from './runners.js';
import {
  DEFAULT_SCAN_INTERVAL_MS,
  type ScanBackstop,
  scanSignature,
  startScanBackstop,
} from './scan-backstop.js';
import { SHARE_WATCH_BY_DEFAULT, type WatchEvents, directoryWatches } from './shared-watch.js';

const SKIPPED_DIRS = ['target', 'node_modules', 'build', 'out'];

/**
 * The dependency plugin, named in full: Maven then needs no plugin-prefix
 * lookup (remote metadata), and every pack resolves its classpath with the
 * same version.
 */
export const MAVEN_DEPENDENCY_PLUGIN = 'org.apache.maven.plugins:maven-dependency-plugin:3.11.0';
const DEFAULT_DEBOUNCE_MS = 150;

export interface JavaPackBuilderOptions {
  readonly packDir: string;
  readonly code: JavaPackCode;
  /** The pack's environment (Maven and `java` run with it, plus `JAVA_HOME`). */
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
  /** Test seam: what the sources are now (`javaSourcesSignature`). */
  readonly scanSources?: () => Promise<string>;
}

/** Whether a change to `relPath` (relative to the pack root) is a change to the pack's code. */
export function isJavaSourceChange(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/);
  if (segments.slice(0, -1).some((s) => s.startsWith('.') || SKIPPED_DIRS.includes(s))) {
    return false;
  }
  const name = segments[segments.length - 1] ?? '';
  if (name.startsWith('.')) return false;
  return relPath === 'pom.xml' || (segments[0] === 'src' && segments[1] === 'main');
}

/** The sources a build reads, with their mtimes and sizes (`scan-backstop.ts`). */
export function javaSourcesSignature(packDir: string): Promise<string> {
  return scanSignature({
    folders: [{ abs: packDir, rel: '' }],
    includes: isJavaSourceChange,
    skipDir: (name) => name.startsWith('.') || SKIPPED_DIRS.includes(name),
  });
}

/** One located compiler error, from Maven's `[ERROR] /abs/File.java:[line,col] message`. */
const COMPILER_ERROR = /^\[ERROR\] (.+\.java):\[(\d+),(\d+)\] (.*)$/;

/**
 * javac's errors in Maven's output, `file:line:col: message` with the file
 * relative to the pack root; the last lines of the output when Maven failed
 * some other way.
 */
export function mavenErrors(
  output: string,
  packDirs: string | readonly string[],
  exitCode: number | null,
): string[] {
  // The pack root as given, and as Maven may report it (symlinks resolved: /var → /private/var).
  const roots = typeof packDirs === 'string' ? [packDirs] : packDirs;
  const located: string[] = [];
  for (const line of output.split('\n')) {
    const m = COMPILER_ERROR.exec(line.trimEnd());
    if (m === null) continue;
    const [, file = '', row = '0', col = '0', message = ''] = m;
    let rel = file;
    if (isAbsolute(file)) {
      const inside = roots
        .map((root) => relative(root, file))
        .find((r) => !r.startsWith('..') && !isAbsolute(r));
      rel = (inside ?? file).split(/[\\/]/).join('/');
    }
    located.push(`${rel}:${row}:${col}: ${message}`);
  }
  if (located.length > 0) return [...new Set(located)];
  const tail = output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '' && !l.startsWith('[INFO]'))
    .slice(-8);
  return [`the pack's Maven build failed (exit ${exitCode}):`, ...tail.map((l) => `    ${l}`)];
}

/** A classpath as a `java` `@argfile` line: quoted, with `\` and `"` escaped. */
export function argsFileText(classpath: readonly string[]): string {
  const quoted = classpath.join(delimiter).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `-cp "${quoted}"\n`;
}

export function createJavaPackBuilder(options: JavaPackBuilderOptions): PackBuilder {
  const { packDir, code } = options;
  const watchFs = options.watchFs ?? watch;
  const scan = options.scanSources ?? (() => javaSourcesSignature(packDir));
  const classpathFile = join(code.workDir, 'classpath.txt');
  let resolvedFor: string | undefined;
  let watcher: FSWatcher | undefined;
  let unsubscribe: (() => void) | undefined;
  let backstop: ScanBackstop | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function build(): Promise<PackBuild> {
    const env = javaEnv(code, await options.env());
    await mkdir(code.workDir, { recursive: true });
    // The classpath is resolved (online) the first time and when pom.xml
    // changes; otherwise the compile runs offline, so a save never waits on
    // the network.
    const pom = await signatureOf(join(packDir, 'pom.xml'));
    const resolve = resolvedFor === undefined || resolvedFor !== pom;
    const [program, ...prefix] = code.maven;
    const goals = resolve
      ? [
          'compile',
          `${MAVEN_DEPENDENCY_PLUGIN}:build-classpath`,
          `-Dmdep.outputFile=${classpathFile}`,
        ]
      : ['-o', 'compile'];
    const maven = await runProcess(
      program,
      [...prefix, '-B', '-q', ...goals],
      { ...env, ...code.mavenEnv },
      packDir,
    );
    if (maven.code !== 0) {
      const roots = [packDir, await realpath(packDir).catch(() => packDir)];
      return {
        kind: 'err',
        errors: mavenErrors(`${maven.stdout}\n${maven.stderr}`, roots, maven.code),
      };
    }
    if (resolve) resolvedFor = pom;
    let dependencies: string[];
    try {
      dependencies = (await readFile(classpathFile, 'utf8'))
        .trim()
        .split(delimiter)
        .filter((p) => p !== '');
    } catch (cause) {
      return {
        kind: 'err',
        errors: [`Maven wrote no classpath (${classpathFile}): ${(cause as Error).message}`],
      };
    }
    const argsText = argsFileText([join(packDir, 'target', 'classes'), ...dependencies]);
    const argsPath = javaArgsFile(code);
    const changed = (await readFile(argsPath, 'utf8').catch(() => '')) !== argsText;
    if (changed) await writeAtomically(argsPath, argsText);
    const launcherPath = javaLauncher(code);
    if (changed || !(await exists(launcherPath))) {
      const launcher = await runProcess(
        code.java,
        [`@${argsPath}`, 'com.kindgi.pack.Main', 'launcher'],
        env,
        packDir,
      );
      if (launcher.code !== 0 || !launcher.stdout.startsWith('#!')) {
        const missing = /ClassNotFoundException|Could not find or load main class/.test(
          launcher.stderr,
        );
        return {
          kind: 'err',
          errors: missing
            ? [
                "com.kindgi.pack isn't on the pack's classpath: add the com.kindgi:kindgi-pack dependency to pom.xml.",
              ]
            : [`kindgi-pack's launcher could not be written: ${launcher.stderr.trim()}`],
        };
      }
      await writeAtomically(launcherPath, launcher.stdout);
    }
    return { kind: 'ok', bundleMap: {} };
  }

  return {
    build,
    async watch(onBuild) {
      if (watcher !== undefined || unsubscribe !== undefined) return;
      const schedule = (): void => {
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
            if (rel !== undefined && isJavaSourceChange(rel)) schedule();
          },
          schedule,
        );
      } else {
        watcher = watchFs(packDir, { recursive: true }, (_event, filename) => {
          if (filename === null || !isJavaSourceChange(filename.toString())) return;
          schedule();
        });
      }
      backstop = await startScanBackstop({
        scan,
        intervalMs: options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
        onChange: schedule,
      });
    },
    // New or removed files need no entry list: Maven compiles what is there.
    syncEntries: () => Promise.resolve(false),
    async dispose() {
      if (timer !== undefined) clearTimeout(timer);
      backstop?.stop();
      backstop = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      watcher?.close();
      watcher = undefined;
    },
  };
}

async function signatureOf(file: string): Promise<string> {
  try {
    const s = await stat(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomically(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

function runProcess(
  program: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(program, [...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (cause) => resolvePromise({ code: null, stdout, stderr: cause.message }));
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}
