// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';
import { publishedCliSpec } from '../src/package-manager.js';
import { CLI_VERSION } from '../src/version-info.js';

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const emptyEnv: Record<string, string | undefined> = {};

function baseInputs(overrides: Partial<Parameters<typeof runCli>[0]> = {}) {
  return {
    argv: [] as readonly string[],
    env: emptyEnv,
    cwd,
    home,
    // The host's pnpm, never this machine's real one.
    initSeam: { pnpmVersion: async () => '10.28.0', packageManagerRuns: async () => true },
    ...overrides,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function listRecursive(root: string): Promise<string[]> {
  const acc: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs, rel);
      else acc.push(rel);
    }
  }
  await walk(root, '');
  acc.sort();
  return acc;
}

describe('kindgi init — argument validation', () => {
  test('missing pack-name AND no package.json → exit 1 with both fix pointers', async () => {
    // No positional AND no package.json at cwd: augment mode auto-detect
    // fails; error explains BOTH paths (fresh needs a pack-name; augment
    // needs to be run in a dir with package.json).
    const out = await runCli(baseInputs({ argv: ['init'] }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('No pack-name provided');
    expect(out.stderr).toContain('no package.json');
    expect(out.stderr).toContain('kindgi init <pack-name>');
  });

  test('invalid pack-name (underscore) → exit 1 with regex hint', async () => {
    const out = await runCli(baseInputs({ argv: ['init', 'Bad_Name'] }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Invalid pack-name');
    expect(out.stderr).toContain('kebab');
  });

  test('unknown template → exit 2 listing available templates', async () => {
    const out = await runCli(baseInputs({ argv: ['init', 'my-pack', '--template=nope'] }));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Unknown template: nope');
    expect(out.stderr).toContain('minimal');
    expect(out.stderr).toContain('sample');
  });

  test('valid dot-namespaced pack id accepted', async () => {
    const out = await runCli(baseInputs({ argv: ['init', 'acme.legal-basics'] }));
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { packId?: string };
    expect(parsed.packId).toBe('acme.legal-basics');
  });
});

describe('kindgi init — minimal template', () => {
  test('scaffolds the expected minimal file set', async () => {
    const out = await runCli(baseInputs({ argv: ['init', 'my-pack'] }));
    expect(out.exitCode).toBe(0);
    const files = await listRecursive(join(cwd, 'my-pack'));
    expect(files).toEqual([
      '.claude/skills/.kindgi-manifest.json',
      '.claude/skills/kindgi-authoring-agents/SKILL.md',
      '.claude/skills/kindgi-authoring-flows/SKILL.md',
      '.claude/skills/kindgi-authoring-guardrails/SKILL.md',
      '.claude/skills/kindgi-authoring-mcp-servers/SKILL.md',
      '.claude/skills/kindgi-authoring-providers/SKILL.md',
      '.claude/skills/kindgi-authoring-tools/SKILL.md',
      '.claude/skills/kindgi-framework-feedback/SKILL.md',
      '.claude/skills/kindgi-getting-started/SKILL.md',
      '.gitignore',
      '.nvmrc',
      'AGENTS.md',
      'README.md',
      'agents/.gitkeep',
      'flows/.gitkeep',
      'guardrails/.gitkeep',
      'kindgi.config.ts',
      'package.json',
      'pnpm-workspace.yaml',
      'tools/.gitkeep',
      'tsconfig.json',
      'vitest.config.ts',
    ]);
  });

  test('generated package.json has correct name + version + deps', async () => {
    await runCli(baseInputs({ argv: ['init', 'my-pack'] }));
    const raw = await readFile(join(cwd, 'my-pack', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as {
      name?: string;
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.name).toBe('my-pack');
    expect(pkg.version).toBe('0.1.0');
    // Tests scaffold into a temp dir outside the checkout, so `init`
    // links both Kindgi packages from the checkout (`link:<abs-path>`).
    // The exact absolute path is machine-dependent; assert the shape.
    expect(pkg.dependencies?.['@kindgi/sdk']).toMatch(/^link:.*\/packages\/sdk$/);
    // The CLI is a project devDependency — the pack runs its own kindgi.
    expect(pkg.devDependencies?.['@kindgi/cli']).toMatch(/^link:.*\/packages\/cli$/);
    expect(raw).not.toContain('workspace:*');
    expect(pkg.dependencies?.zod).toBeTruthy();
  });

  test.each(['minimal', 'sample'])(
    "the %s template decides esbuild's install script for npm and pnpm alike: off (T277)",
    async (template) => {
      await runCli(baseInputs({ argv: ['init', 'my-pack', `--template=${template}`] }));
      const pkg = JSON.parse(await readFile(join(cwd, 'my-pack', 'package.json'), 'utf8')) as {
        allowScripts?: Record<string, unknown>;
      };
      // npm 11's allowScripts; without it `npm install` warns the script isn't covered.
      expect(pkg.allowScripts).toEqual({ esbuild: false });
      expect(await readFile(join(cwd, 'my-pack', 'pnpm-workspace.yaml'), 'utf8')).toContain(
        'allowBuilds:\n  esbuild: false\n',
      );
    },
  );

  test('generated kindgi.config.ts has correct pack id + version', async () => {
    await runCli(baseInputs({ argv: ['init', 'my-pack'] }));
    const raw = await readFile(join(cwd, 'my-pack', 'kindgi.config.ts'), 'utf8');
    expect(raw).toContain("id: 'my-pack'");
    expect(raw).toContain("version: '0.1.0'");
  });

  test('placeholders substituted in every generated file', async () => {
    await runCli(baseInputs({ argv: ['init', 'my-pack'] }));
    const files = await listRecursive(join(cwd, 'my-pack'));
    for (const rel of files) {
      const raw = await readFile(join(cwd, 'my-pack', rel), 'utf8');
      expect(raw, `${rel} still contains an unsubstituted placeholder`).not.toMatch(
        /\{\{[A-Z_]+\}\}/,
      );
    }
  });

  test('post-scaffold instructions printed to stderr', async () => {
    const out = await runCli(baseInputs({ argv: ['init', 'my-pack'] }));
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('Pack scaffolded at');
    expect(out.stderr).toContain('cd my-pack');
    expect(out.stderr).toContain('pnpm install');
    expect(out.stderr).toContain('kindgi dev');
  });
});

describe('kindgi init — python template, from the PyPI CLI (kindgi-cli)', () => {
  test('the pack lists kindgi-cli in its dev group, and the next steps say uv run kindgi', async () => {
    const out = await runCli(
      baseInputs({
        argv: ['init', 'my-pack', '--template=python'],
        env: { KINDGI_CLI_INSTALL: 'pypi' },
      }),
    );
    expect(out.exitCode).toBe(0);
    const pyproject = await readFile(join(cwd, 'my-pack', 'pyproject.toml'), 'utf8');
    expect(pyproject).toMatch(
      /^dev = \["pytest>=8", "kindgi-cli>=\d+\.\d+(\.\d+)?((a|b|rc)\d+)?,<\d+\.\d+"\]$/m,
    );
    expect(out.stderr).toContain('uv run kindgi dev');
    expect(out.stderr).not.toContain('npx');
  });

  test('from the npm CLI: no kindgi-cli, and the npx line as before', async () => {
    const out = await runCli(baseInputs({ argv: ['init', 'my-pack', '--template=python'] }));
    const pyproject = await readFile(join(cwd, 'my-pack', 'pyproject.toml'), 'utf8');
    expect(pyproject).toMatch(/^dev = \["pytest>=8"\]$/m);
    expect(out.stderr).toContain('npx --yes @kindgi/cli@');
  });
});

describe('kindgi init — a machine without pnpm (T280)', () => {
  test('the next steps install and run with npm, never naming pnpm', async () => {
    const out = await runCli(
      baseInputs({
        argv: ['init', 'my-pack'],
        initSeam: {
          pnpmVersion: async () => {
            throw new Error('spawn pnpm ENOENT');
          },
          packageManagerRuns: async (pm) => pm !== 'pnpm',
        },
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('  npm install');
    expect(out.stderr).toContain('npx --no kindgi dev');
    expect(out.stderr).not.toMatch(/^ {2}pnpm /m);
    // No advice to pin a pnpm this machine doesn't have.
    expect(out.stderr).not.toContain('packageManager');
  });
});

describe('kindgi init — the pack pins the pnpm that installs it', () => {
  const manifest = async (dir: string): Promise<{ readonly packageManager?: string }> =>
    JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { packageManager?: string };

  test('a standalone pack: packageManager is the pnpm `pnpm --version` gives in its folder', async () => {
    const asked: string[] = [];
    const out = await runCli(
      baseInputs({
        argv: ['init', 'my-pack'],
        initSeam: {
          pnpmVersion: async (dir) => {
            asked.push(dir);
            return '12.9.1';
          },
        },
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(asked).toEqual([join(cwd, 'my-pack')]);
    expect((await manifest(join(cwd, 'my-pack'))).packageManager).toBe('pnpm@12.9.1');
    expect(out.stderr).toContain('✓ package.json pins pnpm@12.9.1 (packageManager)');
    expect(out.stderr).toContain('pnpm install');
  });

  test('inside a project that says how it installs: nothing is written, the host is not asked', async () => {
    await writeFile(join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8');
    const asked: string[] = [];
    const out = await runCli(
      baseInputs({
        argv: ['init', 'my-pack'],
        initSeam: {
          pnpmVersion: async (dir) => {
            asked.push(dir);
            return '12.9.1';
          },
        },
      }),
    );
    expect(out.exitCode).toBe(0);
    expect(asked).toEqual([]);
    expect((await manifest(join(cwd, 'my-pack'))).packageManager).toBeUndefined();
    expect(out.stderr).not.toContain('packageManager');
  });

  test("pnpm's version can't be read: no field, and one line saying how to set it", async () => {
    const out = await runCli(
      baseInputs({
        argv: ['init', 'my-pack'],
        initSeam: {
          pnpmVersion: async () => {
            throw new Error('spawn pnpm ENOENT');
          },
        },
      }),
    );
    expect(out.exitCode).toBe(0);
    expect((await manifest(join(cwd, 'my-pack'))).packageManager).toBeUndefined();
    expect(out.stderr).toContain(
      "package.json has no packageManager: pnpm's version couldn't be read here (pnpm --version: spawn pnpm ENOENT).",
    );
    expect(out.stderr).toContain('Add "packageManager": "pnpm@<version>"');
  });

  test('a version that is not one is never written', async () => {
    const out = await runCli(
      baseInputs({
        argv: ['init', 'my-pack'],
        initSeam: { pnpmVersion: async () => 'command not found' },
      }),
    );
    expect((await manifest(join(cwd, 'my-pack'))).packageManager).toBeUndefined();
    expect(out.stderr).toContain('pnpm --version printed "command not found"');
  });
});

describe('kindgi init — python template', () => {
  test('scaffolds a Python pack: pyproject [tool.kindgi], tools, guardrail, agent, flow, tests', async () => {
    const out = await runCli(baseInputs({ argv: ['init', 'my-pack', '--template=python'] }));
    expect(out.exitCode).toBe(0);
    const files = await listRecursive(join(cwd, 'my-pack'));
    expect(files).toEqual([
      '.claude/skills/.kindgi-manifest.json',
      // Only the skills written for Python packs: the shared ones and the
      // Python getting-started and authoring skills — none of the TypeScript ones.
      '.claude/skills/kindgi-authoring-mcp-servers/SKILL.md',
      '.claude/skills/kindgi-authoring-providers/SKILL.md',
      '.claude/skills/kindgi-framework-feedback/SKILL.md',
      '.claude/skills/kindgi-python-authoring-agents/SKILL.md',
      '.claude/skills/kindgi-python-authoring-flows/SKILL.md',
      '.claude/skills/kindgi-python-authoring-guardrails/SKILL.md',
      '.claude/skills/kindgi-python-authoring-tools/SKILL.md',
      '.claude/skills/kindgi-python-getting-started/SKILL.md',
      '.gitignore',
      'AGENTS.md',
      'README.md',
      'agents/echo_agent.py',
      'flows/echo_flow.py',
      'guardrails/response_not_empty.py',
      'pyproject.toml',
      'tests/test_tools.py',
      'tools/echo.py',
      'tools/greet.py',
    ]);
    const pyproject = await readFile(join(cwd, 'my-pack', 'pyproject.toml'), 'utf8');
    expect(pyproject).toContain('[tool.kindgi.pack]\nid = "my-pack"\nversion = "0.1.0"');
    // The uv versions whose lockfile the image's uv reads.
    expect(pyproject).toContain('[tool.uv]\nrequired-version = ">=0.12.15,<0.13"');
    // From a checkout, kindgi (Python) is the checkout's SDK, editable.
    expect(pyproject).toMatch(
      /\[tool\.uv\.sources\]\nkindgi = \{ path = ".*sdks\/python", editable = true \}/,
    );
    const tool = await readFile(join(cwd, 'my-pack', 'tools/echo.py'), 'utf8');
    expect(tool).toContain('@tool(id="my-pack.echo")');
    expect(out.stderr).toContain('uv sync');
    expect(out.stderr).toContain(`npx --yes ${publishedCliSpec(CLI_VERSION)} dev`);
  });
});

describe('kindgi init — java template', () => {
  test('scaffolds a Maven pack: kindgi.config.json, pom.xml, the wrapper, sources under the pack id', async () => {
    const out = await runCli(baseInputs({ argv: ['init', 'acme.billing', '--template=java'] }));
    expect(out.exitCode, out.stderr).toBe(0);
    const files = (await listRecursive(join(cwd, 'billing'))).filter(
      (f) => !f.startsWith('.claude/'),
    );
    expect(files).toEqual([
      '.gitignore',
      '.mvn/wrapper/maven-wrapper.properties',
      'AGENTS.md',
      'README.md',
      'kindgi.config.json',
      'kindgiw',
      'kindgiw.cmd',
      'mvnw',
      'pom.xml',
      'src/main/java/acme/billing/agents/EchoAgent.java',
      'src/main/java/acme/billing/flows/EchoFlow.java',
      'src/main/java/acme/billing/guardrails/ResponseNotEmpty.java',
      'src/main/java/acme/billing/tools/Echo.java',
      'src/main/java/acme/billing/tools/Greet.java',
      'src/test/java/acme/billing/ToolsTest.java',
    ]);
    expect(JSON.parse(await readFile(join(cwd, 'billing', 'kindgi.config.json'), 'utf8'))).toEqual({
      language: 'java',
      cli: CLI_VERSION,
      pack: { id: 'acme.billing', version: '0.1.0' },
    });
    const pom = await readFile(join(cwd, 'billing', 'pom.xml'), 'utf8');
    expect(pom).toContain(`<kindgi.version>${CLI_VERSION}</kindgi.version>`);
    expect(pom).toContain('<artifactId>kindgi-pack</artifactId>');
    expect(pom).toContain('<maven.compiler.release>17</maven.compiler.release>');
    const echo = await readFile(
      join(cwd, 'billing', 'src/main/java/acme/billing/tools/Echo.java'),
      'utf8',
    );
    expect(echo).toContain('package acme.billing.tools;');
    expect(echo).toContain('Tool.define("acme.billing.echo")');
    expect(echo).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect((await stat(join(cwd, 'billing', 'mvnw'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(cwd, 'billing', 'kindgiw'))).mode & 0o111).not.toBe(0);
    // From a checkout, the next steps install kindgi-pack from its sdks/java.
    expect(out.stderr).toMatch(/\(cd .*sdks\/java && \.\/mvnw -q install -DskipTests\)/);
    expect(out.stderr).toContain('./mvnw test');
    expect(out.stderr).toContain('./kindgiw dev');
  });
});

describe('kindgi init — sample template', () => {
  test('scaffolds the larger file set including guardrails + flows', async () => {
    const out = await runCli(baseInputs({ argv: ['init', 'my-pack', '--template=sample'] }));
    expect(out.exitCode).toBe(0);
    const files = await listRecursive(join(cwd, 'my-pack'));
    expect(files).toEqual([
      '.claude/skills/.kindgi-manifest.json',
      '.claude/skills/kindgi-authoring-agents/SKILL.md',
      '.claude/skills/kindgi-authoring-flows/SKILL.md',
      '.claude/skills/kindgi-authoring-guardrails/SKILL.md',
      '.claude/skills/kindgi-authoring-mcp-servers/SKILL.md',
      '.claude/skills/kindgi-authoring-providers/SKILL.md',
      '.claude/skills/kindgi-authoring-tools/SKILL.md',
      '.claude/skills/kindgi-framework-feedback/SKILL.md',
      '.claude/skills/kindgi-getting-started/SKILL.md',
      '.gitignore',
      '.nvmrc',
      'AGENTS.md',
      'README.md',
      'agents/echo-agent/index.ts',
      'flows/echo-flow/index.ts',
      'guardrails/response-not-empty/index.ts',
      'kindgi.config.ts',
      'package.json',
      'pnpm-workspace.yaml',
      'tools/echo/index.test.ts',
      'tools/echo/index.ts',
      'tools/fetch-httpbin/index.ts',
      'tools/greet/index.ts',
      'tsconfig.json',
      'vitest.config.ts',
    ]);
  });

  test('sample template files use @kindgi/sdk imports', async () => {
    await runCli(baseInputs({ argv: ['init', 'my-pack', '--template=sample'] }));
    const echoTool = await readFile(join(cwd, 'my-pack', 'tools/echo/index.ts'), 'utf8');
    expect(echoTool).toContain("from '@kindgi/sdk/define'");
    expect(echoTool).toContain("from '@kindgi/sdk/types'");
  });

  test('the sample guardrail types its inline check through @kindgi/sdk (TS2742 under pnpm otherwise)', async () => {
    await runCli(baseInputs({ argv: ['init', 'my-pack', '--template=sample'] }));
    const guardrail = await readFile(
      join(cwd, 'my-pack', 'guardrails/response-not-empty/index.ts'),
      'utf8',
    );
    // Inferred, the check's type names @kindgi/guardrails, which a pnpm
    // pack can't reach: `tsc` with `declaration: true` refuses it.
    expect(guardrail).toContain(
      "import { type DefinedCheck, defineCheck } from '@kindgi/sdk/define'",
    );
    expect(guardrail).toContain('const inlineCheck: InlineCheck = {');
    expect(guardrail).toContain('  check: inlineCheck,');
    // The pack depends on @kindgi/sdk and zod only: no file imports anything else.
    const primitives = (await listRecursive(join(cwd, 'my-pack'))).filter(
      (f) => /^(agents|flows|guardrails|tools)\//.test(f) && f.endsWith('.ts'),
    );
    for (const file of primitives) {
      const source = await readFile(join(cwd, 'my-pack', file), 'utf8');
      for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
        expect(specifier, file).toMatch(/^(@kindgi\/sdk\/[a-z]+|zod|vitest|\.{1,2}\/.*)$/);
      }
    }
  });
});

describe('kindgi init — path + force flags', () => {
  test('--path scaffolds into custom directory', async () => {
    const custom = 'custom/nested/path';
    const out = await runCli(baseInputs({ argv: ['init', 'my-pack', `--path=${custom}`] }));
    expect(out.exitCode).toBe(0);
    expect(await pathExists(join(cwd, custom, 'package.json'))).toBe(true);
    expect(await pathExists(join(cwd, 'my-pack'))).toBe(false);
  });

  test('refuses to scaffold into non-empty dir without --force', async () => {
    // Pre-populate target dir.
    const target = join(cwd, 'my-pack');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'sentinel.txt'), 'do not touch', 'utf8');

    const out = await runCli(baseInputs({ argv: ['init', 'my-pack'] }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('non-empty directory');
    expect(out.stderr).toContain('--force');

    // Sentinel survives.
    const raw = await readFile(join(target, 'sentinel.txt'), 'utf8');
    expect(raw).toBe('do not touch');
  });

  test('--force overwrites existing files in target dir', async () => {
    const target = join(cwd, 'my-pack');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'sentinel.txt'), 'do not touch', 'utf8');

    const out = await runCli(baseInputs({ argv: ['init', 'my-pack', '--force'] }));
    expect(out.exitCode).toBe(0);
    // Sentinel remains (we don't delete unrelated files) but scaffolded files exist.
    expect(await pathExists(join(target, 'package.json'))).toBe(true);
    expect(await pathExists(join(target, 'sentinel.txt'))).toBe(true);
  });
});

describe('kindgi init --template in an existing app (augment mode)', () => {
  test('--template=java in a Node app is refused, pointing at --new-repo', async () => {
    await writeFile(join(cwd, 'package.json'), '{"name":"acme-app"}\n');
    const out = await runCli(baseInputs({ argv: ['init', '--template=java'] }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('--template=java --new-repo');
  });

  test('--template=python is refused before anything is written', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'my-app', version: '1.0.0' }),
    );
    const out = await runCli(baseInputs({ argv: ['init', '--template=python'] }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('--template=python --new-repo');
    expect(await readdir(cwd)).toEqual(['package.json']);
  });

  test('an unknown template is refused', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'my-app', version: '1.0.0' }),
    );
    const out = await runCli(baseInputs({ argv: ['init', '--template=nope'] }));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Unknown template: nope');
  });
});
