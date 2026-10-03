// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Local integrity gate — the single most important step in the deploy
 * pipeline for an auditable deployment.
 * The CLI does not trust the build service; before signing, it must
 * verify byte-for-byte that the server's `index.json` matches what the
 * CLI's own indexer produced against the same source.
 *
 * Two comparison paths — the CLI runs both (or a subset via
 * `--skip-*` flags):
 *
 *   1. **Hash comparison** — sha256 of the CLI's expected-index.json
 *      MUST equal `indexHash` from the server's terminal payload.
 *      Cheap (no docker daemon needed) and catches most tampering.
 *
 *   2. **Docker-pull-and-diff** — pull `imageRef@imageDigest`, extract
 *      `/app/index.json` from the image via `docker create/cp/rm`
 *      (mirror of `packages/build-server/src/docker-wrapper.ts:
 *      extractFileFromImage`), byte-compare against expected. Requires
 *      Docker on the developer's machine. Skippable via
 *      `--skip-image-pull` for CI environments without Docker.
 *
 * Both diffs failing → abort deploy; print a helpful diff line
 * identifying what changed. The CLI refuses to sign a mismatched
 * build.
 */

/** Fixed-width string diff — a hex-safe first-diff-byte report. */
export interface ByteDiff {
  readonly offset: number;
  readonly expected: string;
  readonly actual: string;
  readonly context: string;
}

export function firstByteDiff(expected: Uint8Array, actual: Uint8Array): ByteDiff | null {
  const min = Math.min(expected.length, actual.length);
  for (let i = 0; i < min; i += 1) {
    if (expected[i] !== actual[i]) {
      return {
        offset: i,
        expected: `0x${(expected[i] ?? 0).toString(16).padStart(2, '0')}`,
        actual: `0x${(actual[i] ?? 0).toString(16).padStart(2, '0')}`,
        context: renderContext(expected, actual, i),
      };
    }
  }
  if (expected.length !== actual.length) {
    return {
      offset: min,
      expected: `<length ${expected.length}>`,
      actual: `<length ${actual.length}>`,
      context:
        expected.length > actual.length
          ? 'server bytes truncated relative to expected'
          : 'server bytes longer than expected',
    };
  }
  return null;
}

function renderContext(a: Uint8Array, b: Uint8Array, offset: number): string {
  const start = Math.max(0, offset - 32);
  const end = Math.min(Math.max(a.length, b.length), offset + 32);
  const toStr = (buf: Uint8Array): string => {
    let out = '';
    for (let i = start; i < Math.min(buf.length, end); i += 1) {
      const c = buf[i];
      if (c === undefined) break;
      out += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
    }
    return out;
  };
  return `expected: "${toStr(a)}" | actual: "${toStr(b)}"`;
}

export interface IntegrityCheckInputs {
  readonly expectedBytes: Uint8Array;
  readonly expectedHash: string;
  readonly serverReportedHash: string;
  readonly serverBytes?: Uint8Array;
}

export interface IntegrityCheckResult {
  readonly ok: boolean;
  readonly hashMatches: boolean;
  readonly byteDiff: ByteDiff | null;
  readonly reason?: string;
}

/**
 * Run the two-diff comparison. `serverBytes` optional — when omitted
 * (CI or `--skip-image-pull`), only the hash comparison runs.
 */
export function checkIntegrity(inputs: IntegrityCheckInputs): IntegrityCheckResult {
  const hashMatches = inputs.expectedHash === inputs.serverReportedHash;
  if (!hashMatches) {
    return {
      ok: false,
      hashMatches: false,
      byteDiff: null,
      reason:
        `indexHash mismatch: local ${inputs.expectedHash} vs server ${inputs.serverReportedHash}. ` +
        `Build service produced a different index.json than the CLI's local indexer. ` +
        `Refusing to sign a mismatched build.`,
    };
  }
  if (inputs.serverBytes === undefined) {
    return { ok: true, hashMatches: true, byteDiff: null };
  }
  const byteDiff = firstByteDiff(inputs.expectedBytes, inputs.serverBytes);
  if (byteDiff !== null) {
    return {
      ok: false,
      hashMatches: true,
      byteDiff,
      reason:
        `byte-level diff at offset ${byteDiff.offset}: ` +
        `${byteDiff.expected} != ${byteDiff.actual}. ` +
        `Hashes matched but bytes diverged — this is a bug on either side. ` +
        `Refusing to sign.`,
    };
  }
  return { ok: true, hashMatches: true, byteDiff: null };
}
