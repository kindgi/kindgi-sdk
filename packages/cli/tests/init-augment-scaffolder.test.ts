// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tests for `runInitAugment` — the augment-mode scaffolder. Uses a
 * real tmp filesystem so path handling + skill-copy behavior are
 * exercised end-to-end; every fixture stands up a minimal
 * package.json + optional pre-existing files so we can assert both
 * "merge" and "--force" paths.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { defaultTemplatesRoot } from '../src/commands/init.js';
import { detectSkillDrift } from '../src/commands/skills.js';
import {
  ZOD_DEPENDENCY,
  derivePackId,
  renderAugmentConfig,
  runInitAugment,
  zodWarnings,
} from '../src/init/augment-scaffolder.js';

let root: string;
let skillsRoot: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kindgi-augment-'));
  skillsRoot = await mkdtemp(join(tmpdir(), 'kindgi-augment-skills-'));
  // Pre-populate a couple of fixture skills so the merge path is testable.
  await mkdir(join(skillsRoot, 'kindgi-authoring-tools'), { recursive: true });
  await writeFile(join(skillsRoot, 'kindgi-authoring-tools', 'SKILL.md'), '# tools skill\n');
  await mkdir(join(skillsRoot, 'kindgi-getting-started'), { recursive: true });
  await writeFile(join(skillsRoot, 'kindgi-getting-started', 'SKILL.md'), '# getting started\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(skillsRoot, { recursive: true, force: true });
});

async function writePkgJson(dir: string, pkg: unknown): Promise<void> {
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
}

async function fileContents(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// derivePackId
// ---------------------------------------------------------------------

describe('derivePackId', () => {
  test('simple lowercase-kebab name passes through', () => {
    expect(derivePackId('my-app')).toEqual({ kind: 'ok', id: 'my-app' });
  });

  test('scoped name `@acme/legal` → `acme.legal`', () => {
    expect(derivePackId('@acme/legal')).toEqual({ kind: 'ok', id: 'acme.legal' });
  });

  test('uppercase gets lowercased', () => {
    expect(derivePackId('@ACME/Legal-Basics')).toEqual({
      kind: 'ok',
      id: 'acme.legal-basics',
    });
  });

  test('underscore in name → error with clear fix pointer', () => {
    const result = derivePackId('my_app');
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.message).toContain('--pack-id');
    expect(result.message).toContain('my_app');
  });

  test('empty name → error', () => {
    const result = derivePackId('');
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.message).toContain('empty');
  });
});

// ---------------------------------------------------------------------
// renderAugmentConfig
// ---------------------------------------------------------------------

describe('renderAugmentConfig', () => {
  test('embeds pack id + version + name in the output', () => {
    const out = renderAugmentConfig({
      packId: 'my-app',
      packVersion: '1.2.3',
      packName: 'my-app',
    });
    expect(out).toContain("id: 'my-app'");
    expect(out).toContain("version: '1.2.3'");
    expect(out).toContain('embedded in my-app');
  });

  test('discovery paths point at kindgi/** subdirs', () => {
    const out = renderAugmentConfig({
      packId: 'x',
      packVersion: '0.1.0',
      packName: 'x',
    });
    expect(out).toContain("tools: 'kindgi/tools/**/*.ts'");
    expect(out).toContain("agents: 'kindgi/agents/**/*.ts'");
    expect(out).toContain("guardrails: 'kindgi/guardrails/**/*.ts'");
    expect(out).toContain("flows: 'kindgi/flows/**/*.ts'");
  });

  test('empty environments block (user fills in when deploying)', () => {
    const out = renderAugmentConfig({
      packId: 'x',
      packVersion: '0.1.0',
      packName: 'x',
    });
    expect(out).toContain('environments: {},');
  });
});

// ---------------------------------------------------------------------
// runInitAugment — end-to-end
// ---------------------------------------------------------------------

