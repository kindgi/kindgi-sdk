#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Docs ship with the change: a branch that changes a public contract also
 * changes the docs, or says why it doesn't.
 *
 * The contracts are what users build against: the HTTP API's spec, the
 * environment variables, the wire schemas, the CLI's commands, the SDKs'
 * public sources. The docs are the site's pages, the skills, a README, or
 * the contributor docs. A branch whose commits (since it left `main`)
 * touch a contract and none of the docs passes only with a commit message
 * line `No-docs: <reason>` (for example, a refactor with no visible change).
 *
 * The generated reference (CLI, env vars, schemas, SDK APIs) follows the
 * code by itself; this check is about the pages people write.
 *
 * Usage: `pnpm run check:docs-ship [<base ref>]` (default `origin/main`;
 * CI runs it on pull requests).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const CONTRACTS = [
  'packages/api/openapi.json',
  'packages/env-schema/src/',
  'packages/specs/schemas/',
  'packages/cli/src/commands/',
  'packages/sdk/src/',
  'sdks/python/src/kindgi/',
];
const DOCS = [
  /^site\/src\/content\/docs\//,
  /^packages\/sdk\/skills\//,
  /(^|\/)README\.md$/,
  /^docs\//,
];
const OPT_OUT = /^No-docs:\s*\S/m;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const base = process.argv[2] ?? 'origin/main';
const mergeBase = git('merge-base', base, 'HEAD');
const changed = git('diff', '--name-only', `${mergeBase}...HEAD`).split('\n').filter(Boolean);

// A skill is a view of site pages (site/skills-sources.json): when its pages
// change and it doesn't, say so. A reminder to review it, not a failure:
// skills change only with a before/after check.
const sourcesFile = 'site/skills-sources.json';
if (existsSync(sourcesFile)) {
  const { skills } = JSON.parse(readFileSync(sourcesFile, 'utf8'));
  for (const [name, skill] of Object.entries(skills)) {
    const pages = skill.pages.filter((page) =>
      changed.some((path) => path.replace(/\.mdx?$/, '') === `site/src/content/docs/${page}`),
    );
    const skillChanged = changed.some((path) => path.startsWith(`packages/sdk/skills/${name}/`));
    if (pages.length > 0 && !skillChanged) {
      console.log(`check-docs-ship: review skill ${name}; its pages changed: ${pages.join(', ')}`);
    }
  }
}

const contracts = changed.filter((path) => CONTRACTS.some((prefix) => path.startsWith(prefix)));
if (contracts.length === 0) {
  console.log('check-docs-ship: no public contract changed.');
  process.exit(0);
}
if (changed.some((path) => DOCS.some((pattern) => pattern.test(path)))) {
  console.log(`check-docs-ship: ${contracts.length} contract file(s) changed, with docs.`);
  process.exit(0);
}
const messages = git('log', '--format=%B', `${mergeBase}..HEAD`);
const reason = messages.match(OPT_OUT);
if (reason) {
  console.log(`check-docs-ship: contracts changed without docs; ${reason[0].trim()}`);
  process.exit(0);
}
console.error(
  [
    'check-docs-ship: this branch changes a public contract but no docs:',
    ...contracts.map((path) => `  ${path}`),
    '',
    'Update the pages that describe it (site/src/content/docs/, a skill, a README),',
    'or add a line `No-docs: <why>` to a commit message.',
  ].join('\n'),
);
process.exit(1);
