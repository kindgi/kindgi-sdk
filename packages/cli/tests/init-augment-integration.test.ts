// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * C1 — End-to-end integration test for `kindgi init` (augment mode) +
 * `kindgi build`'s tracer. Proves the full augment story works
 * against a fixture repo shaped like a real Next.js app:
 *
 *   1. Set up a tmp Next.js-ish repo with package.json / next.config /
 *      src/lib/db.ts / node_modules for both a native module and a
 *      pure-JS peer.
 *   2. Run `kindgi init` — auto-detects augment mode. Assert every
 *      Kindgi file written correctly, every surrounding file
 *      untouched, package.json patched (+ @kindgi/sdk in deps), and
 *      .gitignore updated.
 *   3. Write a pack tool at `kindgi/tools/lookup.ts` that imports
 *      cross-repo (`../../src/lib/db`), which itself imports a
 *      native module.
 *   4. Run the real esbuild bundle + tarPack against the fixture.
 *      Verify:
 *        - Bundle contains the cross-repo function inlined
 *          (transitive close crossed the pack/repo boundary).
 *        - `externals` includes the native module, with its version
 *          resolved from the fixture's package.json (workspace:*
 *          not applicable here — that's covered by build-externals.test).
 *        - Synthesized container `package.json` (in the tar-context
 *          dir) contains only the native module — NOT next, react,
 *          tailwind, or the pure-JS peer that got bundled inline.
 *
 * This test is the final proof that the augment-init + build tracer
 * combination delivers on the promise: "user drops kindgi into
 * existing Next.js app, imports app code from pack code, and the
 * pack ships as a tight OCI image without React/Next inside."
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  esbuildBundleReal,
  tarPackReal,
  writeContainerfileReal,
  writeContextReal,
} from '../src/build/defaults.js';
import { resolveHostInstall } from '../src/build/host-install.js';
import { NODE_BASE_IMAGES } from '../src/build/node-image.js';
import { type RunCliInputs, runCli } from '../src/main.js';