describe('runInitAugment — end-to-end', () => {
  test('writes kindgi.config.mts (CommonJS app) + kindgi/ subdirs + skills — and no env file', async () => {
    await writePkgJson(root, { name: 'my-app', version: '2.0.0' });

    const result = await runInitAugment({
      targetDir: root,
      skillsRoot,
      force: false,
    });

    expect(result.kind).toBe('ok');

    // config
    const config = await fileContents(join(root, 'kindgi.config.mts'));
    expect(config).toContain("id: 'my-app'");
    expect(config).toContain("version: '2.0.0'");

    // subdirs
    for (const sub of ['agents', 'tools', 'guardrails', 'flows']) {
      expect(await exists(join(root, 'kindgi', sub, '.gitkeep'))).toBe(true);
    }

    // skills
    expect(
      await exists(join(root, '.claude', 'skills', 'kindgi-authoring-tools', 'SKILL.md')),
    ).toBe(true);
    expect(
      await exists(join(root, '.claude', 'skills', 'kindgi-getting-started', 'SKILL.md')),
    ).toBe(true);
    expect(
      await fileContents(join(root, '.claude', 'skills', 'kindgi-authoring-tools', 'SKILL.md')),
    ).toBe('# tools skill\n');

    // No env file: kindgi dev reads the project's own .env / .env.local.
    expect(await exists(join(root, '.env.local'))).toBe(false);
  });

  test('CommonJS app: kindgi.config.mts + kindgi/package.json marks kindgi/ as ES modules', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    await runInitAugment({ targetDir: root, skillsRoot, force: false });
    expect(await exists(join(root, 'kindgi.config.mts'))).toBe(true);
    expect(await exists(join(root, 'kindgi.config.ts'))).toBe(false);
    expect(JSON.parse(await fileContents(join(root, 'kindgi', 'package.json')))).toEqual({
      type: 'module',
    });
  });

  test('ESM app ("type": "module"): kindgi.config.ts, no marker', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0', type: 'module' });
    await runInitAugment({ targetDir: root, skillsRoot, force: false });
    expect(await exists(join(root, 'kindgi.config.ts'))).toBe(true);
    expect(await exists(join(root, 'kindgi', 'package.json'))).toBe(false);
  });

  test('an existing kindgi/package.json is never overwritten', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    await mkdir(join(root, 'kindgi'), { recursive: true });
    await writeFile(join(root, 'kindgi', 'package.json'), '{"type":"module","x":1}\n', 'utf8');
    await runInitAugment({ targetDir: root, skillsRoot, force: true });
    expect(await fileContents(join(root, 'kindgi', 'package.json'))).toBe(
      '{"type":"module","x":1}\n',
    );
  });

  test('a second init finds the first config whatever its extension', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    await runInitAugment({ targetDir: root, skillsRoot, force: false });
    const again = await runInitAugment({ targetDir: root, skillsRoot, force: false });
    expect(again.kind).toBe('error');
    expect(again.kind === 'error' && again.stderr).toContain('kindgi.config.mts already exists');
  });

  test('installed skills are recorded — kindgi dev reports no drift right after init', async () => {
    await writeFile(
      join(skillsRoot, 'kindgi-authoring-tools', 'SKILL.md'),
      '---\nversion: "1.2.0"\n---\n# tools skill\n',
    );
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    await runInitAugment({ targetDir: root, skillsRoot, force: false });
    expect(await exists(join(root, '.claude', 'skills', '.kindgi-manifest.json'))).toBe(true);
    expect(await detectSkillDrift({ skillsRoot, targetDir: root, language: 'node' })).toEqual({
      missing: [],
      outdated: [],
    });
  });

  test('adds @kindgi/sdk + @kindgi/cli with the resolved specs; next steps use the project package manager', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    const result = await runInitAugment({
      targetDir: root,
      skillsRoot,
      force: false,
      packageManager: 'pnpm',
      dependencySpecs: { source: 'local-checkout', sdk: 'link:/k/sdk', cli: 'link:/k/cli' },
    });
    expect(result.kind).toBe('ok');
    const pkg = JSON.parse(await fileContents(join(root, 'package.json'))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@kindgi/sdk']).toBe('link:/k/sdk');
    expect(pkg.devDependencies?.['@kindgi/cli']).toBe('link:/k/cli');
    const summary = JSON.parse(result.kind === 'ok' ? result.rendered.stdout : '{}') as {
      nextSteps: string[];
    };
    expect(summary.nextSteps).toContain('Install: pnpm install');
    expect(summary.nextSteps).toContain('Boot the dev server: pnpm exec kindgi dev');
    expect(summary.nextSteps.join('\n')).not.toMatch(/pnpm redirect/);
  });

  test('derives dot-namespaced pack id from scoped package name', async () => {
    await writePkgJson(root, { name: '@acme/my-app', version: '1.0.0' });
    await runInitAugment({ targetDir: root, skillsRoot, force: false });
    const config = await fileContents(join(root, 'kindgi.config.mts'));
    expect(config).toContain("id: 'acme.my-app'");
  });

  test('errors when package.json name cannot be normalized (no --pack-id)', async () => {
    await writePkgJson(root, { name: 'My_App', version: '1.0.0' });
    const result = await runInitAugment({ targetDir: root, skillsRoot, force: false });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.stderr).toContain('--pack-id');
  });

  test('--pack-id override succeeds when derivation would fail', async () => {
    await writePkgJson(root, { name: 'My_App', version: '1.0.0' });
    const result = await runInitAugment({
      targetDir: root,
      skillsRoot,
      force: false,
      packIdOverride: 'my-app',
    });
    expect(result.kind).toBe('ok');
    const config = await fileContents(join(root, 'kindgi.config.mts'));
    expect(config).toContain("id: 'my-app'");
  });

  test('--pack-id validates the override against PACK_ID_REGEX', async () => {
    await writePkgJson(root, { name: 'anything', version: '1.0.0' });
    const result = await runInitAugment({
      targetDir: root,
      skillsRoot,
      force: false,
      packIdOverride: 'BAD_ID',
    });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.stderr).toContain('Invalid --pack-id');
  });

  test('refuses to overwrite existing kindgi.config.ts without --force', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    await writeFile(join(root, 'kindgi.config.ts'), 'existing content\n', 'utf8');

    const result = await runInitAugment({ targetDir: root, skillsRoot, force: false });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.stderr).toContain('already exists');
    expect(result.stderr).toContain('--force');

    // Original preserved.
    expect(await fileContents(join(root, 'kindgi.config.ts'))).toBe('existing content\n');
  });

  test('--force overwrites existing kindgi.config.ts', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    await writeFile(join(root, 'kindgi.config.ts'), 'existing\n', 'utf8');

    const result = await runInitAugment({ targetDir: root, skillsRoot, force: true });
    expect(result.kind).toBe('ok');
    expect(await fileContents(join(root, 'kindgi.config.ts'))).toContain("id: 'my-app'");
  });

  test('skills merge: pre-existing user skill file is NOT overwritten by default', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    // User has already customized this skill.
    const userSkillPath = join(root, '.claude', 'skills', 'kindgi-authoring-tools', 'SKILL.md');
    await mkdir(join(root, '.claude', 'skills', 'kindgi-authoring-tools'), { recursive: true });
    await writeFile(userSkillPath, '# CUSTOM USER SKILL\n', 'utf8');

    const result = await runInitAugment({ targetDir: root, skillsRoot, force: false });
    expect(result.kind).toBe('ok');
    // Custom skill preserved.
    expect(await fileContents(userSkillPath)).toBe('# CUSTOM USER SKILL\n');
    // Non-conflicting skill still copied.
    expect(
      await fileContents(join(root, '.claude', 'skills', 'kindgi-getting-started', 'SKILL.md')),
    ).toBe('# getting started\n');
  });

  test('--force overwrites existing skill files too', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    const userSkillPath = join(root, '.claude', 'skills', 'kindgi-authoring-tools', 'SKILL.md');
    await mkdir(join(root, '.claude', 'skills', 'kindgi-authoring-tools'), { recursive: true });
    await writeFile(userSkillPath, '# CUSTOM\n', 'utf8');

    await runInitAugment({ targetDir: root, skillsRoot, force: true });
    expect(await fileContents(userSkillPath)).toBe('# tools skill\n');
  });

  test('preserves existing .env.local when present', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    await writeFile(join(root, '.env.local'), 'MY_EXISTING_SECRET=abc\n', 'utf8');

    await runInitAugment({ targetDir: root, skillsRoot, force: false });
    expect(await fileContents(join(root, '.env.local'))).toBe('MY_EXISTING_SECRET=abc\n');
  });

  test('does not touch unrelated files at the target root', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    await writeFile(join(root, 'next.config.js'), '// next config\n', 'utf8');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), '// user code\n', 'utf8');

    await runInitAugment({ targetDir: root, skillsRoot, force: false });

    expect(await fileContents(join(root, 'next.config.js'))).toBe('// next config\n');
    expect(await fileContents(join(root, 'src', 'index.ts'))).toBe('// user code\n');
    // package.json also untouched by B2 (patcher lands in B3).
    const pkg = JSON.parse(await fileContents(join(root, 'package.json'))) as {
      name: string;
      version: string;
    };
    expect(pkg.name).toBe('my-app');
  });

  test('falls back to default id + version when package.json is missing fields', async () => {
    await writePkgJson(root, {});
    const result = await runInitAugment({ targetDir: root, skillsRoot, force: false });
    // Since name is empty, derivePackId errors first — user must pass --pack-id.
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.stderr).toContain('empty');
  });

  test('no skillsRoot → skips skill copying but still writes everything else', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    const result = await runInitAugment({ targetDir: root, force: false });
    expect(result.kind).toBe('ok');
    expect(await exists(join(root, 'kindgi.config.mts'))).toBe(true);
    expect(await exists(join(root, '.claude', 'skills'))).toBe(false);
  });
});

