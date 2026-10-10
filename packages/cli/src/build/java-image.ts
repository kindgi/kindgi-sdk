// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The image of a Java pack (`kindgi.config.json`, `"language": "java"`).
 *
 * Maven builds it in a pinned Maven + JDK 17 image: the pack's classes
 * (`compile`) and its runtime dependencies (`copy-dependencies`), both
 * from its `pom.xml`. An indexer stage writes `/app/index.json` with
 * `com.kindgi.pack.Main index` and the pinned artifact version and
 * publish time — byte-identical to the CLI's local index, so the
 * integrity gate holds — and the launcher (`kindgi-pack-java`) from the
 * pack's own kindgi-pack jar. The image runs on a pinned JRE 17, as user
 * 65532: the pack service, through the launcher, on `PORT` (8080). The
 * launcher keeps the names the pack declares (`KINDGI_PACK_ENV_DECLARED`,
 * from the local index) and drops the rest of the environment.
 * Debian packages the pack declares (`image.systemPackages`) install in
 * the final stage.
 *
 * The build context is the pack root, minus build output (`target/`), IDE
 * files, `.git`, `.kindgi`, `node_modules` and secret-shaped files
 * (`.env*`, keys, keystores, Maven's `settings.xml`).
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { renderAptGetStep } from './apt.js';
import { forbiddenReason } from './context-files.js';

/** `maven:3.9.16-eclipse-temurin-17` (Ubuntu noble), pinned (manifest list digest, verified 2026-10-07). */
export const DEFAULT_JAVA_BUILD_IMAGE_REF =
  'maven:3.9.16-eclipse-temurin-17@sha256:1a352420f7aba21f5ad08df31bab55f74c013fb491f1ae8ab1dd7ff9ed698584';

/** `eclipse-temurin:17-jre-noble`, pinned (manifest list digest, verified 2026-10-07). */
export const DEFAULT_JAVA_RUNTIME_IMAGE_REF =
  'eclipse-temurin:17-jre-noble@sha256:900322f4cc1b9da9d730ae4bb56d8a1dabbaa9cfa32809fc8b542b600370a045';

/** The dependency plugin, named in full (no plugin-prefix lookup; the same version as `kindgi dev`). */
const DEPENDENCY_PLUGIN = 'org.apache.maven.plugins:maven-dependency-plugin:3.11.0';

/** The classpath inside the image: the pack's classes, then its dependencies. */
const IMAGE_CLASSPATH = '/app/classes:/app/lib/*';

/** A Java pack image's pack service: its ENTRYPOINT. */
export const JAVA_PACK_SERVICE_COMMAND: readonly string[] = [
  'sh',
  '/app/kindgi-pack-java',
  '-cp',
  IMAGE_CLASSPATH,
  'com.kindgi.pack.Main',
  'serve',
  '--index',
  '/app/index.json',
  '--module-root',
  '/app',
];

export interface RenderJavaContainerfileInputs {
  readonly buildImageRef: string;
  readonly runtimeImageRef: string;
  readonly artifactVersion: string;
  readonly publishedAt: string;
  readonly buildTarget: string;
  /** Debian packages for the final stage, checked (`checkAptPackages`). */
  readonly systemPackages: readonly string[];
  /**
   * The names the pack declares (`env.required`, `env.optional`), from the
   * local index: `KINDGI_PACK_ENV_DECLARED`, the launcher's list of what to
   * keep.
   */
  readonly declaredEnv: readonly string[];
}

export function renderJavaContainerfile(inputs: RenderJavaContainerfileInputs): string {
  const { buildImageRef, runtimeImageRef, artifactVersion, publishedAt, buildTarget } = inputs;
  const apt = renderAptGetStep(inputs.systemPackages);
  const classpath = '/app/target/classes:/app/lib/*';
  return `# syntax=docker/dockerfile:1
# A Java Kindgi pack. Emitted by \`kindgi build\` — do not hand-edit.
# Reproducibility: SOURCE_DATE_EPOCH=0 + KINDGI_BUILD_TARGET come from the
# build server; KINDGI_ARTIFACT_VERSION + KINDGI_PUBLISHED_AT are pinned here
# so this image's index.json matches the CLI's byte for byte.

# --- stage: build — the pack's classes and its runtime dependencies ---
FROM ${buildImageRef} AS build
WORKDIR /app
COPY . .
RUN mvn -B -ntp -q compile \\
 && mvn -B -ntp -q ${DEPENDENCY_PLUGIN}:copy-dependencies \\
      -DincludeScope=runtime -DoutputDirectory=/app/lib

# --- stage: indexer ---
FROM build AS indexer
ARG SOURCE_DATE_EPOCH=0
ARG KINDGI_BUILD_TARGET=${buildTarget}
ARG KINDGI_ARTIFACT_VERSION=${artifactVersion}
ARG KINDGI_PUBLISHED_AT=${publishedAt}
RUN java -cp "${classpath}" com.kindgi.pack.Main index \\
      --pack-dir /app \\
      --artifact-version "\${KINDGI_ARTIFACT_VERSION}" \\
      --published-at "\${KINDGI_PUBLISHED_AT}" \\
      --output /app/index.json \\
 && java -cp "${classpath}" com.kindgi.pack.Main launcher > /app/kindgi-pack-java

# --- stage: final — the pack service ---
FROM ${runtimeImageRef} AS final
ARG KINDGI_ARTIFACT_VERSION=${artifactVersion}
ARG KINDGI_PUBLISHED_AT=${publishedAt}
ENV KINDGI_ARTIFACT_VERSION=\${KINDGI_ARTIFACT_VERSION} \\
    KINDGI_PUBLISHED_AT=\${KINDGI_PUBLISHED_AT} \\
    KINDGI_PACK_ENV_DECLARED="${inputs.declaredEnv.join(',')}" \\
    PORT=8080
${apt === '' ? '' : `${apt}\n`}WORKDIR /app
COPY --from=build /app/target/classes /app/classes
COPY --from=build /app/lib /app/lib
COPY --from=indexer /app/index.json /app/index.json
COPY --from=indexer /app/kindgi-pack-java /app/kindgi-pack-java
USER 65532:65532
EXPOSE 8080
ENTRYPOINT [${JAVA_PACK_SERVICE_COMMAND.map((arg) => JSON.stringify(arg)).join(', ')}]
CMD []
`;
}

/**
 * Directories never shipped: build output and IDE state at the pack root
 * (a package may be named `build` or `out` further down), and any module's
 * `target/`.
 */
const SKIPPED_ROOT_DIRS = new Set(['target', 'build', 'out', 'bin', '.idea', '.gradle', '.settings', '.vscode']);

/** Files never shipped: Maven's settings (credentials) and keystores, besides `forbiddenReason`'s. */
function javaForbidden(name: string): boolean {
  return name === 'settings.xml' || name === 'settings-security.xml' || /\.(jks|keystore|truststore)$/.test(name);
}

/**
 * A module's `target/` (a Maven or sbt build's output): any directory named
 * `target` outside the sources. Under `src/` it's a package, and ships.
 */
export function isBuildOutput(rel: string): boolean {
  const segments = rel.split('/');
  return segments[segments.length - 1] === 'target' && !segments.slice(0, -1).includes('src');
}

export type JavaContextFiles =
  | { readonly kind: 'ok'; readonly files: readonly string[] }
  | { readonly kind: 'error'; readonly message: string };

/** The pack-relative files of a Java pack's build context. */
export async function collectJavaContextFiles(packDir: string): Promise<JavaContextFiles> {
  const files: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(rel === '' ? packDir : join(packDir, rel), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isBuildOutput(child) || (rel === '' && SKIPPED_ROOT_DIRS.has(entry.name))) continue;
        if (forbiddenReason(`${child}/x`) !== undefined) continue;
        await walk(child);
      } else if (
        entry.isFile() &&
        forbiddenReason(child) === undefined &&
        !javaForbidden(entry.name) &&
        !entry.name.endsWith('.class')
      ) {
        files.push(child);
      }
    }
  }
  await walk('');
  if (!files.includes('pom.xml')) {
    return {
      kind: 'error',
      message: `No pom.xml at ${packDir}. A Java pack's image builds with Maven; its pom.xml has the com.kindgi:kindgi-pack dependency.`,
    };
  }
  return { kind: 'ok', files: files.sort() };
}
