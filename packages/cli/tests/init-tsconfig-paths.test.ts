// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { parseJsonc, readTsconfigPaths } from '../src/init/tsconfig-paths.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kindgi-tsconfig-paths-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), text, 'utf8');
}

describe('readTsconfigPaths', () => {
  test('no tsconfig.json, or one without paths: none', async () => {
    expect(await readTsconfigPaths(root)).toEqual({ aliases: [], notes: [] });
    await put('tsconfig.json', '{ "compilerOptions": { "strict": true } }');
    expect(await readTsconfigPaths(root)).toEqual({ aliases: [], notes: [] });
  });

  test("a Next.js app's: comments, trailing commas, `@/*` from the app's folder", async () => {
    await put(
      'tsconfig.json',
      `{
  // Next.js writes this file.
  "compilerOptions": {
    "target": "ES2017", /* old */
    "paths": {
      "@/*": ["./*"],
    },
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.mts"],
}
`,
    );
    expect(await readTsconfigPaths(root)).toEqual({
      aliases: [{ pattern: '@/*', target: '*' }],
      notes: [],
    });
  });

  test('targets resolve against baseUrl when it is set', async () => {
    await put(
      'tsconfig.json',
      '{ "compilerOptions": { "baseUrl": "./src", "paths": { "~/*": ["./*"], "db": ["lib/db/index.ts"] } } }',
    );
    expect((await readTsconfigPaths(root)).aliases).toEqual([
      { pattern: 'db', target: 'src/lib/db/index.ts' },
      { pattern: '~/*', target: 'src/*' },
    ]);
  });

  test("an app in a monorepo: paths from the extended base, from the base's folder", async () => {
    await put(
      'tsconfig.base.json',
      '{ "compilerOptions": { "paths": { "@acme/ui/*": ["packages/ui/src/*"] } } }',
    );
    await put('apps/web/tsconfig.json', '{ "extends": "../../tsconfig.base.json" }');
    expect((await readTsconfigPaths(join(root, 'apps', 'web'))).aliases).toEqual([
      { pattern: '@acme/ui/*', target: '../../packages/ui/src/*' },
    ]);
  });

  test("the app's own paths replace what it extends; its baseUrl applies to the base's paths", async () => {
    await put('base.json', '{ "compilerOptions": { "paths": { "@base/*": ["base/*"] } } }');
    await put(
      'tsconfig.json',
      '{ "extends": "./base", "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    );
    expect((await readTsconfigPaths(root)).aliases).toEqual([{ pattern: '@/*', target: 'src/*' }]);

    await put(
      'tsconfig.json',
      '{ "extends": "./base.json", "compilerOptions": { "baseUrl": "app" } }',
    );
    expect((await readTsconfigPaths(root)).aliases).toEqual([
      { pattern: '@base/*', target: 'app/base/*' },
    ]);
  });

  test('an extends array: the last entry wins', async () => {
    await put('a.json', '{ "compilerOptions": { "paths": { "@/*": ["a/*"] } } }');
    await put('b.json', '{ "compilerOptions": { "paths": { "@/*": ["b/*"] } } }');
    await put('tsconfig.json', '{ "extends": ["./a.json", "./b.json"] }');
    expect((await readTsconfigPaths(root)).aliases).toEqual([{ pattern: '@/*', target: 'b/*' }]);
  });

  test("a package's tsconfig, found as Node finds the package", async () => {
    await put('node_modules/@acme/tsconfig/package.json', '{ "name": "@acme/tsconfig" }');
    await put(
      'node_modules/@acme/tsconfig/tsconfig.json',
      '{ "compilerOptions": { "paths": { "#lib/*": ["../../../lib/*"] } } }',
    );
    await put('tsconfig.json', '{ "extends": "@acme/tsconfig" }');
    expect((await readTsconfigPaths(root)).aliases).toEqual([
      { pattern: '#lib/*', target: 'lib/*' },
    ]);
  });

  test("an extends init can't read is named when no paths were found", async () => {
    await put('tsconfig.json', '{ "extends": "@acme/not-installed/tsconfig.json" }');
    const result = await readTsconfigPaths(root);
    expect(result.aliases).toEqual([]);
    expect(result.notes).toEqual([
      "tsconfig.json extends @acme/not-installed/tsconfig.json, which init couldn't read: any paths it sets aren't in vitest's aliases.",
    ]);
  });

  test('a solution-style tsconfig.json (project references, no paths of its own) is named', async () => {
    await put(
      'tsconfig.json',
      '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }',
    );
    const result = await readTsconfigPaths(root);
    expect(result.aliases).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('project references');
  });

  test('several targets: the first, with a note; a pattern starting with `*` is left out, with a note', async () => {
    await put(
      'tsconfig.json',
      '{ "compilerOptions": { "paths": { "@lib/*": ["./a/*", "./b/*"], "*": ["./types/*"] } } }',
    );
    const result = await readTsconfigPaths(root);
    expect(result.aliases).toEqual([{ pattern: '@lib/*', target: 'a/*' }]);
    expect(result.notes).toHaveLength(2);
    expect(result.notes.join('\n')).toContain('"@lib/*" to 2 places');
    expect(result.notes.join('\n')).toContain('"*"');
  });

  test("TypeScript's order: exact names first, then the longest prefix", async () => {
    await put(
      'tsconfig.json',
      '{ "compilerOptions": { "paths": { "@/*": ["./*"], "@/ui/*": ["./ui/*"], "config": ["./config.ts"] } } }',
    );
    expect((await readTsconfigPaths(root)).aliases.map((a) => a.pattern)).toEqual([
      'config',
      '@/ui/*',
      '@/*',
    ]);
  });

  test("a tsconfig that isn't JSON at all: none", async () => {
    await put('tsconfig.json', '{ "compilerOptions": ');
    expect(await readTsconfigPaths(root)).toEqual({ aliases: [], notes: [] });
  });

  test('a cycle of extends ends', async () => {
    await put('a.json', '{ "extends": "./tsconfig.json" }');
    await put('tsconfig.json', '{ "extends": "./a.json" }');
    expect(await readTsconfigPaths(root)).toEqual({ aliases: [], notes: [] });
  });
});

describe('parseJsonc', () => {
  test("strings keep what looks like comments and trailing commas; a BOM doesn't matter", () => {
    expect(
      parseJsonc('﻿{ "a": "http://x/*y*/", "b": "1,}", "c": "q\\"//", /* c */ "d": [1, 2,], }'),
    ).toEqual({ a: 'http://x/*y*/', b: '1,}', c: 'q"//', d: [1, 2] });
  });
});
