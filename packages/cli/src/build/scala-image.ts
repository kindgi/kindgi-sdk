// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The image of a Scala pack (`kindgi.config.json`, `"language": "scala"`).
 *
 * sbt builds it in a pinned sbt + JDK 17 image: the pack's runtime
 * classpath as jars (`export Runtime/fullClasspathAsJars`, the pack's own
 * jar among them), each copied into `/app/lib` with its position as a
 * prefix, so the order holds and two jars of one name don't collide. The
 * indexer stage and the final stage are a Java pack's (`java-image.ts`):
 * `/app/index.json` written with `com.kindgi.pack.Main index` and the
 * pinned artifact version and publish time, the launcher from the pack's
 * kindgi-pack jar, and the pack service on a pinned JRE 17, as user 65532,
 * on `PORT` (8080). The launcher keeps the names the pack declares
 * (`KINDGI_PACK_ENV_DECLARED`, from the local index) and drops the rest of
 * the environment.
 *
 * The build context is the pack root, minus build output (`target/`,
 * `project/target/`, `project/project/`), IDE and build-server state
 * (`.bsp`, `.metals`, `.bloop`, `.idea`), `.git`, `.kindgi`,
 * `node_modules` and secret-shaped files (`.env*`, keys, keystores, sbt's
 * `credentials.sbt` and `.credentials`).
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { renderAptGetStep } from './apt.js';
import { forbiddenReason } from './context-files.js';
import { type JavaContextFiles, isBuildOutput } from './java-image.js';

/**
 * `sbtscala/scala-sbt:eclipse-temurin-17.0.19_10_1.12.15_3.3.8` (sbt 1.12.15 on JDK 17,
 * linux/amd64 and arm64), pinned (manifest list digest, verified 2026-10-08).
 */
export const DEFAULT_SCALA_BUILD_IMAGE_REF =
  'sbtscala/scala-sbt:eclipse-temurin-17.0.19_10_1.12.15_3.3.8@sha256:9034c5f42f81eb75f9f71f93a3d82f53eafc43c0d63cbbfb7c84467e40a525ed';

/** The classpath inside the image: every jar the build exported, the pack's own among them. */
const IMAGE_CLASSPATH = '/app/lib/*';

/** A Scala pack image's pack service: its ENTRYPOINT. */
export const SCALA_PACK_SERVICE_COMMAND: readonly string[] = [
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

export interface RenderScalaContainerfileInputs {
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

export function renderScalaContainerfile(inputs: RenderScalaContainerfileInputs): string {
  const { buildImageRef, runtimeImageRef, artifactVersion, publishedAt, buildTarget } = inputs;
  const apt = renderAptGetStep(inputs.systemPackages);
  return `# syntax=docker/dockerfile:1
# A Scala Kindgi pack. Emitted by \`kindgi build\` — do not hand-edit.
# Reproducibility: SOURCE_DATE_EPOCH=0 + KINDGI_BUILD_TARGET come from the
# build server; KINDGI_ARTIFACT_VERSION + KINDGI_PUBLISHED_AT are pinned here
# so this image's index.json matches the CLI's byte for byte.

# --- stage: build — the pack's runtime classpath, as jars ---
FROM ${buildImageRef} AS build
WORKDIR /app
COPY . .
# sbt's errors go to stdout with the classpath: on a failure, show them.
RUN (sbt -batch -error "export Runtime/fullClasspathAsJars" > /tmp/classpath \\
      || { cat /tmp/classpath; exit 1; }) \\
 && mkdir -p /app/lib \\
 && i=0 && tail -n 1 /tmp/classpath | tr ':' '\\n' | while read -r jar; do \\
      i=$((i + 1)); cp "$jar" "/app/lib/$(printf '%04d' "$i")-$(basename "$jar")"; \\
    done

# --- stage: indexer ---
FROM build AS indexer
ARG SOURCE_DATE_EPOCH=0
ARG KINDGI_BUILD_TARGET=${buildTarget}
ARG KINDGI_ARTIFACT_VERSION=${artifactVersion}
ARG KINDGI_PUBLISHED_AT=${publishedAt}
RUN java -cp "${IMAGE_CLASSPATH}" com.kindgi.pack.Main index \\
      --pack-dir /app \\
      --artifact-version "\${KINDGI_ARTIFACT_VERSION}" \\
      --published-at "\${KINDGI_PUBLISHED_AT}" \\
      --output /app/index.json \\
 && java -cp "${IMAGE_CLASSPATH}" com.kindgi.pack.Main launcher > /app/kindgi-pack-java

# --- stage: final — the pack service ---
FROM ${runtimeImageRef} AS final
ARG KINDGI_ARTIFACT_VERSION=${artifactVersion}
ARG KINDGI_PUBLISHED_AT=${publishedAt}
ENV KINDGI_ARTIFACT_VERSION=\${KINDGI_ARTIFACT_VERSION} \\
    KINDGI_PUBLISHED_AT=\${KINDGI_PUBLISHED_AT} \\
    KINDGI_PACK_ENV_DECLARED="${inputs.declaredEnv.join(',')}" \\
    PORT=8080
${apt === '' ? '' : `${apt}\n`}WORKDIR /app
COPY --from=build /app/lib /app/lib
COPY --from=indexer /app/index.json /app/index.json
COPY --from=indexer /app/kindgi-pack-java /app/kindgi-pack-java
USER 65532:65532
EXPOSE 8080
ENTRYPOINT [${SCALA_PACK_SERVICE_COMMAND.map((arg) => JSON.stringify(arg)).join(', ')}]
CMD []
`;
}

/** Directories never shipped at the pack root: build output, IDE and build-server state. */
const SKIPPED_ROOT_DIRS = new Set([
  'target',
  'build',
  'out',
  'bin',
  '.idea',
  '.vscode',
  '.bsp',
  '.metals',
  '.bloop',
]);

/** Files never shipped: sbt's credentials and keystores, besides `forbiddenReason`'s. */
function scalaForbidden(name: string): boolean {
  return (
    name === 'credentials.sbt' || name === '.credentials' || /\.(jks|keystore|truststore)$/.test(name)
  );
}

/** The pack-relative files of a Scala pack's build context. */
export async function collectScalaContextFiles(packDir: string): Promise<JavaContextFiles> {
  const files: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(rel === '' ? packDir : join(packDir, rel), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (
          isBuildOutput(child) ||
          (rel === '' && SKIPPED_ROOT_DIRS.has(entry.name)) ||
          child === 'project/project'
        ) {
          continue;
        }
        if (forbiddenReason(`${child}/x`) !== undefined) continue;
        await walk(child);
      } else if (
        entry.isFile() &&
        forbiddenReason(child) === undefined &&
        !scalaForbidden(entry.name) &&
        !entry.name.endsWith('.class')
      ) {
        files.push(child);
      }
    }
  }
  await walk('');
  if (!files.includes('build.sbt')) {
    return {
      kind: 'error',
      message: `No build.sbt at ${packDir}. A Scala pack's image builds with sbt; its build.sbt has the kindgi-pack-scala dependency.`,
    };
  }
  return { kind: 'ok', files: files.sort() };
}
