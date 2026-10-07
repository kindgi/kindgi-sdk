// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for the `package.json` patcher — adds `@kindgi/sdk`
 * (dependencies) and `@kindgi/cli` (devDependencies) with the resolved
 * specs, preserving indent, trailing-newline convention, and unrelated
 * fields.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  KINDGI_CLI_PKG,
  KINDGI_SDK_PKG,
  decideAllowScripts,
  detectIndent,
  isDepPresent,
  patchPackageJson,
} from '../src/init/package-json-patcher.js';

let dir: string;

const SPECS = { sdk: 'link:/kindgi/packages/sdk', cli: 'link:/kindgi/packages/cli' };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kindgi-pkg-patch-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writePkg(contents: string): Promise<string> {
  const path = join(dir, 'package.json');
  await writeFile(path, contents, 'utf8');
  return path;
}

async function readPkg(path: string): Promise<{
  raw: string;
  parsed: Record<string, unknown>;
}> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return { raw, parsed };
}

// ---------------------------------------------------------------------
// detectIndent
// ---------------------------------------------------------------------

describe('detectIndent', () => {
  test('2-space indent (default)', () => {
    expect(detectIndent(`{\n  "name": "x"\n}\n`)).toBe(2);
  });

  test('4-space indent', () => {
    expect(detectIndent(`{\n    "name": "x"\n}\n`)).toBe(4);
  });

  test('single-line JSON → default 2', () => {
    expect(detectIndent(`{"name":"x"}`)).toBe(2);
  });

  test('tab indent → normalizes to 4', () => {
    expect(detectIndent(`{\n\t"name": "x"\n}\n`)).toBe(4);
  });
});

// ---------------------------------------------------------------------
// isDepPresent
// ---------------------------------------------------------------------

describe('isDepPresent', () => {
  test('detects in dependencies', () => {
    expect(isDepPresent({ dependencies: { '@kindgi/sdk': 'latest' } }, '@kindgi/sdk')).toBe(true);
  });

  test('detects in devDependencies', () => {
    expect(isDepPresent({ devDependencies: { '@kindgi/sdk': 'workspace:*' } }, '@kindgi/sdk')).toBe(
      true,
    );
  });

  test('detects in peerDependencies', () => {
    expect(isDepPresent({ peerDependencies: { '@kindgi/sdk': '*' } }, '@kindgi/sdk')).toBe(true);
  });

  test('detects in optionalDependencies', () => {
    expect(isDepPresent({ optionalDependencies: { '@kindgi/sdk': '1.0.0' } }, '@kindgi/sdk')).toBe(
      true,
    );
  });

  test('missing → false', () => {
    expect(isDepPresent({ dependencies: { other: '1.0.0' } }, '@kindgi/sdk')).toBe(false);
  });

  test('no relevant sections → false', () => {
    expect(isDepPresent({ name: 'x' }, '@kindgi/sdk')).toBe(false);
  });
});

// ---------------------------------------------------------------------
// patchPackageJson — happy paths
// ---------------------------------------------------------------------