describe('runInitAugment — the sample template', () => {
  const templatesRoot = defaultTemplatesRoot();

  test('adds the sample primitives under kindgi/, rendered for the pack, without the sample tests', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0', type: 'module' });
    const result = await runInitAugment({
      targetDir: root,
      skillsRoot,
      force: false,
      template: 'sample',
      templatesRoot,
    });
    expect(result.kind).toBe('ok');

    for (const file of [
      'agents/echo-agent/index.ts',
      'flows/echo-flow/index.ts',
      'guardrails/response-not-empty/index.ts',
      'tools/echo/index.ts',
      'tools/greet/index.ts',
      'tools/fetch-httpbin/index.ts',
    ]) {
      expect(await exists(join(root, 'kindgi', file)), file).toBe(true);
    }
    expect(await exists(join(root, 'kindgi', 'tools', 'echo', 'index.test.ts'))).toBe(false);
    const agent = await fileContents(join(root, 'kindgi', 'agents', 'echo-agent', 'index.ts'));
    expect(agent).toContain('my-app.echo-agent');
    expect(agent).not.toContain('{{PACK_ID}}');

    // The sample's schemas are Zod; an app without it gets it.
    const pkg = JSON.parse(await fileContents(join(root, 'package.json')));
    expect(pkg.dependencies.zod).toBe('^4.0.0');
    if (result.kind === 'ok') {
      expect(result.rendered.stderr).toContain('--agent=my-app.echo-agent');
    }
  });

  test("an app's own Zod is kept", async () => {
    await writePkgJson(root, {
      name: 'my-app',
      version: '1.0.0',
      type: 'module',
      dependencies: { zod: '^4.1.0' },
    });
    await runInitAugment({
      targetDir: root,
      skillsRoot,
      force: false,
      template: 'sample',
      templatesRoot,
    });
    const pkg = JSON.parse(await fileContents(join(root, 'package.json')));
    expect(pkg.dependencies.zod).toBe('^4.1.0');
  });

  test('a primitive already there is kept unless --force', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0', type: 'module' });
    const mine = join(root, 'kindgi', 'tools', 'echo', 'index.ts');
    await mkdir(join(root, 'kindgi', 'tools', 'echo'), { recursive: true });
    await writeFile(mine, '// mine\n', 'utf8');
    await runInitAugment({
      targetDir: root,
      skillsRoot,
      force: false,
      template: 'sample',
      templatesRoot,
    });
    expect(await fileContents(mine)).toBe('// mine\n');
  });

  test('the minimal template (the default) adds no primitives, and Zod all the same', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0', type: 'module' });
    await runInitAugment({ targetDir: root, skillsRoot, force: false, templatesRoot });
    expect(await exists(join(root, 'kindgi', 'tools', 'echo', 'index.ts'))).toBe(false);
    const pkg = JSON.parse(await fileContents(join(root, 'package.json')));
    expect(pkg.dependencies?.zod).toBe('^4.0.0');
  });
});

