// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The `Containerfile` of a TypeScript pack image, which runs the pack
 * service over the pack's bundles. Stages:
 *
 *   system   the Node base image, tini, CA certificates, the system
 *            packages `image` asks for (corepack on)
 *   deps     the app's dependencies, with its own package manager from
 *            its own lockfile, frozen and scripts off; then the build
 *            scripts it allows; then the extensions' steps (`prisma
 *            generate`); then pruned to production
 *   code     the bundles (`dist/`): the pack's, the framework's, the
 *            config, the bundle map
 *   indexer  `index.json`, indexed from the bundles
 *   final    deps + code + index.json, as the `node` user
 *
 * Image layout: the install root at `/app`, the pack at
 * `/app/<packRel>` (the working directory) with its bundles in `dist/`,
 * and the index at `/app/index.json`.
 *
 * Build context (`kindgi build` writes it):
 *   host/          what the install reads (manifests, lockfile, workspace file, patches)
 *   ext/           what the extensions' steps read (a Prisma schema), at the install root's paths
 *   dist/          the bundles
 *   include/       `bundle.include` files, at their pack-relative paths
 *   Containerfile
 * Registry config that can hold credentials (`.npmrc`, `.yarnrc*`) is
 * never in the context: the install reads it as a BuildKit secret.
 *
 * ## Reproducibility
 *
 * The build service passes `SOURCE_DATE_EPOCH=0` + `KINDGI_BUILD_TARGET`
 * as build args. `KINDGI_PUBLISHED_AT` and `KINDGI_ARTIFACT_VERSION` are
 * `ARG` defaults here, so the CLI's local index and the image's agree
 * without extending the build-server contract.
 *
 * Attribution: the multi-stage layout follows Trigger.dev's (Apache-2.0)
 * `packages/cli-v3/src/deploy/buildImage.ts`.
 */

import { binCommand } from '../package-manager.js';
import { renderAptGetStep } from './apt.js';
import type { HostInstall, InstallCommands } from './host-install.js';
import type { ResolvedImage } from './image-config.js';

export interface RenderContainerfileInputs {
  readonly baseImageRef: string;
  readonly artifactVersion: string;
  readonly publishedAt: string;
  readonly buildTarget: string;
  readonly install: Pick<HostInstall, 'manager' | 'managerSpec' | 'packRel' | 'secrets' | 'yarnBerry'>;
  readonly commands: InstallCommands;
  /** What `image` in `kindgi.config` adds (`image-config.ts`). */
  readonly image: ResolvedImage;
  /** Whether the context has `include/` (files `bundle.include` lists). */
  readonly hasIncludes: boolean;
}

/**
 * pnpm's store in the install stage: the cache mount's own folder, set
 * explicitly (`pnpm_config_store_dir` for pnpm 11, `npm_config_store_dir`
 * before it), under ~/.cache, which the stage gives `node`.
 */
export const PNPM_STORE_DIR = '/home/node/.cache/pnpm-store';

/** Where the pack sits in the image. */
export function imagePackDir(packRel: string): string {
  return packRel === '' ? '/app' : `/app/${packRel}`;
}

/** The pack service's command in the image (after tini). */
export const PACK_SERVICE_COMMAND: readonly string[] = [
  'node',
  '--enable-source-maps',
  './dist/kindgi-pack-service.mjs',
  '--index',
  '/app/index.json',
  '--module-root',
  './dist',
  '--bundle-map',
  './dist/bundle-map.json',
];

/** Render the Containerfile. Pure; the caller writes it. */
export function renderContainerfile(inputs: RenderContainerfileInputs): string {
  const { baseImageRef, artifactVersion, publishedAt, buildTarget, install, commands } = inputs;
  const packDir = imagePackDir(install.packRel);
  const corepack = install.manager !== 'npm';
  const mounts = installMounts(install);
  const run = (command: string): string =>
    mounts.length === 0 ? `RUN ${command}` : `RUN ${mounts.join(' \\\n    ')} \\\n    ${command}`;
  const entrypoint = JSON.stringify(['/usr/bin/tini', '--', ...PACK_SERVICE_COMMAND]);
  const healthcheck = JSON.stringify([
    'node',
    '-e',
    "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
  ]);

  const system = renderAptGetStep(['ca-certificates', 'tini', ...inputs.image.systemPackages].sort());
  const env = Object.entries(inputs.image.buildEnv)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `ENV ${name}=${dockerfileString(value)}`);
  const steps = inputs.image.steps.map((step) => {
    const { command, args } = binCommand(install.manager, step.bin, step.args ?? []);
    return `# ${step.extension}\n${run(`cd ${packDir} && ${[command, ...args].map(shellWord).join(' ')}`)}`;
  });

  return `# syntax=docker/dockerfile:1.7
# A Kindgi pack image: the pack service over the pack's bundles.
# Reproducible: SOURCE_DATE_EPOCH=0 and KINDGI_BUILD_TARGET come in as
# --build-arg from the build service; KINDGI_PUBLISHED_AT and
# KINDGI_ARTIFACT_VERSION are pinned here, so the CLI and the image
# agree on index.json.
#
# Written by \`kindgi build\` (@kindgi/cli). Don't edit it by hand:
# change kindgi.config.ts and run \`kindgi build\` again.

# --- stage: system ---
FROM ${baseImageRef} AS system
${system}${
   corepack
     ? `
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0`
     : ''
 }

# --- stage: deps (${describeManager(install)}, from the lockfile) ---
FROM system AS deps
WORKDIR /app
# The install runs as node, in folders it owns: /app, and its caches
# (a cache mount would otherwise create ~/.cache as root).
RUN chown node:node /app && mkdir -p /home/node/.cache && chown node:node /home/node/.cache${
   install.manager === 'pnpm'
     ? `