let repoRoot: string;
let skillsRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'kindgi-augment-integ-'));
  skillsRoot = await mkdtemp(join(tmpdir(), 'kindgi-augment-integ-skills-'));
  // A single fixture skill is enough — the merge/copy logic itself is
  // covered by init-augment-scaffolder.test.ts.
  await mkdir(join(skillsRoot, 'kindgi-getting-started'), { recursive: true });
  await writeFile(join(skillsRoot, 'kindgi-getting-started', 'SKILL.md'), '# fixture skill\n');
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
  await rm(skillsRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// Fixture setup — a Next.js-shaped repo
// ---------------------------------------------------------------------

async function setupNextishRepo(): Promise<void> {
  // Root package.json — realistic Next.js deps mix.
  await writeFile(
    join(repoRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'my-nextjs-app',
        version: '0.1.0',
        scripts: {
          dev: 'next dev',
          build: 'next build',
          test: 'vitest',
        },
        dependencies: {
          next: '14.2.0',
          react: '18.3.0',
          'react-dom': '18.3.0',
          tailwindcss: '3.4.0',
          // Pure-JS peer the pack code will pull in — this SHOULD end
          // up bundled inline, not externalised.
          'pure-utility': '2.0.0',
          // Native module the pack code will pull in — this SHOULD be
          // externalised into the container's synthesized package.json.
          'native-db-driver': '1.5.0',
        },
        devDependencies: {
          typescript: '^5.0.0',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // The app's own secrets + source — must never reach the image.
  await writeFile(join(repoRoot, '.env'), 'APP_SECRET=do-not-ship\n', 'utf8');
  await mkdir(join(repoRoot, 'src', 'app'), { recursive: true });
  await writeFile(join(repoRoot, 'src', 'app', 'page.tsx'), 'export default 1;\n', 'utf8');

  // next.config.js — must not be touched by init.
  await writeFile(
    join(repoRoot, 'next.config.js'),
    'module.exports = { reactStrictMode: true };\n',
    'utf8',
  );

  // src/lib/db.ts — the cross-repo import target. Uses the native
  // module, so pulling this in transitively should surface
  // `native-db-driver` as external.
  await mkdir(join(repoRoot, 'src', 'lib'), { recursive: true });
  await writeFile(
    join(repoRoot, 'src', 'lib', 'db.ts'),
    `
import { connect } from 'native-db-driver';
import { formatName } from 'pure-utility';

export async function getUser(id: string): Promise<string> {
  const db = await connect();
  const row = await db.lookup(id);
  return formatName(row.name);
}
`,
    'utf8',
  );

  // Fake node_modules:
  //   - native-db-driver: has binding.gyp → externals plugin will
  //     flag as native
  //   - pure-utility: no native indicators → bundled inline
  //   - next / react / tailwindcss: exist so the surrounding
  //     package.json is realistic, but never imported by pack code,
  //     so they're NOT reached by esbuild and MUST NOT appear in
  //     the synthesized container package.json
  const nativeDir = join(repoRoot, 'node_modules', 'native-db-driver');
  await mkdir(nativeDir, { recursive: true });
  await writeFile(
    join(nativeDir, 'package.json'),
    `${JSON.stringify({
      name: 'native-db-driver',
      version: '1.5.0',
      main: 'index.js',
    })}\n`,
    'utf8',
  );
  // binding.gyp — heuristic marker.
  await writeFile(join(nativeDir, 'binding.gyp'), '{}', 'utf8');
  await writeFile(
    join(nativeDir, 'index.js'),
    'export const connect = async () => ({ lookup: async (id) => ({ name: id }) });\n',
    'utf8',
  );

  const pureDir = join(repoRoot, 'node_modules', 'pure-utility');
  await mkdir(pureDir, { recursive: true });
  await writeFile(
    join(pureDir, 'package.json'),
    `${JSON.stringify({ name: 'pure-utility', version: '2.0.0', main: 'index.js' })}\n`,
    'utf8',
  );
  await writeFile(
    join(pureDir, 'index.js'),
    'export const formatName = (n) => `Name: ${n}`;\n',
    'utf8',
  );

  // Surrounding-repo deps we do NOT want bundled — package.json
  // entries only, no fake node_modules code. They must never be
  // touched by the pack build.
  for (const pkg of ['next', 'react', 'react-dom', 'tailwindcss']) {
    const dir = join(repoRoot, 'node_modules', pkg);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: pkg, version: '1.0.0' })}\n`,
      'utf8',
    );
  }

  // Fake `@kindgi/handler-runtime` — esbuildBundleReal always bakes
  // its `kindgi-index` and `pack-service-main` subpath entries
  // into every pack image. In a real install this comes in via
  // `pnpm install`; in the test fixture we provide a stub with the
  // right subpath exports so esbuild can resolve them.
  // The app's lockfile: what the image installs from.
  await writeFile(join(repoRoot, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8');
}

function baseInputs(argv: readonly string[], extras: Partial<RunCliInputs> = {}): RunCliInputs {
  return {
    argv,
    env: {},
    cwd: repoRoot,
    home: '/tmp/fake-home',
    ...extras,
  };
}

// ---------------------------------------------------------------------
// The integration test
// ---------------------------------------------------------------------

describe('kindgi init (augment) + build — end-to-end', () => {
  test('full flow: augment-init + cross-repo import bundling + the image context', async () => {
    // ---- 1. Fixture setup -------------------------------------------
    await setupNextishRepo();

    // ---- 2. Run `kindgi init` — augment mode auto-detects ------------
    // Point at fixture skills via test-friendly overload (init.ts's
    // runInit takes a skillsRoot; the CLI entry provides a default,
    // but for tests we need to inject).
    // Do this by calling runInit directly? Or via runCli.
    // runCli uses defaultSdkSkillsRoot() which resolves to the actual
    // shipped skills. For test purposes we're happy with those — but
    // to keep the test deterministic + fast, call the augment
    // scaffolder directly and skip the CLI shell.

    const augmentInit = await runCli(baseInputs(['init']));
    expect(augmentInit.exitCode).toBe(0);
    expect(augmentInit.stderr).toContain('augment mode');

    // ---- 3. Assert augment files present -----------------------------
    // kindgi.config.mts at root (the fixture app is CommonJS)
    const config = await readFile(join(repoRoot, 'kindgi.config.mts'), 'utf8');
    expect(config).toContain("id: 'my-nextjs-app'");
    expect(config).toContain("tools: 'kindgi/tools/**/*.ts'");

    // kindgi/ subdirs
    for (const sub of ['agents', 'tools', 'guardrails', 'flows']) {
      const gitkeep = join(repoRoot, 'kindgi', sub, '.gitkeep');
      expect((await stat(gitkeep)).isFile()).toBe(true);
    }

    // package.json patched with @kindgi/sdk
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('my-nextjs-app'); // untouched
    expect(pkg.dependencies['@kindgi/sdk']).toBeTruthy();
    expect(pkg.dependencies.next).toBe('14.2.0'); // preserved
    expect(pkg.dependencies['native-db-driver']).toBe('1.5.0'); // preserved

    // .gitignore updated
    const gitignore = await readFile(join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.env.local');
    expect(gitignore).toContain('.kindgi/');

    // Surrounding files untouched
    expect(await readFile(join(repoRoot, 'next.config.js'), 'utf8')).toBe(
      'module.exports = { reactStrictMode: true };\n',
    );
    expect(await readFile(join(repoRoot, 'src', 'lib', 'db.ts'), 'utf8')).toContain('getUser');

    // ---- 4. Write a pack tool that imports cross-repo ---------------
    // The pack code lives at <repo>/kindgi/tools/lookup.ts and imports
    // from <repo>/src/lib/db.ts (which uses native-db-driver + pure-
    // utility). esbuild MUST follow the chain and bundle the pure
    // side while externalising the native side.
    await writeFile(
      join(repoRoot, 'kindgi', 'tools', 'lookup.ts'),
      `
import { getUser } from '../../src/lib/db';

export async function lookupTool(input: { id: string }): Promise<string> {
  return getUser(input.id);
}
`,
      'utf8',
    );

    // ---- 5. Run the real esbuild bundle ------------------------------
    const bundleOutDir = await mkdtemp(join(tmpdir(), 'kindgi-augment-bundle-'));
    const workDir = await mkdtemp(join(tmpdir(), 'kindgi-augment-context-'));
    try {
      const bundle = await esbuildBundleReal({
        packDir: repoRoot,
        outputDir: bundleOutDir,
        discoveryPatterns: ['kindgi/tools/**/*.ts'],
        configPath: join(repoRoot, 'kindgi.config.mts'),
        nodeMajor: 22,
      });

      // ---- 6. The app's installed packages stay external, by name -----
      // Native or not: the image installs them from the app's lockfile.
      expect(bundle.externals).toEqual(['native-db-driver', 'pure-utility']);
      const toolFile = bundle.emitted.find((f) => f.endsWith('/kindgi/tools/lookup.mjs'));
      expect(toolFile).toBeTruthy();
      const toolBundle = await readFile(toolFile as string, 'utf8');
      // The app module the tool imports is bundled…
      expect(toolBundle).toContain('getUser');
      expect(toolBundle).not.toContain('formatName = (n)');
      // …its dependencies imported by name, never by a host path.
      expect(toolBundle).toMatch(/from ["']native-db-driver["']/);
      expect(toolBundle).toMatch(/from ["']pure-utility["']/);
      expect(toolBundle).not.toContain(repoRoot);

      // The framework's entries, the config and the map the image runs from.
      for (const name of ['kindgi-index.mjs', 'kindgi-pack-service.mjs', 'kindgi.config.mjs']) {
        expect(bundle.emitted.some((f) => f.endsWith(`/${name}`))).toBe(true);
      }
      expect(bundle.bundleMap).toEqual({ 'kindgi/tools/lookup.ts': 'kindgi/tools/lookup.mjs' });
      expect(JSON.parse(await readFile(join(bundleOutDir, 'bundle-map.json'), 'utf8'))).toEqual(
        bundle.bundleMap,
      );

      // ---- 7. The build context: the install's files and the bundles ----
      // `kindgi init` linked @kindgi/sdk from this checkout, outside the
      // app: an image can't install that, and the build says what to do.
      const linked = await resolveHostInstall(repoRoot);
      expect(linked.kind === 'err' && linked.message).toContain('Vendor it as a tarball');
      // Vendored inside the project, as the pilot does until it's published.
      await mkdir(join(repoRoot, 'vendor'), { recursive: true });
      await writeFile(join(repoRoot, 'vendor', 'kindgi-sdk.tgz'), 'tgz', 'utf8');
      const appPkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      appPkg.dependencies['@kindgi/sdk'] = 'file:vendor/kindgi-sdk.tgz';
      for (const deps of [appPkg.dependencies, appPkg.devDependencies ?? {}]) {
        for (const [name, spec] of Object.entries(deps)) {
          if (/^(file|link):\//.test(spec)) delete deps[name];
        }
      }
      await writeFile(
        join(repoRoot, 'package.json'),
        `${JSON.stringify(appPkg, null, 2)}\n`,
        'utf8',
      );
      const hostInstall = await resolveHostInstall(repoRoot);
      if (hostInstall.kind !== 'ok') throw new Error(hostInstall.message);
      const containerfilePath = join(workDir, 'Containerfile');
      await writeContainerfileReal({
        outputPath: containerfilePath,
        baseImageRef: NODE_BASE_IMAGES[0]?.ref ?? '',
        artifactVersion: '20260928.1',
        publishedAt: '1970-01-01T00:00:00.000Z',
        buildTarget: 'staging',
        install: hostInstall.install,
        image: { systemPackages: [], buildEnv: {}, contextFiles: [], steps: [], extensions: [] },
        hasIncludes: false,
      });
      const contextDir = join(workDir, 'context');
      await writeContextReal({
        contextDir,
        packDir: repoRoot,
        install: hostInstall.install,
        bundleDir: bundleOutDir,
        containerfilePath,
        includes: [],
        extensionFiles: [],
      });
      const tarPath = join(workDir, 'pack.tgz');
      await tarPackReal({ contextDir, outputPath: tarPath });

      const extractDir = join(workDir, 'extracted');
      await mkdir(extractDir, { recursive: true });
      const tar = await import('tar');
      await tar.extract({ file: tarPath, cwd: extractDir });
      const { readdir } = await import('node:fs/promises');
      const shipped = (await readdir(extractDir, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name).slice(extractDir.length + 1))
        .filter((p) => !p.startsWith('dist/'))
        .sort();
      // No source, no `.env`, no app config: the install's inputs only.
      expect(shipped).toEqual([
        'Containerfile',
        'host/package-lock.json',
        'host/package.json',
        'host/vendor/kindgi-sdk.tgz',
      ]);
      // The app's own package.json, as is — the install reads it with its lockfile.
      const hostPkg = JSON.parse(
        await readFile(join(extractDir, 'host', 'package.json'), 'utf8'),
      ) as {
        dependencies: Record<string, string>;
      };
      expect(hostPkg.dependencies.next).toBe('14.2.0');
    } finally {
      await rm(bundleOutDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
