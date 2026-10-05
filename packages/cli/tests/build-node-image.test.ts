// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The TypeScript pack image: its base image (from the app's
 * `engines.node`) and its Containerfile — the app's own install from its
 * lockfile, the bundles, the index from the bundles, the pack service.
 */

import { describe, expect, test } from 'vitest';

import { prisma } from '@kindgi/handler-runtime/build-extensions';
import { PNPM_STORE_DIR, renderContainerfile } from '../src/build/containerfile.js';

import { type HostInstall, installCommands } from '../src/build/host-install.js';
import { type ResolvedImage, readImageConfig } from '../src/build/image-config.js';
import { NODE_BASE_IMAGES, nodeBaseImageFor } from '../src/build/node-image.js';

const [NODE_22, NODE_24] = NODE_BASE_IMAGES;

function install(over: Partial<HostInstall> = {}): HostInstall {
  return {
    root: '/repo',
    packRel: '',
    manager: 'pnpm',
    yarnBerry: false,
    workspace: false,
    files: ['package.json', 'pnpm-lock.yaml'],
    projectManifests: ['package.json'],
    skippedScripts: [],
    packDependencies: { runtime: [], dev: [] },
    secrets: [],
    hostPnpm: '10.28.0',
    ...over,
  };
}

const NO_IMAGE: ResolvedImage = {
  systemPackages: [],
  buildEnv: {},
  contextFiles: [],
  steps: [],
  extensions: [],
};

/** `install(over)` without the host's pnpm version. */
function installWithoutHostPnpm(over: Partial<HostInstall> = {}): HostInstall {
  const { hostPnpm: _hostPnpm, ...rest } = install(over);
  return rest;
}

function render(over: Partial<HostInstall> = {}, hasIncludes = false, image = NO_IMAGE): string {
  return renderHost(install(over), hasIncludes, image);
}

function renderHost(host: HostInstall, hasIncludes = false, image = NO_IMAGE): string {
  return renderContainerfile({
    baseImageRef: NODE_24?.ref ?? '',
    artifactVersion: '20261002.1',
    publishedAt: '1970-01-01T00:00:00.000Z',
    buildTarget: 'linux/amd64',
    install: host,
    commands: installCommands(host),
    image,
    hasIncludes,
  });
}

function imageOf(config: Record<string, unknown>): ResolvedImage {
  const read = readImageConfig(config);
  if (read.kind !== 'ok') throw new Error(read.message);
  return read.image;
}

describe('the base image', () => {
  test('pinned by digest, one per supported Node major', () => {
    expect(NODE_BASE_IMAGES.map((i) => i.major)).toEqual([22, 24]);
    for (const image of NODE_BASE_IMAGES) {
      expect(image.ref).toMatch(
        new RegExp(`^node:${image.major}-bookworm-slim@sha256:[0-9a-f]{64}$`),
      );
    }
  });

  test.each([
    [undefined, NODE_22],
    ['', NODE_22],
    ['>=22', NODE_22],
    ['24.x', NODE_24],
    ['^24.10.0', NODE_24],
    ['>=20 <23', NODE_22],
  ])('engines.node %j → %o', (range, expected) => {
    expect(nodeBaseImageFor(range)).toEqual({ kind: 'ok', image: expected });
  });

  test('a range no pinned image satisfies, or one that is not a range, is refused', () => {
    expect(nodeBaseImageFor('>=25')).toMatchObject({ kind: 'err' });
    expect(nodeBaseImageFor('^22.99')).toMatchObject({ kind: 'err' });
    expect(nodeBaseImageFor('lts please')).toMatchObject({ kind: 'err' });
  });
});

