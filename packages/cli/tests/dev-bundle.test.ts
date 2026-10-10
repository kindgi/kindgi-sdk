// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi dev`'s bundler and indexer child against a real pack shaped
 * like an app's: a tool that imports a shared module through a tsconfig
 * `paths` alias (extensionless), a dependency installed in the pack's
 * `node_modules`, and a module that reads env when it's imported.
 *
 * The pack lives under the CLI package (`tmp/`, gitignored) so
 * `@kindgi/sdk` resolves as it would from an app.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, onTestFinished, test, vi } from 'vitest';

import { resolvedSpecifier } from '../src/build/bundle.js';
import { esbuildBundleReal } from '../src/build/defaults.js';
import { STAMP_SAFETY_GAP_MS, createDevPackBuilder, stampOf } from '../src/dev/bundler.js';
import { runIndexerReadReal } from '../src/dev/defaults.js';
import type { PackBuild, PackBuilder } from '../src/dev/runners.js';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const PATTERNS = ['tools/**/*.ts'];
let packDir: string;
const builders: PackBuilder[] = [];

const TOOL = (id: string) => `import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { greet, GREETING } from '@/lib/greet';

const defined = defineTool({
  id: '${id}' as ToolId,
  description: \`Greets with \${GREETING}\`,
  version: '0.1.0',
  input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  output: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  mutating: false,
  handler: async (input: { name: string }) => ({ message: greet(input.name) }),
});
if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
`;

async function write(rel: string, body: string): Promise<void> {
  await mkdir(join(packDir, rel, '..'), { recursive: true });
  await writeFile(join(packDir, rel), body, 'utf8');
}

function builder(): PackBuilder {
  const b = createDevPackBuilder({ packDir, patterns: PATTERNS });
  builders.push(b);
  return b;
}

/** A watching builder stops with its test, so it never rebuilds into the next one's files. */
function disposedAfterTest(b: PackBuilder): PackBuilder {
  onTestFinished(() => b.dispose());
  return b;
}

beforeAll(async () => {
  await mkdir(join(PACKAGE_DIR, 'tmp'), { recursive: true });
  packDir = await mkdtemp(join(PACKAGE_DIR, 'tmp', 'dev-bundle-'));
  await write(
    'kindgi.config.ts',
    "export default { pack: { id: 'bt', version: '0.1.0' }, discovery: { tools: 'tools/**/*.ts' } };\n",
  );
  await write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  );
  // A shared module outside the discovery folders, imported by alias
  // and without an extension; it reads env at import and uses a
  // dependency from node_modules.
  await write(
    'src/lib/greet.ts',
    "import { shout } from 'shouty';\nexport const GREETING = process.env.PACK_GREETING ?? 'hello';\nexport function greet(name: string): string {\n  return shout(`${GREETING}, ${name}`);\n}\n",
  );
  await write(
    'node_modules/shouty/package.json',
    JSON.stringify({ name: 'shouty', version: '1.0.0', type: 'module', exports: './index.js' }),
  );
  await write('node_modules/shouty/index.js', 'export const shout = (s) => `${s}!`;\n');
  await write('tools/greet.ts', TOOL('bt.greet'));
});

afterAll(async () => {
  for (const b of builders.splice(0)) await b.dispose();
  await rm(packDir, { recursive: true, force: true });
});

