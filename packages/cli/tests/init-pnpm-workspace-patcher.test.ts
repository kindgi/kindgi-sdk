// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for the `pnpm-workspace.yaml` patcher: a decision for esbuild's
 * install script (`allowBuilds.esbuild: false`) added to (or created in)
 * the file pnpm reads, the app's own keys, comments and layout kept; an
 * existing decision kept.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parse } from 'yaml';

import {
  decideBuildInText,
  patchPnpmWorkspace,
  pnpmWorkspaceFileFor,
} from '../src/init/pnpm-workspace-patcher.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-pnpm-workspace-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The edited text, failing the test when there is none. */
function edited(text: string): string {
  const result = decideBuildInText(text, 'esbuild', false);
  if (result.kind !== 'edited') throw new Error(`not edited: ${JSON.stringify(result)}`);
  return result.text;
}

// The file a Next.js app made with pnpm starts with.
const NEXT_APP = `# Build scripts this app reviewed.
allowBuilds:
  sharp: false # image optimization ships prebuilt
  unrs-resolver: false

minimumReleaseAgeExclude:
  - '@acme/ui@1.2.0'
`;

describe('decideBuildInText', () => {
  test('an empty file gets the allowBuilds block', () => {
    const text = edited('');
    expect(parse(text)).toEqual({ allowBuilds: { esbuild: false } });
    expect(text).toContain('# Install scripts pnpm runs (true) or skips (false)');
  });

  test('a file without allowBuilds keeps every byte and gains the block at the end', () => {
    const before = "packages:\n  - 'apps/*'\n# keep this comment\nshamefullyHoist: true\n";
    const text = edited(before);
    expect(text.startsWith(before)).toBe(true);
    expect(parse(text)).toEqual({
      packages: ['apps/*'],
      shamefullyHoist: true,
      allowBuilds: { esbuild: false },
    });
  });

  test('a file of comments only gains the block after them', () => {
    const text = edited('# nothing yet\n');
    expect(text.startsWith('# nothing yet\n')).toBe(true);
    expect(parse(text)).toEqual({ allowBuilds: { esbuild: false } });
  });

  test("allowBuilds without esbuild: added as its last entry, the app's entries and comments kept", () => {
    expect(edited(NEXT_APP)).toBe(`# Build scripts this app reviewed.
allowBuilds:
  sharp: false # image optimization ships prebuilt
  unrs-resolver: false
  esbuild: false

minimumReleaseAgeExclude:
  - '@acme/ui@1.2.0'
`);
  });

  test("the map's indent is kept", () => {
    expect(edited('allowBuilds:\n    sharp: false\n')).toBe(
      'allowBuilds:\n    sharp: false\n    esbuild: false\n',
    );
  });

  test('after a nested last entry, before the next key', () => {
    expect(edited('allowBuilds:\n  sharp:\n    nested: 1\nnext: 2\n')).toBe(
      'allowBuilds:\n  sharp:\n    nested: 1\n  esbuild: false\nnext: 2\n',
    );
  });

  test("pnpm's placeholder is replaced with false, nothing else changes", () => {
    const before = NEXT_APP.replace(
      'unrs-resolver: false\n',
      'unrs-resolver: false\n  esbuild: set this to true or false\n',
    );
    const result = decideBuildInText(before, 'esbuild', false);
    expect(result).toEqual({
      kind: 'edited',
      change: 'placeholder',
      text: before.replace('esbuild: set this to true or false', 'esbuild: false'),
    });
  });

  test("an existing decision, true or false (a quoted key too), is the app's: kept", () => {
    expect(decideBuildInText('allowBuilds:\n  esbuild: true\n', 'esbuild', false)).toEqual({
      kind: 'decided',
      value: true,
    });
    expect(decideBuildInText("allowBuilds:\n  'esbuild': true\n", 'esbuild', false)).toEqual({
      kind: 'decided',
      value: true,
    });
    expect(decideBuildInText('allowBuilds:\n  esbuild: false # off\n', 'esbuild', false)).toEqual({
      kind: 'decided',
      value: false,
    });
  });

  test('a flow map gains the entry inside its braces', () => {
    expect(edited('allowBuilds: {sharp: false}\n')).toBe(
      'allowBuilds: {sharp: false, esbuild: false}\n',
    );
    expect(edited('allowBuilds: {}\n')).toBe('allowBuilds: { esbuild: false }\n');
  });

  test('an empty allowBuilds: gets the entry under it', () => {
    expect(edited('allowBuilds: # reviewed\nfoo: 1\n')).toBe(
      'allowBuilds: # reviewed\n  esbuild: false\nfoo: 1\n',
    );
  });

  test('what it cannot edit safely is refused, with the reason', () => {
    for (const text of [
      'allowBuilds: [esbuild]\n',
      'allowBuilds:\n  esbuild: maybe\n',
      '- a list\n',
      'allowBuilds: {\n',
      'a: 1\na: 2\n',
    ]) {
      const result = decideBuildInText(text, 'esbuild', false);
      expect(result.kind, text).toBe('refused');
    }
  });
});

