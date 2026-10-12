#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * Every language a feature exists in gets its own tab: a page's language
 * tabs (`<Tabs syncKey="lang">`) show TypeScript, Python, Java and Scala.
 *
 * - **A Tier 1 page** (writing a tool, an agent and a flow, starting a run,
 *   following one) has all four in every group.
 * - **Any other page** has all four in every group, or a tab for a language
 *   that lacks the feature which says so on its first line ("Not in the
 *   Java SDK.") and what to do instead.
 * - **Pages written before this check** have their missing tabs counted in
 *   `tabs-baseline.json`: for each page, how many of its groups lack each
 *   language. A page that lacks more fails, and so does one that lacks
 *   fewer, until its count comes down: the counts only shrink.
 *   `--write-baseline` lowers them to what's left, and raises none.
 *
 * A group is named by the heading above it ("Test it"), with "#2" for a
 * second group under the same heading. The baseline counts rather than
 * names them, so a heading that changes doesn't change it.
 *
 * Usage: node scripts/check-tabs.mjs [--write-baseline]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = 'src/content/docs/';
const BASELINE = join(site, 'scripts', 'tabs-baseline.json');

export const LANGUAGES = ['TypeScript', 'Python', 'Java', 'Scala'];

/** The Tier 1 pages, by slug: every group in all four languages, always. */
export const TIER_1 = [
  'guides/tools/write-a-tool',
  'guides/agents/write-an-agent',
  'guides/flows/write-a-flow',
  'guides/runs/start-a-run',
  'guides/runs/follow-a-run',
];

/** A tab's first line, when it says its SDK lacks the feature. */
const NOT_IN = /^Not in the (TypeScript|Python|Java|Scala) SDK\b/;

/** A heading's text, as a reader sees it. */
function headingText(line) {
  return line
    .replace(/^#+\s*/, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s*\{#[^}]*\}\s*$/, '')
    .trim();
}

const FENCE = /^(`{3,}|~{3,})/;
const LANG_TABS = /^<Tabs\b[^>]*\bsyncKey="lang"/;
const TAB_ITEM = /^<TabItem\b[^>]*\blabel="([^"]+)"/;

/** Outside a group: a heading names what follows; a language `<Tabs>` opens a group. */
function readOutside(state, trimmed, number) {
  if (/^#{2,6}\s/.test(trimmed)) {
    state.heading = headingText(trimmed);
    return;
  }
  if (!LANG_TABS.test(trimmed)) return;
  const count = (state.perHeading.get(state.heading) ?? 0) + 1;
  state.perHeading.set(state.heading, count);
  const name = count === 1 ? state.heading : `${state.heading} #${count}`;
  state.group = { name, line: number, tabs: [] };
}

/** Inside a group: its tabs, each tab's first line, and where it closes. */
function readInGroup(state, trimmed) {
  if (trimmed.startsWith('</Tabs>')) {
    state.groups.push(state.group);
    state.group = undefined;
    state.tab = undefined;
    return;
  }
  const item = trimmed.match(TAB_ITEM);
  if (item) {
    state.tab = { label: item[1], first: undefined };
    state.group.tabs.push(state.tab);
    return;
  }
  const tab = state.tab;
  if (tab && tab.first === undefined && trimmed !== '' && !trimmed.startsWith('</TabItem')) {
    tab.first = trimmed;
  }
}

/** One line, skipping code blocks: a block that opens a tab is its first line. */
function readLine(state, trimmed, number) {
  const marker = trimmed.match(FENCE)?.[1];
  if (state.fence) {
    if (marker?.startsWith(state.fence) && marker === trimmed) state.fence = undefined;
    return;
  }
  if (marker) {
    state.fence = marker;
    if (state.tab && state.tab.first === undefined) state.tab.first = '';
    return;
  }
  if (state.group) readInGroup(state, trimmed);
  else readOutside(state, trimmed, number);
}

/**
 * A page's language tab groups, in order: each with its name (the heading
 * above it, "#2" for a second under the same one), the line it opens on,
 * and its tabs, `{ label, notIn }`, where `notIn` is the SDK a tab says
 * lacks the feature.
 */
export function tabGroups(source) {
  const state = { heading: '(the page’s start)', perHeading: new Map(), groups: [] };
  source.split('\n').forEach((line, index) => readLine(state, line.trim(), index + 1));
  return state.groups.map(({ name, line, tabs }) => ({
    name,
    line,
    tabs: tabs.map(({ label, first }) => ({ label, notIn: first?.match(NOT_IN)?.[1] })),
  }));
}

/** The languages a group has no tab for, in `LANGUAGES` order. */
function missingFrom(group) {
  const labels = new Set(group.tabs.map((tab) => tab.label));
  return LANGUAGES.filter((language) => !labels.has(language));
}

/** A group's "Not in" tabs that name another SDK, or that a Tier 1 page can't have. */
function notInProblems(at, group, isTier1) {
  return group.tabs.flatMap((tab) => {
    if (tab.notIn === undefined) return [];
    if (tab.notIn !== tab.label)
      return [`${at}: the ${tab.label} tab says "Not in the ${tab.notIn} SDK"`];
    return isTier1
      ? [
          `${at}: a Tier 1 page has the feature in every language, but its ${tab.label} tab says it's not in the SDK`,
        ]
      : [];
  });
}

/** How many of a page's groups lack each language: `{ Java: 2, Scala: 2 }`, zeros left out. */
export function missingCounts(groups) {
  const counts = {};
  for (const group of groups) {
    for (const language of missingFrom(group)) counts[language] = (counts[language] ?? 0) + 1;
  }
  return counts;
}

/** A page's missing tabs: on a Tier 1 page any; elsewhere more than its baseline allows. */
function missingProblems(page, groups, allowed, isTier1) {
  const problems = [];
  for (const language of LANGUAGES) {
    const lacking = groups.filter((group) => missingFrom(group).includes(language));
    const limit = isTier1 ? 0 : (allowed[language] ?? 0);
    if (lacking.length <= limit) continue;
    const where = lacking.map((group) => `line ${group.line}, "${group.name}"`).join('; ');
    problems.push(
      isTier1
        ? `${page}: a Tier 1 page needs a ${language} tab in every group (${where})`
        : `${page}: ${lacking.length} group(s) with no ${language} tab, ${limit} allowed (${where}). Add one, with the feature, or a first line "Not in the ${language} SDK." and what to do instead`,
    );
  }
  return problems;
}

/** Baseline counts above what a page lacks now: they come down (--write-baseline). */
function staleProblems(groupsByPage, baseline) {
  return Object.entries(baseline).flatMap(([page, allowed]) => {
    const counts = missingCounts(groupsByPage.get(page) ?? []);
    return Object.entries(allowed)
      .filter(([language, count]) => (counts[language] ?? 0) < count)
      .map(
        ([language, count]) =>
          `${page}: tabs-baseline.json allows ${count} group(s) with no ${language} tab, and the page has ${counts[language] ?? 0}: lower it (--write-baseline)`,
      );
  });
}

/**
 * What fails, for each page's groups (`Map<slug, groups>`) against the
 * baseline (`{ slug: { language: count } }`): more missing tabs than the
 * baseline allows, a count the page has come under, a missing tab on a
 * Tier 1 page, a "Not in" tab on one or naming another SDK than its own.
 */
export function check(groupsByPage, baseline, tier1 = TIER_1) {
  const problems = [];
  for (const [page, groups] of groupsByPage) {
    const isTier1 = tier1.includes(page);
    for (const group of groups) {
      problems.push(
        ...notInProblems(`${page} (line ${group.line}, "${group.name}")`, group, isTier1),
      );
    }
    problems.push(...missingProblems(page, groups, baseline[page] ?? {}, isTier1));
  }
  return [...problems, ...staleProblems(groupsByPage, baseline)];
}

/** The baseline lowered to what pages lack now. No count goes up, and no page is added. */
export function shrink(baseline, groupsByPage) {
  const result = {};
  for (const [page, allowed] of Object.entries(baseline)) {
    const counts = missingCounts(groupsByPage.get(page) ?? []);
    for (const [language, count] of Object.entries(allowed)) {
      const left = Math.min(count, counts[language] ?? 0);
      if (left > 0) {
        result[page] ??= {};
        result[page][language] = left;
      }
    }
  }
  return result;
}

/** The hand-written pages: tracked, and not the generated reference. */
function pages() {
  return execFileSync('git', ['ls-files', '--', DOCS], { cwd: site, encoding: 'utf8' })
    .split('\n')
    .filter((path) => /\.mdx?$/.test(path) && !path.startsWith(`${DOCS}reference/`));
}

function groupsByPage() {
  const result = new Map();
  for (const path of pages()) {
    const groups = tabGroups(readFileSync(join(site, path), 'utf8'));
    if (groups.length > 0) result.set(path.slice(DOCS.length).replace(/\.mdx?$/, ''), groups);
  }
  return result;
}

function main() {
  const found = groupsByPage();
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  if (process.argv.includes('--write-baseline')) {
    const next = shrink(baseline, found);
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`check-tabs: baseline written, ${Object.keys(next).length} page(s).`);
    return;
  }
  const problems = check(found, baseline);
  if (problems.length > 0) {
    console.error(
      'check-tabs: language tabs missing (each language a feature exists in gets a tab):',
    );
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const left = Object.values(baseline).reduce(
    (sum, counts) => sum + Object.values(counts).reduce((a, b) => a + b, 0),
    0,
  );
  console.log(
    `check-tabs: OK, ${found.size} page(s) with language tabs; ${left} missing tab(s) on the baseline, in ${Object.keys(baseline).length} page(s), none new.`,
  );
}

// Run as a script, not when a test imports it (real paths: a temp folder can be a symlink).
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
)
  main();
