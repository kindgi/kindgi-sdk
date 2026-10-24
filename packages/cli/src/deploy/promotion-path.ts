// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi deploy` into a later environment of an environment order is
 * refused (`409 environment-takes-promotions`): a build enters the order at
 * its first environment and moves on one environment at a time, by
 * promotion. This names each environment on the way, so the hint can print
 * each `kindgi promote` to run.
 */

import { envNamesByProject } from '../env-projects.js';
import type { EnvironmentOrderRow, ProjectRow } from './runners.js';

/** One environment a build goes through on its way to the refused one. */
export type PromotionStop =
  /** An environment of the pack config. */
  | { readonly kind: 'env'; readonly name: string }
  /** A project no environment of the pack config names. */
  | { readonly kind: 'project'; readonly name: string }
  /** A project the caller can't read. */
  | { readonly kind: 'hidden' };

/**
 * The environments from the order's first (`firstProjectId`) to the one at
 * `position`, the refused one, each named from the pack config where it
 * names one. `undefined` when no listed order starts at `firstProjectId`, or
 * that order has no environment at `position`.
 */
export function promotionPath(input: {
  readonly firstProjectId: string;
  readonly position: number;
  readonly orders: readonly EnvironmentOrderRow[];
  readonly projects: readonly ProjectRow[];
  readonly environments: readonly { readonly name: string; readonly ref: string }[];
}): readonly PromotionStop[] | undefined {
  const order = input.orders
    .map((o) => [...o.entries].sort((a, b) => a.position - b.position))
    .find((entries) => entries[0]?.projectId === input.firstProjectId);
  if (order === undefined || order.length <= input.position) return undefined;
  const envNames = envNamesByProject(input.environments, input.projects);
  const projects = new Map(input.projects.map((p) => [p.id, p]));
  return order.slice(0, input.position + 1).map((entry): PromotionStop => {
    if (entry.projectId === undefined) return { kind: 'hidden' };
    const env = envNames.get(entry.projectId);
    if (env !== undefined) return { kind: 'env', name: env };
    return { kind: 'project', name: projects.get(entry.projectId)?.name ?? entry.projectId };
  });
}

/**
 * The hint for that refusal: where the build goes instead, and each
 * `kindgi promote` from there, one line each so they copy whole. Without a
 * path (the first environment is one the caller can't read, or the reads
 * failed), the rule and where to look the order up.
 */
export function promotionHint(path: readonly PromotionStop[] | undefined): {
  readonly text: string;
  readonly commands: readonly string[];
} {
  const first = path?.[0];
  const target = path?.[path.length - 1];
  if (path === undefined || first === undefined || target === undefined || path.length < 2) {
    return {
      text:
        'A build enters an environment order at its first environment and moves on one ' +
        'environment at a time, by promotion. Deploy into the first environment, then ' +
        'promote the build from there, one `kindgi promote --from=<environment> --to=<the next one>` ' +
        'at a time. `kindgi environments list` shows the order.',
      commands: [],
    };
  }
  const commands: string[] = [];
  for (let i = 1; i < path.length; i += 1) {
    commands.push(
      `kindgi promote --from=${flagValue(path[i - 1] as PromotionStop)} --to=${flagValue(path[i] as PromotionStop)}`,
    );
  }
  const unnamed = path.flatMap((s) => (s.kind === 'project' ? [s.name] : []));
  const sentences = [
    `Builds reach ${prose(target)} only by promotion from the environment before it.`,
    `A build enters its environment order at ${prose(first)}, the first environment: deploy there, then promote the build one environment at a time.`,
  ];
  if (unnamed.length > 0) {
    sentences.push(
      `Your pack config names no environment for ${unnamed.length === 1 ? 'project' : 'projects'} ${unnamed.join(', ')}: add one, with its \`project\`, to promote through it.`,
    );
  }
  if (path.some((s) => s.kind === 'hidden')) {
    sentences.push('`kindgi environments list` shows the order, as far as you can read it.');
  }
  const text = sentences.join(' ');
  return { text, commands };
}

/** A stop in the hint's sentences. */
function prose(stop: PromotionStop): string {
  if (stop.kind === 'env') return stop.name;
  if (stop.kind === 'project') return `project ${stop.name}`;
  return "a project you can't read";
}

/** A stop as `kindgi promote`'s `--from` / `--to`: an environment's name, else a placeholder. */
function flagValue(stop: PromotionStop): string {
  if (stop.kind === 'env') return stop.name;
  if (stop.kind === 'project') return `<the environment for project ${stop.name}>`;
  return '<the next environment>';
}
