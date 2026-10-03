// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result } from '@kindgi/types';

/**
 * JSONB payload versioning for agents-owned tables. Nested
 * `{ v: 1, doc: <content> }` envelope; `unwrap` accepts only
 * `CURRENT_AGENTS_PAYLOAD_VERSION`.
 */

export const CURRENT_AGENTS_PAYLOAD_VERSION = 1;

export interface UnsupportedPayloadVersionError {
  readonly code: 'unsupported-payload-version';
  readonly message: string;
  readonly version: number;
  readonly currentVersion: number;
}

export interface MalformedEnvelopeError {
  readonly code: 'malformed-envelope';
  readonly message: string;
}

export type EnvelopeError = UnsupportedPayloadVersionError | MalformedEnvelopeError;

export class EnvelopeThrown extends Error {
  readonly error: EnvelopeError;
  constructor(error: EnvelopeError) {
    super(error.message);
    this.error = error;
    this.name = 'EnvelopeThrown';
  }
}

export function wrap<T>(value: T): { readonly v: number; readonly doc: T } {
  return { v: CURRENT_AGENTS_PAYLOAD_VERSION, doc: value };
}

export function unwrap<T = unknown>(raw: unknown): Result<T | null | undefined, EnvelopeError> {
  if (raw === null || raw === undefined) return { kind: 'ok', value: raw };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'err',
      error: {
        code: 'malformed-envelope',
        message: `Expected { v, doc } envelope, got ${typeof raw === 'object' ? 'array' : typeof raw}`,
      },
    };
  }
  const envelope = raw as { readonly v?: unknown; readonly doc?: unknown };
  if (typeof envelope.v !== 'number' || !('doc' in envelope)) {
    return {
      kind: 'err',
      error: { code: 'malformed-envelope', message: 'Payload is missing v or doc field' },
    };
  }
  if (envelope.v === CURRENT_AGENTS_PAYLOAD_VERSION) {
    return { kind: 'ok', value: envelope.doc as T };
  }
  return {
    kind: 'err',
    error: {
      code: 'unsupported-payload-version',
      message: `Unsupported payload version ${envelope.v} (this reader handles version ${CURRENT_AGENTS_PAYLOAD_VERSION})`,
      version: envelope.v,
      currentVersion: CURRENT_AGENTS_PAYLOAD_VERSION,
    },
  };
}

export function unwrapOrThrow<T = unknown>(raw: unknown): T | null | undefined {
  const r = unwrap<T>(raw);
  if (r.kind === 'err') throw new EnvelopeThrown(r.error);
  return r.value;
}
