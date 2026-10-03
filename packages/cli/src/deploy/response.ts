// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Deploy response formatters — turn a `PostDeploymentResult` into the
 * banner lines + JSON summary the command emits. Split out from
 * `commands/deploy.ts` so tests can pin the exact text without
 * exercising the full runCli path.
 */

import type { DeploymentRecord, PostDeploymentResult } from './runners.js';

/**
 * Human-friendly hint text keyed by server wire-error code. Each hint
 * points the developer at the most likely remedy. Unknown codes fall
 * through to a generic "check server logs" line.
 */
const WIRE_ERROR_HINTS: Readonly<Record<string, string>> = {
  'signature-invalid':
    'Check that --tenant matches the tenant your token authenticates as. ' +
    "The server re-canonicalises the envelope using the token's tenantId; " +
    'a mismatch fails signature verification.',
  'signer-not-trusted':
    "The signing key's public key is not on this tenant's trust list. " +
    'Print it with `kindgi key export <keyId>` and have your Kindgi operator ' +
    'add it to the trust list (SigningKeyBinding).',
  'image-unverifiable':
    'The server could not pull the image or the extracted /app/index.json ' +
    'sha256 did not match the signed indexHash. Verify the build server ' +
    'pushed to the same registry the deployment tenant can pull from, and ' +
    'that the imageRef in the envelope is digest-pinned.',
  'deployment-validation-failed':
    'One or more primitives in the pack failed server-side validation. ' +
    'The `details[]` array below names each failing primitive + path + ' +
    'message. Fix locally + re-run `kindgi build`.',
  'bad-input':
    'The wire body was malformed. Regenerate the envelope with ' +
    '`kindgi build` — a partial write on disk can cause this.',
};

export interface RenderedResponse {
  /** Lines to append to the stderr banner. */
  readonly banner: readonly string[];
  /** The value to render as JSON on stdout. `null` for error outcomes. */
  readonly summary: Record<string, unknown> | null;
  /** Exit code the command should return. */
  readonly exitCode: number;
}

/**
 * Render a POST outcome. Includes the "what the developer sees"
 * summary for 201/200 outcomes + code-specific hints for 4xx.
 */
export function renderResponse(
  result: PostDeploymentResult,
  ctx: {
    readonly envName: string;
    readonly endpoint: string;
    readonly imageRef: string;
    readonly artifactVersion: string;
    readonly indexHash: string;
    readonly indexCounts: Readonly<{
      tools: number;
      guardrails: number;
      agents: number;
      flows: number;
    }>;
    readonly signerKeyId: string;
    readonly envelopePath: string;
    readonly idempotencyKey: string;
  },
): RenderedResponse {
  if (result.kind === 'created' || result.kind === 'replayed') {
    const banner: string[] = [];
    banner.push('  Registering deployment');
    const statusLabel = result.kind === 'created' ? '201 Created' : '200 OK (idempotent replay)';
    banner.push(`    ✓ POST /v1/deployments  →  ${statusLabel}`);
    banner.push(`      deploymentId:    ${result.record.deploymentId}`);
    banner.push(`      artifactVersion: ${result.record.artifactVersion}`);
    banner.push(`      primitives:      ${primitivesLine(result.record.primitives)}`);
    banner.push(`      activatedAt:     ${result.record.activatedAt}`);
    banner.push('');
    if (result.kind === 'replayed') {
      banner.push(
        '  Note: same imageDigest previously landed. Server returned the existing record.',
      );
      banner.push(
        `  Runs already in flight continue on their pinned image (${result.record.imageDigest.slice(0, 20)}…).`,
      );
    } else {
      banner.push('  Deploy complete.');
      banner.push(
        `  Runs started from now use image ${result.record.imageDigest.slice(0, 20)}… ` +
          `(artifactVersion ${result.record.artifactVersion}).`,
      );
      banner.push('  Runs already in flight continue on their pinned image.');
    }
    banner.push('');
    const summary: Record<string, unknown> = {
      envName: ctx.envName,
      endpoint: ctx.endpoint,
      envelopePath: ctx.envelopePath,
      idempotencyKey: ctx.idempotencyKey,
      status: result.status,
      outcome: result.kind === 'created' ? 'created' : 'replayed',
      deployment: result.record,
    };
    return { banner, summary, exitCode: 0 };
  }

  if (result.kind === 'wire-error') {
    const banner: string[] = [];
    banner.push('  Registering deployment');
    banner.push(`    ✗ POST /v1/deployments  →  HTTP ${result.status}`);
    banner.push(`      code:    ${result.error.code}`);
    banner.push(`      message: ${result.error.message}`);
    const hint = WIRE_ERROR_HINTS[result.error.code];
    if (hint !== undefined) {
      banner.push('');
      banner.push('  Hint:');
      for (const line of wrapForBanner(hint, 74, '    ')) {
        banner.push(line);
      }
    }
    if (result.error.details !== undefined && result.error.details.length > 0) {
      banner.push('');
      banner.push('  Details:');
      for (const detail of result.error.details) {
        banner.push(`    · ${JSON.stringify(detail)}`);
      }
    }
    if (result.status >= 500) {
      banner.push('');
      banner.push(
        '  This is a server error — check the api-server logs. Idempotent-safe to retry.',
      );
    }
    banner.push('');
    return { banner, summary: null, exitCode: 1 };
  }

  // transport-error
  const banner: string[] = [];
  banner.push('  Registering deployment');
  banner.push('    ✗ POST /v1/deployments  →  transport failure');
  banner.push(`      ${result.message}`);
  banner.push('');
  banner.push(
    '  Check network connectivity + endpoint URL. Idempotent-safe to retry with the same key.',
  );
  banner.push('');
  return { banner, summary: null, exitCode: 1 };
}

/**
 * Pretty-print the primitive counts on one line
 * ("primitives: 5 tools, 1 guardrail, 2 agents"). Handles pluralisation
 * (`guardrail` vs `guardrails` etc.).
 */
export function primitivesLine(p: DeploymentRecord['primitives']): string {
  const parts: string[] = [];
  parts.push(`${p.tools} ${p.tools === 1 ? 'tool' : 'tools'}`);
  parts.push(`${p.guardrails} ${p.guardrails === 1 ? 'guardrail' : 'guardrails'}`);
  parts.push(`${p.agents} ${p.agents === 1 ? 'agent' : 'agents'}`);
  parts.push(`${p.flows} ${p.flows === 1 ? 'flow' : 'flows'}`);
  return parts.join(', ');
}

function wrapForBanner(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = indent;
  for (const word of words) {
    if (current.length + word.length + 1 > width && current !== indent) {
      lines.push(current);
      current = indent;
    }
    current += (current === indent ? '' : ' ') + word;
  }
  if (current !== indent) lines.push(current);
  return lines;
}
