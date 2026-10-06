// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { REVIEWER_ROLE_RANK, type ReviewerRole } from '@kindgi/authz';

import { GATE_METRICS, type GateMetricSpec, type GatePolicySpec } from '../gate-policy-binding.js';

/**
 * A gate policy's `spec`, checked strictly: an unknown key is an issue, so
 * a typo can't leave a check silently off.
 */

export interface SpecIssue {
  readonly path: string;
  readonly message: string;
}

type Raw = Readonly<Record<string, unknown>>;

const REVIEWER_ROLES = Object.keys(REVIEWER_ROLE_RANK) as readonly ReviewerRole[];

const isObject = (v: unknown): v is Raw => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Keys the policy may not use yet, with why. */
const LATER: Readonly<Record<string, string>> = {
  '/spec/approvals/count': 'one reviewer decides a promotion today; leave `count` out',
  '/spec/approvals/forRollback': "rollbacks aren't gated yet; leave `forRollback` out",
};

function unknownKeys(raw: Raw, allowed: readonly string[], at: string, issues: SpecIssue[]) {
  for (const key of Object.keys(raw)) {
    if (allowed.includes(key)) continue;
    const path = `${at}/${key}`;
    issues.push({
      path,
      message:
        LATER[path] ??
        `\`${key}\` isn't a gate policy setting here (expected: ${allowed.join(', ')})`,
    });
  }
}

/** A number in [min, max], when present. */
function num(
  raw: Raw,
  key: string,
  at: string,
  issues: SpecIssue[],
  opts: { min: number; max?: number; integer?: boolean; positive?: boolean },
): number | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  const ok =
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= opts.min &&
    (opts.max === undefined || v <= opts.max) &&
    (opts.integer !== true || Number.isInteger(v)) &&
    (opts.positive !== true || v > 0);
  if (!ok) {
    const range = opts.max === undefined ? `at least ${opts.min}` : `${opts.min} to ${opts.max}`;
    issues.push({
      path: `${at}/${key}`,
      message: `\`${key}\` must be ${opts.integer === true ? 'a whole number' : 'a number'}, ${opts.positive === true ? 'above 0' : range}`,
    });
    return undefined;
  }
  return v as number;
}

function bool(raw: Raw, key: string, at: string, issues: SpecIssue[]): boolean | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') {
    issues.push({ path: `${at}/${key}`, message: `\`${key}\` must be true or false` });
    return undefined;
  }
  return v;
}

function block(raw: Raw, key: string, issues: SpecIssue[]): Raw | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (!isObject(v)) {
    issues.push({ path: `/spec/${key}`, message: `\`${key}\` must be an object` });
    return undefined;
  }
  return v;
}