describe('the dev bundler', () => {
  test('bundles the alias import; keeps the node_modules dependency external', async () => {
    const build = await builder().build();
    expect(build).toMatchObject({
      kind: 'ok',
      bundleMap: { 'tools/greet.ts': '.kindgi/dev/dist/tools/greet.mjs' },
    });
    // Named with the file importing it. (The linked SDK is bundled, so
    // its own dependencies are externals too.)
    expect(build.kind === 'ok' && build.externals?.find((e) => e.name === 'shouty')).toEqual({
      name: 'shouty',
      importers: ['src/lib/greet.ts'],
    });
    const bundle = await readFile(join(packDir, '.kindgi/dev/dist/tools/greet.mjs'), 'utf8');
    // The shared module is inlined …
    expect(bundle).toContain('PACK_GREETING');
    // … the dependency is imported from its installed location, by file URL.
    expect(bundle).toMatch(/from "file:\/\/\/.*node_modules\/shouty\/index\.js"/);
    expect(bundle).toContain('//# sourceMappingURL=greet.mjs.map');
  });

  test('the indexer child imports the bundle with the pack env and records the source path', async () => {
    const build = (await builder().build()) as Extract<PackBuild, { kind: 'ok' }>;
    const out = join(packDir, '.kindgi/dev/index.test.json');
    const indexed = await runIndexerReadReal(packDir, out, {
      bundleMap: build.bundleMap,
      env: async () => ({ PATH: process.env.PATH ?? '', PACK_GREETING: 'kia ora' }),
    });
    if (indexed.kind === 'err') throw new Error(`${indexed.code}: ${indexed.message}`);
    const tools = (
      indexed.index as { tools: { id: string; modulePath: string; description: string }[] }
    ).tools;
    expect(tools).toEqual([
      expect.objectContaining({
        id: 'bt.greet',
        modulePath: 'tools/greet.ts',
        // Read from the pack env when the module was imported.
        description: 'Greets with kia ora',
      }),
    ]);
  });

  test('a syntax error is reported with its file and line', async () => {
    await write('src/lib/broken.ts', 'export const x = ;\n');
    await write('tools/broken.ts', "import { x } from '@/lib/broken';\nexport default x;\n");
    try {
      const build = await builder().build();
      expect(build.kind).toBe('err');
      expect(build.kind === 'err' && build.errors.join('\n')).toMatch(
        /src\/lib\/broken\.ts:1:\d+: /,
      );
    } finally {
      await rm(join(packDir, 'tools/broken.ts'));
      await rm(join(packDir, 'src/lib/broken.ts'));
    }
  });

  // esbuild's watch mode polls, so each wait has room for a busy machine.
  test(
    'watching: an edit to the shared module rebuilds; a new tool file is picked up',
    { timeout: 60_000 },
    async () => {
      const b = disposedAfterTest(builder());
      await b.build();
      // Each report with the bundle it names, read as it's reported: the
      // build has written it, and no other build runs until it's reported.
      const reports: { build: PackBuild; greet: string }[] = [];
      const greetBundle = join(packDir, '.kindgi/dev/dist/tools/greet.mjs');
      await b.watch((build) => reports.push({ build, greet: readFileSync(greetBundle, 'utf8') }));

      await write(
        'src/lib/greet.ts',
        (await readFile(join(packDir, 'src/lib/greet.ts'), 'utf8')).replace("'hello'", "'hi'"),
      );
      await vi.waitFor(() => expect(reports.at(-1)?.greet).toContain('"hi"'), { timeout: 30_000 });

      await write('tools/second.ts', TOOL('bt.second'));
      expect(await b.syncEntries()).toBe(true);
      await vi.waitFor(
        () =>
          expect(reports.at(-1)?.build).toMatchObject({
            kind: 'ok',
            bundleMap: {
              'tools/greet.ts': '.kindgi/dev/dist/tools/greet.mjs',
              'tools/second.ts': '.kindgi/dev/dist/tools/second.mjs',
            },
          }),
        { timeout: 30_000 },
      );
      expect(await b.syncEntries()).toBe(false);
    },
  );

  test(
    'watching: removing the last primitive file reports an empty build',
    { timeout: 60_000 },
    async () => {
      const b = disposedAfterTest(builder());
      await b.build();
      const builds: PackBuild[] = [];
      await b.watch((build) => builds.push(build));
      await rm(join(packDir, 'tools'), { recursive: true, force: true });
      expect(await b.syncEntries()).toBe(true);
      await vi.waitFor(
        () => expect(builds.at(-1)).toEqual({ kind: 'ok', bundleMap: {}, externals: [] }),
        { timeout: 30_000 },
      );
    },
  );
});

