// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Liquid } from 'liquidjs';

import type { BlockIssue, PromptBlockContent } from './blocks.js';

/**
 * What a drafted prompt template (an improvement pass's candidate) is
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

/** A dotted id (`acme.export`): two or more segments, the first at least two characters. */
const DOTTED_ID = /\b[a-z][a-z0-9_-]+(?:\.[a-z0-9_-]+)+\b/gi;

const liquid = new Liquid();

function rootsOf(template: string): Array<readonly (string | number)[]> {
  return liquid.globalVariableSegmentsSync(template).map((s) => s as readonly (string | number)[]);
}

/**
 * Whether a drafted template may replace the current one, as data: the
 * problems, none when it may. Drafted templates come from a model fed
 * judges' reasons and case data, so a template is held to what the agent
 * already has, whatever the model was told:
 *
 *   - it parses as Liquid;
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
  const issues: BlockIssue[] = [];
  if (candidate.trim() === '') return [{ path: '/template', message: 'the template is empty' }];
  if (candidate === current) {
    return [{ path: '/template', message: 'the template is the current one' }];
  }
  const max = Math.min(DRAFTED_TEMPLATE_MAX, Math.max(2 * current.length, 2000));
  if (candidate.length > max) {
    issues.push({
      path: '/template',
      message: `the template is ${candidate.length} characters; at most ${max} (twice the current one)`,
    });
  }

  let read: Array<readonly (string | number)[]>;
  try {
    read = rootsOf(candidate);
  } catch (cause) {
    issues.push({
      path: '/template',
      message: `the template isn't valid Liquid: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    return issues;
  }
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

  const known = new Set([...context.knownIds, ...(current.match(DOTTED_ID) ?? [])]);
  const newIds = new Set((candidate.match(DOTTED_ID) ?? []).filter((id) => !known.has(id)));
  for (const id of newIds) {
    issues.push({
      path: '/template',
      message: `it names "${id}", which the agent doesn't use (its tools, blocks, or what the current template names)`,
    });
  }
  return issues;
}