describe('the Containerfile', () => {
  test('pnpm: corepack, a frozen install with scripts off, the allowed builds, then the prune', () => {
    const text = render({ managerSpec: 'pnpm@11.25.0' });
    expect(text).toContain(`FROM ${NODE_24?.ref} AS system`);
    expect(text).toContain('apt-get install -y --no-install-recommends ca-certificates tini');
    expect(text).toContain('RUN corepack enable');
    expect(text).toContain('# --- stage: deps (pnpm: pnpm@11.25.0, from the lockfile) ---');
    expect(text).toContain('pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild');
    expect(text).toContain('pnpm prune --prod');
    // The install runs as `node`, in a folder it owns.
    expect(text.indexOf('RUN chown node:node /app && mkdir -p /home/node/.cache')).toBeLessThan(
      text.indexOf('USER node'),
    );
  });

  test.each([
    ['10.28.0', '10'],
    ['12.9.1', '12'],
  ])("pnpm with no packageManager: the host's pnpm %s, before the install, as node", (version) => {
    const text = render({ hostPnpm: version });
    expect(text).toContain(
      `# --- stage: deps (pnpm: pnpm@${version}, the host's, from the lockfile) ---`,
    );
    const pin = text.indexOf(`RUN corepack install -g pnpm@${version}`);
    expect(pin).toBeGreaterThan(text.indexOf('USER node'));
    expect(pin).toBeLessThan(text.indexOf('pnpm install --frozen-lockfile'));
    expect(text.match(/corepack install -g/g)).toHaveLength(1);
    // The policies stay as pnpm sets them.
    expect(text).not.toMatch(/minimum-?release-?age/i);
  });

  test("a packageManager wins over the host's pnpm: corepack takes it from package.json", () => {
    const text = render({ managerSpec: 'pnpm@12.9.1', hostPnpm: '10.28.0' });
    expect(text).not.toContain('corepack install -g');
    expect(text).toContain('# --- stage: deps (pnpm: pnpm@12.9.1, from the lockfile) ---');
  });

  test('pnpm with neither is never left to the newest: refused', () => {
    expect(() => renderHost(installWithoutHostPnpm())).toThrow(
      'a pnpm install needs packageManager or the host pnpm version',
    );
  });

  test('npm and yarn: no pnpm pin', () => {
    for (const over of [
      { manager: 'npm' as const, files: ['package.json', 'package-lock.json'] },
      { manager: 'yarn' as const, files: ['package.json', 'yarn.lock'] },
    ]) {
      expect(renderHost(installWithoutHostPnpm(over))).not.toContain('corepack install -g');
    }
  });

  test("pnpm's store is the cache mount, named for pnpm explicitly (else it falls back outside it)", () => {
    const text = render({});
    expect(PNPM_STORE_DIR.startsWith('/home/node/.cache/')).toBe(true);
    expect(text).toContain(
      `--mount=type=cache,id=kindgi-pnpm-store,target=${PNPM_STORE_DIR},uid=1000,gid=1000`,
    );
    expect(text).toContain(`ENV pnpm_config_store_dir=${PNPM_STORE_DIR}`);
    expect(text).toContain(`ENV npm_config_store_dir=${PNPM_STORE_DIR}`);
    expect(text).not.toContain('.local/share/pnpm');
    // Set before the install, in the deps stage only.
    const deps = text.indexOf('# --- stage: deps');
    const env = text.indexOf('ENV pnpm_config_store_dir=');
    expect(env).toBeGreaterThan(deps);
    expect(env).toBeLessThan(text.indexOf('pnpm install --frozen-lockfile'));
    expect(text.indexOf('ENV pnpm_config_store_dir=', env + 1)).toBe(-1);
  });

  test('a pnpm workspace installs only the pack project and what it depends on, and prunes the same way', () => {
    const member = render({ workspace: true, packRel: 'apps/support' });
    expect(member).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts --filter '{./apps/support}...' && pnpm --filter '{./apps/support}...' rebuild",
    );
    expect(member).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts --prod --filter '{./apps/support}...'",
    );
    expect(member).not.toContain('pnpm prune');
    expect(render({ workspace: true })).toContain("--filter '{.}...'");
    expect(member).toContain(
      '--mount=type=cache,id=kindgi-pnpm-cache,target=/home/node/.cache/pnpm',
    );
  });

  test('registry config is a build secret mount, never copied in', () => {
    const text = render({ secrets: [{ id: 'npmrc', file: '.npmrc' }] });
    expect(text).toContain(
      '--mount=type=secret,id=npmrc,target=/app/.npmrc,uid=1000,gid=1000,required=false',
    );
    expect(text).not.toMatch(/COPY[^\n]*\.npmrc/);
  });

  test('npm: no corepack; npm ci, rebuild, prune', () => {
    const text = render({ manager: 'npm', files: ['package.json', 'package-lock.json'] });
    expect(text).not.toContain('corepack');
    expect(text).toContain('npm ci --ignore-scripts --no-audit --no-fund && npm rebuild');
    expect(text).toContain('npm prune --omit=dev');
    expect(text).not.toContain('store_dir');
  });

  test('yarn: berry installs immutably and focuses production; classic reinstalls production', () => {
    expect(render({ manager: 'yarn', yarnBerry: true })).toContain(
      'yarn workspaces focus --all --production',
    );
    expect(render({ manager: 'yarn', yarnBerry: false })).toContain(
      'yarn install --production --frozen-lockfile --ignore-scripts --non-interactive',
    );
  });

  test('the index comes from the bundles, at /app/index.json', () => {
    const text = render();
    expect(text).toContain('COPY --from=code --chown=node:node /dist /app/dist');
    expect(text).toContain('RUN node --enable-source-maps ./dist/kindgi-index.mjs');
    expect(text).toContain('--bundle-map ./dist/bundle-map.json');
    expect(text).toContain('--config ./dist/kindgi.config.mjs');
    expect(text).toContain('--output /app/index.json');
    // A module that fails to load in the image fails the build there.
    expect(text).toContain('--strict');
    expect(text).toContain('COPY --from=indexer --chown=node:node /app/index.json /app/index.json');
  });

  test('the final stage runs the pack service over the bundles, under tini, as node', () => {
    const text = render();
    expect(text).toContain(
      'ENTRYPOINT ["/usr/bin/tini","--","node","--enable-source-maps","./dist/kindgi-pack-service.mjs","--index","/app/index.json","--module-root","./dist","--bundle-map","./dist/bundle-map.json"]',
    );
    expect(text).toContain('ENV NODE_ENV=production');
    expect(text).toContain('ENV PORT=8080');
    expect(text).toContain('EXPOSE 8080');
    expect(text).toContain('HEALTHCHECK');
    expect(text).not.toContain('managed-run-controller');
  });

  test('a pack inside a workspace sits at its own path, so its own node_modules resolve', () => {
    const text = render({ packRel: 'apps/support' });
    expect(text).toContain('COPY --from=code --chown=node:node /dist /app/apps/support/dist');
    expect(text.match(/WORKDIR \/app\/apps\/support/g)).toHaveLength(2);
  });

  test('bundle.include files are copied only when there are some', () => {
    expect(render({}, true)).toContain('COPY --chown=node:node include/ ./');
    expect(render({}, false)).not.toContain('include/');
  });
});

