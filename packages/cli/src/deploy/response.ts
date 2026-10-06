// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Deploy response formatters — turn a `PostDeploymentResult` into the
 * banner lines + JSON summary the command emits. Split out from
 * `commands/deploy.ts` so tests can pin the exact text without
 * exercising the full runCli path.
 */

import type { DeployedVersionRecord, DeploymentRecord, PostDeploymentResult } from './runners.js';

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
    "The runtime doesn't trust the signing key {signerKeyId}: it isn't on this tenant's " +
    'trust list, or it was revoked. Trust it (with a token that has signing-keys:write), ' +
    'then deploy again. A revoked key stays revoked: make a new one with ' +
    '`kindgi key create <newId>`.',
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

/**
 * The command a hint names, on a line of its own so it copies whole.
 * `{signerKeyId}` and `{endpoint}` are filled in from the deploy.
 */
const WIRE_ERROR_COMMANDS: Readonly<Record<string, string>> = {
  'signer-not-trusted': 'kindgi key trust {signerKeyId} --url {endpoint}',
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
    banner.push(...versionBlock(result.record.contents));
    if (result.idempotentReplay === true) {
      banner.push(
        `  Note: answered from the server's record of an earlier request with this Idempotency-Key (${ctx.idempotencyKey}); nothing ran again.`,
      );
    }
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
    const fill = (text: string): string =>
      text.replaceAll('{signerKeyId}', ctx.signerKeyId).replaceAll('{endpoint}', ctx.endpoint);
    const hint = WIRE_ERROR_HINTS[result.error.code];
    if (hint !== undefined) {
      banner.push('');
      banner.push('  Hint:');
      for (const line of wrapForBanner(fill(hint), 74, '    ')) {
        banner.push(line);
      }
      const command = WIRE_ERROR_COMMANDS[result.error.code];
      if (command !== undefined) banner.push(`      ${fill(command)}`);
    }
    if (result.error.details !== undefined && result.error.details.length > 0) {
      banner.push('');
      banner.push('  Details:');
      for (const detail of result.error.details) {
        banner.push(`    · ${JSON.stringify(detail)}`);
      }
    }
    if (result.idempotentReplay === true) {
      // A runtime before 0.1.3 stored refusals too.
      banner.push('');
      banner.push(
        `  This answer is a replay: an earlier request with the same Idempotency-Key (${ctx.idempotencyKey}) got it,`,
      );
      banner.push(
        '  and the server returned it without running again. After fixing the cause, deploy',
      );
      banner.push('  with a new key: --idempotency-key <new value>.');
    } else if (result.status >= 500) {
      banner.push('');
      banner.push(
        "  This is a server error: check the runtime's logs, then run the same command again.",
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
    '  Check the network and the endpoint URL, then run the same command again: it sends',
  );
  banner.push(
    `  the same Idempotency-Key (${ctx.idempotencyKey}), so a deploy that did land isn't registered twice.`,
  );
  banner.push('');
  return { banner, summary: null, exitCode: 1 };
}

/**
 * One line per agent or flow registered under another version than its
 * definition names, saying which version runs, why, and how to make the
 * code match so the two don't drift apart:
 *
 *   agent acme.matcher: registered new version 1.4.1 (1.4.0's pins changed: tool acme.score 1.0.0 → 1.1.0); set version: '1.4.1' in acme.matcher to match
 */
export function versionLines(
  kind: 'agent' | 'flow',
  entries: readonly DeployedVersionRecord[],
): string[] {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.authoredVersion === undefined || e.authoredVersion === e.version) continue;
    const why = whyRenumbered(kind, e);
    const what =
      e.newVersion === false
        ? `${e.authoredVersion} runs as ${e.version}, registered by an earlier deploy`
        : `registered new version ${e.version}`;
    lines.push(
      `${kind} ${e.id}: ${what} (${why}); set version: '${e.version}' in ${e.id} to match`,
    );
  }
  return lines;
}

/** Why an agent or flow runs as another version than its definition names. */
function whyRenumbered(kind: 'agent' | 'flow', e: DeployedVersionRecord): string {
  if (e.reason === 'pins-changed') {
    return `${e.authoredVersion}'s pins changed${pinChangesText(e.pinChanges ?? [])}`;
  }
  if (e.reason === 'unpinned') {
    const blocks = kind === 'agent' ? 'tools' : 'tools and agents';
    return `${e.authoredVersion} was published before pins; ${e.version} pins its ${blocks}`;
  }
  return `${e.authoredVersion} is taken by a different definition`;
}

/** `versionLines` for a deployment's agents then flows, followed by a blank line; none when there are none. */
function versionBlock(contents: DeploymentRecord['contents']): string[] {
  const lines = [
    ...versionLines('agent', contents?.agents ?? []),
    ...versionLines('flow', contents?.flows ?? []),
  ];
  return lines.length === 0 ? [] : [...lines.map((line) => `  ${line}`), ''];
}

function pinChangesText(changes: NonNullable<DeployedVersionRecord['pinChanges']>): string {
  if (changes.length === 0) return '';
  const parts = changes.map((c) => `${c.kind} ${c.id} ${c.from ?? 'none'} → ${c.to ?? 'none'}`);
  return `: ${parts.join(', ')}`;
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