describe('runInitAugment — Zod', () => {
  async function initWith(pkg: Record<string, unknown>) {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0', ...pkg });
    const result = await runInitAugment({ targetDir: root, skillsRoot, force: false });
    if (result.kind !== 'ok') throw new Error(result.stderr);
    const summary = JSON.parse(result.rendered.stdout) as {
      created: string[];
      warnings: string[];
    };
    const written = JSON.parse(await fileContents(join(root, 'package.json')));
    return { result, summary, written };
  }

  test("an app without Zod gets the fresh templates' range", async () => {
    const { summary, written } = await initWith({});
    expect(written.dependencies.zod).toBe('^4.0.0');
    expect(summary.created.join('\n')).toContain('+zod');
    expect(summary.warnings).toEqual([]);
  });

  test('the range is the one the fresh templates use', async () => {
    for (const template of ['minimal', 'sample']) {
      const raw = await fileContents(join(defaultTemplatesRoot(), template, 'package.json.tmpl'));
      expect(JSON.parse(raw).dependencies.zod, template).toBe(ZOD_DEPENDENCY.spec);
    }
  });

  test('an app on zod 4 keeps its own, without a warning', async () => {
    const { summary, written } = await initWith({ devDependencies: { zod: '~4.1.0' } });
    expect(written.devDependencies.zod).toBe('~4.1.0');
    expect(written.dependencies.zod).toBeUndefined();
    expect(summary.warnings).toEqual([]);
  });

  test('an app on zod 3 keeps it, and init says Kindgi needs zod 4', async () => {
    const { result, summary, written } = await initWith({ dependencies: { zod: '^3.25.0' } });
    expect(written.dependencies.zod).toBe('^3.25.0');
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain('zod ^3.25.0');
    expect(summary.warnings[0]).toContain('zod 4');
    if (result.kind === 'ok')
      expect(result.rendered.stderr).toContain('  ⚠ zod: the app has zod ^3.25.0');
  });

  test('a spec that is not a semver range is taken on trust', () => {
    expect(zodWarnings({ dependencies: { zod: 'catalog:' } })).toEqual([]);
    expect(zodWarnings({ dependencies: { zod: '>=3.20.0' } })).toEqual([]);
    expect(zodWarnings({ peerDependencies: { zod: '3.22.4' } })).toHaveLength(1);
  });
});

