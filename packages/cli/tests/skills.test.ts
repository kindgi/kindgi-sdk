// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi skills sync` and the `kindgi dev` drift check copy a pack only
 * the skills written for its language (`pack_languages` in a skill's
 * frontmatter).
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { detectSkillDrift, skillPackLanguages, syncSkills } from '../src/commands/skills.js';
import { runCli } from '../src/main.js';

let skillsRoot: string;
let packDir: string;

beforeEach(async () => {
  skillsRoot = await mkdtemp(join(tmpdir(), 'kindgi-skills-bundle-'));
  packDir = await mkdtemp(join(tmpdir(), 'kindgi-skills-pack-'));
});

afterEach(async () => {
  await rm(skillsRoot, { recursive: true, force: true });
  await rm(packDir, { recursive: true, force: true });
});

async function bundle(name: string, frontmatter: string): Promise<void> {
  await mkdir(join(skillsRoot, name), { recursive: true });
  await writeFile(
    join(skillsRoot, name, 'SKILL.md'),
    `---\nname: ${name}\nversion: "1.0.0"\n${frontmatter}---\n# ${name}\n`,
  );
}

async function installed(): Promise<string[]> {
  const entries = await readdir(join(packDir, '.claude', 'skills'), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe('skillPackLanguages', () => {
  test('a skill without the field teaches the TypeScript surface', () => {
    expect(skillPackLanguages('---\nname: x\n---\n# x\n')).toEqual(['node']);
    expect(skillPackLanguages('# no frontmatter\n')).toEqual(['node']);
  });

  test('reads the list, quoted or not; unknown languages are ignored', () => {
    expect(skillPackLanguages('---\npack_languages: [node, python]\n---\n')).toEqual([
      'node',
      'python',
    ]);
    expect(skillPackLanguages('---\npack_languages: ["python"]\n---\n')).toEqual(['python']);
    expect(skillPackLanguages('---\npack_languages: [ruby, python]\n---\n')).toEqual(['python']);
    expect(skillPackLanguages('---\npack_languages: [node, python, java]\n---\n')).toEqual([
      'node',
      'python',
      'java',
    ]);
  });
});

describe('syncSkills — by pack language', () => {
  beforeEach(async () => {
    await bundle('ts-only', '');
    await bundle('both', 'pack_languages: [node, python]\n');
    await bundle('python-only', 'pack_languages: [python]\n');
  });

  test('a Python pack gets the skills written for Python packs', async () => {
    const report = await syncSkills({
      skillsRoot,
      targetDir: packDir,
      language: 'python',
      force: false,
      dryRun: false,
    });
    expect(report.packLanguage).toBe('python');
    expect(report.outcomes.map((o) => [o.name, o.status])).toEqual([
      ['both', 'added'],
      ['python-only', 'added'],
    ]);
    expect(await installed()).toEqual(['both', 'python-only']);
  });

  test('a Node pack gets the TypeScript ones', async () => {
    await syncSkills({
      skillsRoot,
      targetDir: packDir,
      language: 'node',
      force: false,
      dryRun: false,
    });
    expect(await installed()).toEqual(['both', 'ts-only']);
  });

  test("drift ignores skills that aren't for the pack's language", async () => {
    await syncSkills({
      skillsRoot,
      targetDir: packDir,
      language: 'python',
      force: false,
      dryRun: false,
    });
    expect(await detectSkillDrift({ skillsRoot, targetDir: packDir, language: 'python' })).toEqual({
      missing: [],
      outdated: [],
    });
    expect(await detectSkillDrift({ skillsRoot, targetDir: packDir, language: 'node' })).toEqual({
      missing: ['ts-only'],
      outdated: [],
    });
  });
});

describe('kindgi skills sync', () => {
  test('in a Python pack, copies the bundled skills written for Python packs', async () => {
    await writeFile(
      join(packDir, 'pyproject.toml'),
      '[project]\nname = "ledger"\nversion = "0.1.0"\n\n[tool.kindgi.pack]\nid = "ledger"\nversion = "0.1.0"\n',
    );
    const out = await runCli({
      argv: ['skills', 'sync', '--json'],
      env: {},
      cwd: packDir,
      home: packDir,
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).packLanguage).toBe('python');
    expect(await installed()).toEqual([
      'kindgi-authoring-mcp-servers',
      'kindgi-authoring-providers',
      'kindgi-framework-feedback',
      'kindgi-python-authoring-agents',
      'kindgi-python-authoring-flows',
      'kindgi-python-authoring-guardrails',
      'kindgi-python-authoring-tools',
      'kindgi-python-getting-started',
    ]);
  });

  test('in a Scala pack, copies the bundled skills written for Scala packs', async () => {
    await writeFile(
      join(packDir, 'kindgi.config.json'),
      '{"language": "scala", "pack": {"id": "ledger", "version": "0.1.0"}}',
    );
    const out = await runCli({
      argv: ['skills', 'sync', '--json'],
      env: {},
      cwd: packDir,
      home: packDir,
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).packLanguage).toBe('scala');
    expect(await installed()).toEqual([
      'kindgi-authoring-mcp-servers',
      'kindgi-authoring-providers',
      'kindgi-framework-feedback',
      'kindgi-scala-authoring-agents',
      'kindgi-scala-authoring-flows',
      'kindgi-scala-authoring-guardrails',
      'kindgi-scala-authoring-tools',
      'kindgi-scala-getting-started',
    ]);
  });

  test('in a Java pack, copies the bundled skills written for Java packs', async () => {
    await writeFile(
      join(packDir, 'kindgi.config.json'),
      '{"language": "java", "pack": {"id": "ledger", "version": "0.1.0"}}',
    );
    const out = await runCli({
      argv: ['skills', 'sync', '--json'],
      env: {},
      cwd: packDir,
      home: packDir,
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).packLanguage).toBe('java');
    expect(await installed()).toEqual([
      'kindgi-authoring-mcp-servers',
      'kindgi-authoring-providers',
      'kindgi-framework-feedback',
      'kindgi-java-authoring-agents',
      'kindgi-java-authoring-flows',
      'kindgi-java-authoring-guardrails',
      'kindgi-java-authoring-tools',
      'kindgi-java-getting-started',
    ]);
  });
});
