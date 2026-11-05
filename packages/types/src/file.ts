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
  'reading',
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
 * Why an update of a file added no version: `rule` (the file isn't one
 * of the run's), `denied` (the run may not write where the file is),
 * `gone` (the file is deleted), `type` (the bytes aren't a type the
 * runtime keeps), `size` (over the type's limit, or past what a call may
 * send), or `storage` (the workspace's storage is full).
 */
export const FILE_NOT_UPDATED_REASONS = [
  'rule',
  'denied',
  'gone',
  'type',
  'size',
  'storage',
] as const;

export type FileNotUpdatedReason = (typeof FILE_NOT_UPDATED_REASONS)[number];

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
  /**
   * The file these bytes are a version of, when they're one (on a runtime
   * that keeps file versions). With `version`, it names `artifactId`'s
   * bytes another way: a runtime admits the value only when both name
   * the same bytes.
   */
  readonly fileId?: string;
  /** Which version of `fileId` these bytes are, from 1. Set with `fileId`. */
  readonly version?: number;
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
   * `storage` (a tool's store found the workspace's storage full),
   * `reading` (what the model is sent in its place, an image or a text
   * made from it, isn't made yet).
   */
  readonly notShown?: FileNotShownReason;
}

/**
 * Whether `value` has a file value's shape: each field of the right type,
 * a whole size, a lowercase hex sha256, a whole page count from 1, a
 * `fileId` and a whole `version` from 1 set together or not at all, and a
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
    hasVersionFields(v) &&
    (v.pages === undefined || (Number.isSafeInteger(v.pages) && (v.pages as number) >= 1)) &&
    (v.notShown === undefined ||
      (FILE_NOT_SHOWN_REASONS as readonly unknown[]).includes(v.notShown))
  );
}

/** `fileId` and `version` together, or neither: one names nothing on its own. */
function hasVersionFields(v: Readonly<Record<string, unknown>>): boolean {
  if (v.fileId === undefined && v.version === undefined) return true;
  return (
    typeof v.fileId === 'string' &&
    v.fileId.length > 0 &&
    Number.isSafeInteger(v.version) &&
    (v.version as number) >= 1
  );
}

/**
 * A file named by its id, where a caller passes one (a run's input, the
 * files routes): its latest version, or a fixed one. `latest` is read
 * once, when the file is taken, and the exact version is kept from then.
 */
export interface FileRef {
  readonly fileId: string;
  /** A version from 1, or `latest` (the default). */
  readonly version?: number | 'latest';
}

/**
 * Whether a file's type is text, read and written as lines: any `text/*`,
 * JSON, XML or YAML (`application/json`, `application/xml`,
 * `application/yaml`), and any `+json`, `+xml` or `+yaml` type, in any
 * case, its parameters (`; charset=utf-8`) aside. The model's
 * `kindgi_update_file` and `kindgi_create_file` change only text files.
 */
export function isTextFileType(contentType: string): boolean {
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (!MEDIA_TYPE.test(type)) return false;
  return type.startsWith('text/') || TEXT_APPLICATION_TYPES.has(type) || TEXT_SUFFIX.test(type);
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const TEXT_APPLICATION_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
]);
const TEXT_SUFFIX = /\+(?:json|xml|yaml)$/;
