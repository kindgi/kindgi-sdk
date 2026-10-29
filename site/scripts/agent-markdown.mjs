// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The docs for coding agents, written from the built pages at the end of a
 * build (llmstxt.org):
 *
 * - **A Markdown version of every page,** beside it: `/start/install/` is
 *   also `/start/install.md`. Its links are absolute, and a link to another
 *   page points at that page's Markdown. Notes keep their box (a quote that
 *   starts with the note's title), tabs keep their labels, and code blocks
 *   keep their language and file name. A block that isn't a whole file says
 *   so after its language (```` ```ts excerpt ````), and so does an API
 *   signature (```` ```python signature ````).
 * - **`llms.txt`:** every page's Markdown, by sidebar section and in sidebar
 *   order, the generated references under "Optional".
 * - **`llms-full.txt`** (every page), **`llms-small.txt`** (every page but
 *   the generated references), and one file per section under
 *   `_llms-txt/`, each made of the pages' Markdown, so headings and notes
 *   survive.
 * - **A `<link rel="alternate" type="text/markdown">`** in each page's head.
 *   For people, `src/components/PageTitle.astro` links the Markdown under
 *   each page's title, and this checks it's the page's own.
 *
 * Each `llms*.txt` file names the version it describes (`llms.txt` below its
 * description, the others in their `<SYSTEM>` heading): an agent that fetched
 * one from a versioned build (`/v0.1.7/llms.txt`) knows which Kindgi it reads
 * about.
 *
 * It reads the built HTML, so every page gets a Markdown version, the HTTP
 * API's included, and the version fixes (`versioned-pages.mjs`, listed
 * before it) are already in.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { select, selectAll } from 'hast-util-select';
import rehypeParse from 'rehype-parse';
import rehypeRemark from 'rehype-remark';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';

/** The sections that get a file of their own under `_llms-txt/`. */
export const SECTIONS = [
  {
    slug: 'start',
    label: 'Start',
    description: 'install, quickstarts, existing apps',
    paths: ['start/'],
  },
  {
    slug: 'tutorials',
    label: 'Tutorials',
    description: 'build something, step by step',
    paths: ['tutorials/'],
  },
  { slug: 'guides', label: 'Guides', description: 'how to do one thing', paths: ['guides/'] },
  {
    slug: 'sites',
    label: 'Sites',
    description: "Kindgi in your website's admin",
    paths: ['sites/'],
  },
  { slug: 'concepts', label: 'Concepts', paths: ['concepts/'] },
  {
    slug: 'deploy',
    label: 'Deploy',
    description: 'on Kindgi Cloud, or self-hosted',
    paths: ['deploy/', 'hosted/'],
  },
  { slug: 'release-notes', label: 'Release notes', paths: ['releases/'] },
  { slug: 'cli-reference', label: 'CLI reference', paths: ['reference/cli/'] },
  { slug: 'python-sdk-reference', label: 'Python SDK reference', paths: ['reference/python/'] },
];

/**
 * Generated references, long and mostly for lookups, by path: listed under
 * "Optional" in `llms.txt`, and left out of `llms-small.txt`.
 */
export const REFERENCES = [
  { path: 'reference/api/', label: 'HTTP API' },
  { path: 'reference/typescript/', label: 'TypeScript SDK' },
  { path: 'reference/packages/', label: 'Packages' },
  { path: 'contributing/', label: 'Contributing to the SDK' },
];

const ASIDE_TYPES = { note: 'Note', tip: 'Tip', caution: 'Caution', danger: 'Danger' };

const parseHtml = unified().use(rehypeParse);
const toMdast = unified().use(rehypeRemark);
const toMarkdown = unified().use(remarkGfm).use(remarkStringify, {
  bullet: '-',
  emphasis: '_',
  fences: true,
  listItemIndent: 'one',
  rule: '-',
});

/** The text in a hast node, as a reader sees it. */
function textOf(node) {
  if (node.type === 'text') return node.value;
  return (node.children ?? []).map(textOf).join('');
}

function element(tagName, children, properties = {}) {
  return { type: 'element', tagName, properties, children };
}

function text(value) {
  return { type: 'text', value };
}

