// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The shipped skills load in levels, so a coding agent reads only what its
 * case needs:
 *
 *  1. The description, which an agent loads in every session for every
 *     installed skill: at most 1,024 characters (the Agent Skills limit).
 *  2. `SKILL.md`, the entry, loaded when the skill is used: at most 6 KiB
 *     with its frontmatter. It holds what's true on every path, and links
 *     the file for each case.
 *  3. The files beside it, read only for their case: flat, kebab-case
 *     `.md`, at most 16 KiB each. Only the entry links them, and a file
 *     links no other file of the folder (back to `SKILL.md` is fine), so an
 *     agent never chains through files. One over 100 lines opens with a
 *     `## Contents` list. A list that names numbered items names every
 *     one, and a list that names paragraphs by their bold titles names
 *     every such paragraph, so a section whose title wraps isn't left out.
 *
 * A skill not split yet is listed in `NOT_YET_LEVELED` with a ceiling on
 * its size: it can't grow past it, and once it's under the caps it fails
 * until it's taken off the list. So the list only shrinks, and a split
 * skill can't grow back. A change that grows a listed skill raises its
 * ceiling in the same change.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const SKILLS = join(import.meta.dirname, '..', 'skills');
const ENTRY = 'SKILL.md';

const DESCRIPTION_MAX = 1_024;
const ENTRY_MAX = 6 * 1_024;
const FILE_MAX = 16 * 1_024;
const CONTENTS_FROM_LINES = 100;

/** The skills not split yet, and the most bytes each one's entry may hold. */
const NOT_YET_LEVELED: Readonly<Record<string, { readonly bytes: number }>> = {
  'kindgi-authoring-agents': { bytes: 16_113 },
  'kindgi-authoring-flows': { bytes: 13_272 },
  'kindgi-authoring-guardrails': { bytes: 25_816 },
  'kindgi-getting-started': { bytes: 18_457 },
  'kindgi-java-authoring-agents': { bytes: 12_530 },
  'kindgi-java-authoring-flows': { bytes: 18_629 },
  'kindgi-java-authoring-guardrails': { bytes: 12_148 },
  'kindgi-java-authoring-tools': { bytes: 25_225 },
  'kindgi-java-getting-started': { bytes: 16_936 },
  'kindgi-python-authoring-agents': { bytes: 13_316 },
  'kindgi-python-authoring-flows': { bytes: 15_030 },
  'kindgi-python-authoring-guardrails': { bytes: 11_241 },
  'kindgi-python-authoring-tools': { bytes: 24_843 },
  'kindgi-python-getting-started': { bytes: 18_233 },
  'kindgi-scala-authoring-agents': { bytes: 12_422 },
  'kindgi-scala-authoring-flows': { bytes: 17_420 },
  'kindgi-scala-authoring-guardrails': { bytes: 11_845 },
  'kindgi-scala-authoring-tools': { bytes: 23_689 },
  'kindgi-scala-getting-started': { bytes: 18_263 },
  'kindgi-using': { bytes: 15_027 },
};

const TOPIC_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

