#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The contribution check: an outside contributor's pull request carries
 * what `.claude/skills/kindgi-contributing/SKILL.md` asks for. Changes here
 * are made by a coding agent and supervised by a person:
 *
 *   - the agent: a `Co-Authored-By: <agent> <email>` trailer on one of the
 *     commits (a reply only, not a failure, for now);
 *   - the person: one `Supervised-by: Full Name <email>` line in the body,
 *     not the template's placeholder;
 *   - the checks: a `## Checks` list of `- [x] \`<command>\`: <result>`
 *     lines, with no unticked `- [ ]` left.
 *
 * Only a pull request from a fork is checked: a branch in this repository
 * needs push access, so it's a maintainer's (`fromFork`). It's a norm and a
 * workflow, not security: trailers can be written by hand.
 *
 * Run by `.github/workflows/contribution-check.yml` (`pull_request_target`):
 * it reads the pull request from the event and its commits through the API,
 * and never runs the pull request's code. It comments once, and updates
 * that comment on every run; when it may not comment, the result goes to
 * the job summary and the check fails (`report`). Tests:
 * `scripts/contribution-check.test.mjs`.
 * `CONTRIBUTION_CHECK_DRY_RUN=1` reads through the API but prints the
 * comment instead of posting it (to try it against a real pull request).
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The comment the check owns, found again by this marker. */
export const COMMENT_MARKER = '<!-- kindgi-contribution-check -->';

const SKILL_URL =
  'https://github.com/kindgi/kindgi-sdk/blob/main/.claude/skills/kindgi-contributing/SKILL.md';

/**
 * Whether a pull request (the event's `pull_request`) comes from a fork,
 * an outside contributor's: its head branch lives in another repository.
 * `author_association` can't tell, since a private member of the org shows
 * as `CONTRIBUTOR` in a public repository's events. A fork that was
 * deleted (no head repository) counts as one.
 *
 * @param {{ head?: { repo?: { full_name?: string } | null }, base?: { repo?: { full_name?: string } } }} pr
 */
export function fromFork(pr) {
  const head = pr.head?.repo?.full_name;
  return head === undefined || head !== pr.base?.repo?.full_name;
}

/**
 * What the pull request has and lacks.
 *
 * @param {{ fork: boolean, body: string | null | undefined, commitMessages: readonly string[] }} pr
 */
export function evaluateContribution({ fork, body, commitMessages }) {
  if (!fork) {
    return { applies: false, missing: [], notes: [], failed: false };
  }
  const text = (body ?? '').replace(/\r\n/g, '\n');
  const missing = [];
  const notes = [];

  const person = supervisedBy(text);
  if (person !== undefined) missing.push(person);

  const checks = checksList(text);
  if (checks !== undefined) missing.push(checks);

  if (!commitMessages.some(hasAgentTrailer)) {
    notes.push(
      "**The agent's trailer:** none of the commits has a `Co-Authored-By: <agent> <email>` trailer. The agent that made the change adds it to each commit it wrote.",
    );
  }
  return { applies: true, missing, notes, failed: missing.length > 0 };
}