/** `node` with its children that match `drop` removed, at any depth. */
function prune(node, drop) {
  if (!node.children) return;
  node.children = node.children.filter((child) => !(child.type === 'element' && drop(child)));
  for (const child of node.children) prune(child, drop);
}

function hasClass(node, name) {
  const classes = node.properties?.className;
  return Array.isArray(classes) && classes.includes(name);
}

/**
 * Expressive Code's frame, as a code block with its language and file name.
 * Only the code and the title are read, so a marked frame's label
 * (`div.excerpt`, `div.signature`, beside the code) stays out; `markFrames`
 * marks its fence instead.
 */
function codeFrame(frame) {
  const pre = select('pre', frame);
  const code = select('code', frame);
  if (!pre || !code) return [frame];
  // Expressive Code always names one (`plaintext` by default); a marked
  // frame needs one, since a fence's meta follows its language.
  const marked = FRAME_KINDS.some((kind) => hasClass(frame, `is-${kind}`));
  const language = pre.properties.dataLanguage ?? (marked ? 'plaintext' : undefined);
  const lines = selectAll('.ec-line', code);
  const changed =
    language !== 'diff' && lines.some((line) => hasClass(line, 'ins') || hasClass(line, 'del'));
  const body = lines.length
    ? lines
        .map((line) => {
          // An empty line holds a line break of its own.
          const value = textOf(select('.code', line) ?? line).replace(/\n$/, '');
          if (!changed) return value;
          if (hasClass(line, 'ins')) return `+${value}`;
          if (hasClass(line, 'del')) return `-${value}`;
          return ` ${value}`;
        })
        .join('\n')
    : textOf(code);
  const lang = changed ? 'diff' : language;
  const block = element('pre', [
    element('code', [text(body)], lang ? { className: [`language-${lang}`] } : {}),
  ]);
  // The frame's place in the page, which the code block's mdast node keeps.
  block.position = pre.position;
  const title = textOf(select('figcaption .title', frame) ?? text('')).trim();
  return title ? [element('p', [element('code', [text(title)])]), block] : [block];
}

/**
 * The kinds of code frame the site marks (`figure.is-<kind>`), each written
 * after the fence's language: an excerpt, a block that isn't a whole
 * runnable file, and a signature, an API's declaration in a reference.
 */
const FRAME_KINDS = ['excerpt', 'signature'];

/** Where each marked frame's code sits in the page: its `pre`'s offset, and its kind. */
function markedFrames(content) {
  const marked = new Map();
  for (const kind of FRAME_KINDS) {
    for (const pre of selectAll(`figure.is-${kind} pre`, content)) {
      const offset = pre.position?.start.offset;
      if (offset !== undefined) marked.set(offset, kind);
    }
  }
  return marked;
}

/**
 * Writes each marked frame's kind after its code block's language
 * (```` ```ts excerpt ````, ```` ```python signature ````), so an agent
 * knows it isn't a whole file. hast-util-to-mdast's code handler always sets
 * `meta` to null and has no option for it, so this sets it on the mdast tree
 * after the conversion, finding each block by the position its code node
 * keeps from the frame's `pre` (`codeFrame`).
 */
function markFrames(node, marked) {
  if (node.type === 'code' && marked.has(node.position?.start.offset)) {
    node.meta = marked.get(node.position.start.offset);
  }
  for (const child of node.children ?? []) markFrames(child, marked);
}

/** Starlight's tabs, as a list: each item the tab's label, then its panel. */
function tabsList(tabs) {
  const tablist = select('.tablist-wrapper', tabs);
  const labels = tablist ? selectAll('[role="tab"]', tablist).map((tab) => textOf(tab).trim()) : [];
  const panels = tabs.children.filter((child) => child.properties?.role === 'tabpanel');
  const items = panels.map((panel, index) =>
    element('li', [
      element('p', [element('strong', [text(labels[index] ?? '')])]),
      ...panel.children,
    ]),
  );
  return [element('ul', items)];
}