describe('patchPnpmWorkspace', () => {
  test('no file: creates it with the allowBuilds block', async () => {
    const path = join(dir, 'pnpm-workspace.yaml');
    expect(await patchPnpmWorkspace(path)).toEqual({ kind: 'created' });
    expect(parse(await readFile(path, 'utf8'))).toEqual({ allowBuilds: { esbuild: false } });
  });

  test("an existing file with other keys and comments: merged, the app's text kept", async () => {
    const path = join(dir, 'pnpm-workspace.yaml');
    const before = "# Monorepo layout\npackages:\n  - 'apps/*' # the apps\n";
    await writeFile(path, before, 'utf8');
    expect(await patchPnpmWorkspace(path)).toEqual({ kind: 'patched', change: 'added' });
    const after = await readFile(path, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(parse(after)).toEqual({ packages: ['apps/*'], allowBuilds: { esbuild: false } });
  });

  test("pnpm's placeholder: replaced", async () => {
    const path = join(dir, 'pnpm-workspace.yaml');
    await writeFile(path, 'allowBuilds:\n  esbuild: set this to true or false\n', 'utf8');
    expect(await patchPnpmWorkspace(path)).toEqual({ kind: 'patched', change: 'placeholder' });
    expect(await readFile(path, 'utf8')).toBe('allowBuilds:\n  esbuild: false\n');
  });

  test('an existing false: already decided, the file untouched', async () => {
    const path = join(dir, 'pnpm-workspace.yaml');
    await writeFile(path, 'allowBuilds:\n  esbuild: false\n', 'utf8');
    expect(await patchPnpmWorkspace(path)).toEqual({ kind: 'already-decided', value: false });
    expect(await readFile(path, 'utf8')).toBe('allowBuilds:\n  esbuild: false\n');
  });

  test("an existing true (the app's choice), or not editable: the file untouched", async () => {
    const path = join(dir, 'pnpm-workspace.yaml');
    await writeFile(path, 'allowBuilds:\n  esbuild: true\n', 'utf8');
    expect(await patchPnpmWorkspace(path)).toEqual({ kind: 'already-decided', value: true });
    expect(await readFile(path, 'utf8')).toBe('allowBuilds:\n  esbuild: true\n');
    await writeFile(path, 'allowBuilds: [esbuild]\n', 'utf8');
    expect((await patchPnpmWorkspace(path)).kind).toBe('refused');
    expect(await readFile(path, 'utf8')).toBe('allowBuilds: [esbuild]\n');
  });
});

describe('pnpmWorkspaceFileFor', () => {
  test("the workspace root's file when the app is inside one", async () => {
    const app = join(dir, 'apps', 'web');
    await mkdir(app, { recursive: true });
    await writeFile(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf8');
    expect(await pnpmWorkspaceFileFor(app)).toBe(join(dir, 'pnpm-workspace.yaml'));
  });

  test("the app's own file (to create) when there is none", async () => {
    const exists = async () => false;
    expect(await pnpmWorkspaceFileFor(join(dir, 'app'), exists)).toBe(
      join(dir, 'app', 'pnpm-workspace.yaml'),
    );
  });
});