describe("the dev bundler's externals", () => {
  let dir: string;
  const put = async (rel: string, body: string): Promise<void> => {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), body, 'utf8');
  };
  const fakePackage = async (name: string, exportsName: string): Promise<void> => {
    await put(
      `node_modules/${name}/package.json`,
      JSON.stringify({
        name,
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.js', './sub': './index.js' },
      }),
    );
    await put(`node_modules/${name}/index.js`, `export const ${exportsName} = () => 1;\n`);
  };
  const externalsOf = (build: PackBuild | undefined) =>
    build?.kind === 'ok' ? build.externals : undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(PACKAGE_DIR, 'tmp', 'dev-externals-'));
    await fakePackage('acme-clock', 'now');
    await fakePackage('@acme/ids', 'id');
    await fakePackage('acme-config-helper', 'helper');
    await put('src/time.ts', "import { now } from 'acme-clock';\nexport const at = now;\n");
    await put(
      'tools/clock.ts',
      "import { now } from 'acme-clock';\nimport { at } from '../src/time';\nexport default { now, at };\n",
    );
    await put(
      'kindgi.config.ts',
      "import { helper } from 'acme-config-helper';\nexport default { pack: { id: 'x', version: '0.1.0' }, helper };\n",
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function externalsBuilder(): PackBuilder {
    const b = createDevPackBuilder({
      packDir: dir,
      patterns: PATTERNS,
      configPath: join(dir, 'kindgi.config.ts'),
    });
    builders.push(b);
    return b;
  }

  test("a build names what it loads from node_modules, with the files importing it; the config's imports too", async () => {
    expect(externalsOf(await externalsBuilder().build())).toEqual([
      { name: 'acme-clock', importers: ['src/time.ts', 'tools/clock.ts'] },
      { name: 'acme-config-helper', importers: ['kindgi.config.ts'] },
    ]);
  });

  test("the same packages as a pack image's bundles (`kindgi build`)", async () => {
    const dev = externalsOf(await externalsBuilder().build());
    const image = await esbuildBundleReal({
      packDir: dir,
      outputDir: join(dir, '.kindgi', 'build', 'dist'),
      discoveryPatterns: PATTERNS,
      configPath: join(dir, 'kindgi.config.ts'),
      nodeMajor: 22,
    });
    expect(dev?.map((e) => e.name)).toEqual(image.externals);
  });

  // Each edit is written as soon as watching starts, while watch mode's
  // first build may be reading the file — the race an editor's save can
  // hit. Whatever that build read, the last build reported is the edit's.
  test('watching: each rebuild names its own externals', { timeout: 60_000 }, async () => {
    const b = disposedAfterTest(externalsBuilder());
    await b.build();
    const builds: PackBuild[] = [];
    await b.watch((build) => builds.push(build));

    // A new import (a subpath: the package is named).
    await put(
      'tools/clock.ts',
      "import { now } from 'acme-clock';\nimport { id } from '@acme/ids/sub';\nexport default { now, id };\n",
    );
    await vi.waitFor(
      () =>
        expect(externalsOf(builds.at(-1))).toEqual([
          { name: '@acme/ids', importers: ['tools/clock.ts'] },
          { name: 'acme-clock', importers: ['tools/clock.ts'] },
          { name: 'acme-config-helper', importers: ['kindgi.config.ts'] },
        ]),
      { timeout: 30_000 },
    );

    // An import removed is gone from the next build's.
    await put('tools/clock.ts', "import { id } from '@acme/ids';\nexport default { id };\n");
    await vi.waitFor(
      () =>
        expect(externalsOf(builds.at(-1))).toEqual([
          { name: '@acme/ids', importers: ['tools/clock.ts'] },
          { name: 'acme-config-helper', importers: ['kindgi.config.ts'] },
        ]),
      { timeout: 30_000 },
    );
  });
});

