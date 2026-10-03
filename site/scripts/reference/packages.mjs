// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * One reference page per public `@kindgi/*` package, from its README.
 *
 * Links in a README are written for the repository. Here, a link to
 * another public package goes to that package's page; any other file or
 * directory in the repository goes to GitHub at the docs' own ref
 * (`KINDGI_DOCS_REF`, a release tag for a versioned build, else `main`),
 * so a version's docs never point at newer code.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GITHUB = 'https://github.com/kindgi/kindgi-sdk';
const README = `README${'.md'}`;

/** Public `@kindgi/*` packages: `{ name, dir, slug }`. */
function publicPackages() {
  const dirs = [];
  for (const parent of ['packages', join('packages', 'adapters')]) {
    for (const entry of readdirSync(join(REPO, parent))) {
      const dir = join(REPO, parent, entry);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs
    .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }))
    .filter(({ manifest }) => manifest.name?.startsWith('@kindgi/') && manifest.private !== true)
    .filter(({ dir }) => existsSync(join(dir, README)))
    .map(({ dir, manifest }) => ({
      name: manifest.name,
      description: manifest.description ?? '',
      dir,
      slug: manifest.name.slice('@kindgi/'.length),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function rewriteLinks(markdown, pkg, bySlugDir, ref) {
  return markdown.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g,
    (whole, bang, text, target, rest) => {
      if (/^(?:[a-z]+:|#|\/\/)/i.test(target)) return whole; // a URL, an anchor
      const [path, hash = ''] = target.split('#');
      const absolute = resolve(pkg.dir, path);
      const anchor = hash ? `#${hash}` : '';
      // Another public package (its directory or its README): its page.
      const packageDir = absolute.endsWith(README) ? dirname(absolute) : absolute;
      const other = bySlugDir.get(packageDir);
      if (other && !bang) {
        const self = other.slug === pkg.slug;
        return `[${text}](${self ? '' : `../${other.slug}/`}${anchor}${rest})`;
      }
      const inRepo = relative(REPO, absolute);
      if (inRepo.startsWith('..') || !existsSync(absolute)) return text; // nowhere to point
      const kind = statSync(absolute).isDirectory() ? 'tree' : 'blob';
      return `${bang}[${text}](${GITHUB}/${kind}/${ref}/${inRepo}${anchor}${rest})`;
    },
  );
}

export function packagePages() {
  const ref = process.env.KINDGI_DOCS_REF ?? 'main';
  const packages = publicPackages();
  const bySlugDir = new Map(packages.map((pkg) => [pkg.dir, pkg]));
  const pages = packages.map((pkg) => {
    const readme = readFileSync(join(pkg.dir, README), 'utf8').replace(/^# .*\n+/, '');
    const body = rewriteLinks(readme, pkg, bySlugDir, ref);
    return {
      slug: `reference/packages/${pkg.slug}`,
      content: [
        '---',
        `title: ${JSON.stringify(pkg.name)}`,
        `description: ${JSON.stringify(pkg.description)}`,
        '---',
        '',
        `\`npm install ${pkg.name}\` · [source](${GITHUB}/tree/${ref}/${relative(REPO, pkg.dir)})`,
        '',
        body.trimEnd(),
        '',
      ].join('\n'),
    };
  });
  const overview = [
    '---',
    'title: Packages',
    'description: Every public @kindgi/* package and what it is for.',
    'sidebar:',
    '  order: 0',
    '  label: Overview',
    '---',
    '',
    'The public `@kindgi/*` packages (Apache-2.0). They share one version. Most',
    'apps need only `@kindgi/sdk`, with `@kindgi/cli` for development; the others',
    'are its building blocks, and the pieces you swap or extend.',
    '',
    ...packages.map((pkg) => `- [\`${pkg.name}\`](${pkg.slug}/): ${pkg.description}`),
    '',
  ];
  return [{ slug: 'reference/packages/index', content: overview.join('\n') }, ...pages];
}
