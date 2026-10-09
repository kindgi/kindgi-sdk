// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Java pack service and indexer (`sdks/java/kindgi-pack`, `com.kindgi.pack.Main`).
 *
 * Needs a JDK 17+ (`KINDGI_CONFORMANCE_JAVA_HOME`, else `JAVA_HOME`, else the
 * `java` on PATH) and the built module: `./mvnw -pl kindgi-pack -am compile`
 * in sdks/java writes its classes and `target/classpath.txt`. The suite
 * compiles the fixture pack against them and runs the service through its
 * launcher (`kindgi-pack-java`), as `kindgi dev` and an image do. Without a
 * JDK or the build it skips locally and says why; under CI it fails instead,
 * so the Java target is never skipped there by accident.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, test } from 'vitest';

import { describePackServiceConformance, fixturePackDir } from '../src/index.js';

const packDir = fixturePackDir('java-pack');
const moduleDir = fileURLToPath(new URL('../../../sdks/java/kindgi-pack', import.meta.url));
const classes = join(moduleDir, 'target', 'classes');
const classpathFile = join(moduleDir, 'target', 'classpath.txt');
const launcher = join(classes, 'com', 'kindgi', 'pack', 'kindgi-pack-java');

const javaHome = process.env.KINDGI_CONFORMANCE_JAVA_HOME ?? process.env.JAVA_HOME;
const bin = (tool: string): string => (javaHome ? join(javaHome, 'bin', tool) : tool);

function javaSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? javaSources(join(dir, entry.name))
      : entry.name.endsWith('.java')
        ? [join(dir, entry.name)]
        : [],
  );
}

/** Why the target can't run here, or undefined when it can. */
function missing(): string | undefined {
  let version: string;
  try {
    version = execFileSync(bin('javac'), ['-version'], { encoding: 'utf8', stdio: 'pipe' });
  } catch {
    return 'no JDK: set KINDGI_CONFORMANCE_JAVA_HOME or JAVA_HOME to a JDK 17+';
  }
  const major = Number(/javac (\d+)/.exec(version)?.[1] ?? 0);
  if (major < 17) return `JDK 17+ needed, ${bin('javac')} is ${version.trim()}`;
  if (!existsSync(launcher) || !existsSync(classpathFile)) {
    return 'kindgi-pack is not built: run `./mvnw -pl kindgi-pack -am compile` in sdks/java';
  }
  return undefined;
}

const why = missing();
if (why !== undefined && process.env.CI) {
  throw new Error(`pack service conformance — java can't run under CI: ${why}`);
}

if (why !== undefined) {
  describe('pack service conformance — java', () => {
    test.skip(why, () => {});
  });
} else {
  // The fixture pack, compiled as a pack's build compiles it: against the
  // module's classes and its runtime classpath.
  const workDir = mkdtempSync(join(tmpdir(), 'kindgi-java-pack-'));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));
  const fixtureClasses = join(workDir, 'classes');
  const dependencies = readFileSync(classpathFile, 'utf8').trim();
  const compileClasspath = [classes, dependencies].join(delimiter);
  const sources = javaSources(join(packDir, 'src'));
  execFileSync(
    bin('javac'),
    [
      '--release',
      '17',
      '-Xlint:all',
      '-Werror',
      '-d',
      fixtureClasses,
      '-cp',
      compileClasspath,
      ...sources,
    ],
    { stdio: 'pipe' },
  );
  const classpath = [fixtureClasses, compileClasspath].join(delimiter);

  describePackServiceConformance({
    name: 'java',
    packDir,
    command: ['sh', launcher, '-cp', classpath, 'com.kindgi.pack.Main', 'serve'],
    env: javaHome ? { JAVA_HOME: javaHome } : {},
    async buildIndex(outputPath, pins) {
      let stdout: string;
      try {
        stdout = execFileSync(
          bin('java'),
          [
            '-cp',
            classpath,
            'com.kindgi.pack.Main',
            'index',
            '--pack-dir',
            packDir,
            '--output',
            outputPath,
            '--artifact-version',
            pins.artifactVersion,
            '--published-at',
            pins.publishedAt,
            '--json',
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (cause) {
        const failed = cause as { stdout?: string; stderr?: string };
        throw new Error(`indexer failed: ${failed.stdout ?? ''}${failed.stderr ?? ''}`);
      }
      const outcome = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as {
        kind: string;
        value?: { fileErrors: { message: string }[] };
      };
      if (outcome.kind !== 'ok' || (outcome.value?.fileErrors.length ?? 0) > 0) {
        throw new Error(`indexer: ${stdout}`);
      }
    },
  });
}
