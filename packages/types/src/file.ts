// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** Why a file isn't sent to the model. The model reads a line saying so in its place. */
export const FILE_NOT_SHOWN_REASONS = [
  'type',
  'size',
  'model',
  'limit',
  'store',
  'gone',
  'changed',
  'refused',
  'storage',
] as const;

export type FileNotShownReason = (typeof FILE_NOT_SHOWN_REASONS)[number];

/**
 * Why a tool's read of a stored file answered no bytes: `rule` (its run
 * may not read a file of that id), `gone` (it's deleted, or its bytes are
 * missing), `changed` (its bytes aren't the ones that were checked), or
 * `size` (over its type's limit).
 */
export const FILE_NOT_READ_REASONS = ['rule', 'gone', 'changed', 'size'] as const;

export type FileNotReadReason = (typeof FILE_NOT_READ_REASONS)[number];

/**
 * A stored file as a value: in a run's input, a tool's result, a
 * conversation message or a flow's values. Plain JSON, so it travels like any
 * value. Its fields say what its maker wrote: only `artifactId` is trusted,
 * and a runtime admits a value by its own checked record of that file.
 */
export interface FileValue {
  readonly type: 'kindgi.file';
  /** The stored file. Only the id is trusted: the rest comes from the file's checks. */
  readonly artifactId: string;
  readonly name?: string;
  /** Its type, as checked from its bytes. */
  readonly contentType: string;
  /** Its size in bytes. */
  readonly size: number;
  /** sha256 of its bytes, hex, lowercase. */
  readonly sha256: string;
  /** A PDF's page count, as checked from its bytes. Absent: it counts as a call's whole page limit. */
  readonly pages?: number;
  /**
   * Set when it isn't sent: `type` (not a type a model is shown, or its
   * bytes aren't that type), `size` (over its type's limit), `model` (the
   * agent or its model doesn't take images and documents), `limit` (over a
   * call's or a list's limits), `store` (no file store), `gone` (no
   * longer stored), `changed` (not the bytes that were checked),
   * `refused` (the model couldn't read it when it was attached),
   * `storage` (a tool's store found the tenant's storage full).
   */
  readonly notShown?: FileNotShownReason;
}

/**
 * Whether `value` has a file value's shape: each field of the right type,
 * a whole size, a lowercase hex sha256, a whole page count from 1, and a
 * known `notShown` reason. Its fields aren't checked against anything.
 */
export function isFileValue(value: unknown): value is FileValue {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Readonly<Record<string, unknown>>;
  return v.type === 'kindgi.file' && hasFileFields(v) && hasOptionalFileFields(v);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function hasFileFields(v: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof v.artifactId === 'string' &&
    v.artifactId.length > 0 &&
    typeof v.contentType === 'string' &&
    Number.isSafeInteger(v.size) &&
    (v.size as number) >= 0 &&
    typeof v.sha256 === 'string' &&
    SHA256_HEX.test(v.sha256)
  );
}

function hasOptionalFileFields(v: Readonly<Record<string, unknown>>): boolean {
  return (
    (v.name === undefined || typeof v.name === 'string') &&
    (v.pages === undefined || (Number.isSafeInteger(v.pages) && (v.pages as number) >= 1)) &&
    (v.notShown === undefined ||
      (FILE_NOT_SHOWN_REASONS as readonly unknown[]).includes(v.notShown))
  );
}
