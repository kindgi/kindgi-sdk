// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { BlockIssue, PromptBlockContent } from './blocks.js';
import { isLetter, isSegmentChar, startsWord } from './char-class.js';
import { templateProblem, tenantLiquid } from './liquid.js';

/**
 * What a drafted prompt template (an Improve run's candidate) is
 * checked against: the template it would replace, and what the agent
 * version already has.
 */
export interface DraftedTemplateContext {
  /** The prompt block content the version pins: the template, and its parameters. */
  readonly current: PromptBlockContent;
  /** The settings blocks the version pins: `settings["<id>"]` may read these. */
  readonly settingsBlocks: readonly string[];
  /** The ids the agent already uses (its own, its tools', its blocks'): a template may name these. */
  readonly knownIds: readonly string[];
}

/** The most a drafted template may be: twice the current one, at least 2,000 characters. */
export const DRAFTED_TEMPLATE_MAX = 20_000;

/** Variables any template may read: the turn's clock and identity. */
const HARMLESS_VARS: ReadonlySet<string> = new Set(['today', 'now', 'agent', 'conversation']);

/** A dotted id's segments after its first, from its first `.`, to a word's end. */
const ID_TAIL = /(?:\.[a-z0-9_-]+)+\b/iy;

function rootsOf(template: string): Array<readonly (string | number)[]> {
  return tenantLiquid()
    .globalVariableSegmentsSync(template)
    .map((s) => s as readonly (string | number)[]);
}

/**
 * The dotted ids `text` names (`acme.export`): two or more segments, the
 * first at least two characters and starting with a letter. These are the
 * matches of `/\b[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b/gi`, found in time in
 * step with the text's length. That pattern tries an id from every word's
 * start, and a `-` inside a segment starts a word, so its time grows with the
 * square of a long run of segment characters.
 *
 * From each `.`, the first segment is walked back once, no further than the
 * last id's end. Every start in that run meets the same `.` and the same
 * rest, so an id starts at the run's leftmost letter with a word break before
 * it: the one that leaves the most for the first segment.
 */
export function dottedIds(text: string): string[] {
  const ids: string[] = [];
  let last = 0;
  let dot = text.indexOf('.');
  while (dot !== -1) {
    let start = dot;
    while (start > last && isSegmentChar(text.charCodeAt(start - 1))) start--;
    while (start < dot - 1 && !(isLetter(text.charCodeAt(start)) && startsWord(text, start))) {
      start++;
    }
    ID_TAIL.lastIndex = dot;
    const tail = start < dot - 1 ? ID_TAIL.exec(text) : null;
    if (tail === null) {
      dot = text.indexOf('.', dot + 1);
      continue;
    }
    last = dot + tail[0].length;
    ids.push(text.slice(start, last));
    dot = text.indexOf('.', last);
  }
  return ids;
}

/**
 * Whether a drafted template may replace the current one, as data: the
 * problems, none when it may. Drafted templates come from a model fed
 * judges' reasons and case data, so a template is held to what the agent
 * already has, whatever the model was told:
 *
 *   - it passes the check every template passes (`templateProblem`):
 *     Liquid the renderer parses, no partials, within the bounds;
 *   - the variables it reads are the declared parameters, the variables
 *     the current template reads, the turn's clock and identity, and
 *     `settings["<id>"]` of a settings block the version pins;
 *   - the dotted ids it names (`acme.export`, say) are the agent's own,
 *     its tools' and blocks', or ones the current template names: no new
 *     tool, agent or data reference;
 *   - it isn't empty or the current template, and at most twice as long
 *     as it (at least 2,000 characters; never over `DRAFTED_TEMPLATE_MAX`).
 */
export function checkDraftedTemplate(
  candidate: string,
  context: DraftedTemplateContext,
): BlockIssue[] {
  const current = context.current.template;
  if (candidate.trim() === '') return [{ path: '/template', message: 'the template is empty' }];
  if (candidate === current) {
    return [{ path: '/template', message: 'the template is the current one' }];
  }
  // Too long is refused before it's parsed.
  const max = Math.min(DRAFTED_TEMPLATE_MAX, Math.max(2 * current.length, 2000));
  if (candidate.length > max) {
    return [
      {
        path: '/template',
        message: `the template is ${candidate.length} characters; at most ${max} (twice the current one)`,
      },
    ];
  }
  const problem = templateProblem(candidate);
  if (problem !== undefined) return [{ path: '/template', message: problem }];

  const issues: BlockIssue[] = [];
  const read = rootsOf(candidate);
  const parameters = new Set((context.current.parameters ?? []).map((p) => p.name));
  let currentRoots: Set<string>;
  try {
    currentRoots = new Set(rootsOf(current).map((s) => String(s[0])));
  } catch {
    currentRoots = new Set();
  }
  const settingsBlocks = new Set(context.settingsBlocks);
  const named = new Set<string>();
  for (const segments of read) {
    const root = String(segments[0]);
    if (root === 'settings') {
      const block = segments[1];
      if (block === undefined || !settingsBlocks.has(String(block))) {
        named.add(`settings${block === undefined ? '' : `["${String(block)}"]`}`);
      }
      continue;
    }
    if (parameters.has(root) || currentRoots.has(root) || HARMLESS_VARS.has(root)) continue;
    named.add(root);
  }
  for (const variable of named) {
    issues.push({
      path: '/template',
      message: `it reads "${variable}", which the agent doesn't have (a declared parameter, a variable the current template reads, or a settings block the version pins)`,
    });
  }

  const known = new Set([...context.knownIds, ...dottedIds(current)]);
  const newIds = new Set(dottedIds(candidate).filter((id) => !known.has(id)));
  for (const id of newIds) {
    issues.push({
      path: '/template',
      message: `it names "${id}", which the agent doesn't use (its tools, blocks, or what the current template names)`,
    });
  }
  return issues;
}