describe('runInitAugment — pnpm-workspace.yaml', () => {
  async function initPnpm(packageManager: 'pnpm' | 'npm' = 'pnpm') {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0' });
    const result = await runInitAugment({
      targetDir: root,
      skillsRoot,
      force: false,
      packageManager,
      dependencySpecs: { source: 'published', sdk: '0.1.0', cli: '0.1.0' },
    });
    if (result.kind !== 'ok') throw new Error(result.stderr);
    return {
      result,
      summary: JSON.parse(result.rendered.stdout) as {
        created: string[];
        skipped: string[];
        warnings: string[];
      },
    };
  }
  const workspaceFile = () => join(root, 'pnpm-workspace.yaml');

  test('a pnpm app without the file gets one allowing esbuild, reported like the other edits', async () => {
    const { summary } = await initPnpm();
    expect(await fileContents(workspaceFile())).toContain('allowBuilds:\n  esbuild: true\n');
    expect(summary.created).toContain(`${workspaceFile()} (created: allowBuilds.esbuild: true)`);
    expect(summary.warnings).toEqual([]);
  });

  test("an existing file is merged: the app's keys and comments stay", async () => {
    const before =
      '# Our workspace\nallowBuilds:\n  sharp: false # prebuilt\nnodeLinker: hoisted\n';
    await writeFile(workspaceFile(), before, 'utf8');
    const { summary } = await initPnpm();
    expect(await fileContents(workspaceFile())).toBe(
      '# Our workspace\nallowBuilds:\n  sharp: false # prebuilt\n  esbuild: true\nnodeLinker: hoisted\n',
    );
    expect(summary.created).toContain(`${workspaceFile()} (patched: +allowBuilds.esbuild: true)`);
  });

  test("pnpm's placeholder is replaced", async () => {
    await writeFile(
      workspaceFile(),
      'allowBuilds:\n  esbuild: set this to true or false\n',
      'utf8',
    );
    const { summary } = await initPnpm();
    expect(await fileContents(workspaceFile())).toBe('allowBuilds:\n  esbuild: true\n');
    expect(summary.created.join('\n')).toContain("replacing pnpm's placeholder");
  });

  test('an explicit false is left alone, with a warning', async () => {
    await writeFile(workspaceFile(), 'allowBuilds:\n  esbuild: false\n', 'utf8');
    const { result, summary } = await initPnpm();
    expect(await fileContents(workspaceFile())).toBe('allowBuilds:\n  esbuild: false\n');
    expect(summary.skipped).toContain(
      `${workspaceFile()} (allowBuilds.esbuild is false, left as is)`,
    );
    expect(summary.warnings.join('\n')).toContain('sets allowBuilds.esbuild to false');
    if (result.kind === 'ok') expect(result.rendered.stderr).toContain('  ⚠ pnpm: ');
  });

  test('a file it cannot edit safely is left alone; the warning says what to add', async () => {
    await writeFile(workspaceFile(), 'allowBuilds: [esbuild]\n', 'utf8');
    const { summary } = await initPnpm();
    expect(await fileContents(workspaceFile())).toBe('allowBuilds: [esbuild]\n');
    expect(summary.warnings.join('\n')).toContain('ERR_PNPM_IGNORED_BUILDS');
  });

  test("an app in a pnpm monorepo: the workspace root's file is the one edited", async () => {
    const app = join(root, 'apps', 'web');
    await mkdir(app, { recursive: true });
    await writeFile(workspaceFile(), "packages:\n  - 'apps/*'\n", 'utf8');
    await writePkgJson(app, { name: 'web', version: '1.0.0' });
    const result = await runInitAugment({
      targetDir: app,
      skillsRoot,
      force: false,
      packageManager: 'pnpm',
      dependencySpecs: { source: 'published', sdk: '0.1.0', cli: '0.1.0' },
    });
    expect(result.kind).toBe('ok');
    expect(await fileContents(workspaceFile())).toContain('  esbuild: true\n');
    expect(await exists(join(app, 'pnpm-workspace.yaml'))).toBe(false);
  });

  test('an app on another package manager gets no pnpm-workspace.yaml', async () => {
    await initPnpm('npm');
    expect(await exists(workspaceFile())).toBe(false);
  });
});
