// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Deploy envelope loader — reads `deploy-envelope.json` (emitted by
 * `kindgi build`) from disk and structurally
 * validates it. The signature itself was computed at build time; we do
 * NOT re-sign here. This loader's job is to catch corruption + partial
 * writes + the "someone hand-edited the file" class of bugs before we
 * put anything on the wire.
 *
 * The result feeds directly into `packages/cli/src/deploy/post.ts`
 * (which strips `tenantId` for the wire body) + into the summary/
 * banner code paths.
 */

import { readFile } from 'node:fs/promises';

import { DEPLOY_ENVELOPE_SCHEMA, type DeployEnvelope } from '../build/envelope.js';
import type { LoadEnvelopeResult } from './runners.js';

/**
 * Structural check + schema pin. On success returns the parsed
 * envelope; on failure returns a typed error the command surfaces to
 * the developer as an actionable message.
 */
export function validateEnvelopeStructure(raw: unknown, path: string): LoadEnvelopeResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'err',
      code: 'envelope-schema-mismatch',
      message: 'deploy-envelope.json must be a JSON object.',
      path,
    };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.$schema !== DEPLOY_ENVELOPE_SCHEMA) {
    return {
      kind: 'err',
      code: 'envelope-schema-mismatch',
      message:
        `deploy-envelope.json $schema mismatch: expected "${DEPLOY_ENVELOPE_SCHEMA}", got ` +
        `"${String(obj.$schema)}". Re-run \`kindgi build\` to regenerate.`,
      path,
    };
  }

  const requiredStrings: readonly (keyof DeployEnvelope)[] = [
    'imageRef',
    'imageDigest',
    'artifactVersion',
    'indexHash',
    'tenantId',
    'publishedAt',
  ];
  for (const field of requiredStrings) {
    const value = obj[field as string];
    if (typeof value !== 'string' || value.length === 0) {
      return {
        kind: 'err',
        code: 'envelope-schema-mismatch',
        message: `deploy-envelope.json is missing required field "${String(field)}" (or the value is empty). Re-run \`kindgi build\` to regenerate.`,
        path,
      };
    }
  }

  const index = obj.index;
  if (index === null || typeof index !== 'object' || Array.isArray(index)) {
    return {
      kind: 'err',
      code: 'envelope-schema-mismatch',
      message: 'deploy-envelope.json `index` must be an object (verbatim /app/index.json).',
      path,
    };
  }

  // Optional signature triplet: either all three are present, or all
  // three are absent. Half-signed envelopes are corruption.
  const hasSig = typeof obj.signature === 'string' && (obj.signature as string).length > 0;
  const hasKeyId = typeof obj.signerKeyId === 'string' && (obj.signerKeyId as string).length > 0;
  const hasPubKey =
    typeof obj.signerPublicKey === 'string' && (obj.signerPublicKey as string).length > 0;
  const sigCount = Number(hasSig) + Number(hasKeyId) + Number(hasPubKey);
  if (sigCount !== 0 && sigCount !== 3) {
    return {
      kind: 'err',
      code: 'envelope-schema-mismatch',
      message:
        'deploy-envelope.json has a partial signature triplet — expected all ' +
        'three of `signature` / `signerKeyId` / `signerPublicKey`, or none of ' +
        'them. Re-run `kindgi build` (drop `--skip-sign` if you intended to sign).',
      path,
    };
  }

  return { kind: 'ok', envelope: obj as unknown as DeployEnvelope };
}

/**
 * Read the envelope from disk + validate. Returns typed errors for
 * missing-file / bad-JSON / schema-mismatch cases — the command
 * translates each to an actionable stderr message.
 */
export async function loadEnvelopeReal(opts: {
  readonly path: string;
}): Promise<LoadEnvelopeResult> {
  let raw: string;
  try {
    raw = await readFile(opts.path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        kind: 'err',
        code: 'envelope-not-found',
        message: `deploy-envelope.json not found at ${opts.path}.`,
        path: opts.path,
      };
    }
    return {
      kind: 'err',
      code: 'envelope-not-found',
      message: `Failed to read ${opts.path}: ${(err as Error).message}`,
      path: opts.path,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'err',
      code: 'envelope-invalid-json',
      message: `deploy-envelope.json is not valid JSON: ${(err as Error).message}`,
      path: opts.path,
    };
  }
  return validateEnvelopeStructure(parsed, opts.path);
}

/**
 * Check whether an envelope is signed. `kindgi deploy` refuses to
 * POST an unsigned envelope unless `--dry-run` is set — the server
 * would reject anyway (400 signature-invalid), so we fail fast with a
 * clearer message.
 */
export function isEnvelopeSigned(envelope: DeployEnvelope): boolean {
  return (
    typeof envelope.signature === 'string' &&
    envelope.signature.length > 0 &&
    typeof envelope.signerKeyId === 'string' &&
    envelope.signerKeyId.length > 0 &&
    typeof envelope.signerPublicKey === 'string' &&
    envelope.signerPublicKey.length > 0
  );
}
