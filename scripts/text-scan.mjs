// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What public text in this repository leaves out, for its files
 * (`check-refs.mjs`) and for a pull request's own text, its title, body
 * and commit messages (`check-pr-text.mjs`):
 *
 * - **internal process markers** (`MARKERS`): development-phase ids,
 *   hand-off notes, scratch paths, internal labels;
 * - **forbidden names**: kept here only as salted hashes
 *   (`forbidden-names.json`), so the repository checks for a name without
 *   naming it. Text is split into tokens, runs of `[a-z0-9_]` lower-cased;
 *   a token whose hash is listed is a hit, unless it's inside an accepted
 *   phrase (listed hashed too, as its tokens joined by spaces). A hit is
 *   reported by where it is, never by what it is.
 *
 * The list is generated, not edited here: the runtime's repository
 * exports it (`scripts/export-public-names.mjs` there) and checks it's
 * current at each pin.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const MARKERS = [
  [/\bsub-?phase\b/i, 'development-phase identifier'],
  [/\bphase[ _-]?[0-9]+\b/i, 'development-phase identifier'],
  [/\bHANDOFF\b/, 'hand-off note'],
  [/another session/i, 'session narration'],
  [/(?:^|[\s(`'"])\.scratch\//, 'scratch path'],
  [/\bclosed[- ](?:runtime|factory|package|repo|impl)/i, 'reference to closed-source code'],
  [/\bLayer [0-9]\b/, 'internal architecture label'],
  [/\bMVP\b/, 'internal milestone label'],
  [/\bTBD\b/, 'unresolved placeholder'],
];

/** What a name hit is reported as: never the name. */
export const NAME_HIT = 'a name the repository doesn\'t use (see CONTRIBUTING, "Public text")';

/** The hashed list, ready to match against. */
export function loadNames(json) {
  return {
    salt: json.salt,
    maxPhrase: json.maxPhrase,
    tokens: new Set(json.tokens),
    allowed: new Set(json.allowed),
  };
}

const NAMES = loadNames(
  JSON.parse(readFileSync(new URL('./forbidden-names.json', import.meta.url), 'utf8')),
);

/** The tokens of `text`: runs of `[a-z0-9_]`, lower-cased. */
export function tokenize(text) {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

const digest = (salt, text) => createHash('sha256').update(`${salt}:${text}`).digest('hex');

/** Is the hit at `tokens[i]` inside an accepted phrase? */
function inAcceptedPhrase(tokens, i, names) {
  for (let length = 2; length <= names.maxPhrase; length++) {
    for (let start = i - length + 1; start <= i; start++) {
      if (start < 0 || start + length > tokens.length) continue;
      if (names.allowed.has(digest(names.salt, tokens.slice(start, start + length).join(' ')))) {
        return true;
      }
    }
  }
  return false;
}

/** How many forbidden names `line` holds, outside accepted phrases. */
export function nameHits(line, names = NAMES) {
  const tokens = tokenize(line);
  let hits = 0;
  tokens.forEach((token, i) => {
    if (names.tokens.has(digest(names.salt, token)) && !inAcceptedPhrase(tokens, i, names)) hits++;
  });
  return hits;
}

/**
 * The problems in `text`, one per line and kind: `{ line, what, excerpt }`.
 * A marker's excerpt is the line; a name's is undefined, so a report
 * never repeats the name.
 */
export function scanText(text, { names = NAMES, markers = MARKERS } = {}) {
  const problems = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    for (const [re, what] of markers) {
      if (re.test(line)) problems.push({ line: i + 1, what, excerpt: line.trim().slice(0, 120) });
    }
    if (nameHits(line, names) > 0) problems.push({ line: i + 1, what: NAME_HIT });
  });
  return problems;
}
