// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { rename, writeFile } from 'node:fs/promises';

import { flowGraphProblem } from '@kindgi/flow';

/** A file error or a warning, in the indexers' own form. */
export interface IndexProblem {
  readonly code: string;
  readonly message: string;
  readonly filePath?: string;
}

/** What `judgeFlowGraphs` found in an index. */
export interface FlowGraphFindings {
  /** The index without the flows that failed, or the same index when none did. */
  readonly index: unknown;
  /** How many flows failed and were dropped from `index`. */
  readonly dropped: number;
  /** One `manifest-validation-failed` per dropped flow. */
  readonly fileErrors: readonly IndexProblem[];
  /** One `flow-not-checked` per flow whose shape this CLI doesn't know. */
  readonly warnings: readonly IndexProblem[];
}

/**
 * `loadFlow`'s graph checks (`flowGraphProblem`) on every flow in an
 * index: ids, edges between steps that exist, the edge from `$start`, no
 * cycles, loop bodies, policies and mappings. A Python, Java or Scala
 * pack's indexer checks a flow against the schema only, so a flow with a
 * cycle would otherwise index cleanly, and then hang or skip a step when
 * it runs. A TypeScript pack's flows went through `loadFlow` when they
 * were indexed, so nothing is found there.
 *
 * A flow that fails becomes a file error in the indexers' own form
 * (`<module>: flow '<id>' is invalid: <loader code>: <message>`, code
 * `manifest-validation-failed`) and is dropped from the index, as an
 * indexer drops a flow whose schema fails. A flow whose shape this CLI
 * doesn't know (an unknown node kind, from a newer SDK) isn't judged: it
 * stays, with a warning. Throws `SchemaCompileBudgetError`, as `loadFlow`
 * does.
 */
export function judgeFlowGraphs(index: unknown): FlowGraphFindings {
  const unchanged: FlowGraphFindings = { index, dropped: 0, fileErrors: [], warnings: [] };
  if (!isRecord(index) || !Array.isArray(index.flows)) return unchanged;
  const kept: unknown[] = [];
  const fileErrors: IndexProblem[] = [];
  const warnings: IndexProblem[] = [];
  for (const flow of index.flows) {
    const checked = flowGraphProblem(flow);
    const { id, modulePath } = namesOf(flow);
    const at = modulePath !== undefined ? `${modulePath}: ` : '';
    const where = modulePath !== undefined ? { filePath: modulePath } : {};
    if (checked.kind === 'err') {
      fileErrors.push({
        code: 'manifest-validation-failed',
        message: `${at}flow '${id}' is invalid: ${checked.error.code}: ${checked.error.message}`,
        ...where,
      });
      continue;
    }
    if (checked.kind === 'not-judged') {
      warnings.push({
        code: 'flow-not-checked',
        message: `${at}flow '${id}' was not checked: it has a shape this CLI doesn't know (${checked.reason})`,
        ...where,
      });
    }
    kept.push(flow);
  }
  if (fileErrors.length === 0) return { ...unchanged, warnings };
  return { index: { ...index, flows: kept }, dropped: fileErrors.length, fileErrors, warnings };
}

/**
 * Write `index` to `path` as the TypeScript indexer writes one: keys
 * sorted, two-space indent, a final newline, through a temporary file
 * renamed into place.
 */
export async function writeIndexFile(path: string, index: unknown): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(sortedKeys(index), null, 2)}\n`, 'utf8');
  await rename(tmpPath, path);
}

function namesOf(flow: unknown): { readonly id: string; readonly modulePath?: string } {
  if (!isRecord(flow)) return { id: '?' };
  const id = typeof flow.id === 'string' ? flow.id : '?';
  return typeof flow.modulePath === 'string' ? { id, modulePath: flow.modulePath } : { id };
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortedKeys(value[key]);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
