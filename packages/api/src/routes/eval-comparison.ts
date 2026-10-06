// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId } from '@kindgi/agents';
import type { ProjectId, Semver } from '@kindgi/types';

import type { EvalBaseline, EvalComparison } from '../eval-run-binding.js';
import { DEFAULT_COMPARISON } from '../judged-dispatcher.js';

const MAX_REPETITIONS = 10;
const MAX_K = 100;

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseLive(raw: unknown): EvalBaseline | string {
  const live = obj(raw);
  if (live === undefined) return '`baseline.live` must be an object';
  const segments = live.segments === undefined ? undefined : obj(live.segments);
  const stringsOnly =
    segments !== undefined && Object.values(segments).every((v) => typeof v === 'string');
  if (live.segments !== undefined && !stringsOnly) {
    return '`baseline.live.segments` must be an object of strings';
  }
  if (live.projectId !== undefined && typeof live.projectId !== 'string') {
    return '`baseline.live.projectId` must be a string';
  }
  return {
    live: {
      ...(typeof live.projectId === 'string' && { projectId: live.projectId as ProjectId }),
      ...(segments !== undefined && { segments: segments as Record<string, string> }),
    },
  };
}

function parseBaseline(raw: unknown): EvalBaseline | string {
  if (raw === 'recorded') return 'recorded';
  const o = obj(raw);
  if (o === undefined) {
    return "`baseline` must be 'recorded', { agentId, version } or { live: { projectId?, segments? } }";
  }
  if (o.live !== undefined) return parseLive(o.live);
  if (typeof o.agentId !== 'string' || o.agentId === '' || typeof o.version !== 'string') {
    return '`baseline` as a version needs `agentId` and `version`';
  }
  return { agentId: o.agentId as AgentId, version: o.version as Semver };
}

function integerIn(raw: unknown, name: string, max: number): number | string {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= max
    ? raw
    : `\`${name}\` must be an integer from 1 to ${max}`;
}

/**
 * A comparison eval run's settings from the start body: `baseline`,
 * `reads`, `repetitions` and `k`. `undefined` when none is given (the
 * defaults apply); an error message for a bad one.
 */
export function parseComparison(
  b: Readonly<Record<string, unknown>>,
):
  | { readonly kind: 'ok'; readonly value?: EvalComparison }
  | { readonly kind: 'err'; readonly message: string } {
  const { baseline, reads, repetitions, k } = b;
  if (
    baseline === undefined &&
    reads === undefined &&
    repetitions === undefined &&
    k === undefined
  ) {
    return { kind: 'ok' };
  }
  const parsedBaseline =
    baseline === undefined ? DEFAULT_COMPARISON.baseline : parseBaseline(baseline);
  if (typeof parsedBaseline === 'string' && parsedBaseline !== 'recorded') {
    return { kind: 'err', message: parsedBaseline };
  }
  if (reads !== undefined && reads !== 'recorded' && reads !== 'live') {
    return { kind: 'err', message: "`reads` must be 'recorded' or 'live'" };
  }
  const reps =
    repetitions === undefined
      ? DEFAULT_COMPARISON.repetitions
      : integerIn(repetitions, 'repetitions', MAX_REPETITIONS);
  if (typeof reps === 'string') return { kind: 'err', message: reps };
  const topK = k === undefined ? DEFAULT_COMPARISON.k : integerIn(k, 'k', MAX_K);
  if (typeof topK === 'string') return { kind: 'err', message: topK };
  return {
    kind: 'ok',
    value: {
      baseline: parsedBaseline,
      reads: reads ?? DEFAULT_COMPARISON.reads,
      repetitions: reps,
      k: topK,
    },
  };
}