/** A Starlight aside, as a quote that starts with its kind and title. */
function asideQuote(aside) {
  const kind = Object.keys(ASIDE_TYPES).find((type) => hasClass(aside, `starlight-aside--${type}`));
  const label = ASIDE_TYPES[kind] ?? 'Note';
  const title = textOf(select('.starlight-aside__title', aside) ?? text('')).trim();
  const heading = title && title !== label ? `${label}: ${title}` : label;
  const content = select('.starlight-aside__content', aside);
  return [
    element('blockquote', [
      element('p', [element('strong', [text(heading)])]),
      ...(content?.children ?? []),
    ]),
  ];
}

/** Replaces, at any depth, each element that `match` picks with what `make` returns. */
function replace(node, match, make) {
  if (!node.children) return;
  node.children = node.children.flatMap((child) =>
    child.type === 'element' && match(child) ? make(child) : [child],
  );
  for (const child of node.children) replace(child, match, make);
}

/**
 * Where a link in the page at `pageUrl` should point in its Markdown: an
 * absolute URL, and for another page of these docs (`pages`, their URL
 * paths), that page's Markdown.
 */
export function markdownLink(href, { pageUrl, pages, base }) {
  let url;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return href;
  }
  if (url.origin === new URL(pageUrl).origin && pages.has(url.pathname)) {
    url.pathname = twinPath(url.pathname, base);
  }
  return url.href;
}

/**
 * The URL path of a page's Markdown: `/start/install/` is
 * `/start/install.md`, and the home page (`base`) is `index.md` in it.
 */
export function twinPath(pagePath, base) {
  return pagePath === base ? `${base}index.md` : `${pagePath.replace(/\/$/, '')}.md`;
}

/**
 * A built page as Markdown: its title, description and content, or
 * undefined for a page with no content (a redirect, the 404 page).
 */
export function pageToMarkdown(html, { pageUrl, pages, base, siteDescription }) {
  const tree = parseHtml.parse(html);
  if (select('meta[http-equiv="refresh"]', tree)) return undefined;
  const content = select('.sl-markdown-content', tree);
  if (!content) return undefined;
  const title = textOf(select('h1#_top', tree) ?? select('title', tree) ?? text('')).trim();
  const description = select('meta[name="description"]', tree)?.properties.content;

  prune(
    content,
    (node) =>
      ['script', 'style', 'link', 'svg', 'button', 'template'].includes(node.tagName) ||
      hasClass(node, 'sl-anchor-link') ||
      hasClass(node, 'sr-only') ||
      hasClass(node, 'copy'),
  );
  const marked = markedFrames(content);
  replace(
    content,
    (node) => hasClass(node, 'expressive-code'),
    (node) => {
      const frame = select('figure', node) ?? node;
      return codeFrame(frame);
    },
  );
  replace(content, (node) => node.tagName === 'starlight-tabs', tabsList);
  replace(
    content,
    (node) => node.tagName === 'aside' && hasClass(node, 'starlight-aside'),
    asideQuote,
  );
  // What a reader can't see: the code samples not picked (the HTTP API's
  // pages), popovers and form controls. After the tabs, whose other panels
  // are hidden too.
  prune(
    content,
    (node) =>
      node.properties?.hidden !== undefined ||
      node.properties?.popover !== undefined ||
      ['select', 'input', 'sl-openapi-snippet-picker'].includes(node.tagName),
  );
  for (const link of selectAll('a[href]', content)) {
    link.properties.href = markdownLink(link.properties.href, { pageUrl, pages, base });
  }
  for (const image of selectAll('img[src]', content)) {
    image.properties.src = markdownLink(image.properties.src, { pageUrl, pages: new Set(), base });
  }

  const mdast = toMdast.runSync({ type: 'root', children: content.children });
  markFrames(mdast, marked);
  const body = String(toMarkdown.stringify(mdast)).trim();
  const own = description && description !== siteDescription ? description : undefined;
  const head = own ? `# ${title}\n\n> ${own}` : `# ${title}`;
  return { title, description: own, markdown: `${head}\n\n${body}\n` };
}

/**
 * The sidebar's links, in order, each with the labels of the groups it sits
 * in (outermost first), read from a built page's HTML.
 */
