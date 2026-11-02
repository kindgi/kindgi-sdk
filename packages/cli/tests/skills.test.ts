// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi skills sync` and `kindgi dev`'s refresh copy a pack only the
 * skills written for its language (`pack_languages` in a skill's
 * frontmatter), into `.claude/skills/` and `.agents/skills/` alike, under
 * one manifest.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  type SkillSyncOutcome,
  type SkillSyncReport,
  describeDevSkillsRefresh,
  refreshSkillsForDev,
  skillCopyPaths,
  skillPackLanguages,
  syncSkills,
} from '../src/commands/skills.js';
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

async function installed(folder = '.claude/skills'): Promise<string[]> {
  const entries = await readdir(join(packDir, folder), { withFileTypes: true });
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
    expect(report.outcomes.map((o) => [o.folder, o.name, o.status])).toEqual([
      ['.claude/skills', 'both', 'added'],
      ['.claude/skills', 'python-only', 'added'],
      ['.agents/skills', 'both', 'added'],
      ['.agents/skills', 'python-only', 'added'],
    ]);
    expect(await installed()).toEqual(['both', 'python-only']);
    expect(await installed('.agents/skills')).toEqual(['both', 'python-only']);
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

  test("with no manifest, kindgi dev counts only the skills for the pack's language", async () => {
    await syncSkills({
      skillsRoot,
      targetDir: packDir,
      language: 'python',
      force: false,
      dryRun: false,
    });
    await rm(join(packDir, '.claude', 'skills', '.kindgi-manifest.json'));
    const commands = { sync: 'kindgi skills sync', force: 'kindgi skills sync --force' };
    const said = async (language: 'node' | 'python') =>
      describeDevSkillsRefresh(
        await refreshSkillsForDev({ skillsRoot, targetDir: packDir, language }),
        commands,
      ).map((line) => line.text);
    expect(await said('python')).toEqual([]);
    expect(await said('node')).toEqual([
      '  ⚠ Framework skills: 1 out of date.',
      '    · 1 not installed: `kindgi skills sync` adds it.',
    ]);
  });
});

