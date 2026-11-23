// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Reference pages from the READMEs of what isn't an npm package: the Java
 * and Scala SDKs (on Maven Central) and the Terraform modules (each
 * release's are downloads, `/downloads/kindgi-<module>-<version>.zip`).
 *
 * A README is written for its directory in the repository. Its page leaves out
 * the sections about building it from source, and its links are rewritten
 * as the package pages' are (`readme-links.mjs`). Each Java or Scala block
 * that isn't a whole file, and each block in a language nothing checks
 * (`hcl`), is marked `excerpt`, as the site's own pages mark them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXCERPT, metaWords } from '../excerpts.mjs';
import { publicPackages } from './packages.mjs';
import { rewriteLinks } from './readme-links.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const README = `README${'.md'}`;
/** Sections about building from a checkout: not on the page. */
const FROM_SOURCE = ['Build from source'];
/** A module page's first paragraph: where its zip is. */
const DOWNLOAD = (module, guide, title) =>
  `Each release's module is a download, \`kindgi-${module}-{{kindgi.version}}.zip\` for this one, with its \`.sha256\`: [${title}](../../../deploy/self-hosted/${guide}/) shows how to fetch and check it.`;

/**
 * The READMEs, with each page's slug, title, sidebar label and order (in its
 * group), description, and what goes before the README's text.
 */
export const READMES = [
  {
    dir: 'sdks/java',
    slug: 'reference/java/index',
    title: 'Java SDK',
    label: 'kindgi-client',
    order: 0,
    description: 'com.kindgi:kindgi-client: the Kindgi API client for Java and Scala apps.',
  },
  {
    dir: 'sdks/java/kindgi-pack',
    slug: 'reference/java/kindgi-pack',
    title: 'Java packs',
    label: 'kindgi-pack',
    order: 1,
    description: "com.kindgi:kindgi-pack: a pack's tools and guardrail checks in Java.",
  },
  {
    dir: 'sdks/scala',
    slug: 'reference/scala/index',
    title: 'Scala packs',
    label: 'kindgi-pack-scala',
    order: 0,
    description: "com.kindgi:kindgi-pack-scala: a pack's tools, checks, agents and flows in Scala.",
  },
  {
    dir: 'deploy/gcp-cloud-run',
    slug: 'reference/terraform/gcp-cloud-run',
    title: 'Terraform: Google Cloud Run',
    label: 'Google Cloud Run',
    order: 1,
    description: 'The Terraform module that runs Kindgi on Google Cloud Run, step by step.',
    before: DOWNLOAD('gcp-cloud-run', 'cloud-run', 'Deploy on Google Cloud Run'),
  },
  {
    dir: 'deploy/azure-container-apps',
    slug: 'reference/terraform/azure-container-apps',
    title: 'Terraform: Azure Container Apps',
    label: 'Azure Container Apps',
    order: 2,
    description: 'The Terraform module that runs Kindgi on Azure Container Apps, step by step.',
    before: DOWNLOAD(
      'azure-container-apps',
      'azure-container-apps',
      'Deploy on Azure Container Apps',
    ),
  },
];

/** The Python SDK's README: its page is the Python reference's overview. */
const PYTHON = { dir: 'sdks/python', slug: 'reference/python/index' };

/**
 * The page of every README the site renders, by its directory: the public
 * packages', these, and the Python SDK's. A link to one goes to its page.
 */
export function readmeLinks() {
  return new Map([
    ...publicPackages().map((pkg) => [pkg.dir, pkg.pageSlug]),
    ...[...READMES, PYTHON].map(({ dir, slug }) => [join(REPO, dir), slug]),
  ]);
}

/** A heading's anchor, as the site (and GitHub) makes it. */
export function anchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Leaves out each section titled one of `titles` (its heading to the next
 * heading at its level or above), and the links to it: a `(see [...](#it))`
 * goes, any other becomes its text.
 */
export function dropSections(markdown, titles) {
  const lines = markdown.split('\n');
  const out = [];
  let close;
  let dropping;
  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (close === undefined) {
      const heading = line.match(/^(#{1,6})\s+(.*?)\s*$/);
      if (heading && dropping !== undefined && heading[1].length <= dropping) dropping = undefined;
      if (heading && dropping === undefined && titles.includes(heading[2])) {
        dropping = heading[1].length;
      }
      if (fence) close = fence[1];
    } else if (fence && line.trim().replace(/^[`~]+/, '') === '' && line.trim().startsWith(close)) {
      close = undefined;
    }
    if (dropping === undefined) out.push(line);
  }
  let kept = out.join('\n');
  for (const title of titles) {
    const id = anchor(title);
    kept = kept
      .replaceAll(new RegExp(`\\s*\\(see \\[[^\\]]*\\]\\(#${id}\\)\\)`, 'g'), '')
      .replaceAll(new RegExp(`\\[([^\\]]*)\\]\\(#${id}\\)`, 'g'), '$1');
  }
  return kept;
}

/** A Java or Scala block's first line when it's a whole file, as check-samples reads it. */
const WHOLE_FILE = {
  java: /^\/\/\s*src\/(?:main|test)\/java\/\S+\.java\s*$/,
  scala: /^\/\/\s*src\/(?:main|test)\/scala\/\S+\.scala\s*$/,
};
/** The languages check-samples checks as pasted, besides the compiled ones. */
const CHECKED = new Set([
  ...['', 'text', 'txt', 'plaintext'],
  ...['sh', 'bash', 'shell', 'zsh'],
  ...['json', 'jsonc', 'toml', 'xml', 'js', 'javascript', 'mjs'],
]);

/**
 * Marks `excerpt` each Java or Scala block that isn't a whole file, and each
 * block in a language nothing checks.
 */
export function markExcerpts(markdown) {
  const lines = markdown.split('\n');
  let close;
  for (let i = 0; i < lines.length; i++) {
    if (close) {
      if (lines[i].trim() === close) close = undefined;
      continue;
    }
    const fence = lines[i].match(/^(\s*)(`{3,}|~{3,})([^\s`]*)(.*)$/);
    if (!fence) continue;
    const [, indent, marks, language, meta] = fence;
    close = marks;
    if (metaWords(meta).includes(EXCERPT)) continue;
    const whole = WHOLE_FILE[language];
    const excerpt = whole ? !whole.test(lines[i + 1] ?? '') : !CHECKED.has(language);
    if (excerpt) lines[i] = `${indent}${marks}${language} ${EXCERPT}${meta}`;
  }
  return lines.join('\n');
}

export function readmePages(links = readmeLinks()) {
  return READMES.map((readme) => {
    const dir = join(REPO, readme.dir);
    const markdown = readFileSync(join(dir, README), 'utf8').replace(/^# .*\n+/, '');
    const body = markExcerpts(
      rewriteLinks(dropSections(markdown, FROM_SOURCE), { slug: readme.slug, dir, pages: links }),
    );
    return {
      slug: readme.slug,
      content: [
        '---',
        `title: ${JSON.stringify(readme.title)}`,
        `description: ${JSON.stringify(readme.description)}`,
        'sidebar:',
        `  label: ${JSON.stringify(readme.label)}`,
        `  order: ${readme.order}`,
        '---',
        '',
        ...(readme.before ? [readme.before, ''] : []),
        body.trimEnd(),
        '',
      ].join('\n'),
    };
  });
}
