#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The model adapters' tests against a candidate release of an AI SDK
 * package we pin (`.github/workflows/ai-sdk-candidate.yml`). The
 * candidates come in `CANDIDATES`, space-separated `<package>@<version>`
 * pairs, never interpolated into a shell:
 *
 * - `validate`: every candidate is a package an adapter pins (`@ai-sdk/*`
 *   in `packages/adapters/<name>/package.json` dependencies), at a stable
 *   version (`<major>.<minor>.<patch>`, no pre-release), at most once.
 *   Anything else exits 1 before the candidates are used.
 * - `apply`: each pin moves to its candidate version, in place, in every
 *   adapter that pins it.
 * - `report`: the adapters' vitest JSON results (`REPORTS_DIR`) become
 *   `result.json` (`{ candidates, passed, failed: [{ file, test }] }`), and a
 *   summary for the run's page (`GITHUB_STEP_SUMMARY`).
 *
 * Usage: `CANDIDATES='@ai-sdk/amazon-bedrock@5.0.120' node scripts/ai-sdk-candidate.mjs validate|apply|report`
 */

import { appendFileSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTERS = join('packages', 'adapters');
const MAX_CANDIDATES = 10;
const CANDIDATE = /^(@ai-sdk\/[a-z0-9][a-z0-9-]*)@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Each adapter's `package.json` path, with the `@ai-sdk/*` packages it pins and their versions. */
export function adapterPins(root = '.') {
  const dir = join(root, ADAPTERS);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(dir, d.name, 'package.json'))
    .flatMap((path) => {
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return [];
      }
      const pins = Object.entries(manifest.dependencies ?? {}).filter(([name]) =>
        name.startsWith('@ai-sdk/'),
      );
      return pins.length === 0 ? [] : [{ path, pins: Object.fromEntries(pins) }];
    });
}

/**
 * The candidates in `text`, or every problem with them. A candidate is a
 * pinned package (`allowed`) at a stable version, named once.
 */
export function parseCandidates(text, allowed) {
  const tokens = (text ?? '').split(/\s+/).filter((t) => t.length > 0);
  const problems = [];
  if (tokens.length === 0) problems.push('no candidates: give `<package>@<version>` pairs');
  if (tokens.length > MAX_CANDIDATES) problems.push(`at most ${MAX_CANDIDATES} candidates`);
  const candidates = [];
  const seen = new Set();
  for (const token of tokens.slice(0, MAX_CANDIDATES)) {
    const match = CANDIDATE.exec(token);
    if (match === null) {
      problems.push(
        `"${printable(token)}" isn't \`@ai-sdk/<name>@<major>.<minor>.<patch>\` (a stable version)`,
      );
      continue;
    }
    const [, name] = match;
    const version = token.slice(name.length + 1);
    if (!allowed.has(name)) {
      problems.push(`${name} isn't pinned by a model adapter (${[...allowed].sort().join(', ')})`);
      continue;
    }
    if (seen.has(name)) {
      problems.push(`${name} is named twice`);
      continue;
    }
    seen.add(name);
    candidates.push({ name, version });
  }
  return problems.length > 0 ? { kind: 'err', problems } : { kind: 'ok', candidates };
}

/** A token as it may be printed: no control characters, at most 80 characters. */
function printable(token) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const clean = token.replace(/[\u0000-\u001f\u007f]/g, '?');
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}

/**
 * Move each candidate's pin to its version in `text` (a `package.json`),
 * in place: only the `"<name>": "<version>"` text changes, so the file's
 * layout stays as it was.
 */
export function applyToManifest(text, candidates) {
  let out = text;
  for (const { name, version } of candidates) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    out = out.replace(new RegExp(`("${escaped}"\\s*:\\s*")[^"]*(")`), `$1${version}$2`);
  }
  return out;
}

/** One vitest file result's failures: each failed test, or the file itself when it ran none. */
function failuresOf(file) {
  const assertions = file.assertionResults ?? [];
  if (assertions.length === 0) {
    return file.status === 'failed'
      ? [{ file: file.name, test: file.message ?? 'the file failed to run' }]
      : [];
  }
  return assertions
    .filter((a) => a.status === 'failed')
    .map((a) => ({ file: file.name, test: a.fullName ?? a.title }));
}

/** The adapters' vitest JSON reports, as the run's result. */
export function summarize(candidates, reports) {
  const files = reports.flatMap((r) => r.testResults ?? []);
  const tests = files.reduce((n, f) => n + (f.assertionResults ?? []).length, 0);
  const failed = files.flatMap(failuresOf);
  return { candidates, passed: reports.length > 0 && failed.length === 0, tests, failed };
}

function applyCandidates(pins, candidates) {
  for (const { path, pins: pinned } of pins) {
    const mine = candidates.filter((c) => c.name in pinned);
    if (mine.length === 0) continue;
    writeFileSync(path, applyToManifest(readFileSync(path, 'utf8'), mine));
    for (const c of mine) console.log(`${path}: ${c.name} ${pinned[c.name]} → ${c.version}`);
  }
  return 0;
}

function readReports(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'result.json')
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  } catch {
    return [];
  }
}

function report(candidates, env) {
  const dir = env.REPORTS_DIR ?? '.ai-sdk-candidate';
  const result = summarize(candidates, readReports(dir));
  writeFileSync(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    `## AI SDK candidate: ${result.passed ? 'the adapters pass' : 'the adapters fail'}`,
    '',
    ...candidates.map((c) => `- \`${c.name}@${c.version}\``),
    '',
    `${result.tests} tests, ${result.failed.length} failed.`,
    ...result.failed.slice(0, 50).map((f) => `- ${f.file}: ${f.test}`),
  ];
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  return result.passed ? 0 : 1;
}

function main(argv, env) {
  const command = argv[0];
  if (!['validate', 'apply', 'report'].includes(command)) {
    console.error('ai-sdk-candidate: usage: validate | apply | report');
    return 2;
  }
  const pins = adapterPins();
  const parsed = parseCandidates(env.CANDIDATES, new Set(pins.flatMap((p) => Object.keys(p.pins))));
  if (parsed.kind === 'err') {
    for (const p of parsed.problems) console.error(`ai-sdk-candidate: ${p}`);
    return 1;
  }
  if (command === 'apply') return applyCandidates(pins, parsed.candidates);
  if (command === 'report') return report(parsed.candidates, env);
  for (const c of parsed.candidates) console.log(`candidate ${c.name}@${c.version}`);
  return 0;
}

if (realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