describe('syncSkills — both folders, one manifest', () => {
  const sync = (force = false): Promise<SkillSyncReport> =>
    syncSkills({ skillsRoot, targetDir: packDir, language: 'node', force, dryRun: false });
  /** What a sync would still write or keep, by folder: its dry run's. */
  const behind = async () =>
    (
      await syncSkills({
        skillsRoot,
        targetDir: packDir,
        language: 'node',
        force: false,
        dryRun: true,
      })
    ).outcomes
      .filter((o) => o.status !== 'unchanged' && o.status !== 'local-only')
      .map((o) => [o.folder, o.status]);
  const copy = (folder: string) => readFile(join(packDir, folder, 'one', 'SKILL.md'), 'utf8');
  const manifestPath = () => join(packDir, '.claude', 'skills', '.kindgi-manifest.json');
  const manifest = async () => JSON.parse(await readFile(manifestPath(), 'utf8'));
  const statuses = (report: SkillSyncReport) => report.outcomes.map((o) => [o.folder, o.status]);

  beforeEach(async () => {
    await bundle('one', '');
  });

  /** The bundle's next version of `one`. */
  async function advance(): Promise<void> {
    await writeFile(
      join(skillsRoot, 'one', 'SKILL.md'),
      '---\nname: one\nversion: "2.0.0"\n---\n# one, again\n',
    );
  }

  test('writes the same copy into each folder, and records both', async () => {
    await sync();
    expect(await copy('.agents/skills')).toBe(await copy('.claude/skills'));
    const recorded = await manifest();
    expect(recorded.v).toBe(2);
    expect(recorded.skills.one.installedVersion).toBe('1.0.0');
    expect(recorded.agentsSkills.one).toEqual(recorded.skills.one);
    expect(await behind()).toEqual([]);
  });

  test('an edited copy is kept while the other folder updates; --force overwrites it', async () => {
    await sync();
    await writeFile(join(packDir, '.agents', 'skills', 'one', 'SKILL.md'), '# mine\n');
    await advance();
    expect(statuses(await sync())).toEqual([
      ['.claude/skills', 'updated'],
      ['.agents/skills', 'skipped-modified'],
    ]);
    expect(await copy('.claude/skills')).toContain('# one, again');
    expect(await copy('.agents/skills')).toBe('# mine\n');
    // Still the person's on the next sync, and behind for the next one.
    const kept = await sync();
    expect(statuses(kept)).toEqual([
      ['.claude/skills', 'unchanged'],
      ['.agents/skills', 'skipped-modified'],
    ]);
    expect(kept.outcomes[1]?.reason).toBe('Local edits detected; --force to overwrite.');
    expect(await behind()).toEqual([['.agents/skills', 'skipped-modified']]);
    expect(statuses(await sync(true))).toEqual([
      ['.claude/skills', 'unchanged'],
      ['.agents/skills', 'updated'],
    ]);
    expect(await copy('.agents/skills')).toContain('# one, again');
  });

  test.each(['.claude/skills', '.agents/skills'])(
    'recreates %s when it is deleted',
    async (folder) => {
      await sync();
      await rm(join(packDir, folder), { recursive: true, force: true });
      expect(await behind()).toEqual([[folder, 'added']]);
      const report = await sync();
      expect(report.outcomes.find((o) => o.folder === folder)?.status).toBe('added');
      expect(await installed(folder)).toEqual(['one']);
      expect(await behind()).toEqual([]);
    },
  );

  test("kindgi dev's words count a skill once, however many of its copies are behind", () => {
    const commands = { sync: 'kindgi skills sync', force: 'kindgi skills sync --force' };
    const outcome = (
      name: string,
      folder: SkillSyncOutcome['folder'],
      status: SkillSyncOutcome['status'],
    ): SkillSyncOutcome => ({ name, folder, status, toVersion: '2' });
    const dryRun = (outcomes: SkillSyncOutcome[]) =>
      describeDevSkillsRefresh(
        {
          kind: 'no-manifest',
          report: { targetDir: '.', packLanguage: 'node', outcomes, dryRun: true, force: false },
        },
        commands,
      ).map((line) => line.text);
    expect(dryRun([])).toEqual([]);
    expect(
      dryRun([
        outcome('a', '.claude/skills', 'added'),
        outcome('a', '.agents/skills', 'added'),
        outcome('b', '.agents/skills', 'added'),
        outcome('c', '.claude/skills', 'skipped-modified'),
        outcome('c', '.agents/skills', 'skipped-modified'),
      ]),
    ).toEqual([
      '  ⚠ Framework skills: 3 out of date.',
      '    · 2 not installed: `kindgi skills sync` adds them.',
      '    · 1 that differs, with no record of what was installed: `kindgi skills sync --force` replaces it.',
    ]);
  });

  test("a manifest without .agents/skills' entries (an older CLI's) judges its copies by .claude/skills'", async () => {
    await sync();
    // An older CLI rewrites the manifest without the field it doesn't know.
    await writeFile(manifestPath(), JSON.stringify({ v: 2, skills: (await manifest()).skills }));
    await advance();
    expect(statuses(await sync())).toEqual([
      ['.claude/skills', 'updated'],
      ['.agents/skills', 'updated'],
    ]);
  });

  test('a pack synced before .agents/skills is behind until the next sync writes it', async () => {
    await sync();
    await rm(join(packDir, '.agents'), { recursive: true, force: true });
    await writeFile(manifestPath(), JSON.stringify({ v: 2, skills: (await manifest()).skills }));
    expect(await behind()).toEqual([['.agents/skills', 'added']]);
    expect(statuses(await sync())).toEqual([
      ['.claude/skills', 'unchanged'],
      ['.agents/skills', 'added'],
    ]);
    expect(await behind()).toEqual([]);
  });
});

