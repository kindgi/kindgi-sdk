// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** A Scala pack's image: its Containerfile, its build context, its pack root. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { DEFAULT_JAVA_RUNTIME_IMAGE_REF } from '../src/build/java-image.js';
import { resolvePackRoots } from '../src/build/pack-root.js';
import {
  DEFAULT_SCALA_BUILD_IMAGE_REF,
  SCALA_PACK_SERVICE_COMMAND,
  collectScalaContextFiles,
  renderScalaContainerfile,
} from '../src/build/scala-image.js';

let packDir: string;
beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-scala-image-'));
});
afterEach(async () => {
  await rm(packDir, { recursive: true, force: true });
});

async function files(entries: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(entries)) {
    await mkdir(dirname(join(packDir, rel)), { recursive: true });
    await writeFile(join(packDir, rel), text, 'utf8');
  }
}

describe('the Scala Containerfile', () => {
  const inputs = {
    buildImageRef: DEFAULT_SCALA_BUILD_IMAGE_REF,
    runtimeImageRef: DEFAULT_JAVA_RUNTIME_IMAGE_REF,
    artifactVersion: '20261008.1',
    publishedAt: '1970-01-01T00:00:00.000Z',
    buildTarget: 'staging',
  };
  const text = renderScalaContainerfile({ ...inputs, systemPackages: [] });

  test('pins its images by digest: sbt + JDK 17 to build, a JRE 17 to run', () => {
    expect(DEFAULT_SCALA_BUILD_IMAGE_REF).toMatch(
      /^sbtscala\/scala-sbt:eclipse-temurin-17\.[\d._]+_1\.12\.\d+_3\.3\.\d+@sha256:[0-9a-f]{64}$/,
    );
    expect(text).toContain(`FROM ${DEFAULT_SCALA_BUILD_IMAGE_REF} AS build`);
    expect(text).toContain(`FROM ${DEFAULT_JAVA_RUNTIME_IMAGE_REF} AS final`);
  });

  test('sbt exports the runtime classpath as jars, each copied in order into /app/lib', () => {
    expect(text).toContain(
      'RUN (sbt -batch -error "export Runtime/fullClasspathAsJars" > /tmp/classpath \\\n      || { cat /tmp/classpath; exit 1; })',
    );
    expect(text).toContain(`cp "$jar" "/app/lib/$(printf '%04d' "$i")-$(basename "$jar")"`);
    expect(text).toContain('COPY --from=build /app/lib /app/lib');
  });

  test('indexes with the pinned version and time, and runs the service through the launcher as 65532', () => {
    expect(text).toContain('ARG KINDGI_ARTIFACT_VERSION=20261008.1');
    expect(text).toContain('RUN java -cp "/app/lib/*" com.kindgi.pack.Main index');
    expect(text).toContain(
      'java -cp "/app/lib/*" com.kindgi.pack.Main launcher > /app/kindgi-pack-java',
    );
    expect(text).toContain('USER 65532:65532');
    expect(text).toContain(
      `ENTRYPOINT [${SCALA_PACK_SERVICE_COMMAND.map((a) => JSON.stringify(a)).join(', ')}]`,
    );
    expect(SCALA_PACK_SERVICE_COMMAND.slice(0, 4)).toEqual([
      'sh',
      '/app/kindgi-pack-java',
      '-cp',
      '/app/lib/*',
    ]);
  });

  test('system packages install in the final stage', () => {
    const withApt = renderScalaContainerfile({ ...inputs, systemPackages: ['libpq5'] });
    const final = withApt.slice(withApt.indexOf('AS final'));
    expect(final).toContain('libpq5');
  });
});

describe("a Scala pack's build context", () => {
  test('the pack root, minus build output, build-server state and credentials', async () => {
    await files({
      'build.sbt': 'scalaVersion := "3.3.8"\n',
      'kindgi.config.json': '{"language": "scala"}',
      'project/build.properties': 'sbt.version=1.12.15\n',
      'project/Dependencies.scala': 'object Dependencies',
      'src/main/scala/acme/tools/Echo.scala': 'object Echo',
      'src/main/scala/acme/target/Kept.scala': 'object Kept',
      'target/scala-3.3.8/classes/Echo$.class': 'x',
      'project/target/active.json': '{}',
      'project/project/target/x': 'x',
      '.bsp/sbt.json': '{}',
      '.metals/x': 'x',
      'credentials.sbt': 'credentials += ???',
      'project/.credentials': 'secret',
      'keys.jks': 'x',
      '.env.local': 'SECRET=1',
    });
    expect(await collectScalaContextFiles(packDir)).toEqual({
      kind: 'ok',
      files: [
        'build.sbt',
        'kindgi.config.json',
        'project/Dependencies.scala',
        'project/build.properties',
        // A package named target is source, not build output.
        'src/main/scala/acme/target/Kept.scala',
        'src/main/scala/acme/tools/Echo.scala',
      ],
    });
  });

  test('without build.sbt: refused, saying why', async () => {
    await files({ 'kindgi.config.json': '{"language": "scala"}' });
    expect(await collectScalaContextFiles(packDir)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('No build.sbt'),
    });
  });

  test('a kindgi.config.json saying "scala" is a standalone Scala pack', async () => {
    await files({
      'kindgi.config.json': '{"language": "scala", "pack": {"id": "a", "version": "1"}}',
    });
    expect(await resolvePackRoots({ cwd: packDir })).toEqual({
      kind: 'ok',
      roots: { packDir, repoRoot: packDir, mode: 'standalone', language: 'scala' },
    });
  });
});