export function parseGatePolicySpec(
  raw: unknown,
): { kind: 'ok'; spec: GatePolicySpec } | { kind: 'err'; issues: readonly SpecIssue[] } {
  if (!isObject(raw)) {
    return { kind: 'err', issues: [{ path: '/spec', message: '`spec` must be an object' }] };
  }
  const issues: SpecIssue[] = [];
  unknownKeys(raw, ['comparison', 'evidence', 'metrics', 'replay', 'approvals'], '/spec', issues);
  const spec: {
    -readonly [K in keyof GatePolicySpec]: GatePolicySpec[K];
  } = {};

  const comparison = block(raw, 'comparison', issues);
  if (comparison !== undefined) {
    const at = '/spec/comparison';
    unknownKeys(comparison, ['maxAgeHours', 'suite'], at, issues);
    const maxAgeHours = num(comparison, 'maxAgeHours', at, issues, { min: 0, positive: true });
    let suite: { id: string; version?: string } | undefined;
    if (comparison.suite !== undefined) {
      const s = comparison.suite;
      if (!isObject(s) || typeof s.id !== 'string' || s.id === '') {
        issues.push({ path: `${at}/suite`, message: '`suite` must be `{ id, version? }`' });
      } else {
        unknownKeys(s, ['id', 'version'], `${at}/suite`, issues);
        if (s.version !== undefined && (typeof s.version !== 'string' || s.version === '')) {
          issues.push({ path: `${at}/suite/version`, message: '`version` must be a version' });
        }
        suite = { id: s.id, ...(typeof s.version === 'string' && { version: s.version }) };
      }
    }
    spec.comparison = {
      ...(maxAgeHours !== undefined && { maxAgeHours }),
      ...(suite !== undefined && { suite }),
    };
  }

  const evidence = block(raw, 'evidence', issues);
  if (evidence !== undefined) {
    const at = '/spec/evidence';
    unknownKeys(evidence, ['minCases', 'minWeight'], at, issues);
    const minCases = num(evidence, 'minCases', at, issues, { min: 0, integer: true });
    const minWeight = num(evidence, 'minWeight', at, issues, { min: 0 });
    spec.evidence = {
      ...(minCases !== undefined && { minCases }),
      ...(minWeight !== undefined && { minWeight }),
    };
  }

  if (raw.metrics !== undefined) {
    if (!Array.isArray(raw.metrics)) {
      issues.push({ path: '/spec/metrics', message: '`metrics` must be a list' });
    } else {
      const metrics: GateMetricSpec[] = [];
      const seen = new Set<string>();
      raw.metrics.forEach((m: unknown, i: number) => {
        const at = `/spec/metrics/${i}`;
        const before = issues.length;
        if (!isObject(m)) {
          issues.push({ path: at, message: 'each metric must be an object' });
          return;
        }
        unknownKeys(m, ['name', 'k', 'minCandidate', 'maxDrop'], at, issues);
        const name = m.name;
        if (typeof name !== 'string' || !(GATE_METRICS as readonly string[]).includes(name)) {
          issues.push({
            path: `${at}/name`,
            message: `\`name\` must be one of: ${GATE_METRICS.join(', ')}`,
          });
          return;
        }
        if (seen.has(name)) {
          issues.push({ path: `${at}/name`, message: `\`${name}\` is gated twice` });
          return;
        }
        seen.add(name);
        if (m.k !== undefined && name !== 'weightedPrecisionAtK') {
          issues.push({ path: `${at}/k`, message: '`k` applies to `weightedPrecisionAtK` only' });
        }
        const k = num(m, 'k', at, issues, { min: 1, max: 100, integer: true });
        const minCandidate = num(m, 'minCandidate', at, issues, { min: 0, max: 1 });
        const maxDrop = num(m, 'maxDrop', at, issues, { min: 0, max: 1 });
        if (minCandidate === undefined && maxDrop === undefined && issues.length === before) {
          issues.push({
            path: at,
            message: `\`${name}\` needs \`minCandidate\`, \`maxDrop\` or both: what it must reach`,
          });
        }
        metrics.push({
          name: name as GateMetricSpec['name'],
          ...(k !== undefined && { k }),
          ...(minCandidate !== undefined && { minCandidate }),
          ...(maxDrop !== undefined && { maxDrop }),
        });
      });
      spec.metrics = metrics;
    }
  }

  const replay = block(raw, 'replay', issues);
  if (replay !== undefined) {
    const at = '/spec/replay';
    const knobs = ['maxDiverged', 'maxErrors', 'maxRefusedWrites', 'maxStopped'] as const;
    unknownKeys(replay, knobs, at, issues);
    const out: { -readonly [K in (typeof knobs)[number]]?: number } = {};
    for (const knob of knobs) {
      const v = num(replay, knob, at, issues, { min: 0, integer: true });
      if (v !== undefined) out[knob] = v;
    }
    spec.replay = out;
  }

  const approvals = block(raw, 'approvals', issues);
  if (approvals !== undefined) {
    const at = '/spec/approvals';
    unknownKeys(approvals, ['role', 'separateApprover'], at, issues);
    const role = approvals.role;
    if (role !== undefined && !(REVIEWER_ROLES as readonly unknown[]).includes(role)) {
      issues.push({
        path: `${at}/role`,
        message: `\`role\` must be one of: ${REVIEWER_ROLES.join(', ')}`,
      });
    }
    const separateApprover = bool(approvals, 'separateApprover', at, issues);
    spec.approvals = {
      ...(typeof role === 'string' && { role: role as ReviewerRole }),
      ...(separateApprover !== undefined && { separateApprover }),
    };
  }

  return issues.length > 0 ? { kind: 'err', issues } : { kind: 'ok', spec };
}
