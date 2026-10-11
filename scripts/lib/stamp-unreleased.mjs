// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The release step of a changelog kept by hand (Changesets writes the npm
 * packages' own): its `## Unreleased` section becomes the version's, under a
 * fresh, empty `## Unreleased`.
 *
 *   ## Unreleased                ## Unreleased
 *                       →
 *   - a change                   ## 1.2.0
 *
 *                                - a change
 *
 * Each pull request adds its line under `## Unreleased`; the release stamps
 * it. A section with no entries gets `emptyText`, so every released version
 * keeps a heading. Stamping a version that already has a heading changes
 * nothing: the release script may run twice on the same tree.
 */

/** A changelog that can't be stamped; its message says what's wrong. */
export class StampError extends Error {}

const UNRELEASED = /^## Unreleased[ \t]*$/;
const SECTION = /^## /;
const FENCE = /^(```|~~~)/;

/** The indexes of the `## ` heading lines, outside fenced code blocks. */
function sectionHeadings(lines) {
  const found = [];
  let fence;
  lines.forEach((line, i) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (marker === fence) fence = undefined;
      return;
    }
    if (fence === undefined && SECTION.test(line)) found.push(i);
  });
  return found;
}

/**
 * What keeps a changelog from being stamped: exactly one `## Unreleased`,
 * above every version, and no version twice. Empty when it's fine.
 *
 * @param {string} text the changelog
 * @param {string} file its name, for the messages
 * @returns {string[]}
 */
export function unreleasedProblems(text, file) {
  const lines = text.split('\n');
  const headings = sectionHeadings(lines);
  const problems = [];
  const unreleased = headings.filter((i) => UNRELEASED.test(lines[i]));
  if (unreleased.length !== 1) {
    problems.push(`${file} needs one "## Unreleased" heading; it has ${unreleased.length}`);
  } else if (headings[0] !== unreleased[0]) {
    problems.push(`${file}: "## Unreleased" must be the first section, above every version`);
  }
  const seen = new Set();
  for (const i of headings) {
    const heading = lines[i].trimEnd();
    if (seen.has(heading)) problems.push(`${file} has "${heading}" twice`);
    seen.add(heading);
  }
  return problems;
}

/** The lines without the blank ones at either end. */
function trimBlank(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

/**
 * The changelog with its `## Unreleased` section stamped as `version`'s.
 *
 * @param {string} text the changelog
 * @param {string} version the version being released
 * @param {string} emptyText the stamped section's text when it has no entries
 * @param {string} file the changelog's name, for the messages
 * @returns {string} the stamped changelog; `text` itself when `version` already has a heading
 * @throws {StampError} when the headings aren't as `unreleasedProblems` needs
 */
export function stampUnreleased(text, version, emptyText, file) {
  const problems = unreleasedProblems(text, file);
  if (problems.length > 0) throw new StampError(problems.join('\n'));
  const lines = text.split('\n');
  const headings = sectionHeadings(lines);
  if (headings.some((i) => lines[i].trimEnd() === `## ${version}`)) return text;
  const start = headings[0];
  const next = headings[1] ?? lines.length;
  const entries = trimBlank(lines.slice(start + 1, next));
  const rest = lines.slice(next);
  return [
    ...lines.slice(0, start),
    '## Unreleased',
    '',
    `## ${version}`,
    '',
    ...(entries.length > 0 ? entries : [emptyText]),
    '',
    ...rest,
  ].join('\n');
}
