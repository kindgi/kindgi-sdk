#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Pages don't date themselves: each version's docs describe that version.
 * A version fact goes in the release notes, as a requirement ("needs 0.1.7
 * or later"), or in a reference page's version history.
 *
 * This fails on prose in a hand-written page that dates it:
 *
 * - **A version as a point in time:** "from 0.1.6", "fixed in 0.1.1",
 *   "since 0.1.4", "in 0.1.6", "on 0.1.6", "0.1.6 and earlier", "0.1.5 or older". A
 *   requirement ("0.1.7 or later") and a range ("in 0.1.x") are fine. So is a
 *   version with a later major than Kindgi's own (the CLI's): it's another
 *   thing's number, an agent's ("a conversation started on 1.2.0") or a
 *   dependency's ("fixed in 48.0.1"). From Kindgi 1.0 on, an agent version in a
 *   page needs a major above Kindgi's, or this rule needs another way to tell.
 * - **Time words:** "today", "currently", "for now", "at the moment",
 *   "a fix is planned", "coming soon".
 *
 * Code (fenced and inline), image text, link targets and comments aren't
 * prose, so they're not checked. Nor are release notes pages
 * (`releases/`) or a `:::note[Version history]` box. A line that needs one
 * of these words for another reason says so with a comment on it:
 * `<!-- timeless: <why> -->`, or `{/* timeless: <why> *\/}` in MDX.
 *
 * Pages written before this check have their hits counted in
 * `timeless-baseline.json`. A page may have fewer, never more. Rewriting
 * them in the present tense brings the counts down;
 * `--write-baseline` records what's left.
 *
 * Usage: node scripts/check-timeless.mjs [--write-baseline]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docsVersion } from './versioned-pages.mjs';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = 'src/content/docs/';
const BASELINE = join(site, 'scripts', 'timeless-baseline.json');

const VERSION =
  /\b(?:from|since|before|until|as of|fixed in|added in|changed in|new in|removed in|in|on)\s+(?:Kindgi\s+|the runtime\s+|runtime\s+)?\d+\.\d+\.\d+(?:\.\d+)?\b(?!\.\d)(?!\s+(?:or|and)\s+(?:later|earlier|older))/gi;
