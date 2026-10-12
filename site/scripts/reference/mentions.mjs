// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Where the hand-written pages use a reference item: the `kindgi` command
 * lines in their shell blocks, and the env vars, error codes and API routes
 * they name in code spans. The reference's examples and "see also" links
 * come from here, so they follow the guides as they change.
 *
 * Generated pages (everything under `reference/`) and the contributing
 * pages are left out: a reference entry links to the guides, not to itself.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The ways the guides run the CLI: `kindgi …`, `npx @kindgi/cli …`, `npx kindgi …`,
 * `pnpm exec kindgi …`, `uvx … kindgi …`.
 */
const CLI_LINE =
  /^(?:npx\s+(?:--yes\s+|--no\s+--\s+)?@kindgi\/cli(?:@\S+)?\s+|(?:npx\s+(?:--yes\s+|--no\s+--\s+)?|pnpm\s+(?:exec\s+)?|uvx\s+(?:--from\s+\S+\s+)?)?kindgi\s+)(.*)$/;
const SHELL_BLOCK = /```(?:sh|bash|shell|console|zsh)[^\n]*\n([\s\S]*?)```/g;
const CODE_SPAN = /`([^`\n]+)`/g;
const ROUTE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/v1\/\S*)$/;

/** Every hand-written page under `docs`: its slug, title and text. */
export function handWrittenPages(docs) {
  const pages = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.mdx?$/.test(name)) {
        const slug = relative(docs, path)
          .split(sep)
          .join('/')
          .replace(/\.mdx?$/, '');
        if (slug.startsWith('reference/') || slug.startsWith('contributing/')) continue;
        const text = readFileSync(path, 'utf8');
        const title = text.match(/^title:\s*(.+)$/m)?.[1].replace(/^['"]|['"]$/g, '') ?? slug;
        pages.push({ slug, title, text });
      }
    }
  };
  walk(docs);
  return pages;
}

/**
 * The longest known command path a `kindgi` line runs, e.g. "agents promote"
 * for `kindgi agents promote acme.order-desk 1.0.0`, or undefined.
 */
export function commandOf(line, commands) {
  const match = line
    .replace(/^\$\s+/, '')
    .trim()
    .match(CLI_LINE);
  if (!match) return undefined;
  const words = [];
  for (const word of match[1].split(/\s+/)) {
    if (!/^[a-z][a-z0-9-]*$/.test(word)) break;
    words.push(word);
  }
  for (let i = words.length; i > 0; i--) {
    const path = words.slice(0, i).join(' ');
    if (commands.has(path)) return path;
  }
  return undefined;
}

/**
 * What each hand-written page uses: `commands` maps a command path to the
 * lines that run it (with the page), `codeSpans` maps every code span's text
 * to the pages that have it (env vars, error codes), and `routes` maps
 * "METHOD /path" to the pages that name it.
 */
export function collectMentions(pages, commandPaths) {
  const commands = new Map();
  const codeSpans = new Map();
  const routes = new Map();
  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  const known = new Set(commandPaths);
  for (const page of pages) {
    for (const block of page.text.matchAll(SHELL_BLOCK)) {
      for (const raw of block[1].split('\n')) {
        const line = raw.replace(/^\$\s+/, '').trim();
        const command = commandOf(line, known);
        if (command) add(commands, command, { page, line });
      }
    }
    const spans = new Set([...page.text.matchAll(CODE_SPAN)].map((m) => m[1].trim()));
    for (const span of spans) {
      add(codeSpans, span, page);
      const route = span.match(ROUTE);
      if (route) add(routes, `${route[1]} ${route[2].replace(/\?.*$/, '')}`, page);
    }
  }
  return { commands, codeSpans, routes };
}

/** Distinct pages, in first-seen order, at most `limit`. */
export function distinctPages(pages, limit) {
  const seen = new Map();
  for (const page of pages ?? []) if (!seen.has(page.slug)) seen.set(page.slug, page);
  return [...seen.values()].slice(0, limit);
}

/** The URL path a slug is served at: `guides/runs/index` → `/guides/runs/`. */
export function servedPath(slug) {
  return `/${slug.replace(/(^|\/)index$/, '')}/`.replace(/\/+/g, '/');
}

/** A relative link from the page `fromSlug` to `toSlug` (plus an optional `#anchor`). */
export function linkTo(fromSlug, toSlug, hash = '') {
  const from = servedPath(fromSlug).split('/').filter(Boolean);
  const to = servedPath(toSlug).split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const up = from.length - common;
  const path = [...Array(up).fill('..'), ...to.slice(common)].join('/');
  const href = path === '' ? './' : `${path}/`;
  return `${href.startsWith('.') ? href : `./${href}`}${hash ? `#${hash}` : ''}`;
}

/** A heading's id as Starlight makes it (github-slugger): lowercase, punctuation dropped, spaces to dashes. */
export function headingId(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}