describe('the Containerfile with image extensions', () => {
  const image = imageOf({
    image: {
      systemPackages: ['tesseract-ocr'],
      extensions: [prisma({ schema: 'prisma/schema.prisma', config: 'prisma.config.ts' })],
      buildEnv: { DATABASE_URL: 'postgresql://build-placeholder/$db' },
    },
  });

  test('system packages go in the base stage with tini and the CA certificates', () => {
    expect(render({}, false, image)).toContain(
      'apt-get install -y --no-install-recommends ca-certificates tesseract-ocr tini',
    );
  });

  test("prisma generate runs after the install and before the prune, through the app's package manager", () => {
    const text = render({ packRel: 'apps/support' }, false, image);
    const install = text.indexOf('pnpm install --frozen-lockfile');
    const files = text.indexOf('COPY --chown=node:node ext/ ./');
    const generate = text.indexOf(
      'cd /app/apps/support && pnpm exec prisma generate --config prisma.config.ts',
    );
    const prune = text.indexOf('pnpm prune --prod');
    expect(install).toBeGreaterThan(0);
    expect(files).toBeGreaterThan(install);
    expect(generate).toBeGreaterThan(files);
    expect(prune).toBeGreaterThan(generate);
    expect(render({ manager: 'npm' }, false, image)).toContain(
      'cd /app && npx --no prisma generate',
    );
  });

  test('build env is set in the install stage only, quoted, $ not expanded', () => {
    const text = render({}, false, image);
    const env = text.indexOf('ENV DATABASE_URL="postgresql://build-placeholder/\\$db"');
    expect(env).toBeGreaterThan(text.indexOf('FROM system AS deps'));
    expect(env).toBeLessThan(text.indexOf('FROM scratch AS code'));
    expect(text.slice(text.indexOf('FROM system AS final'))).not.toContain('DATABASE_URL');
  });

  test('without extensions, nothing extra is rendered', () => {
    const text = render();
    expect(text).not.toContain('ext/');
    expect(text).not.toContain('Build env');
  });
});