const skills = readdirSync(SKILLS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

/** A skill folder's entries, without dotfiles (the CLI doesn't copy them). */
function folder(skill: string) {
  return readdirSync(join(SKILLS, skill), { withFileTypes: true }).filter(
    (e) => !e.name.startsWith('.'),
  );
}

function read(skill: string, file: string): Buffer {
  return readFileSync(join(SKILLS, skill, file));
}

/**
 * The frontmatter's `description`: a folded block (`>`), its lines joined
 * with spaces, or a value on its own line.
 */
function description(entry: string): string {
  const lines = entry.split('\n');
  const end = lines.indexOf('---', 1);
  const frontmatter = lines[0] === '---' && end > 0 ? lines.slice(1, end) : [];
  const at = frontmatter.findIndex((line) => line.startsWith('description:'));
  if (at < 0) throw new Error('no description in the frontmatter');
  const value = (frontmatter[at] ?? '').slice('description:'.length).trim();
  if (value !== '>' && value !== '>-') return value.replace(/^(["'])(.*)\1$/, '$2');
  const folded: string[] = [];
  for (const line of frontmatter.slice(at + 1)) {
    if (!line.startsWith(' ')) break;
    folded.push(line.trim());
  }
  return folded.join(' ');
}

/** The `.md` files a markdown text links outside code, each with its `#part` taken off. */
function linkedFiles(text: string): string[] {
  const prose = text.replace(/^ *```[\s\S]*?^ *```/gm, '').replace(/`[^`\n]*`/g, '');
  const files: string[] = [];
  for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = (match[1] ?? '').replace(/#.*$/, '');
    if (target.endsWith('.md') && !target.includes(':')) files.push(target);
  }
  return files;
}

/** The items of a markdown text's `## Contents` list, in order. */
function contents(text: string): string[] {
  const lines = text.split('\n');
  const items: string[] = [];
  for (const line of lines.slice(lines.indexOf('## Contents') + 1)) {
    if (line.startsWith('- ')) items.push(line.slice(2));
    else if (line !== '' || items.length > 0) break;
  }
  return lines.includes('## Contents') ? items : [];
}

/** A markdown text's numbered items that open with a bold title, outside code, as `N. Title`; a title wrapped onto more lines is joined. */
function numberedTitles(text: string): string[] {
  const prose = text.replace(/^ *```[\s\S]*?^ *```/gm, '');
  return [...prose.matchAll(/^ {0,3}(\d+)\. \*\*([\s\S]+?)\*\*/gm)].map(
    (match) => `${match[1]}. ${(match[2] ?? '').replace(/\s+/g, ' ')}`,
  );
}

/** A markdown text's paragraphs that open with a bold title, outside code, as the title without a closing `:` or `.`; a title wrapped onto more lines is joined. */
function boldTitles(text: string): string[] {
  const prose = text.replace(/^ *```[\s\S]*?^ *```/gm, '');
  return [...prose.matchAll(/(?<=^|\n\n)\*\*([^*]+)\*\*/g)].map((match) =>
    (match[1] ?? '').replace(/\s+/g, ' ').replace(/[:.]$/, ''),
  );
}

describe('the helpers', () => {
  test('a folded description is joined with spaces; a one-line one is read as it is', () => {
    expect(
      description('---\nname: x\ndescription: >\n  One line,\n  and two.\ntype: core\n---\n'),
    ).toBe('One line, and two.');
    expect(description('---\ndescription: "Short."\n---\n')).toBe('Short.');
  });

  test('links outside code count, and only to .md files', () => {
    /** A file's name, built so check-refs doesn't read it as a document reference. */
    const md = (name: string) => `${name}.md`;
    expect(
      linkedFiles(
        [
          `See [path A](${md('path-a')}#keys) and [the docs](https://kindgi.com/docs/${md('x')}).`,
          `\`[not](${md('code')})\``,
          '```scala',
          `Agent[Ctx](id) // [no](${md('fenced')})`,
          '```',
          '1. Then:',
          '   ```ts',
          `   // [no](${md('indented')})`,
          '   ```',
          `| [B](${md('path-b')}) | [up](../${md('other')}) |`,
        ].join('\n'),
      ),
    ).toEqual([md('path-a'), md('path-b'), `../${md('other')}`]);
  });

  test("a Contents list is read to its end; a wrapped title is joined, and one in code isn't read", () => {
    const text = [
      '# Common mistakes',
      '',
      '## Contents',
      '',
      '- 1. One.',
      '- 2. Two, wrapped.',
      '',
      '1. **One.** Body.',
      '2. **Two,',
      '   wrapped.** Body.',
      '```md',
      '3. **In code.**',
      '```',
    ].join('\n');
    expect(contents(text)).toEqual(['1. One.', '2. Two, wrapped.']);
    expect(numberedTitles(text)).toEqual(['1. One.', '2. Two, wrapped.']);
    expect(contents('# No list\n')).toEqual([]);
  });

  test("a bold title opens a paragraph; a wrapped one is joined, and one in code or mid-paragraph isn't read", () => {
    const text = [
      '**Step 1 — set the key:**',
      '',
      '**A title that',
      'wraps.** Body,',
      '**not a title** in a paragraph.',
      '',
      '```md',
      '**In code.**',
      '```',
      '',
      '**No closing mark** opens this one.',
      '',
      '1. **A numbered item.**',
    ].join('\n');
    expect(boldTitles(text)).toEqual([
      'Step 1 — set the key',
      'A title that wraps',
      'No closing mark',
    ]);
  });
});

describe.each(skills)('%s', (skill) => {
  const listed = NOT_YET_LEVELED[skill];
  const entry = read(skill, ENTRY);
  const others = folder(skill).filter((e) => e.name !== ENTRY);
  const files = others.filter((e) => e.isFile());

  const unsplit =
    "not split yet, so it can't grow: split it, or raise its ceiling in NOT_YET_LEVELED";

  test('its description is within the limit', () => {
    expect(description(entry.toString('utf8')).length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  test('its entry is within the cap', () => {
    expect(entry.byteLength, listed === undefined ? ENTRY : unsplit).toBeLessThanOrEqual(
      listed?.bytes ?? ENTRY_MAX,
    );
  });

  test('a skill under the caps is off the not-yet-split list', () => {
    const leveled = entry.byteLength <= ENTRY_MAX;
    expect(leveled && listed !== undefined, 'take it off NOT_YET_LEVELED').toBe(false);
  });

  test('its folder holds flat .md files, each within the cap', () => {
    for (const e of others) {
      expect(e.isFile(), `${e.name} is a file`).toBe(true);
      expect(e.name).toMatch(TOPIC_FILE);
      expect(read(skill, e.name).byteLength, e.name).toBeLessThanOrEqual(FILE_MAX);
    }
  });

  test('the entry links files of its folder, and every one of them', () => {
    const linked = new Set(linkedFiles(entry.toString('utf8')));
    const names = new Set(files.map((e) => e.name));
    for (const file of linked) {
      expect(names.has(file), `${file} is in ${skill}/`).toBe(true);
    }
    for (const name of names) {
      expect(linked.has(name), `${ENTRY} links ${name}`).toBe(true);
    }
  });

  test('a file links no other file of the folder, and a long one opens with its contents', () => {
    for (const e of files) {
      const text = read(skill, e.name).toString('utf8');
      for (const file of linkedFiles(text)) {
        expect(file, `${e.name} links ${file}`).toBe(ENTRY);
      }
      if (text.split('\n').length > CONTENTS_FROM_LINES) {
        expect(text.split('\n').slice(0, 20), `${e.name} has ## Contents`).toContain('## Contents');
      }
    }
  });

  test('a numbered Contents list names every numbered item, in order', () => {
    for (const e of files) {
      const text = read(skill, e.name).toString('utf8');
      const items = contents(text);
      if (!items.some((item) => /^\d+\. /.test(item))) continue;
      expect(items, `${e.name}'s ## Contents`).toEqual(numberedTitles(text));
    }
  });

  test('a Contents list that names a bold-titled paragraph names every one, in order', () => {
    for (const e of files) {
      const text = read(skill, e.name).toString('utf8');
      const titles = boldTitles(text);
      // An item names a paragraph by its title, or by its title and what it says: "Practical rule: …".
      const named = contents(text).flatMap((item) => {
        const title = titles.find((t) => item === t || item.startsWith(`${t}: `));
        return title === undefined ? [] : [title];
      });
      if (named.length === 0) continue;
      expect(named, `${e.name}'s ## Contents`).toEqual(titles);
    }
  });
});

test('every listed skill is shipped', () => {
  expect(Object.keys(NOT_YET_LEVELED).filter((skill) => !skills.includes(skill))).toEqual([]);
});
