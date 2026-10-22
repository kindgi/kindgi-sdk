#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * A command the docs give runs as copied. The CLI is project-local (a
 * dependency `kindgi init` adds, never a global install), so a shell block
 * starts it through the project: `pnpm exec kindgi …` in a TypeScript
 * project, `uv run kindgi …` in a Python one, `./kindgiw …` in Java or
 * Scala. A page with language tabs gives a shared step one tab per
 * language; any other page writes `pnpm exec kindgi …`, and the install
 * page names the other forms.
 *
 * This fails on a bare `kindgi` where a shell block runs a command: at the
 * start of a command, after `&&`, `||`, `;`, `|`, `(`, inside `$(…)` or
 * backticks, after `NAME=value` words, and after a word that runs the next
 * one (`sudo`, `nohup`, `exec`, `env`, `time`, `xargs`, `watch`). A
 * `kindgi` that's an argument (`which kindgi`), in quotes, in a comment or
 * in a heredoc's text isn't run, so it's fine. Only shell blocks (`sh`,
 * `bash`, `shell`, `zsh`) are read: a `text` block is output or a prompt
 * to paste, printed as it is.
 *
 * A command run before there's a project starts the CLI from the registry,
 * `npx --yes @kindgi/cli@0.1 …` or `uvx --from "kindgi-cli>=0.1,<0.2" kindgi …`:
 * there `kindgi` is a package name or an argument, so it's fine too. Every
 * page is read, the coding agents' setup page included.
 *
 * Usage: node scripts/check-cli-launch.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = 'src/content/docs/';

/** The fence languages that are shell, as check-samples.mjs reads them. */
const SHELL = new Set(['sh', 'bash', 'shell', 'zsh']);
/** Words that run the word after them as a command. */
const RUNS_NEXT = new Set([
  'sudo',
  'nohup',
  'exec',
  'env',
  'time',
  'command',
  'xargs',
  'watch',
  'then',
  'do',
  'else',
  'if',
  'elif',
  'while',
  'until',
  '!',
  '{',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const OPERATOR = new Set([';', '&', '|', '(', ')']);
const BLANK = new Set([' ', '\t', '\n']);

/**
 * The shell blocks in a page's source: each one's fence language, the
 * 1-based number of its first line inside the fence, and its lines.
 */
export function shellBlocks(source) {
  const lines = source.split('\n');
  const blocks = [];
  let fence;
  let block;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const marker = trimmed.match(/^(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (marker?.startsWith(fence) && marker === trimmed) {
        fence = undefined;
        block = undefined;
      } else {
        block?.lines.push(lines[index]);
      }
    } else if (marker) {
      fence = marker;
      const lang = trimmed.slice(marker.length).trim().split(/\s+/)[0];
      if (SHELL.has(lang)) {
        block = { lang, start: index + 2, lines: [] };
        blocks.push(block);
      }
    }
  }
  return blocks;
}

/** Where a quote that opens at `text[at]` closes: its index, or the end. */
function quoteEnd(text, at) {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length && text[i] !== quote) i += quote === '"' && text[i] === '\\' ? 2 : 1;
  return i;
}

/** Where the `(` at `text[open]` closes: the index of its match, or -1. */
function parenEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i = quoteEnd(text, i);
    } else if (c === '\\') {
      i += 1;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The `$(…)` or backticks at `text[at]`: the launches of the command in it
 * go in `found`, and it returns the index after it.
 */
function substitution(text, at, found) {
  const tick = text[at] === '`';
  const end = tick ? text.indexOf('`', at + 1) : parenEnd(text, at + 1);
  const close = end === -1 ? text.length : end;
  found.push(...launchesIn(text, tick ? at + 1 : at + 2, close));
  return close + 1;
}

/** A `"…"` that opens at `text[at]`: the index after it, with its substitutions read. */
function doubleQuoted(text, at, to, found) {
  let i = at + 1;
  while (i < to && text[i] !== '"') {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '`' || (text[i] === '$' && text[i + 1] === '('))
      i = substitution(text, i, found);
    else i += 1;
  }
  return i + 1;
}

