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
  derivePackId,
  renderAugmentConfig,
  runInitAugment,
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
      dependencies: { zod: '^3.25.0' },
    });
    await runInitAugment({
      targetDir: root,
      skillsRoot,
      force: false,
      template: 'sample',
      templatesRoot,
    });
    const pkg = JSON.parse(await fileContents(join(root, 'package.json')));
    expect(pkg.dependencies.zod).toBe('^3.25.0');
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

  test('the minimal template (the default) adds no primitives and no Zod', async () => {
    await writePkgJson(root, { name: 'my-app', version: '1.0.0', type: 'module' });
    await runInitAugment({ targetDir: root, skillsRoot, force: false, templatesRoot });
    expect(await exists(join(root, 'kindgi', 'tools', 'echo', 'index.ts'))).toBe(false);
    const pkg = JSON.parse(await fileContents(join(root, 'package.json')));
    expect(pkg.dependencies?.zod).toBeUndefined();
  });
});
