// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result } from '@kindgi/types';

/**
 * Payload versioning for the documents the runtime stores (journal
 * payloads, run input / output, …).
 *
 * Every stored payload is a nested envelope `{ v: 1, doc: <content> }`.
 * Wrapping under a dedicated `doc` key means the envelope's version
 * marker cannot collide with any user field named `version`,
 * `schemaVersion`, etc. Readers switch on `v` and return the inner `doc`,
 * so consumer code sees the same content shape as if no envelope
 * existed.
 *
 * Newer versions than this reader knows about are a hard error — a
 * writer/reader skew would silently drop v2 data otherwise. No implicit
 * versioning: every payload must carry an explicit envelope.
 */

export const CURRENT_KERNEL_PAYLOAD_VERSION = 1;

/** Discriminated error surfaced when a stored payload's version exceeds the reader's. */
export interface UnsupportedPayloadVersionError {
  readonly code: 'unsupported-payload-version';
  readonly message: string;
  readonly version: number;
  readonly currentVersion: number;
}

/** Emitted when a stored payload lacks the envelope entirely. */
export interface MalformedEnvelopeError {
  readonly code: 'malformed-envelope';
  readonly message: string;
}

export type EnvelopeError = UnsupportedPayloadVersionError | MalformedEnvelopeError;

/**
 * Thrown by `*OrThrow` helpers when a stored payload can't be unwrapped.
 * Catch at the operation boundary (e.g. `readJournal`) and surface
 * as a KernelError.
 */
export class EnvelopeThrown extends Error {
  readonly error: EnvelopeError;
  constructor(error: EnvelopeError) {
    super(error.message);
    this.error = error;
    this.name = 'EnvelopeThrown';
  }
}

/**
 * Wrap any value in the current-version envelope. The stored payload is
 * always `{ v: 1, doc: value }` regardless of whether `value` is an
 * object, array, primitive, or null.
 */
export function wrap<T>(value: T): { readonly v: number; readonly doc: T } {
  return { v: CURRENT_KERNEL_PAYLOAD_VERSION, doc: value };
}

/**
 * Unwrap a stored envelope and return the inner document. Handles:
 *   - null / undefined: returned as-is (nothing was stored).
 *   - `{ v: 1, doc: X }`: returns `X`.
 *   - `{ v: N, doc: X }` with any other numeric N:
 *     `unsupported-payload-version` error.
 *   - Anything else: `malformed-envelope` error.
 */
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
      error: {
        code: 'malformed-envelope',
        message: 'Payload is missing v or doc field',
      },
    };
  }
  if (envelope.v === CURRENT_KERNEL_PAYLOAD_VERSION) {
    return { kind: 'ok', value: envelope.doc as T };
  }
  return {
    kind: 'err',
    error: {
      code: 'unsupported-payload-version',
      message: `Unsupported payload version ${envelope.v} (this reader handles version ${CURRENT_KERNEL_PAYLOAD_VERSION})`,
      version: envelope.v,
      currentVersion: CURRENT_KERNEL_PAYLOAD_VERSION,
    },
  };
}

export function unwrapOrThrow<T = unknown>(raw: unknown): T | null | undefined {
  const r = unwrap<T>(raw);
  if (r.kind === 'err') throw new EnvelopeThrown(r.error);
  return r.value;
}
