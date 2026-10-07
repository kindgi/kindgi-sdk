// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** A Java pack's image: its Containerfile, its build context, its pack root. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_JAVA_BUILD_IMAGE_REF,
  DEFAULT_JAVA_RUNTIME_IMAGE_REF,
  JAVA_PACK_SERVICE_COMMAND,
  collectJavaContextFiles,
  renderJavaContainerfile,
} from '../src/build/java-image.js';
import { resolvePackRoots } from '../src/build/pack-root.js';

let packDir: string;
beforeEach(async () => {
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-java-image-'));
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

describe('the Java Containerfile', () => {
  const inputs = {
    buildImageRef: DEFAULT_JAVA_BUILD_IMAGE_REF,
    runtimeImageRef: DEFAULT_JAVA_RUNTIME_IMAGE_REF,
    artifactVersion: '20261007.1',
    publishedAt: '1970-01-01T00:00:00.000Z',
    buildTarget: 'staging',
  };
  const text = renderJavaContainerfile({ ...inputs, systemPackages: [] });

  test('pins its images by digest: Maven + JDK 17 to build, a JRE 17 to run', () => {
    expect(DEFAULT_JAVA_BUILD_IMAGE_REF).toMatch(
      /^maven:3\.9\.\d+-eclipse-temurin-17@sha256:[0-9a-f]{64}$/,
    );
    expect(DEFAULT_JAVA_RUNTIME_IMAGE_REF).toMatch(
      /^eclipse-temurin:17-jre-noble@sha256:[0-9a-f]{64}$/,
    );
    expect(text).toContain(`FROM ${DEFAULT_JAVA_BUILD_IMAGE_REF} AS build`);
    expect(text).toContain(`FROM ${DEFAULT_JAVA_RUNTIME_IMAGE_REF} AS final`);
  });

  test('Maven compiles and copies the runtime dependencies, naming the plugin in full', () => {
    expect(text).toContain('RUN mvn -B -ntp -q compile');
    expect(text).toContain(
      'mvn -B -ntp -q org.apache.maven.plugins:maven-dependency-plugin:3.11.0:copy-dependencies',
    );
    expect(text).toContain('-DincludeScope=runtime -DoutputDirectory=/app/lib');
  });

  test('indexes with the pins, writes the launcher from the jar, serves through it', () => {
    expect(text).toContain('ARG KINDGI_ARTIFACT_VERSION=20261007.1');
    expect(text).toContain('ARG KINDGI_PUBLISHED_AT=1970-01-01T00:00:00.000Z');
    expect(text).toContain(
      'RUN java -cp "/app/target/classes:/app/lib/*" com.kindgi.pack.Main index',
    );
    expect(text).toContain('--output /app/index.json');
    expect(text).toContain('com.kindgi.pack.Main launcher > /app/kindgi-pack-java');
    expect(text).toContain('COPY --from=indexer /app/index.json /app/index.json');
    expect(text).toContain('COPY --from=indexer /app/kindgi-pack-java /app/kindgi-pack-java');
    expect(text).toContain('COPY --from=build /app/target/classes /app/classes');
    expect(JAVA_PACK_SERVICE_COMMAND).toEqual([
      'sh',
      '/app/kindgi-pack-java',
      '-cp',
      '/app/classes:/app/lib/*',
      'com.kindgi.pack.Main',
      'serve',
      '--index',
      '/app/index.json',
      '--module-root',
      '/app',
    ]);
    expect(text).toContain(
      'ENTRYPOINT ["sh", "/app/kindgi-pack-java", "-cp", "/app/classes:/app/lib/*", "com.kindgi.pack.Main", "serve", "--index", "/app/index.json", "--module-root", "/app"]',
    );
    expect(text).toMatch(/USER 65532:65532\nEXPOSE 8080/);
    expect(text).toContain('PORT=8080');
  });

  test('declared Debian packages install in the final stage, one apt step', () => {
    const withApt = renderJavaContainerfile({ ...inputs, systemPackages: ['tesseract-ocr'] });
    const finalStage = withApt.slice(withApt.indexOf('# --- stage: final'));
    expect(finalStage).toContain(
      'RUN apt-get update \\\n && apt-get install -y --no-install-recommends tesseract-ocr \\\n && rm -rf /var/lib/apt/lists/*',
    );
    expect(finalStage.indexOf('apt-get')).toBeLessThan(finalStage.indexOf('USER 65532'));
    expect(text).not.toContain('apt-get');
  });
});

describe("a Java pack's build context", () => {
  test('the pack root, minus build output, IDE files, Maven settings, keystores and secrets', async () => {
    await files({
      'pom.xml': '<project/>',
      'kindgi.config.json': '{}',
      mvnw: '#!/bin/sh\n',
      '.mvn/wrapper/maven-wrapper.properties': 'x=1\n',
      'src/main/java/com/acme/tools/Greet.java': 'class Greet {}',
      'src/main/java/com/acme/build/Report.java': 'class Report {}',
      'src/main/resources/app.properties': 'a=1\n',
      'target/classes/com/acme/tools/Greet.class': 'x',
      'module/target/x.jar': 'x',
      'build/libs/x.jar': 'x',
      '.idea/workspace.xml': '<x/>',
      'settings.xml': '<settings/>',
      'certs/server.jks': 'x',
      '.env': 'SECRET=1\n',
      '.git/HEAD': 'ref',
      '.kindgi/dev/java/java.args': '-cp ""',
    });
    const context = await collectJavaContextFiles(packDir);
    expect(context).toEqual({
      kind: 'ok',
      files: [
        '.mvn/wrapper/maven-wrapper.properties',
        'kindgi.config.json',
        'mvnw',
        'pom.xml',
        'src/main/java/com/acme/build/Report.java',
        'src/main/java/com/acme/tools/Greet.java',
        'src/main/resources/app.properties',
      ],
    });
  });

  test('without a pom.xml: the build stops, saying why', async () => {
    await files({ 'kindgi.config.json': '{}' });
    expect(await collectJavaContextFiles(packDir)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('No pom.xml'),
    });
  });

  test('a Java pack root is standalone, with no Node project around it', async () => {
    await files({
      'kindgi.config.json': JSON.stringify({ language: 'java', pack: { id: 'a', version: '1' } }),
    });
    expect(await resolvePackRoots({ cwd: packDir })).toEqual({
      kind: 'ok',
      roots: { packDir, repoRoot: packDir, mode: 'standalone', language: 'java' },
    });
  });
});
