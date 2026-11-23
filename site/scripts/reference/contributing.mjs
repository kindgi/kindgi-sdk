// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The Contributing section's pages, from the repository's own contributor
 * docs: the root contributing guide (`contributing/repository`) and every
 * markdown file in `docs/` (`contributing/<its name, lowercased>`).
 *
 * The files stay in the repository, where contributors and the API spec's
 * descriptions point at them. Links between them become links between the
 * pages; a link to any other file in the repository becomes its text, like
 * the package pages', since the repository is private.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MARKDOWN = '.md';

/** `{ path, slug }` for every source, the root guide first. */
function sources() {
  const root = { path: join(REPO, `CONTRIBUTING${MARKDOWN}`), slug: 'contributing/repository' };
  const docsDir = join(REPO, 'docs');
  const docs = existsSync(docsDir)
    ? readdirSync(docsDir)
        .filter((name) => extname(name) === MARKDOWN)
        .sort()
        .map((name) => ({
          path: join(docsDir, name),
          slug: `contributing/${basename(name, MARKDOWN).toLowerCase()}`,
        }))
    : [];
  return [root, ...docs].filter((source) => existsSync(source.path));
}

function rewriteLinks(markdown, source, bySourcePath) {
  return markdown.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g,
    (whole, bang, text, target, rest) => {
      if (/^(?:[a-z]+:|#|\/\/)/i.test(target)) return whole; // a URL, an anchor
      const [path, hash = ''] = target.split('#');
      const absolute = resolve(dirname(source.path), path);
      const anchor = hash ? `#${hash}` : '';
      const other = bySourcePath.get(absolute);
      if (other && !bang) {
        return `[${text}](${other === source ? '' : `../${basename(other.slug)}/`}${anchor}${rest})`;
      }
      return text; // the private repository: nowhere a reader can open
    },
  );
}

export function contributingPages() {
  const all = sources();
  const bySourcePath = new Map(all.map((source) => [source.path, source]));
  return all.map((source, index) => {
    const markdown = readFileSync(source.path, 'utf8');
    const heading = markdown.match(/^# (.*)\n+/);
    const title = heading ? heading[1].trim() : basename(source.path, MARKDOWN);
    const body = rewriteLinks(
      heading ? markdown.slice(heading[0].length) : markdown,
      source,
      bySourcePath,
    );
    return {
      slug: source.slug,
      content: [
        '---',
        `title: ${JSON.stringify(title)}`,
        'sidebar:',
        `  order: ${index + 1}`,
        '---',
        '',
        body.trimEnd(),
        '',
      ].join('\n'),
    };
  });
}