describe('patchPackageJson — makes Kindgi a project dependency', () => {
  test('adds @kindgi/sdk to dependencies and @kindgi/cli to devDependencies, with the given specs', async () => {
    const path = await writePkg(
      `${JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2)}\n`,
    );
    const result = await patchPackageJson(path, SPECS);
    expect(result).toEqual({ kind: 'patched', added: [KINDGI_SDK_PKG, KINDGI_CLI_PKG] });
    const { parsed } = await readPkg(path);
    expect(parsed.dependencies).toEqual({ [KINDGI_SDK_PKG]: SPECS.sdk });
    expect(parsed.devDependencies).toEqual({ [KINDGI_CLI_PKG]: SPECS.cli });
  });

  test('never writes `latest`', async () => {
    const path = await writePkg(`${JSON.stringify({ name: 'my-app' }, null, 2)}\n`);
    await patchPackageJson(path, SPECS);
    expect((await readPkg(path)).raw).not.toContain('latest');
  });

  test('adds only the missing one', async () => {
    const path = await writePkg(
      `${JSON.stringify({ name: 'my-app', dependencies: { '@kindgi/sdk': '1.2.3' } }, null, 2)}\n`,
    );
    const result = await patchPackageJson(path, SPECS);
    expect(result).toEqual({ kind: 'patched', added: [KINDGI_CLI_PKG] });
    const { parsed } = await readPkg(path);
    expect((parsed.dependencies as Record<string, string>)[KINDGI_SDK_PKG]).toBe('1.2.3');
  });

  test('adds to existing dependencies alongside others (sorted)', async () => {
    const path = await writePkg(
      `${JSON.stringify(
        {
          name: 'my-app',
          version: '1.0.0',
          dependencies: {
            zod: '^4.0.0',
            react: '^18.0.0',
          },
        },
        null,
        2,
      )}\n`,
    );
    await patchPackageJson(path, SPECS);
    const { parsed } = await readPkg(path);
    const deps = parsed.dependencies as Record<string, string>;
    expect(deps[KINDGI_SDK_PKG]).toBeTruthy();
    expect(deps.zod).toBe('^4.0.0');
    expect(deps.react).toBe('^18.0.0');
    // Sorted alphabetically (JSON.stringify uses object key order = insertion).
    expect(Object.keys(deps)).toEqual(['@kindgi/sdk', 'react', 'zod']);
  });
});

// ---------------------------------------------------------------------
// patchPackageJson — idempotency
// ---------------------------------------------------------------------

describe('patchPackageJson — idempotent', () => {
  test('no-op when both are already declared', async () => {
    const source = `${JSON.stringify(
      {
        name: 'my-app',
        version: '1.0.0',
        dependencies: { '@kindgi/sdk': 'workspace:*' },
        devDependencies: { '@kindgi/cli': 'workspace:*' },
      },
      null,
      2,
    )}\n`;
    const path = await writePkg(source);
    const result = await patchPackageJson(path, SPECS);
    expect(result.kind).toBe('already-present');
    const { raw } = await readPkg(path);
    expect(raw).toBe(source);
  });

  test('no-op when already in devDependencies (respect placement)', async () => {
    const source = `${JSON.stringify(
      {
        name: 'my-app',
        version: '1.0.0',
        devDependencies: { '@kindgi/sdk': 'link:/some/path', '@kindgi/cli': 'link:/other' },
      },
      null,
      2,
    )}\n`;
    const path = await writePkg(source);
    const result = await patchPackageJson(path, SPECS);
    expect(result.kind).toBe('already-present');
    const { parsed } = await readPkg(path);
    expect(parsed.dependencies).toBeUndefined();
    expect((parsed.devDependencies as Record<string, string>)[KINDGI_SDK_PKG]).toBe(
      'link:/some/path',
    );
  });
});

// ---------------------------------------------------------------------
// patchPackageJson — format preservation
// ---------------------------------------------------------------------

