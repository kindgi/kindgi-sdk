// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Scala layer (`sdks/scala`, kindgi-pack-scala) on the Java pack service and indexer: the
 * fixture pack in Scala (`fixtures/scala-pack`), built by sbt against the layer from source.
 *
 * Needs a JDK 17+ (`KINDGI_CONFORMANCE_JAVA_HOME`, else `JAVA_HOME`, else the `java` on PATH) and
 * the built fixture: with kindgi-pack installed (`./mvnw -pl kindgi-pack -am install -DskipTests`
 * in sdks/java), `sbt writeClasspath` in the fixture writes `target/classpath.txt` (and
 * `target/scala-version.txt`; `sbt ++2.13.18! writeClasspath` builds it with Scala 2.13). The
 * suite takes the launcher from kindgi-pack (`Main launcher`), as `kindgi dev` does, and runs the
 * service through it. Without a JDK or the build it skips and says why; the Scala job
 * (`.github/workflows/scala.yml`) sets `KINDGI_CONFORMANCE_SCALA=1`, under which it fails instead.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, test } from 'vitest';

import { describePackServiceConformance, fixturePackDir } from '../src/index.js';

const packDir = fixturePackDir('scala-pack');
const classpathFile = join(packDir, 'target', 'classpath.txt');
const versionFile = join(packDir, 'target', 'scala-version.txt');

const javaHome = process.env.KINDGI_CONFORMANCE_JAVA_HOME ?? process.env.JAVA_HOME;
const bin = (tool: string): string => (javaHome ? join(javaHome, 'bin', tool) : tool);

/** Why the target can't run here, or undefined when it can. */
function missing(): string | undefined {
  const probe = spawnSync(bin('java'), ['-version'], { encoding: 'utf8' });
  if (probe.error !== undefined || probe.status !== 0) {
    return 'no JDK: set KINDGI_CONFORMANCE_JAVA_HOME or JAVA_HOME to a JDK 17+';
  }
  const major = Number(/version "(\d+)/.exec(probe.stderr)?.[1] ?? 0);
  if (major < 17) return `JDK 17+ needed, ${bin('java')} is ${probe.stderr.split('\n')[0]}`;
  if (!existsSync(classpathFile) || !existsSync(versionFile)) {
    return 'the Scala fixture is not built: run `sbt writeClasspath` in fixtures/scala-pack';
  }
  return undefined;
}

const why = missing();
if (why !== undefined && process.env.KINDGI_CONFORMANCE_SCALA) {
  throw new Error(
    `pack service conformance — scala can't run with KINDGI_CONFORMANCE_SCALA set: ${why}`,
  );
}

if (why !== undefined) {
  describe('pack service conformance — scala', () => {
    test.skip(why, () => {});
  });
} else {
  const classpath = readFileSync(classpathFile, 'utf8').trim();
  const scalaVersion = readFileSync(versionFile, 'utf8').trim();
  // The launcher ships in kindgi-pack's jar; the service runs through it, as an image's does.
  const workDir = mkdtempSync(join(tmpdir(), 'kindgi-scala-pack-'));
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));
  const launcher = join(workDir, 'kindgi-pack-java');
  writeFileSync(
    launcher,
    execFileSync(bin('java'), ['-cp', classpath, 'com.kindgi.pack.Main', 'launcher'], {
      stdio: 'pipe',
    }),
  );

  describePackServiceConformance({
    name: `scala ${scalaVersion}`,
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