export function sidebarLinks(html) {
  const tree = parseHtml.parse(html);
  const top = select('#starlight__sidebar ul.top-level', tree);
  if (!top) return [];
  const links = [];
  const walk = (list, groups) => {
    for (const item of list.children.filter((child) => child.tagName === 'li')) {
      const details = item.children.find((child) => child.tagName === 'details');
      if (details) {
        const label = textOf(select('summary .group-label', details) ?? text('')).trim();
        const inner = details.children.find((child) => child.tagName === 'ul');
        if (inner) walk(inner, [...groups, label]);
        continue;
      }
      const link = select('a[href]', item);
      if (link) links.push({ href: link.properties.href, label: textOf(link).trim(), groups });
    }
  };
  walk(top, []);
  return links;
}

function* builtPages(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* builtPages(path);
    else if (name === 'index.html') yield path;
  }
}

function inSection(path, prefixes) {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

/** One page in a combined file: its Markdown, with a line naming its URL. */
function combined(page) {
  const [first, ...rest] = page.markdown.split('\n');
  return [first, '', `Source: ${page.url}`, ...rest].join('\n');
}

/** The Markdown a built page links under its title (`data-markdown`). */
const LINKED_MARKDOWN = /\sdata-markdown="([^"]*)"/;

/**
 * Writes each built page's Markdown beside it and links it from the page's
 * head. A page whose title links any Markdown but its own fails the build.
 * Returns the pages that got one, by URL path, and the sidebar's links.
 */
function writePages(root, { origin, base, description }) {
  const files = [...builtPages(root)];
  const pagePath = (file) =>
    `${base}${relative(root, dirname(file)).split('\\').join('/')}/`.replace(/\/\/$/, '/');
  const pagePaths = new Set(files.map(pagePath));
  const pages = new Map();
  let sidebar = [];
  for (const file of files) {
    const path = pagePath(file);
    const html = readFileSync(file, 'utf8');
    if (sidebar.length === 0) sidebar = sidebarLinks(html);
    const at = {
      pageUrl: `${origin}${path}`,
      pages: pagePaths,
      base,
      siteDescription: description,
    };
    const page = pageToMarkdown(html, at);
    const twin = page ? twinPath(path, base) : undefined;
    // The link under the page's title (PageTitle.astro) is its own Markdown.
    const linked = LINKED_MARKDOWN.exec(html)?.[1];
    if (linked !== undefined && linked !== twin) {
      throw new Error(
        `${path} links ${linked} as its Markdown version, but ${twin ? `its own is ${twin}` : 'it has none'}.`,
      );
    }
    if (!page) continue;
    const twinFile = join(root, twin.slice(base.length));
    mkdirSync(dirname(twinFile), { recursive: true });
    writeFileSync(twinFile, page.markdown);
    const link = `<link rel="alternate" type="text/markdown" href="${twin}">`;
    writeFileSync(file, html.replace('</head>', `${link}</head>`));
    const rel = path.slice(base.length);
    pages.set(path, { ...page, rel, url: `${origin}${path}`, twinUrl: `${origin}${twin}` });
  }
  return { pages, sidebar };
}

/**
 * The pages in reading order, each with its sidebar groups: the home page,
 * then the sidebar's order, then any page the sidebar doesn't show, by path.
 */
function readingOrder(pages, sidebar, { origin, base }) {
  const ordered = [];
  const seen = new Set();
  const add = (path, groups) => {
    if (seen.has(path) || !pages.has(path)) return;
    ordered.push({ ...pages.get(path), groups });
    seen.add(path);
  };
  add(base, ['Start']);
  for (const link of sidebar) add(new URL(link.href, `${origin}${base}`).pathname, link.groups);
  for (const path of [...pages.keys()].sort()) add(path, []);
  return ordered;
}

/** The generated reference a page belongs to, if any. */
function referenceOf(page) {
  return REFERENCES.find((reference) => page.rel.startsWith(reference.path));
}

/**
 * `llms.txt`: what the docs are and which version, how to get any page as
 * Markdown, the combined files, then every page: a section per sidebar
 * group and a subsection per group inside it, the generated references
 * under "Optional", as llmstxt.org names it.
 */