const OLDER = /\b\d+\.\d+\.\d+(?:\.\d+)?\s+(?:or|and)\s+(?:earlier|older)\b/gi;
const TIME_WORDS = /\b(?:today|currently|for now|at the moment|a fix is planned|coming soon)\b/gi;
const ALLOWED = /<!--\s*timeless:|\{\/\*\s*timeless:/;

/** `line` with what isn't prose blanked out: inline code, images, link targets, comments. */
export function proseOf(line) {
  return line
    .replace(/`+[^`]*`+/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/<!--.*?-->/g, ' ')
    .replace(/\{\/\*.*?\*\/\}/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/** Where the front matter ends: the index of the line after its closing `---`, or 0. */
function frontmatterEnd(lines) {
  if (lines[0]?.trim() !== '---') return 0;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return close === -1 ? 0 : close + 1;
}

/**
 * The lines a reader reads as prose, with their numbers: the front matter's
 * title and description, then every line outside code blocks and version
 * history boxes, except one that says why it may date the page.
 */
function proseLines(source) {
  const lines = source.split('\n');
  const start = frontmatterEnd(lines);
  const prose = [];
  lines.slice(0, start).forEach((line, index) => {
    if (/^(?:title|description):/.test(line.trim())) prose.push({ number: index + 1, line });
  });
  let fence;
  let history = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const marker = trimmed.match(/^(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (marker?.startsWith(fence) && marker === trimmed) fence = undefined;
    } else if (marker) {
      fence = marker;
    } else if (trimmed.startsWith(':::note[Version history]')) {
      history = true;
    } else if (history) {
      history = trimmed !== ':::';
    } else if (!ALLOWED.test(line)) {
      prose.push({ number: index + 1, line });
    }
  }
  return prose;
}

/**
 * The prose in paragraphs: runs of consecutive prose lines, so a phrase the
 * page's hard wrap splits across two lines is still one phrase. Each
 * paragraph keeps where each line starts in its joined text.
 */
function paragraphs(prose) {
  const result = [];
  let current;
  for (const { number, line } of prose) {
    if (line.trim() === '') {
      current = undefined;
      continue;
    }
    if (!current || number !== current.last + 1) {
      current = { text: '', starts: [], last: number };
      result.push(current);
    }
    if (current.text) current.text += ' ';
    current.starts.push({ at: current.text.length, number });
    current.text += proseOf(line);
    current.last = number;
  }
  return result;
}

/** Whether `version`'s major is at most Kindgi's (`kindgi`), so it can be Kindgi's own. */
export function couldBeKindgis(version, kindgi) {
  return Number(version.split('.')[0]) <= Number(kindgi.split('.')[0]);
}

/**
 * The phrases in a page's source that date it, each with the line it starts
 * on. `kindgi` is Kindgi's version, the CLI's in this checkout.
 */
export function datedPhrases(source, kindgi = docsVersion()) {
  return paragraphs(proseLines(source)).flatMap(({ text, starts }) =>
    [VERSION, OLDER, TIME_WORDS]
      .flatMap((pattern) => [...text.matchAll(pattern)])
      .filter((match) => {
        const version = match[0].match(/\d+\.\d+\.\d+/)?.[0];
        return !version || couldBeKindgis(version, kindgi);
      })
      .sort((a, b) => a.index - b.index)
      .map((match) => ({
        line: starts.findLast(({ at }) => at <= match.index).number,
        phrase: match[0].replace(/\s+/g, ' '),
      })),
  );
}

/** The hand-written pages this check reads: tracked, and not release notes. */
function pages() {
  return execFileSync('git', ['ls-files', '--', DOCS], { cwd: site, encoding: 'utf8' })
    .split('\n')
    .filter((path) => /\.mdx?$/.test(path) && !path.startsWith(`${DOCS}releases/`));
}

/** Each page's hits, by its slug (its path under the docs, without `.md` or `.mdx`). */
function hitsByPage() {
  const result = new Map();
  const kindgi = docsVersion();
  for (const path of pages()) {
    const hits = datedPhrases(readFileSync(join(site, path), 'utf8'), kindgi);
    if (hits.length > 0) result.set(path.slice(DOCS.length).replace(/\.mdx?$/, ''), hits);
  }
  return result;
}

/**
 * The pages with more hits than the baseline allows, and those with fewer
 * (whose baseline can come down).
 */
export function compare(hits, baseline) {
  const over = [];
  const under = [];
  for (const [page, list] of hits) {
    const allowed = baseline[page] ?? 0;
    if (list.length > allowed) over.push({ page, allowed, hits: list });
  }
  for (const [page, allowed] of Object.entries(baseline)) {
    const count = hits.get(page)?.length ?? 0;
    if (count < allowed) under.push({ page, allowed, count });
  }
  return { over, under };
}

function main() {
  const hits = hitsByPage();
  if (process.argv.includes('--write-baseline')) {
    const counts = Object.fromEntries(
      [...hits].sort(([a], [b]) => a.localeCompare(b)).map(([page, list]) => [page, list.length]),
    );
    writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`check-timeless: baseline written, ${hits.size} page(s).`);
    return;
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const { over, under } = compare(hits, baseline);
  for (const { page, allowed, count } of under) {
    console.log(
      `check-timeless: ${page} has ${count} dated phrase(s), its baseline ${allowed}: run --write-baseline to lower it.`,
    );
  }
  if (over.length > 0) {
    console.error(
      "check-timeless: pages that date themselves (each version's docs describe that version):",
    );
    for (const { page, allowed, hits: list } of over) {
      console.error(`  ${page}: ${list.length} dated phrase(s), ${allowed} allowed`);
      for (const { line, phrase } of list) console.error(`    line ${line}: "${phrase}"`);
    }
    console.error(
      'Write the page in the present tense; put the version fact in the release notes, or as a requirement ("needs 0.1.7 or later").',
    );
    process.exit(1);
  }
  const total = [...hits.values()].reduce((sum, list) => sum + list.length, 0);
  console.log(
    `check-timeless: OK, ${total} dated phrase(s) left in ${hits.size} page(s), none new.`,
  );
}

// Run as a script, not when a test imports it (real paths: a temp folder can be a symlink).
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
)
  main();
