// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * A README's links, for the reference page the site renders it as.
 *
 * A README is also read on npm and PyPI, away from the site, so its links to
 * the docs are whole URLs (`https://docs.kindgi.com/<path>`, or a line's
 * `https://docs.kindgi.com/v0.8/<path>`). On its page each one becomes a
 * relative link, as the site's own pages have, so every version's docs link
 * within that version. A link to `/downloads/` stays whole: the downloads
 * are served once, at the site's root.
 *
 * A relative link (to a file in the repository) goes to the page of the
 * README it names (its directory, or the file itself), or becomes its text.
 * Code, fenced or inline, is left as it is.
 */
import { basename, dirname, posix, resolve } from 'node:path';

export const DOCS_URL = 'https://docs.kindgi.com/';
const DOWNLOADS = `${DOCS_URL}downloads/`;
/** A docs line's or the pre-release's prefix: `v0.8/`, `next/`. */
const LINE = /^(?:v\d+\.\d+|next)\//;
const README = `README${'.md'}`;

/** The site path a page is served at, without the leading slash: `reference/java/`. */
export function pagePath(slug) {
  const path = slug.replace(/(?:^|\/)index$/, '');
  return path === '' ? '' : `${path}/`;
}

/**
 * The relative link from the page at `slug` to `target`, a site path without
 * the leading slash (`concepts/security/#your-tools-code`).
 */
export function hrefFrom(slug, target) {
  const at = target.indexOf('#');
  const path = at === -1 ? target : target.slice(0, at);
  const hash = at === -1 ? '' : target.slice(at);
  let href = posix.relative(`/${pagePath(slug)}`, `/${path}`);
  if (href !== '' && (path === '' || path.endsWith('/'))) href += '/';
  if (href === '') return hash === '' ? './' : hash;
  return `${href}${hash}`;
}

/** A code span (left as it is) or a link: `[text](target "title")`, `![alt](src)`. */
const SPAN_OR_LINK = /(`+)[^\n]*?\1|(!?)\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g;

/** Applies `rewrite` to the markdown outside fenced code blocks. */
function outsideFences(markdown, rewrite) {
  const lines = markdown.split('\n');
  const out = [];
  let prose = [];
  let close;
  const flush = () => {
    if (prose.length > 0) out.push(rewrite(prose.join('\n')));
    prose = [];
  };
  for (const line of lines) {
    if (close) {
      out.push(line);
      if (line.trim().startsWith(close) && line.trim().replace(/^[`~]+/, '') === '')
        close = undefined;
      continue;
    }
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      flush();
      close = fence[1];
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join('\n');
}

/**
 * Rewrites a README's links for its page (see the module comment).
 *
 * @param {string} markdown the README
 * @param {{ slug: string, dir: string, pages: Map<string, string> }} page
 *   `slug`: the page's; `dir`: the README's directory; `pages`: the slug of
 *   every rendered README's page, by its directory
 */
export function rewriteLinks(markdown, { slug, dir, pages }) {
  return outsideFences(markdown, (prose) =>
    prose.replace(SPAN_OR_LINK, (whole, code, bang, text, target, rest) => {
      if (code !== undefined) return whole;
      if (target.startsWith(DOCS_URL) && !target.startsWith(DOWNLOADS)) {
        const path = target.slice(DOCS_URL.length).replace(LINE, '');
        return `${bang}[${text}](${hrefFrom(slug, path)}${rest})`;
      }
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return whole; // a URL, an anchor
      const at = target.indexOf('#');
      const path = at === -1 ? target : target.slice(0, at);
      const hash = at === -1 ? '' : target.slice(at);
      const absolute = resolve(dir, path);
      const other = pages.get(basename(absolute) === README ? dirname(absolute) : absolute);
      if (other !== undefined && !bang) {
        return `[${text}](${hrefFrom(slug, `${pagePath(other)}${hash}`)}${rest})`;
      }
      return text; // a file in the repository: nowhere a reader can open
    }),
  );
}