describe("syncSkills — a skill's folder", () => {
  /** A file's name, built so check-refs doesn't read it as a document reference. */
  const md = (name: string) => `${name}.md`;
  const [A, B, NOTES, OUTSIDE] = [md('path-a'), md('path-b'), md('notes'), md('outside')];
  const sync = (force = false, dryRun = false): Promise<SkillSyncReport> =>
    syncSkills({ skillsRoot, targetDir: packDir, language: 'node', force, dryRun });
  const local = (folder: string, file: string) => join(packDir, folder, 'two', file);
  const read = (folder: string, file: string) => readFile(local(folder, file), 'utf8');
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );
  const manifestPath = () => join(packDir, '.claude', 'skills', '.kindgi-manifest.json');
  const manifest = async () => JSON.parse(await readFile(manifestPath(), 'utf8'));
  const statuses = (report: SkillSyncReport) => report.outcomes.map((o) => [o.folder, o.status]);

  /** A file beside the bundled skill's entry. */
  const topic = (file: string, text: string) => writeFile(join(skillsRoot, 'two', file), text);

  beforeEach(async () => {
    await bundle('two', '');
    await topic(A, '# path a\n');
    await topic(B, '# path b\n');
  });

  test('copies every file of the folder into both, and records each one', async () => {
    const report = await sync();
    expect(report.outcomes.map((o) => [o.folder, o.status, o.files])).toEqual([
      ['.claude/skills', 'added', ['SKILL.md', A, B]],
      ['.agents/skills', 'added', ['SKILL.md', A, B]],
    ]);
    for (const folder of ['.claude/skills', '.agents/skills']) {
      expect(await read(folder, A)).toBe('# path a\n');
      expect(await read(folder, B)).toBe('# path b\n');
    }
    const entry = (await manifest()).skills.two;
    expect(Object.keys(entry.installedFiles)).toEqual(['SKILL.md', A, B]);
    expect(entry.installedFiles['SKILL.md']).toBe(entry.installedHash);
    expect(report.outcomes.map((o) => o.written)).toEqual([
      ['SKILL.md', A, B],
      ['SKILL.md', A, B],
    ]);
    expect(skillCopyPaths(packDir, report.outcomes[0] as SkillSyncOutcome, 'files')).toEqual([
      local('.claude/skills', 'SKILL.md'),
      local('.claude/skills', A),
      local('.claude/skills', B),
    ]);
    expect(statuses(await sync())).toEqual([
      ['.claude/skills', 'unchanged'],
      ['.agents/skills', 'unchanged'],
    ]);
  });

  test('a file the bundle changed is written, and the only one named as written; the rest are left as they are', async () => {
    await sync();
    await topic(B, '# path b, again\n');
    await utimes(local('.claude/skills', A), 0, 0);
    const report = await sync();
    expect(statuses(report)).toEqual([
      ['.claude/skills', 'updated'],
      ['.agents/skills', 'updated'],
    ]);
    expect(report.outcomes.map((o) => o.written)).toEqual([[B], [B]]);
    expect(skillCopyPaths(packDir, report.outcomes[0] as SkillSyncOutcome, 'written')).toEqual([
      local('.claude/skills', B),
    ]);
    expect(await read('.claude/skills', B)).toBe('# path b, again\n');
    expect((await stat(local('.claude/skills', A))).mtimeMs).toBe(0);
  });

  test('an edited file keeps the whole copy as it is; --force overwrites it', async () => {
    await sync();
    await writeFile(local('.agents/skills', A), '# mine\n');
    await topic(B, '# path b, again\n');
    expect(statuses(await sync())).toEqual([
      ['.claude/skills', 'updated'],
      ['.agents/skills', 'skipped-modified'],
    ]);
    expect(await read('.agents/skills', A)).toBe('# mine\n');
    expect(await read('.agents/skills', B)).toBe('# path b\n');
    const forced = await sync(true);
    expect(forced.outcomes.find((o) => o.folder === '.agents/skills')).toMatchObject({
      status: 'updated',
      reason: 'Overwrote local edits (--force)',
    });
    expect(await read('.agents/skills', A)).toBe('# path a\n');
    expect(await read('.agents/skills', B)).toBe('# path b, again\n');
  });

  test("a file that's gone comes back, as a deleted skill does", async () => {
    await sync();
    await rm(local('.claude/skills', A));
    const report = await sync();
    expect(statuses(report)).toEqual([
      ['.claude/skills', 'updated'],
      ['.agents/skills', 'unchanged'],
    ]);
    expect(report.outcomes.map((o) => o.written)).toEqual([[A], undefined]);
    expect(await read('.claude/skills', A)).toBe('# path a\n');
  });

  test('a file the bundle no longer ships is removed, unless it was edited', async () => {
    await sync();
    await writeFile(local('.agents/skills', B), '# mine\n');
    await rm(join(skillsRoot, 'two', B));
    const report = await sync();
    expect(report.outcomes.map((o) => [o.folder, o.status, o.removed])).toEqual([
      ['.claude/skills', 'updated', [B]],
      ['.agents/skills', 'skipped-modified', undefined],
    ]);
    expect(await exists(local('.claude/skills', B))).toBe(false);
    expect(await read('.agents/skills', B)).toBe('# mine\n');
    expect(Object.keys((await manifest()).skills.two.installedFiles)).toEqual(['SKILL.md', A]);
    // Still recorded as installed there, so --force removes it too.
    expect(Object.keys((await manifest()).agentsSkills.two.installedFiles)).toContain(B);
    expect((await sync(true)).outcomes.find((o) => o.folder === '.agents/skills')?.removed).toEqual(
      [B],
    );
    expect(await exists(local('.agents/skills', B))).toBe(false);
  });

  test('a dry run writes and removes nothing, and says what it would do', async () => {
    await sync();
    await rm(join(skillsRoot, 'two', B));
    await topic(A, '# path a, again\n');
    const report = await sync(false, true);
    expect(report.outcomes.map((o) => [o.status, o.removed])).toEqual([
      ['updated', [B]],
      ['updated', [B]],
    ]);
    expect(await read('.claude/skills', A)).toBe('# path a\n');
    expect(await exists(local('.claude/skills', B))).toBe(true);
  });

  test('a file you added to the folder is yours: never counted, written or removed', async () => {
    await sync();
    await writeFile(local('.claude/skills', NOTES), '# my notes\n');
    expect(statuses(await sync())).toEqual([
      ['.claude/skills', 'unchanged'],
      ['.agents/skills', 'unchanged'],
    ]);
    await topic(A, '# path a, again\n');
    expect(statuses(await sync(true))).toEqual([
      ['.claude/skills', 'updated'],
      ['.agents/skills', 'updated'],
    ]);
    expect(await read('.claude/skills', NOTES)).toBe('# my notes\n');
    expect(Object.keys((await manifest()).skills.two.installedFiles)).not.toContain(NOTES);
    // A file of yours the bundle starts shipping under the same name is an edit.
    await topic(NOTES, '# the bundle notes\n');
    expect(statuses(await sync())).toEqual([
      ['.claude/skills', 'skipped-modified'],
      ['.agents/skills', 'updated'],
    ]);
    expect(await read('.claude/skills', NOTES)).toBe('# my notes\n');
  });

  test('an entry from before skills had more files reads as its SKILL.md alone', async () => {
    await rm(join(skillsRoot, 'two', A));
    await rm(join(skillsRoot, 'two', B));
    await sync();
    // An older CLI rewrites the manifest without the field it doesn't know.
    const { skills } = await manifest();
    const { installedFiles: _, ...older } = skills.two;
    await writeFile(manifestPath(), JSON.stringify({ v: 2, skills: { two: older } }));
    await topic(A, '# path a\n');
    expect(statuses(await sync())).toEqual([
      ['.claude/skills', 'updated'],
      ['.agents/skills', 'updated'],
    ]);
    expect(await read('.claude/skills', A)).toBe('# path a\n');
    // An edited SKILL.md is still an edit under the older entry.
    await writeFile(manifestPath(), JSON.stringify({ v: 2, skills: { two: older } }));
    await writeFile(local('.claude/skills', 'SKILL.md'), '# mine\n');
    expect(statuses(await sync())).toEqual([
      ['.claude/skills', 'skipped-modified'],
      ['.agents/skills', 'unchanged'],
    ]);
  });

  test("a manifest can't point the sync outside the copy", async () => {
    await sync();
    const outside = join(packDir, OUTSIDE);
    await writeFile(outside, '# not a skill\n');
    const recorded = await manifest();
    const hash = recorded.skills.two.installedFiles[A];
    await writeFile(outside, '# path a\n');
    for (const folder of ['skills', 'agentsSkills']) {
      recorded[folder].two.installedFiles[`../../../${OUTSIDE}`] = hash;
      recorded[folder].two.installedFiles['.hidden'] = hash;
    }
    await writeFile(manifestPath(), JSON.stringify(recorded));
    expect(statuses(await sync())).toEqual([
      ['.claude/skills', 'unchanged'],
      ['.agents/skills', 'unchanged'],
    ]);
    expect(await readFile(outside, 'utf8')).toBe('# path a\n');
    expect(Object.keys((await manifest()).skills.two.installedFiles)).toEqual(['SKILL.md', A, B]);
  });
});