/** Why the `Supervised-by:` line doesn't count, or `undefined` when it does. */
function supervisedBy(text) {
  const lines = text.split('\n').filter((line) => /^\s*supervised-by\s*:/i.test(line));
  const ask =
    '**The person who supervised it:** add one line `Supervised-by: Full Name <email>` to the description, with the name and email of the person who read the change before it was submitted.';
  if (lines.length === 0) return ask;
  if (lines.length > 1) return `${ask} There are ${lines.length}; keep one.`;
  const match = /^\s*supervised-by\s*:\s*(.+?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/i.exec(lines[0] ?? '');
  if (match === null) return `${ask} The line needs both: \`Supervised-by: Full Name <email>\`.`;
  const [, name, email] = match;
  if (/^your name$/i.test(name ?? '') || /@example\.(com|org)$/i.test(email ?? '')) {
    return `${ask} It still has the template's placeholder.`;
  }
  return undefined;
}

/** Why the `## Checks` list doesn't count, or `undefined` when it does. */
function checksList(text) {
  const ask =
    '**The checks you ran:** a `## Checks` section listing each one as ``- [x] `<command>`: <its result>``. The skill names the checks for what changed.';
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^##\s+checks\s*$/i.test(line.trim()));
  if (start === -1) return ask;
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim()) || /^\s*supervised-by\s*:/i.test(line)) break;
    section.push(line.trim());
  }
  if (section.some((line) => /^[-*]\s+\[\s\]/.test(line))) {
    return `${ask} Some are still unticked (\`- [ ]\`): run them and give their results, or leave out the ones you couldn't run and say so.`;
  }
  const ran = section.filter((line) => /^[-*]\s+\[[xX]\]\s+`[^`]+`\s*:\s*\S/.test(line));
  if (ran.length === 0) return `${ask} The section has none in that form.`;
  return undefined;
}

function hasAgentTrailer(message) {
  return /^co-authored-by:\s*\S.*<[^<>\s]+@[^<>\s]+>\s*$/im.test(message);
}

/** The check's comment for a result that applies. */
export function renderComment(result) {
  const lines = [COMMENT_MARKER];
  if (result.missing.length === 0 && result.notes.length === 0) {
    lines.push(
      '✓ Thanks! This pull request has what the repository asks of a contribution: the checks that were run and the person who supervised it. A maintainer will review it, and CI runs the full suite.',
    );
    return lines.join('\n');
  }
  lines.push(
    result.missing.length > 0
      ? 'Thanks for this pull request! Changes here are made by a coding agent and supervised by a person, and the pull request shows both. Missing so far:'
      : 'Thanks for this pull request! One thing to add:',
    '',
    ...result.missing.map((item) => `- ${item}`),
    ...result.notes.map((item) => `- ${item}`),
    '',
    `How to: the [\`kindgi-contributing\` skill](${SKILL_URL}) (your coding agent can follow it). This check runs again when the description is edited or a commit is pushed.`,
  );
  return lines.join('\n');
}

/**
 * Comment on the pull request and exit as the result says. When the token
 * may not comment (403: the workflow's permissions, or the org capping
 * them), the result goes to the job summary and the check fails, so an
 * outside contributor's pull request never fails silently.
 *
 * @param {{ failed: boolean }} result
 * @param {string} body the comment
 * @param {{ comment: (body: string) => Promise<void>, summary: (text: string) => void }} io
 * @returns {Promise<number>} the exit code
 */
export async function report(result, body, io) {
  try {
    await io.comment(body);
  } catch (err) {
    if (err?.status !== 403) throw err;
    io.summary(
      `${body}\n\n---\n\nThis check couldn't comment on the pull request (403: the workflow's token may not), so the result is here, and the check fails until it can.\n`,
    );
    console.log("Couldn't comment on the pull request (403): the result is in the job summary.");
    return 1;
  }
  return result.failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The run, in GitHub Actions
// ---------------------------------------------------------------------------

async function api(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
    },
  });
  if (!response.ok) {
    const err = new Error(
      `${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`,
    );
    err.status = response.status;
    throw err;
  }
  return response.status === 204 ? undefined : response.json();
}

/** Every page of a list endpoint. */
async function all(path) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
  const pr = event.pull_request;
  const repo = process.env.GITHUB_REPOSITORY;
  const commits = await all(`/repos/${repo}/pulls/${pr.number}/commits`);
  const result = evaluateContribution({
    fork: fromFork(pr),
    body: pr.body,
    commitMessages: commits.map((c) => c.commit.message),
  });
  if (!result.applies) {
    console.log("A branch of this repository: a maintainer's pull request; nothing to check.");
    return 0;
  }
  const body = renderComment(result);
  if (process.env.CONTRIBUTION_CHECK_DRY_RUN === '1') {
    console.log(`Dry run: the comment would be:\n${body}`);
    return result.failed ? 1 : 0;
  }
  for (const item of [...result.missing, ...result.notes]) console.log(`- ${item}`);
  console.log(
    result.failed
      ? 'The contribution format is incomplete (see the comment on the pull request).'
      : 'The contribution format is complete.',
  );
  return report(result, body, {
    comment: async (text) => {
      const comments = await all(`/repos/${repo}/issues/${pr.number}/comments`);
      const mine = comments.find(
        (c) => typeof c.body === 'string' && c.body.startsWith(COMMENT_MARKER),
      );
      if (mine === undefined) {
        await api(`/repos/${repo}/issues/${pr.number}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body: text }),
        });
      } else if (mine.body !== text) {
        await api(`/repos/${repo}/issues/comments/${mine.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ body: text }),
        });
      }
    },
    summary: (text) => {
      const file = process.env.GITHUB_STEP_SUMMARY;
      if (file === undefined || file === '') console.log(text);
      else appendFileSync(file, text);
    },
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