function llmsIndex(ordered, { origin, base, title, version, description, details }) {
  const at = (rel) => `${origin}${base}${rel}`;
  const howTo = [
    "Every page of these docs has a Markdown version: replace the slash at the end of the page's URL with `.md`",
    `(\`${at('start/install/')}\` is \`${origin}${twinPath(`${base}start/install/`, base)}\`). The links below point at those.`,
  ].join('\n');
  const files = [
    'Whole sections in one file each:',
    ...SECTIONS.map(
      (section) =>
        `- [${section.label}](${at(`_llms-txt/${section.slug}.txt`)})${described(section)}`,
    ),
    `- [Everything but the generated references](${at('llms-small.txt')})`,
    `- [Everything](${at('llms-full.txt')})`,
  ].join('\n');

  const sections = new Map();
  for (const page of ordered) {
    const [outer = 'Other pages', inner = ''] = page.groups;
    const reference = referenceOf(page);
    const heading = reference ? 'Optional' : outer;
    const sub = reference ? reference.label : inner;
    const subs = sections.get(heading) ?? new Map();
    sections.set(heading, subs);
    subs.set(sub, [
      ...(subs.get(sub) ?? []),
      `- [${page.title}](${page.twinUrl})${described(page)}`,
    ]);
  }
  const headings = [...sections.keys()].filter((heading) => heading !== 'Optional');
  if (sections.has('Optional')) headings.push('Optional');
  const lists = headings.map((heading) =>
    [
      `## ${heading}`,
      ...[...sections.get(heading)].flatMap(([sub, entries]) => [
        '',
        ...(sub ? [`### ${sub}`, ''] : []),
        ...entries,
      ]),
    ].join('\n'),
  );
  const which = `These are the docs for ${title} ${version}.`;
  return `${[`# ${title}`, `> ${description}`, which, details, howTo, files, ...lists].join('\n\n')}\n`;
}

/** `: <description>` for a list entry, or nothing. */
function described({ description }) {
  return description ? `: ${description}` : '';
}

/**
 * Pages in one file: a heading for the file, with the release it describes
 * (`Kindgi 0.1.7`), then each page with its URL.
 */
function combinedFile(list, heading, release) {
  return `${[`<SYSTEM>${heading} (${release})</SYSTEM>`, ...list.map(combined)].join('\n\n')}\n`;
}

/**
 * Writes every page's Markdown and the `llms*.txt` files into the build at
 * `root`, for the docs of `version` served at `origin` + `base`. Returns
 * how many pages got a Markdown version.
 */
export function writeAgentMarkdown(root, { origin, base, title, version, description, details }) {
  const { pages, sidebar } = writePages(root, { origin, base, description });
  const ordered = readingOrder(pages, sidebar, { origin, base });
  const release = `${title} ${version}`;
  writeFileSync(
    join(root, 'llms.txt'),
    llmsIndex(ordered, { origin, base, title, version, description, details }),
  );
  writeFileSync(
    join(root, 'llms-full.txt'),
    combinedFile(ordered, `${title}: the complete documentation`, release),
  );
  writeFileSync(
    join(root, 'llms-small.txt'),
    combinedFile(
      ordered.filter((page) => !referenceOf(page)),
      `${title}: the documentation without the generated references`,
      release,
    ),
  );
  mkdirSync(join(root, '_llms-txt'), { recursive: true });
  for (const section of SECTIONS) {
    const list = ordered.filter((page) => inSection(page.rel, section.paths));
    const heading = section.description
      ? `${section.label}: ${section.description}`
      : section.label;
    writeFileSync(
      join(root, '_llms-txt', `${section.slug}.txt`),
      combinedFile(list, heading, release),
    );
  }
  return pages.size;
}

/**
 * The integration: writes the agents' Markdown once the build is done.
 * `version` is the release the build describes (`docsVersion()`).
 */
export function agentMarkdown({ site, base, title, version, description, details }) {
  if (!version) {
    throw new Error('agentMarkdown: no version: each llms*.txt file names the one it describes.');
  }
  return {
    name: 'kindgi-agent-markdown',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const origin = new URL(site).origin;
        const count = writeAgentMarkdown(root, {
          origin,
          base,
          title,
          version,
          description,
          details,
        });
        logger.info(`${count} page(s) written as Markdown, with llms.txt and the section files.`);
      },
    },
  };
}