# pnpm's store, where the cache mount is: by default pnpm picks it from
# ~/.local/share, which a mount's parents (created as root) make it skip.
ENV pnpm_config_store_dir=${PNPM_STORE_DIR}
ENV npm_config_store_dir=${PNPM_STORE_DIR}`
     : ''
 }
USER node
COPY --chown=node:node host/ ./${env.length > 0 ? `\n# Build env: the build steps and the indexer stage only, never the final image.\n${env.join('\n')}` : ''}
${run(commands.install)}${inputs.image.contextFiles.length > 0 ? '\nCOPY --chown=node:node ext/ ./' : ''}${steps.length > 0 ? `\n${steps.join('\n')}` : ''}
${run(commands.prune)}

# --- stage: code ---
FROM scratch AS code
COPY dist/ /dist/

# --- stage: indexer ---
FROM deps AS indexer
ARG SOURCE_DATE_EPOCH=0
ARG KINDGI_BUILD_TARGET=${buildTarget}
ARG KINDGI_ARTIFACT_VERSION=${artifactVersion}
ARG KINDGI_PUBLISHED_AT=${publishedAt}
ENV SOURCE_DATE_EPOCH=\${SOURCE_DATE_EPOCH}
ENV KINDGI_BUILD_TARGET=\${KINDGI_BUILD_TARGET}
ENV KINDGI_ARTIFACT_VERSION=\${KINDGI_ARTIFACT_VERSION}
ENV KINDGI_PUBLISHED_AT=\${KINDGI_PUBLISHED_AT}
COPY --from=code --chown=node:node /dist ${packDir}/dist
WORKDIR ${packDir}
RUN node --enable-source-maps ./dist/kindgi-index.mjs \\
      --pack-dir . \\
      --config ./dist/kindgi.config.mjs \\
      --bundle-map ./dist/bundle-map.json \\
      --module-root ./dist \\
      --artifact-version "\${KINDGI_ARTIFACT_VERSION}" \\
      --published-at "\${KINDGI_PUBLISHED_AT}" \\
      --strict \\
      --output /app/index.json

# --- stage: final ---
FROM system AS final
ARG KINDGI_ARTIFACT_VERSION=${artifactVersion}
ARG KINDGI_PUBLISHED_AT=${publishedAt}
ENV KINDGI_ARTIFACT_VERSION=\${KINDGI_ARTIFACT_VERSION}
ENV KINDGI_PUBLISHED_AT=\${KINDGI_PUBLISHED_AT}
ENV NODE_ENV=production
ENV PORT=8080
USER node
WORKDIR ${packDir}
COPY --from=deps --chown=node:node /app /app
COPY --from=code --chown=node:node /dist ./dist${
   inputs.hasIncludes
     ? `
COPY --chown=node:node include/ ./`
     : ''
 }
COPY --from=indexer --chown=node:node /app/index.json /app/index.json
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ${healthcheck}
# The pack service: serves /app/index.json's tools and checks on $PORT
# to a server holding KINDGI_PACK_SERVICE_TOKEN.
ENTRYPOINT ${entrypoint}
CMD []
`;
}

/** The secret mounts for registry config, and the package manager's download cache. */
function installMounts(install: RenderContainerfileInputs['install']): string[] {
  const owner = 'uid=1000,gid=1000';
  const mounts = install.secrets.map(
    (s) => `--mount=type=secret,id=${s.id},target=/app/${s.file},${owner},required=false`,
  );
  if (install.manager === 'pnpm') {
    mounts.push(
      `--mount=type=cache,id=kindgi-pnpm-store,target=${PNPM_STORE_DIR},${owner}`,
      // Package metadata, so a rebuild needn't fetch it all again.
      `--mount=type=cache,id=kindgi-pnpm-cache,target=/home/node/.cache/pnpm,${owner}`,
    );
  } else if (install.manager === 'npm') {
    mounts.push(`--mount=type=cache,id=kindgi-npm-cache,target=/home/node/.npm,${owner}`);
  }
  return mounts;
}

function describeManager(install: RenderContainerfileInputs['install']): string {
  const name =
    install.manager === 'yarn' ? (install.yarnBerry ? 'yarn berry' : 'yarn classic') : install.manager;
  return install.managerSpec !== undefined ? `${name}: ${install.managerSpec}` : name;
}

/** A Dockerfile `ENV` value: double-quoted, with `$` not expanded. */
function dockerfileString(value: string): string {
  return `"${value.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
}

/** A word for `sh`: as is when it's plain, else single-quoted. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
