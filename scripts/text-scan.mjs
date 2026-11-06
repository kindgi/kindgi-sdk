// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What public text in this repository leaves out, for its files
 * (`check-refs.mjs`) and for a pull request's own text, its title, body
 * and commit messages (`check-pr-text.mjs`):
 *
 * - **internal process markers** (`MARKERS`): development-phase ids,
 *   hand-off notes, scratch paths, internal labels;
 * - **internal tracking references** (`ID_MARKERS`): all of them in a
 *   pull request's own text, and in a file those that can't be sample
 *   data (`FILE_ID_MARKERS`);
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

// One digit, or a letter and one or two: `A-1042` (an order id in a sample) isn't one, nor is
// a regex's character class (`[A-Z0-9_]`, `[A-F0-9]`: after `[`, or before a range's `-9`).
const STEP_ID = [/(?<!\[)\b[A-Z]-(?:[0-9]|[A-Z][0-9]{1,2})[a-z]?\b(?!-[0-9])/, 'internal step id'];
// Lower case and whole: `W3C` and `w3c` aren't one.
const SESSION_NAME = [/\bw[1-9]\b/, 'internal session name'];

/**
 * Internal tracking references, for a pull request's own text
 * (`check-pr-text.mjs`, and the `commit-msg` hook): a ticket id (`T123`),
 * a step or check id (`M-2`, `L-A5`), a process rule's number, a release
 * batch's name, a working session's name (`w3`). They mean nothing
 * outside the team, and a pull request's
 * commits are public, though the squash commit leaves them out. A real
 * term that looks like one goes in `ALLOWED_TERMS`.
 */
export const ID_MARKERS = [
  // `T12:00` is a time.
  [/\bT[0-9]{2,4}[a-z]?\b(?!:[0-9])/, 'internal tracking id'],
  STEP_ID,
  // A dotted version (`protocol 2.5.0`) is a real term; the pack protocol's `protocol 2` is allowed.
  [/\bprotocol [0-9]+\b(?![.][0-9])/i, 'internal process rule'],
  [/\bwave [0-9]+\b/i, 'internal release batch'],
  [/\bpin[ -]batch(?:es)?\b/i, 'internal release batch'],
  SESSION_NAME,
];

/**
 * The internal tracking references a repository file leaves out
 * (`check-refs.mjs`): `ID_MARKERS` less a step id and a session name,
 * which in a file are sample data as often as not (an order `A-1` in a
 * test, `w3.org` in an XML namespace).
 */
export const FILE_ID_MARKERS = ID_MARKERS.filter((m) => m !== STEP_ID && m !== SESSION_NAME);

/**
 * Real terms that look like internal references (`ID_MARKERS`), each with
 * why it's real: they're blanked out of a line, as whole words and in any
 * case, before it's checked. Tried on every commit message on main, the
 * rules hit only real internal references, and these.
 *
 * @type {readonly { term: string, why: string }[]}
 */
export const ALLOWED_TERMS = [
  {
    term: 'protocol 2',
    why: "the pack protocol's major version, as the pack service's startup line says it",
  },
];

/** `line` with each allowed term, as a whole word in any case, blanked out. */
function withoutAllowed(line, allowed) {
  let out = line;
  for (const term of allowed) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gi'), (hit) =>
      ' '.repeat(hit.length),
    );
  }
  return out;
}

/**
 * The tracked files the file rules read (`check-refs.mjs`): docs,
 * manifests, and the source, tests and templates of each of the
 * repository's languages, those with no extension of their own among them
 * (the git hooks, the wrappers `init` copies into a project, the Java
 * pack's launcher). Not an ignore list, which names what's kept out, nor a
 * binary, nor Maven's own wrapper (`mvnw`).
 */
export const PUBLIC_TEXT_FILE = new RegExp(
  [
    /\.(ts|tsx|mts|cts|js|mjs|cjs|md|mdx|json|jsonc|ya?ml|toml|py|java|scala|sbt|php|sh|sql|tf|tfvars|hcl|astro|tmpl|liquid|css|xml|properties|txt)$/
      .source,
    /(^|\/)(scripts\/hooks\/[^/]+|kindgiw|kindgiw\.cmd|kindgi-pack-java)$/.source,
  ].join('|'),
);

/**
 * A changelog records what releases said, so it keeps the names and
 * references it was released with; the runtime's own border check skips
 * changelogs too. A changeset is checked: it becomes a changelog's line.
 */
const RELEASE_RECORD = /(^|\/)CHANGELOG\.md$/;

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
const NO_NAMES = loadNames({ salt: '', maxPhrase: 0, tokens: [], allowed: [] });

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
 * never repeats the name. `allowed` terms are blanked out before the
 * markers are tried.
 */
export function scanText(text, { names = NAMES, markers = MARKERS, allowed = [] } = {}) {
  const problems = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const checked = withoutAllowed(line, allowed);
    for (const [re, what] of markers) {
      if (re.test(checked))
        problems.push({ line: i + 1, what, excerpt: line.trim().slice(0, 120) });
    }
    if (nameHits(line, names) > 0) problems.push({ line: i + 1, what: NAME_HIT });
  });
  return problems;
}

/**
 * The problems in a repository file's text (`check-refs.mjs`), as
 * `scanText` reports them: the markers, the file's tracking references
 * (`FILE_ID_MARKERS`, less `ALLOWED_TERMS`) and the names. A changelog
 * gets the markers only.
 */
export function fileTextProblems(file, text, { names = NAMES } = {}) {
  if (RELEASE_RECORD.test(file)) return scanText(text, { names: NO_NAMES });
  return scanText(text, {
    names,
    markers: [...MARKERS, ...FILE_ID_MARKERS],
    allowed: ALLOWED_TERMS.map((t) => t.term),
  });
}
