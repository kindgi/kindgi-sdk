// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi init` in an existing Python app: `[tool.kindgi]` appended to its
 * pyproject.toml, `kindgi` added to its dependencies, `kindgi/` folders,
 * the Python-pack skills, `.gitignore` — through the real CLI.
 */

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { PACK_UV_REQUIRED_VERSION } from '../src/build/python-image.js';
import { kindgiTables, pythonAugmentNextSteps } from '../src/init/python-augment.js';
import { runCli } from '../src/main.js';

let app: string;

beforeEach(async () => {
  app = await mkdtemp(join(tmpdir(), 'kindgi-py-app-'));
});

afterEach(async () => {
  await rm(app, { recursive: true, force: true });
});

const UV_APP = `[project]
name = "Acme_Widgets"
version = "2.3.0"
requires-python = ">=3.11"
dependencies = [
    "httpx>=0.27",  # the API client
    "pydantic>=2",
]

[tool.ruff]
line-length = 100
`;

function init(...flags: string[]) {
  return runCli({ argv: ['init', ...flags], env: {}, cwd: app, home: app });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('kindgi init in a uv app', () => {
  beforeEach(async () => {
    await writeFile(join(app, 'pyproject.toml'), UV_APP);
    await writeFile(join(app, 'uv.lock'), '');
  });

  test("appends [tool.kindgi], adds kindgi to the dependencies, keeps the app's layout", async () => {
    const out = await init();
    expect(out.exitCode).toBe(0);
    const text = await readFile(join(app, 'pyproject.toml'), 'utf8');
    // The app's own lines are untouched; kindgi is a new last dependency.
    expect(text.startsWith(UV_APP.split('\n]')[0] as string)).toBe(true);
    expect(text).toContain('    "pydantic>=2",\n    "kindgi",\n]');
    const doc = parse(text) as {
      project: { dependencies: string[] };
      tool: {
        ruff: unknown;
        uv: { sources: { kindgi: { path: string; editable: boolean } } };
        kindgi: { pack: unknown; discovery: Record<string, string> };
      };
    };
    expect(doc.project.dependencies).toEqual(['httpx>=0.27', 'pydantic>=2', 'kindgi']);
    // No uv range of its own: Kindgi's, the one the image's uv works with.
    expect((doc.tool.uv as unknown as Record<string, unknown>)['required-version']).toBe(
      PACK_UV_REQUIRED_VERSION,
    );
    expect(doc.tool.ruff).toEqual({ 'line-length': 100 });
    // From a checkout, the SDK is the checkout's (a published CLI writes the PyPI range instead).
    expect(doc.tool.uv.sources.kindgi.path).toMatch(/sdks\/python$/);
    expect(doc.tool.kindgi.pack).toEqual({ id: 'acme-widgets', version: '2.3.0' });
    expect(doc.tool.kindgi.discovery.tools).toBe('kindgi/tools/**/*.py');

    for (const sub of ['agents', 'flows', 'guardrails', 'tools']) {
      expect(await exists(join(app, 'kindgi', sub, '.gitkeep'))).toBe(true);
    }
    const skills = (await readdir(join(app, '.claude', 'skills'))).filter(
      (n) => !n.startsWith('.'),
    );
    expect(skills.sort()).toEqual([
      'kindgi-authoring-mcp-servers',
      'kindgi-authoring-providers',
      'kindgi-framework-feedback',
      'kindgi-python-authoring-agents',
      'kindgi-python-authoring-flows',
      'kindgi-python-authoring-guardrails',
      'kindgi-python-authoring-tools',
      'kindgi-python-getting-started',
    ]);
    expect(await readFile(join(app, '.gitignore'), 'utf8')).toContain('.kindgirc.json');
    expect(out.stderr).toContain('Pack id: acme-widgets    Version: 2.3.0');
    expect(out.stderr).toContain('Install: uv sync');
    expect(JSON.parse(out.stdout)).toMatchObject({ language: 'python', installer: 'uv' });
  });

  test("an app's own uv range is kept — and a note when it leaves out the image's uv", async () => {
    await writeFile(
      join(app, 'pyproject.toml'),
      `${UV_APP}\n[tool.uv]\nrequired-version = ">=0.13"\n`,
    );
    const out = await init();
    expect(out.exitCode).toBe(0);
    const doc = parse(await readFile(join(app, 'pyproject.toml'), 'utf8')) as {
      tool: { uv: Record<string, unknown> };
    };
    expect(doc.tool.uv['required-version']).toBe('>=0.13');
    expect(out.stderr).toContain('the app\'s required-version (">=0.13") excludes uv 0.12.15');
  });

  test('a second run refuses: the app is a pack already', async () => {
    await init();
    const again = await init();
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('already has a [tool.kindgi] table');
  });

  test('a TypeScript template does not apply to a Python app', async () => {
    const out = await init('--template=sample');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('A Python app gets a Python pack');
  });
});

describe('kindgi init in other Python apps', () => {
  test('Poetry 1 (no [project]): no dependency edit, the command instead, poetry runs the pack', async () => {
    await writeFile(
      join(app, 'pyproject.toml'),
      '[tool.poetry]\nname = "ledger"\nversion = "1.0.0"\n\n[tool.poetry.dependencies]\npython = "^3.11"\n',
    );
    const out = await init();
    expect(out.exitCode).toBe(0);
    const doc = parse(await readFile(join(app, 'pyproject.toml'), 'utf8')) as {
      tool: { poetry: { dependencies: unknown }; kindgi: { pack: unknown; dev: unknown } };
    };
    expect(doc.tool.poetry.dependencies).toEqual({ python: '^3.11' });
    // Named and versioned from [tool.poetry].
    expect(doc.tool.kindgi.pack).toEqual({ id: 'ledger', version: '1.0.0' });
    expect(doc.tool.kindgi.dev).toEqual({ python: ['poetry', 'run', 'python'] });
    // No uv settings in an app uv doesn't install.
    expect((doc.tool as Record<string, unknown>).uv).toBeUndefined();
    expect(out.stderr).toContain("Add the SDK to the app's dependencies: poetry add --editable ");
  });

  test('the installer: uv by its build backend (a fresh `uv init`, no lock yet); pip by requirements.txt', async () => {
    await writeFile(
      join(app, 'pyproject.toml'),
      '[project]\nname = "fresh"\nversion = "0.1.0"\ndependencies = []\n\n[build-system]\nrequires = ["uv_build"]\nbuild-backend = "uv_build"\n',
    );
    expect(JSON.parse((await init()).stdout)).toMatchObject({ installer: 'uv' });

    const pipApp = await mkdtemp(join(tmpdir(), 'kindgi-pip-app-'));
    await writeFile(
      join(pipApp, 'pyproject.toml'),
      '[project]\nname = "legacy"\nversion = "1.0.0"\n',
    );
    await writeFile(join(pipApp, 'requirements.txt'), 'httpx\n');
    const out = await runCli({ argv: ['init'], env: {}, cwd: pipApp, home: pipApp });
    expect(JSON.parse(out.stdout)).toMatchObject({ installer: 'pip' });
    const pipDoc = parse(await readFile(join(pipApp, 'pyproject.toml'), 'utf8')) as {
      tool: Record<string, unknown>;
    };
    expect(pipDoc.tool.uv).toBeUndefined();
    expect(out.stderr).toContain('pip install -e ');
    await rm(pipApp, { recursive: true, force: true });
  });

  test('no [project].name: --pack-id is needed', async () => {
    await writeFile(join(app, 'pyproject.toml'), '[tool.black]\nline-length = 88\n');
    const out = await init();
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Pass `--pack-id=<id>`');
  });

  test('an app with both files gets a TypeScript pack unless --template=python', async () => {
    await writeFile(join(app, 'package.json'), '{"name":"web","version":"1.0.0","type":"module"}');
    await writeFile(join(app, 'pyproject.toml'), '[project]\nname = "api"\nversion = "1.0.0"\n');
    const python = await init('--template=python');
    expect(python.exitCode).toBe(0);
    expect(JSON.parse(python.stdout)).toMatchObject({ language: 'python', packId: 'api' });
    expect(await exists(join(app, 'kindgi.config.ts'))).toBe(false);
  });
});

describe('the appended tables and next steps', () => {
  test('tables: pack, discovery, a commented dev block (or Poetry’s interpreter)', () => {
    expect(parse(kindgiTables('acme', '1.0.0', false))).toEqual({
      tool: {
        kindgi: {
          pack: { id: 'acme', version: '1.0.0' },
          discovery: {
            agents: 'kindgi/agents/**/*.py',
            tools: 'kindgi/tools/**/*.py',
            guardrails: 'kindgi/guardrails/**/*.py',
            flows: 'kindgi/flows/**/*.py',
          },
        },
      },
    });
  });

  test('next steps per installer, published or from a checkout', () => {
    const published = { kind: 'published', requirement: 'kindgi>=0.1,<0.2' } as const;
    const checkout = { kind: 'local-checkout', path: '/k/sdks/python' } as const;
    expect(pythonAugmentNextSteps('uv', true, published)[0]).toBe('Install: uv sync');
    expect(pythonAugmentNextSteps('pip', true, checkout)[0]).toBe(
      'Install: pip install -e /k/sdks/python && pip install -e .',
    );
    expect(pythonAugmentNextSteps('uv', false, published)[0]).toBe(
      'Add the SDK to the app\'s dependencies: uv add "kindgi>=0.1,<0.2"',
    );
    expect(pythonAugmentNextSteps('pip', false, published)[0]).toBe(
      'Add the SDK to the app\'s dependencies: pip install "kindgi>=0.1,<0.2" (and list it with the app’s requirements)',
    );
  });
});