/** Where the word that starts at `text[start]` ends, with its substitutions read. */
function wordEnd(text, start, to, found) {
  let i = start;
  while (i < to && !/[\s;&|()]/.test(text[i])) {
    const c = text[i];
    if (c === '\\') i += 2;
    else if (c === "'") i = quoteEnd(text, i) + 1;
    else if (c === '"') i = doubleQuoted(text, i, to, found);
    else if (c === '`' || (c === '$' && text[i + 1] === '(')) i = substitution(text, i, found);
    else i += 1;
  }
  return i;
}

/**
 * Where a bare `kindgi` is run in one line of shell (continuations joined):
 * the index of each one's `k`. `from` and `to` bound the part read, for a
 * `$(…)` or backticks inside it.
 */
export function launchesIn(text, from = 0, to = text.length) {
  const found = [];
  let expect = true;
  let i = from;
  while (i < to) {
    const c = text[i];
    if (BLANK.has(c)) {
      i += 1;
    } else if (c === '#') {
      break;
    } else if (OPERATOR.has(c)) {
      expect = c !== ')';
      i += 1;
    } else {
      const start = i;
      i = wordEnd(text, start, to, found);
      const word = text.slice(start, Math.min(i, to));
      if (expect && word === 'kindgi') found.push(start);
      expect = expect && (ASSIGNMENT.test(word) || RUNS_NEXT.has(word));
    }
  }
  return found.sort((a, b) => a - b);
}

/**
 * The command line that starts at `lines[index]`: it and the lines its
 * trailing `\`s go on into, joined by `\n`, and where each line starts in it.
 */
function commandLine(lines, index) {
  const parts = [{ index, at: 0 }];
  let text = lines[index];
  while (/(^|[^\\])(\\\\)*\\$/.test(text) && parts.at(-1).index + 1 < lines.length) {
    text = `${text.slice(0, -1)} `;
    const next = parts.at(-1).index + 1;
    parts.push({ index: next, at: text.length + 1 });
    text = `${text}\n${lines[next]}`;
  }
  return { text, parts };
}

/**
 * Where a block's commands run a bare `kindgi`: `{ line, column }`, both
 * 0-based within the block's lines. A line ending in `\` goes on in the
 * next one, and a heredoc's text up to its delimiter isn't a command.
 */
export function blockLaunches(lines) {
  const found = [];
  let heredoc;
  let index = 0;
  while (index < lines.length) {
    if (heredoc) {
      if ((heredoc.strip ? lines[index].trim() : lines[index]) === heredoc.word)
        heredoc = undefined;
      index += 1;
      continue;
    }
    const { text, parts } = commandLine(lines, index);
    for (const at of launchesIn(text)) {
      const part = parts.findLast((p) => p.at <= at);
      found.push({ line: part.index, column: at - part.at });
    }
    const here = text.match(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (here) heredoc = { strip: here[1] === '-', word: here[3] };
    index = parts.at(-1).index + 1;
  }
  return found;
}

/**
 * Each bare `kindgi` a page's shell blocks run: its 1-based line and the
 * line's text.
 */
export function bareLaunches(source) {
  return shellBlocks(source).flatMap(({ start, lines }) =>
    blockLaunches(lines).map(({ line }) => ({ line: start + line, text: lines[line].trim() })),
  );
}

/** The hand-written pages: tracked `.md` and `.mdx` under the docs. */
function pages() {
  return execFileSync('git', ['ls-files', '--', DOCS], { cwd: site, encoding: 'utf8' })
    .split('\n')
    .filter((path) => /\.mdx?$/.test(path));
}

function main() {
  const paths = pages();
  const hits = paths.flatMap((path) =>
    bareLaunches(readFileSync(join(site, path), 'utf8')).map((hit) => ({ path, ...hit })),
  );
  if (hits.length > 0) {
    console.error(
      'check-cli-launch: shell blocks that run a bare `kindgi`, which runs only if it was installed globally:',
    );
    for (const { path, line, text } of hits) console.error(`  ${path}:${line}: ${text}`);
    console.error(
      'Start it through the project: `pnpm exec kindgi …` (TypeScript), `uv run kindgi …` (Python), `./kindgiw …` (Java, Scala). On a page with language tabs, give the step a `<Tabs syncKey="lang">` group, one tab per language.',
    );
    process.exit(1);
  }
  console.log(
    `check-cli-launch: OK, ${paths.length} page(s), no bare \`kindgi\` in a shell block.`,
  );
}

// Run as a script, not when a test imports it (real paths: a temp folder can be a symlink).
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
)
  main();