describe('refreshSkillsForDev — kindgi dev as it starts', () => {
  const commands = { sync: 'kindgi skills sync', force: 'kindgi skills sync --force' };
  const sync = () =>
    syncSkills({ skillsRoot, targetDir: packDir, language: 'node', force: false, dryRun: false });
  const start = async () =>
    describeDevSkillsRefresh(
      await refreshSkillsForDev({ skillsRoot, targetDir: packDir, language: 'node' }),
      commands,
    );
  const copy = (folder: string) => readFile(join(packDir, folder, 'one', 'SKILL.md'), 'utf8');
  const manifestPath = () => join(packDir, '.claude', 'skills', '.kindgi-manifest.json');
  const ignore = () => join(packDir, '.prettierignore');
  const said = (text: string) => ({ text, problem: false });
  // A warning: said under `--quiet` too.
  const warned = (text: string) => ({ text, problem: true });
  const wrote = '  ✓ Framework skills: 1 updated, 1 added.';
  const unrecorded =
    '    · 1 that differs, with no record of what was installed: `kindgi skills sync --force` replaces it.';

  beforeEach(async () => {
    await bundle('one', '');
    await sync();
  });

  /** This CLI's skills after an upgrade: `one` moved on, and `two` is new. */
  async function upgrade(): Promise<void> {
    await writeFile(
      join(skillsRoot, 'one', 'SKILL.md'),
      '---\nname: one\nversion: "2.0.0"\n---\n# one, again\n',
    );
    await bundle('two', '');
  }

  test('after an upgrade, brings each copy up to date and adds the new skill to both folders', async () => {
    await upgrade();
    expect(await start()).toEqual([said(wrote)]);
    for (const folder of ['.claude/skills', '.agents/skills']) {
      expect(await copy(folder)).toContain('# one, again');
      expect(await installed(folder)).toEqual(['one', 'two']);
    }
    const recorded = JSON.parse(await readFile(manifestPath(), 'utf8'));
    expect(recorded.skills.one.installedVersion).toBe('2.0.0');
    expect(recorded.agentsSkills.two.installedVersion).toBe('1.0.0');
  });

  test('with nothing new, writes nothing and says nothing', async () => {
    const then = new Date('2026-01-01T00:00:00Z');
    await utimes(manifestPath(), then, then);
    await writeFile(ignore(), 'dist/\n');
    expect(await start()).toEqual([]);
    expect((await stat(manifestPath())).mtime).toEqual(then);
    expect(await readFile(ignore(), 'utf8')).toBe('dist/\n');
  });

  test("records a copy that already matches but isn't in the manifest, so an upgrade doesn't take it for an edit", async () => {
    const recorded = JSON.parse(await readFile(manifestPath(), 'utf8'));
    await writeFile(manifestPath(), JSON.stringify({ ...recorded, skills: {}, agentsSkills: {} }));
    expect(await start()).toEqual([]);
    expect(JSON.parse(await readFile(manifestPath(), 'utf8'))).toEqual(recorded);
    await upgrade();
    expect(await start()).toEqual([said(wrote)]);
    for (const folder of ['.claude/skills', '.agents/skills']) {
      expect(await copy(folder)).toContain('# one, again');
    }
  });

  test('an edited copy is kept while its other copy moves on, and it says how to replace it: a warning, and the heading with it', async () => {
    await writeFile(join(packDir, '.agents', 'skills', 'one', 'SKILL.md'), '# mine\n');
    expect(await start()).toEqual([]);
    await upgrade();
    expect(await start()).toEqual([
      warned(wrote),
      warned('    · 1 you edited is kept: `kindgi skills sync --force` replaces it.'),
    ]);
    expect(await copy('.agents/skills')).toBe('# mine\n');
    expect(await copy('.claude/skills')).toContain('# one, again');
  });

  test('a copy you deleted stays deleted, and is said while it is behind; kindgi skills sync brings it back', async () => {
    await rm(join(packDir, '.claude', 'skills', 'one'), { recursive: true, force: true });
    expect(await start()).toEqual([]);
    await upgrade();
    const deleted = warned('    · 1 you deleted: `kindgi skills sync` brings it back.');
    expect(await start()).toEqual([warned(wrote), deleted]);
    expect(await installed('.claude/skills')).toEqual(['two']);
    expect(await copy('.agents/skills')).toContain('# one, again');
    expect(await start()).toEqual([warned('  ⚠ Framework skills: 1 out of date.'), deleted]);
    await sync();
    expect(await installed('.claude/skills')).toEqual(['one', 'two']);
  });

  test('.prettierignore gets the skills folders only when a skill was written', async () => {
    await writeFile(ignore(), 'dist/\n');
    expect(await start()).toEqual([]);
    expect(await readFile(ignore(), 'utf8')).toBe('dist/\n');
    await upgrade();
    expect(await start()).toEqual([
      said(wrote),
      said(
        expect.stringMatching(
          /^ {4}· Added \.claude\/skills\/kindgi-\*\/ and \.agents\/skills\/kindgi-\*\/ to \S*\.prettierignore\.$/,
        ),
      ),
    ]);
    expect(await readFile(ignore(), 'utf8')).toContain('.agents/skills/kindgi-*/');
  });

  test("a .prettierignore it can't patch is a warning, and the heading with it", async () => {
    await mkdir(ignore());
    await upgrade();
    expect(await start()).toEqual([
      warned(wrote),
      warned(
        expect.stringMatching(/^ {4}· Couldn't add the skills' folders to \S*\.prettierignore: /),
      ),
    ]);
  });

  test.each([
    {
      lost: 'is gone with .claude/skills',
      lose: () => rm(join(packDir, '.claude'), { recursive: true, force: true }),
      notInstalled: '2 not installed: `kindgi skills sync` adds them.',
    },
    {
      lost: "can't be read",
      lose: () => writeFile(manifestPath(), '{ not json'),
      notInstalled: '1 not installed: `kindgi skills sync` adds it.',
    },
  ])('with no manifest (it $lost), it writes nothing and says what a sync would do', async (c) => {
    await c.lose();
    await upgrade();
    expect(await start()).toEqual([
      warned('  ⚠ Framework skills: 2 out of date.'),
      warned(`    · ${c.notInstalled}`),
      warned(unrecorded),
    ]);
    expect(await installed('.agents/skills')).toEqual(['one']);
    expect(
      await readFile(join(packDir, '.agents', 'skills', 'one', 'SKILL.md'), 'utf8'),
    ).not.toContain('again');
    if (c.lost === "can't be read") {
      expect(await readFile(manifestPath(), 'utf8')).toBe('{ not json');
    } else {
      await expect(stat(join(packDir, '.claude'))).rejects.toThrow(/ENOENT/);
    }
  });

  test("with no manifest, a copy that matches the bundle isn't behind, and nothing is written", async () => {
    await rm(manifestPath());
    expect(await start()).toEqual([]);
    await expect(stat(manifestPath())).rejects.toThrow(/ENOENT/);
  });

  test('with no manifest, the sync does what it says: it adds the new skill and keeps the copy that differs, which --force replaces', async () => {
    await rm(manifestPath());
    await upgrade();
    expect(await start()).toEqual([
      warned('  ⚠ Framework skills: 2 out of date.'),
      warned('    · 1 not installed: `kindgi skills sync` adds it.'),
      warned(unrecorded),
    ]);
    const kept = 'No record of what was installed; --force to overwrite.';
    expect((await sync()).outcomes.map((o) => [o.folder, o.name, o.status, o.reason])).toEqual([
      ['.claude/skills', 'one', 'skipped-modified', kept],
      ['.claude/skills', 'two', 'added', undefined],
      ['.agents/skills', 'one', 'skipped-modified', kept],
      ['.agents/skills', 'two', 'added', undefined],
    ]);
    // The manifest now records `two` alone: `one` still has no record.
    expect(await start()).toEqual([
      warned('  ⚠ Framework skills: 1 out of date.'),
      warned(unrecorded),
    ]);
    const forced = await syncSkills({
      skillsRoot,
      targetDir: packDir,
      language: 'node',
      force: true,
      dryRun: false,
    });
    const overwrote = 'Overwrote a copy with no record of what was installed (--force)';
    expect(forced.outcomes.map((o) => [o.folder, o.name, o.status, o.reason])).toEqual([
      ['.claude/skills', 'one', 'updated', overwrote],
      ['.claude/skills', 'two', 'unchanged', undefined],
      ['.agents/skills', 'one', 'updated', overwrote],
      ['.agents/skills', 'two', 'unchanged', undefined],
    ]);
    expect(await start()).toEqual([]);
    for (const folder of ['.claude/skills', '.agents/skills']) {
      expect(await copy(folder)).toContain('# one, again');
    }
  });

  test('a skills folder that is gone stays gone: a new skill goes only to the folder that is there', async () => {
    await rm(join(packDir, '.agents'), { recursive: true, force: true });
    expect(await start()).toEqual([]);
    await upgrade();
    expect(await start()).toEqual([
      warned(wrote),
      warned('    · .agents/skills/ is gone: `kindgi skills sync` brings it back.'),
    ]);
    await expect(stat(join(packDir, '.agents'))).rejects.toThrow(/ENOENT/);
    expect(await installed('.claude/skills')).toEqual(['one', 'two']);
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
      'kindgi-fix-corrections',
      'kindgi-framework-feedback',
      'kindgi-python-authoring-agents',
      'kindgi-python-authoring-flows',
      'kindgi-python-authoring-guardrails',
      'kindgi-python-authoring-tools',
      'kindgi-python-getting-started',
      'kindgi-using',
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
      'kindgi-fix-corrections',
      'kindgi-framework-feedback',
      'kindgi-scala-authoring-agents',
      'kindgi-scala-authoring-flows',
      'kindgi-scala-authoring-guardrails',
      'kindgi-scala-authoring-tools',
      'kindgi-scala-getting-started',
      'kindgi-using',
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
      'kindgi-fix-corrections',
      'kindgi-framework-feedback',
      'kindgi-java-authoring-agents',
      'kindgi-java-authoring-flows',
      'kindgi-java-authoring-guardrails',
      'kindgi-java-authoring-tools',
      'kindgi-java-getting-started',
      'kindgi-using',
    ]);
    expect(await installed('.agents/skills')).toEqual(await installed());
  });

  test('the summary names both folders, each with its own counts; --json leaves it out', async () => {
    await writeFile(
      join(packDir, 'kindgi.config.json'),
      '{"language": "java", "pack": {"id": "ledger", "version": "0.1.0"}}',
    );
    const sync = (...flags: string[]) =>
      runCli({ argv: ['skills', 'sync', ...flags], env: {}, cwd: packDir, home: packDir });
    const asked = await sync('--json', '--dry-run');
    expect(asked.exitCode).toBe(0);
    expect(asked.stderr).toBe('');
    const out = await sync();
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout).outcomes).toHaveLength(20);
    expect(out.stderr).toMatch(/^Synced \S*\/\.claude\/skills\/ and \S*\/\.agents\/skills\/$/m);
    expect(out.stderr).toMatch(/^\.claude\/skills\/\n {2}\+ kindgi-/m);
    expect(out.stderr).toMatch(/^\.agents\/skills\/\n {2}\+ kindgi-/m);
    expect(
      out.stderr.match(
        /^ {2}10 added, 0 updated, 0 unchanged, 0 skipped-modified, 0 local-only$/gm,
      ),
    ).toHaveLength(2);
  });

  describe('.prettierignore', () => {
    const sync = (...flags: string[]) =>
      runCli({ argv: ['skills', 'sync', ...flags], env: {}, cwd: packDir, home: packDir });
    const ignore = () => join(packDir, '.prettierignore');

    beforeEach(async () => {
      await writeFile(
        join(packDir, 'kindgi.config.json'),
        '{"language": "java", "pack": {"id": "ledger", "version": "0.1.0"}}',
      );
    });

    test("gets the folder it lacks (an app that got Kindgi before .agents/skills), but --dry-run doesn't", async () => {
      const before = 'dist/\n\n# Kindgi\n.claude/skills/kindgi-*/\n';
      await writeFile(ignore(), before);
      expect((await sync('--dry-run')).exitCode).toBe(0);
      expect(await readFile(ignore(), 'utf8')).toBe(before);

      const out = await sync();
      expect(out.exitCode).toBe(0);
      expect(await readFile(ignore(), 'utf8')).toBe(
        `${before}\n# Kindgi\n.agents/skills/kindgi-*/\n`,
      );
      expect(JSON.parse(out.stdout).prettierignore).toEqual({
        path: expect.stringMatching(/\.prettierignore$/),
        status: 'patched',
        appended: ['.agents/skills/kindgi-*/'],
      });
      expect(out.stderr).toMatch(
        /^Added \.agents\/skills\/kindgi-\*\/ to \S*\.prettierignore, so the formatter leaves the skills as they are\.$/m,
      );
      // Once both lines are there, there's nothing to say.
      const again = await sync();
      expect(JSON.parse(again.stdout).prettierignore).toBeUndefined();
      expect(again.stderr).not.toMatch(/prettierignore/);
    });

    test('is never created', async () => {
      const out = await sync();
      expect(out.exitCode).toBe(0);
      expect(JSON.parse(out.stdout).prettierignore).toBeUndefined();
      await expect(readFile(ignore(), 'utf8')).rejects.toThrow(/ENOENT/);
    });

    test("one it can't read: the skills are still synced, and the summary says what to add by hand", async () => {
      await mkdir(ignore());
      const out = await sync();
      expect(out.exitCode).toBe(0);
      expect(await installed('.agents/skills')).toHaveLength(10);
      expect(JSON.parse(out.stdout).prettierignore).toEqual({
        path: expect.stringMatching(/\.prettierignore$/),
        status: 'error',
        message: expect.stringMatching(/^Failed to read .*\.prettierignore: /),
      });
      expect(out.stderr).toMatch(/^Couldn't add the skills' folders to \S*\.prettierignore: /m);
      expect(out.stderr).toContain(
        '  Add .claude/skills/kindgi-*/ and .agents/skills/kindgi-*/ to it yourself: a skill the formatter rewrites, the next sync keeps as edited.',
      );
    });
  });
});