describe('patchPackageJson — preserves format', () => {
  test('preserves 4-space indent', async () => {
    const source = `${JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 4)}\n`;
    const path = await writePkg(source);
    await patchPackageJson(path, SPECS);
    const raw = await readFile(path, 'utf8');
    // Every key line begins with 4 spaces.
    const indentedLines = raw.split('\n').filter((l) => /^\s+"/.test(l));
    for (const line of indentedLines) {
      expect(line.startsWith('    ')).toBe(true);
    }
  });

  test('preserves 2-space indent', async () => {
    const source = `${JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2)}\n`;
    const path = await writePkg(source);
    await patchPackageJson(path, SPECS);
    const raw = await readFile(path, 'utf8');
    // First-level keys ("name", "version", "dependencies") should be at 2 spaces.
    const topLevelKeys = raw.split('\n').filter((l) => /^ {2}"[^"]+":/.test(l));
    expect(topLevelKeys.length).toBeGreaterThan(0);
    // No first-level key should be indented deeper than 2 spaces.
    for (const line of topLevelKeys) {
      expect(line).toMatch(/^ {2}"[a-zA-Z@]/); // exactly 2 spaces before the quote
      expect(line).not.toMatch(/^ {4}"/); // not 4
    }
  });

  test('preserves trailing newline present', async () => {
    const source = `${JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2)}\n`;
    const path = await writePkg(source);
    await patchPackageJson(path, SPECS);
    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  test('preserves absent trailing newline', async () => {
    const source = JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2);
    const path = await writePkg(source);
    await patchPackageJson(path, SPECS);
    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(false);
  });

  test('preserves unrelated fields (scripts, engines, etc.)', async () => {
    const path = await writePkg(
      `${JSON.stringify(
        {
          name: 'my-app',
          version: '1.0.0',
          scripts: { dev: 'next dev', build: 'next build' },
          engines: { node: '>=22' },
          repository: { type: 'git', url: 'https://example.com/repo' },
        },
        null,
        2,
      )}\n`,
    );
    await patchPackageJson(path, SPECS);
    const { parsed } = await readPkg(path);
    expect(parsed.scripts).toEqual({ dev: 'next dev', build: 'next build' });
    expect(parsed.engines).toEqual({ node: '>=22' });
    expect(parsed.repository).toEqual({ type: 'git', url: 'https://example.com/repo' });
  });
});

// ---------------------------------------------------------------------
// patchPackageJson — error paths
// ---------------------------------------------------------------------

describe('patchPackageJson — errors', () => {
  test('missing file → error', async () => {
    const result = await patchPackageJson(join(dir, 'nonexistent.json'), SPECS);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('Failed to read');
  });

  test('invalid JSON → error', async () => {
    const path = await writePkg('{ not valid json');
    const result = await patchPackageJson(path, SPECS);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('not valid JSON');
  });

  test('array root → error', async () => {
    const path = await writePkg('["nope"]');
    const result = await patchPackageJson(path, SPECS);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('JSON object');
  });
});

describe('decideAllowScripts (T277)', () => {
  test("adds the decision, keeping the file's indent, newline and other fields", async () => {
    const path = await writePkg('{\n    "name": "app",\n    "scripts": { "test": "vitest" }\n}\n');
    expect(await decideAllowScripts(path, 'esbuild', false)).toEqual({ kind: 'patched' });
    const raw = await readFile(path, 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toContain('\n    "allowScripts": {\n        "esbuild": false\n    }');
    expect(JSON.parse(raw)).toEqual({
      name: 'app',
      scripts: { test: 'vitest' },
      allowScripts: { esbuild: false },
    });
  });

  test('a name-only or pinned decision already there is kept, and the file is untouched', async () => {
    for (const key of ['esbuild', 'esbuild@0.28.2']) {
      const before = JSON.stringify({ name: 'app', allowScripts: { [key]: true } });
      const path = await writePkg(before);
      expect(await decideAllowScripts(path, 'esbuild', false)).toEqual({
        kind: 'already-decided',
        key,
        value: true,
      });
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  });

  test("another package's entry doesn't count (esbuild-wasm is not esbuild)", async () => {
    const path = await writePkg(JSON.stringify({ allowScripts: { 'esbuild-wasm': true } }));
    expect((await decideAllowScripts(path, 'esbuild', false)).kind).toBe('patched');
    expect(JSON.parse(await readFile(path, 'utf8')).allowScripts).toEqual({
      'esbuild-wasm': true,
      esbuild: false,
    });
  });

  test('an allowScripts that is not an object is refused, not rewritten', async () => {
    const path = await writePkg(JSON.stringify({ allowScripts: ['esbuild'] }));
    expect((await decideAllowScripts(path, 'esbuild', false)).kind).toBe('refused');
    expect(JSON.parse(await readFile(path, 'utf8')).allowScripts).toEqual(['esbuild']);
  });
});