describe("a build's stamp (what it read)", () => {
  let dir: string;
  const resultOf = (...inputs: string[]) => ({
    metafile: {
      inputs: Object.fromEntries(inputs.map((input) => [input, { bytes: 0, imports: [] }])),
      outputs: {},
    },
  });
  /** A build that started well after the files last changed. */
  const later = (): number => Date.now() + 60_000;

  beforeAll(async () => {
    dir = await mkdtemp(join(PACKAGE_DIR, 'tmp', 'dev-stamp-'));
    await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(dir, 'b.ts'), 'export const b = 2;\n');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('the same files, unchanged: the same stamp, whatever the order', async () => {
    const stamp = await stampOf(resultOf('a.ts', 'b.ts'), dir, later());
    expect(stamp).toMatch(/^a\.ts:\d+:.*\nb\.ts:\d+:/);
    expect(await stampOf(resultOf('b.ts', 'a.ts'), dir, later())).toBe(stamp);
  });

  test('a file changed between two builds: a different stamp', async () => {
    const before = await stampOf(resultOf('a.ts'), dir, later());
    await writeFile(join(dir, 'a.ts'), 'export const a = 10;\n');
    const after = await stampOf(resultOf('a.ts'), dir, later());
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  // The build may have read it before the change (or half written): a
  // stamp taken now would describe the file after the change, and the
  // rebuild the change triggers would match it and go unreported.
  test('a file changed after the build started, or just before: no stamp', async () => {
    const startedAt = Date.now();
    await writeFile(join(dir, 'b.ts'), 'export const b = 20;\n');
    expect(await stampOf(resultOf('a.ts', 'b.ts'), dir, startedAt)).toBeUndefined();
    // Within the safety gap before the start: too close to tell.
    const soonAfter = Date.now() + STAMP_SAFETY_GAP_MS / 2;
    expect(await stampOf(resultOf('b.ts'), dir, soonAfter)).toBeUndefined();
  });

  test('a file that is gone: no stamp', async () => {
    expect(await stampOf(resultOf('a.ts', 'gone.ts'), dir, later())).toBeUndefined();
  });
});

// Node's ESM loader takes a URL: a Windows path (`C:\…`) is rejected,
// and a `#` in any path starts a fragment. `require` takes a path.
describe('how a dev bundle names what it loads from node_modules', () => {
  const WIN = 'C:\\Users\\acme\\my pack\\node_modules\\shouty\\index.js';

  test('an import of a Windows path: a file URL', () => {
    expect(resolvedSpecifier(WIN, 'import-statement', 'win32')).toBe(
      'file:///C:/Users/acme/my%20pack/node_modules/shouty/index.js',
    );
    expect(resolvedSpecifier(WIN, 'dynamic-import', 'win32')).toBe(
      'file:///C:/Users/acme/my%20pack/node_modules/shouty/index.js',
    );
  });

  test('an import of a path with a #: a file URL, the # escaped', () => {
    expect(
      resolvedSpecifier(
        '/home/acme/pack #1/node_modules/shouty/index.js',
        'import-statement',
        'linux',
      ),
    ).toBe('file:///home/acme/pack%20%231/node_modules/shouty/index.js');
  });

  test('a require keeps the path, on Windows too', () => {
    expect(resolvedSpecifier(WIN, 'require-call', 'win32')).toBe(WIN);
    expect(resolvedSpecifier(WIN, 'require-resolve', 'win32')).toBe(WIN);
  });

  describe('a pack in a folder with a # in its name', () => {
    let dir: string;
    const put = async (rel: string, body: string): Promise<void> => {
      await mkdir(join(dir, rel, '..'), { recursive: true });
      await writeFile(join(dir, rel), body, 'utf8');
    };

    beforeAll(async () => {
      dir = await mkdtemp(join(PACKAGE_DIR, 'tmp', 'dev-specifiers #1 '));
      await put(
        'node_modules/shouty/package.json',
        JSON.stringify({ name: 'shouty', version: '1.0.0', type: 'module', exports: './index.js' }),
      );
      await put('node_modules/shouty/index.js', 'export const shout = (s) => `${s}!`;\n');
      // CommonJS, required from CommonJS code the bundle inlines.
      await put(
        'node_modules/bracketed/package.json',
        JSON.stringify({ name: 'bracketed', version: '1.0.0', main: 'index.js' }),
      );
      await put('node_modules/bracketed/index.js', 'exports.bracket = (s) => `[${s}]`;\n');
      await put(
        'src/legacy.cjs',
        "const { bracket } = require('bracketed');\nmodule.exports = { tag: (s) => bracket(s) };\n",
      );
      await put(
        'tools/both.ts',
        "import { shout } from 'shouty';\nimport legacy from '../src/legacy.cjs';\nexport const run = (): string => legacy.tag(shout('hi'));\n",
      );
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test('its bundle imports and runs: the import by file URL, the require by path', async () => {
      const b = createDevPackBuilder({ packDir: dir, patterns: PATTERNS });
      builders.push(b);
      const build = await b.build();
      expect(build).toMatchObject({
        kind: 'ok',
        bundleMap: { 'tools/both.ts': '.kindgi/dev/dist/tools/both.mjs' },
      });
      const bundlePath = join(dir, '.kindgi/dev/dist/tools/both.mjs');
      const bundle = await readFile(bundlePath, 'utf8');
      expect(bundle).toContain(
        `from "${pathToFileURL(join(dir, 'node_modules/shouty/index.js')).href}"`,
      );
      expect(bundle).toContain(JSON.stringify(join(dir, 'node_modules/bracketed/index.js')));
      // In plain Node, as `kindgi dev`'s indexer child loads it (vitest's
      // own loader doesn't decode the URL).
      const ran = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'const m = await import(process.argv[1]); process.stdout.write(m.run());',
          pathToFileURL(bundlePath).href,
        ],
        { encoding: 'utf8' },
      );
      expect(ran).toBe('[hi!]');
    });
  });
});
