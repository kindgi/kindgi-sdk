#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Every README a registry shows has whole links only: npm shows a published
 * package's, PyPI the Python SDK's and the CLI's (each `pyproject.toml`'s
 * `readme`). There, a relative link (`../specs/`, `./LICENSE`) resolves to
 * nothing a reader can open. A link to a page of the docs is its
 * `https://docs.kindgi.com/...` URL (the site turns it back into a link
 * within each version's docs), to another package its reference page there,
 * and the license is its `https://www.apache.org/licenses/LICENSE-2.0`. An
 * anchor in the README itself (`#usage`) is fine.
 *
 * Which READMEs: each `packages/*`, `packages/adapters/*` and `sdks/*`
 * package whose `package.json` isn't `"private": true`, and each `sdks/*`
 * `pyproject.toml`'s readme. Code, fenced or inline, isn't read.
 *
 * Usage: `pnpm run check:readme-links`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const README = `README${'.md'}`;

/** The READMEs npm and PyPI show, repository-relative, sorted. */
export function publishedReadmes(root) {
  const tracked = execFileSync(
    'git',
    [
      'ls-files',
      '--',
      'packages/*/package.json',
      'packages/adapters/*/package.json',
      'sdks/*/package.json',
      'sdks/*/pyproject.toml',
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\n')
    .filter((file) => file !== '');
  const readmes = new Set();
  for (const file of tracked) {
    const text = readFileSync(join(root, file), 'utf8');
    let readme;
    if (file.endsWith('package.json')) {
      if (JSON.parse(text).private === true) continue;
      readme = README;
    } else {
      readme = /^readme\s*=\s*(?:"([^"]+)"|\{[^}]*\bfile\s*=\s*"([^"]+)")/m
        .exec(text)
        ?.slice(1)
        .find((name) => name !== undefined);
      if (readme === undefined) continue;
    }
    const path = join(dirname(file), readme);
    if (existsSync(join(root, path))) readmes.add(path);
  }
  return [...readmes].sort();
}

/** A code span (skipped), an inline link or image, an HTML `href` or `src`. */
const LINK =
  /(`+)[^\n]*?\1|!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)|\b(?:href|src)\s*=\s*["']([^"']+)["']/g;
/** A link reference definition: `[label]: target`. */
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/;

/** A whole URL (`https:`, `mailto:`), or an anchor in the document itself. */
const isWhole = (target) => /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target);

/**
 * The relative links in `markdown` (outside code), as `{ line, target }`,
 * the line 1-based.
 */
export function relativeLinks(markdown) {
  const found = [];
  let close;
  markdown.split('\n').forEach((text, index) => {
    const fence = text.match(/^\s*(`{3,}|~{3,})/);
    if (close !== undefined) {
      if (fence && text.trim().startsWith(close) && text.trim().replace(/^[`~]+/, '') === '') {
        close = undefined;
      }
      return;
    }
    if (fence) {
      close = fence[1];
      return;
    }
    const line = index + 1;
    const definition = DEFINITION.exec(text);
    if (definition) {
      if (!isWhole(definition[1])) found.push({ line, target: definition[1] });
      return;
    }
    for (const match of text.matchAll(LINK)) {
      const target = match[2] ?? match[3];
      if (target !== undefined && !isWhole(target)) found.push({ line, target });
    }
  });
  return found;
}

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const readmes = publishedReadmes(root);
  const problems = readmes.flatMap((file) =>
    relativeLinks(readFileSync(join(root, file), 'utf8')).map(
      ({ line, target }) => `${file}:${line}: ${target}`,
    ),
  );
  if (problems.length > 0) {
    console.error(
      `A README npm or PyPI shows has relative links, which go nowhere there: link the docs (https://docs.kindgi.com/...), or keep the text.\n${problems.map((p) => `  ${p}`).join('\n')}`,
    );
    process.exit(1);
  }
  console.log(`README links: ${readmes.length} published READMEs, every link whole.`);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
