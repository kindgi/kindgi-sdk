// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The TypeScript pack image: its base image (from the app's
 * `engines.node`) and its Containerfile — the app's own install from its
 * lockfile, the bundles, the index from the bundles, the pack service.
 */

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { prisma } from '@kindgi/handler-runtime/build-extensions';
import { PNPM_STORE_DIR, renderContainerfile } from '../src/build/containerfile.js';
import { writeContainerfileReal } from '../src/build/defaults.js';

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
  dependencies: 'all',
  keep: [],
  keepIfInstalled: [],
};

/** An image with one build step: `prisma()`'s `prisma generate`. */
const PRISMA_IMAGE = imageOf({
  image: { extensions: [prisma({ schema: 'prisma/schema.prisma' })] },
});

/** `install(over)` without the host's pnpm version. */
function installWithoutHostPnpm(over: Partial<HostInstall> = {}): HostInstall {
  const { hostPnpm: _hostPnpm, ...rest } = install(over);
  return rest;
}

function render(over: Partial<HostInstall> = {}, hasIncludes = false, image = NO_IMAGE): string {
  return renderHost(install(over), hasIncludes, image);
}

function renderHost(
  host: HostInstall,
  hasIncludes = false,
  image = NO_IMAGE,
  hasBlocks = false,
): string {
  return renderContainerfile({
    baseImageRef: NODE_24?.ref ?? '',
    artifactVersion: '20261002.1',
    publishedAt: '1970-01-01T00:00:00.000Z',
    buildTarget: 'linux/amd64',
    install: host,
    commands: installCommands(host, image.steps),
    image,
    hasIncludes,
    hasBlocks,
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
  test('pnpm: corepack, a frozen install of production dependencies with scripts off, then the allowed builds', () => {
    const text = render({ managerSpec: 'pnpm@11.25.0' });
    expect(text).toContain(`FROM ${NODE_24?.ref} AS system`);
    expect(text).toContain('apt-get install -y --no-install-recommends ca-certificates tini');
    expect(text).toContain('RUN corepack enable');
    expect(text).toContain('# --- stage: deps (pnpm: pnpm@11.25.0, from the lockfile) ---');
    expect(text).toContain('# Production dependencies only, as there are no build steps.');
    expect(text).toContain(
      'pnpm install --frozen-lockfile --ignore-scripts --prod && pnpm rebuild',
    );
    // Nothing to prune: no dev dependency was installed.
    expect(text).not.toContain('prune');
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
      "pnpm install --frozen-lockfile --ignore-scripts --prod --filter '{./apps/support}...' && pnpm --filter '{./apps/support}...' rebuild",
    );
    // With a build step: everything the project needs, then the same filtered install with --prod.
    const withSteps = render({ workspace: true, packRel: 'apps/support' }, false, PRISMA_IMAGE);
    expect(withSteps).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts --prod=false --filter '{./apps/support}...' && pnpm --filter '{./apps/support}...' rebuild",
    );
    expect(withSteps).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts --prod --config.confirm-modules-purge=false --filter '{./apps/support}...'\n",
    );
    expect(withSteps).not.toContain('pnpm prune');
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

  test('npm: no corepack; npm ci of production dependencies, then rebuild; with a build step, npm ci, the step, the prune', () => {
    const npm = { manager: 'npm', files: ['package.json', 'package-lock.json'] } as const;
    const text = render(npm);
    expect(text).not.toContain('corepack');
    expect(text).toContain(
      'npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm rebuild',
    );
    expect(text).not.toContain('prune');
    expect(text).not.toContain('store_dir');
    const withSteps = render(npm, false, PRISMA_IMAGE);
    expect(withSteps).toContain(
      'npm ci --include=dev --ignore-scripts --no-audit --no-fund && npm rebuild',
    );
    expect(withSteps).toContain('npm prune --omit=dev --no-audit --no-fund');
  });

  test('yarn: classic installs production; berry installs immutably and focuses production, as its production install resolves what yarn.lock lacks', () => {
    const classic = render({ manager: 'yarn', yarnBerry: false });
    expect(classic).toContain(
      'yarn install --production --frozen-lockfile --ignore-scripts --non-interactive && npm rebuild',
    );
    expect(classic).not.toContain('yarn install --frozen-lockfile');
    const berry = render({ manager: 'yarn', yarnBerry: true });
    expect(berry).toContain(
      "# Dev dependencies too, since yarn berry's production install resolves what yarn.lock lacks instead of failing; pruned to production after.",
    );
    expect(berry.indexOf('yarn workspaces focus --all --production')).toBeGreaterThan(
      berry.indexOf('yarn install --immutable'),
    );
    expect(berry.indexOf('yarn install --immutable')).toBeGreaterThan(0);
    // Classic with a build step: the full install, then production again.
    const classicSteps = render({ manager: 'yarn', yarnBerry: false }, false, PRISMA_IMAGE);
    expect(classicSteps).toContain(
      'yarn install --production=false --frozen-lockfile --ignore-scripts --non-interactive && npm rebuild',
    );
    expect(classicSteps).toContain('yarn install --production --frozen-lockfile');
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

  test('the indexer loads the modules with NODE_ENV=production, as the service does; the install has none', () => {
    const text = render();
    const indexer = text.slice(
      text.indexOf('FROM deps AS indexer'),
      text.indexOf('FROM system AS final'),
    );
    expect(indexer).toContain('\nENV NODE_ENV=production\n');
    expect(indexer.indexOf('ENV NODE_ENV=production')).toBeLessThan(
      indexer.indexOf('kindgi-index.mjs'),
    );
    // With it, the install would leave out the dev dependencies a build step needs.
    expect(
      text.slice(text.indexOf('FROM system AS deps'), text.indexOf('FROM scratch AS code')),
    ).not.toContain('NODE_ENV');
  });

  test('the final stage runs the pack service over the bundles, under tini, as node', () => {
    const text = render();
    const final = text.slice(text.indexOf('FROM system AS final'));
    expect(final).toContain(
      'ENTRYPOINT ["/usr/bin/tini","--","node","--enable-source-maps","./dist/kindgi-pack-service.mjs","--index","/app/index.json","--module-root","./dist","--bundle-map","./dist/bundle-map.json"]',
    );
    expect(final).toContain('ENV NODE_ENV=production');
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

  test("the pack's blocks go to the indexer stage only, before it indexes", () => {
    const text = renderHost(install({ packRel: 'apps/support' }), false, NO_IMAGE, true);
    const indexer = text.slice(
      text.indexOf('# --- stage: indexer ---'),
      text.indexOf('# --- stage: final ---'),
    );
    const copy = 'COPY --chown=node:node blocks/ ./';
    expect(indexer).toContain(
      `WORKDIR /app/apps/support\n# The pack's data blocks, read into the index: this stage's only.\n${copy}`,
    );
    expect(indexer.indexOf(copy)).toBeLessThan(
      indexer.indexOf('RUN node --enable-source-maps ./dist/kindgi-index.mjs'),
    );
    expect(text.split(copy)).toHaveLength(2);
    expect(render()).not.toContain('blocks/');
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
    expect(text).toContain(
      '# Dev dependencies too, for the build steps (prisma), whose tools can be dev dependencies; pruned to production after.',
    );
    expect(install).toBeGreaterThan(0);
    expect(files).toBeGreaterThan(install);
    expect(generate).toBeGreaterThan(files);
    expect(prune).toBeGreaterThan(generate);
    expect(render({ manager: 'npm' }, false, image)).toContain(
      'cd /app && npx --no -- prisma generate',
    );
  });

  test("kindgi build's Containerfile takes the image's steps: dev dependencies too, the step, the prune", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'kindgi-containerfile-')));
    try {
      const write = async (image: ResolvedImage): Promise<string> => {
        const outputPath = join(dir, 'Containerfile');
        await writeContainerfileReal({
          outputPath,
          baseImageRef: NODE_24?.ref ?? '',
          artifactVersion: '20261002.1',
          publishedAt: '1970-01-01T00:00:00.000Z',
          buildTarget: 'linux/amd64',
          install: install(),
          image,
          hasIncludes: false,
          hasBlocks: false,
        });
        return readFile(outputPath, 'utf8');
      };
      const withSteps = await write(image);
      expect(withSteps).toContain(
        'pnpm install --frozen-lockfile --ignore-scripts --prod=false && pnpm rebuild',
      );
      expect(withSteps).toContain('pnpm prune --prod');
      const without = await write(NO_IMAGE);
      expect(without).toContain(
        'pnpm install --frozen-lockfile --ignore-scripts --prod && pnpm rebuild',
      );
      expect(without).not.toContain('prune');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('build env is set in the install stage only, quoted, $ not expanded', () => {
    const text = render({}, false, image);
    const env = text.indexOf('ENV DATABASE_URL="postgresql://build-placeholder/\\$db"');
    expect(env).toBeGreaterThan(text.indexOf('FROM system AS deps'));
    expect(env).toBeLessThan(text.indexOf('FROM scratch AS code'));
    expect(text.slice(text.indexOf('FROM system AS final'))).not.toContain('DATABASE_URL');
  });

  test("buildEnv's NODE_ENV is the indexer's, with either dependencies setting; the service's stays production", () => {
    for (const dependencies of ['all', 'loaded'] as const) {
      const text = render(
        {},
        false,
        imageOf({ image: { dependencies, buildEnv: { NODE_ENV: 'development' } } }),
      );
      const at = text.indexOf(' AS indexer');
      const indexer = text.slice(at, text.indexOf('FROM system AS final'));
      expect(indexer).not.toContain('NODE_ENV=production');
      if (dependencies === 'all') {
        // The indexer is on deps, where the build env is set.
        expect(text).toContain('FROM deps AS indexer');
        const set = text.indexOf('ENV NODE_ENV="development"');
        expect(set).toBeGreaterThan(text.indexOf('FROM system AS deps'));
        expect(set).toBeLessThan(text.indexOf('FROM scratch AS code'));
      } else {
        expect(indexer).toContain('ENV NODE_ENV="development"');
      }
      expect(text.slice(text.indexOf('FROM system AS final'))).toContain(
        '\nENV NODE_ENV=production\n',
      );
    }
  });

  test("buildEnv's NODE_ENV=production comes before the install, which asks for dev dependencies for the steps all the same", () => {
    const production = imageOf({
      image: {
        extensions: [prisma({ schema: 'prisma/schema.prisma' })],
        buildEnv: { NODE_ENV: 'production' },
      },
    });
    for (const [over, installs] of [
      [{}, 'pnpm install --frozen-lockfile --ignore-scripts --prod=false && pnpm rebuild'],
      [
        { manager: 'npm' },
        'npm ci --include=dev --ignore-scripts --no-audit --no-fund && npm rebuild',
      ],
      [
        { manager: 'yarn', yarnBerry: false },
        'yarn install --production=false --frozen-lockfile --ignore-scripts --non-interactive && npm rebuild',
      ],
    ] as const) {
      const text = render(over, false, production);
      const said = text.indexOf(
        '\n# Build env: the install, the build steps and the indexer stage only, never the final image.\nENV NODE_ENV="production"\n',
      );
      expect(said).toBeGreaterThan(text.indexOf('FROM system AS deps'));
      expect(text.indexOf(installs)).toBeGreaterThan(said);
    }
  });

  test('without extensions, nothing extra is rendered', () => {
    const text = render();
    expect(text).not.toContain('ext/');
    expect(text).not.toContain('Build env');
  });
});

describe("the Containerfile with image.dependencies: 'loaded'", () => {
  const image = imageOf({
    image: {
      dependencies: 'loaded',
      keep: ['pino-pretty', '@acme/plugin'],
      extensions: [prisma({ schema: 'prisma/schema.prisma' })],
      buildEnv: { DATABASE_URL: 'postgresql://build-placeholder' },
    },
  });

  test('a closure stage trims the install from deps: externals, the keeps, no network', () => {
    const text = render({ packRel: 'apps/support' }, false, image);
    const closure = text.slice(
      text.indexOf('FROM deps AS closure'),
      text.indexOf('FROM system AS trimmed'),
    );
    expect(closure).toContain(
      'COPY --from=code --chown=node:node /dist/kindgi-closure.mjs /dist/externals.json /home/node/closure-in/',
    );
    expect(closure).toContain(
      [
        'RUN node /home/node/closure-in/kindgi-closure.mjs trim \\',
        '      --root /app \\',
        '      --bundle-dir /app/apps/support/dist \\',
        '      --externals /home/node/closure-in/externals.json \\',
        '      --keep @acme/plugin \\',
        '      --keep pino-pretty \\',
        '      --keep-if-installed .prisma/client \\',
        '      --out /home/node/closure',
      ].join('\n'),
    );
    expect(closure).not.toContain('--mount=type=secret');
    expect(text).toContain(
      'FROM system AS trimmed\nCOPY --from=closure --chown=node:node /home/node/closure /app',
    );
  });

  test('an install cut down to what the pack loads: one project, the same frozen install, and said', () => {
    const reduced = {
      written: {},
      copied: ['apps/support/package.json'],
      kept: 15,
      total: 17,
      leftOut: [],
    };
    const cut = render({ packRel: 'apps/support', workspace: false, reduced }, false, image);
    const deps = cut.slice(cut.indexOf('AS deps'), cut.indexOf('FROM deps AS closure'));
    expect(deps).toContain(
      "# Only what the pack loads: 15 of the lockfile's 17 packages, from the manifest and lockfile kindgi build cut down to them.",
    );
    expect(deps).toContain('pnpm install --frozen-lockfile');
    expect(deps).not.toContain('--filter');
    const full = render({ packRel: 'apps/support', workspace: true }, false, image);
    expect(full).not.toContain("of the lockfile's");
    expect(full).toContain('--filter');
  });

  test('the indexer runs on the trimmed install, after the load check, with the build env', () => {
    const text = render({}, false, image);
    const indexer = text.slice(
      text.indexOf('FROM trimmed AS indexer'),
      text.indexOf('FROM system AS final'),
    );
    expect(indexer).toContain('USER node');
    expect(indexer).toContain('ENV DATABASE_URL="postgresql://build-placeholder"');
    expect(indexer).toContain('\nENV NODE_ENV=production\n');
    const check = indexer.indexOf(
      'RUN node ./dist/kindgi-closure.mjs check --bundle-dir /app/dist --externals ./dist/externals.json',
    );
    expect(check).toBeGreaterThan(indexer.indexOf('COPY --from=code'));
    expect(indexer.indexOf('kindgi-index.mjs')).toBeGreaterThan(check);
  });

  test('the final image takes the trimmed install, and says it is trimmed to the pack service', () => {
    const final = render({}, false, image).split('FROM system AS final')[1] ?? '';
    expect(final).toContain('COPY --from=trimmed --chown=node:node /app /app');
    expect(final).not.toContain('--from=deps');
    expect(final).toContain('ENV KINDGI_IMAGE_DEPENDENCIES=loaded');
    expect(final).not.toContain('DATABASE_URL');
  });

  test("'all', the default: none of it", () => {
    for (const text of [
      render(),
      render({}, false, imageOf({ image: { dependencies: 'all', keep: ['x'] } })),
    ]) {
      expect(text).not.toMatch(/closure|trimmed|KINDGI_IMAGE_DEPENDENCIES/);
      expect(text).toContain('FROM deps AS indexer');
      expect(text).toContain('COPY --from=deps --chown=node:node /app /app');
    }
  });
});
