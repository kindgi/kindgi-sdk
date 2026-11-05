// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Scope } from '@kindgi/platform';
import type {
  ArtifactId,
  Cursor,
  FileId,
  ProjectId,
  Result,
  RunId,
  TenantId,
  Timestamp,
} from '@kindgi/types';

import type { BlobError, BlobPutInput } from './index.js';

/**
 * Caller-plugged surface for files with versions, beside
 * `BlobStorageBinding`: a file is a name and its versions 1, 2, 3, each
 * one stored blob. The API package mounts `/v1/files` only when a
 * deployment plugs one in.
 *
 * ## Identity
 *
 * A file's id is the `ArtifactId` of its version 1's bytes. A blob the
 * deployment stored with no file record (before it kept versions) reads
 * as version 1 of a file with the blob's own id, and adding a version to
 * it writes that file's record. Nothing is backfilled.
 *
 * ## Numbers and Latest
 *
 * Numbers start at 1, only grow, and are never reused. Latest is the
 * highest version that isn't deleted. It moves when a version is added,
 * and when Latest itself is deleted: then to the next live version down.
 * A pin never moves it.
 *
 * ## Writes
 *
 * `addVersion` and `restoreVersion` are each one change under the
 * file's lock:
 * - with `expectedVersion`, a Latest that isn't it is
 *   `file-version-conflict`, and nothing is written;
 * - bytes whose sha256 is Latest's add no version: the answer is
 *   Latest, with `created: false`, and the bytes just stored are
 *   discarded;
 * - bytes whose sha256 is an earlier version's of the same file reuse
 *   that version's blob, and the bytes just stored are discarded;
 * - otherwise the new version is the highest + 1, with Latest as its
 *   `parentVersion`.
 *
 * Without `expectedVersion`, the last write wins: it becomes Latest
 * whatever came in between, which stays in the history.
 *
 * A write checks in this order: the file and the version it names
 * exist (`file-not-found`, `file-version-not-found`), then
 * `expectedVersion` (`file-version-conflict`), then the bytes.
 *
 * ## Delete
 *
 * Soft, as `BlobStorageBinding.delete` is, and idempotent. A pinned
 * version can't be deleted, nor a file while any of its versions is
 * pinned (`file-version-pinned`). A file's last live version goes only
 * with the file (`file-last-version`).
 */
export interface FileVersionsBinding {
  /** Version 1 of a new file. The file's id is the new blob's id. */
  create(tenantId: TenantId, input: FileCreateInput): Promise<Result<FileVersionWrite, FileError>>;
  /**
   * The file with its Latest. `null` when unknown or deleted, and for a
   * later version's blob id: only version 1's names the file.
   */
  get(tenantId: TenantId, fileId: FileId): Promise<StoredFile | null>;
  /**
   * Cursor-paginated files, newest change first (`updatedAt desc,
   * fileId desc`). Deleted files aren't listed. Filters compose as AND.
   * A blob with no file record is listed as a one-version file (see
   * "Identity").
   */
  list(
    tenantId: TenantId,
    filter: FileFilter,
    cursor?: Cursor,
    limit?: number,
  ): Promise<Result<FileListPage, FileError>>;
  /** Deletes the file and every version. `{ deleted: false }` when it's already gone. */
  delete(tenantId: TenantId, fileId: FileId): Promise<Result<FileDeleteOutcome, FileError>>;

  /**
   * Every version of the file, newest first, deleted and purged ones
   * included: a number is never left out of the history.
   */
  listVersions(
    tenantId: TenantId,
    fileId: FileId,
    cursor?: Cursor,
    limit?: number,
  ): Promise<Result<FileVersionPage, FileError>>;
  /** One version's record, deleted or purged too, without its bytes. */
  getVersion(
    tenantId: TenantId,
    fileId: FileId,
    version: FileVersionSelector,
  ): Promise<Result<FileVersion, FileError>>;
  /**
   * One version's bytes, streamed. A deleted or purged version is
   * `file-version-not-found`: there's no falling back to Latest.
   */
  readVersion(
    tenantId: TenantId,
    fileId: FileId,
    version: FileVersionSelector,
  ): Promise<Result<FileVersionRead, FileError>>;
  /** A new version from new bytes (see "Writes"). */
  addVersion(
    tenantId: TenantId,
    fileId: FileId,
    input: FileVersionAddInput,
  ): Promise<Result<FileVersionWrite, FileError>>;
  /**
   * A new version from an earlier version's bytes, with `restoredFrom`
   * set (see "Writes"). It keeps Latest's name; its type and tags are the
   * source version's. Nothing is removed. A deleted or purged source is
   * `file-version-not-found`, as for `readVersion`.
   */
  restoreVersion(
    tenantId: TenantId,
    fileId: FileId,
    version: number,
    input: FileRestoreInput,
  ): Promise<Result<FileVersionWrite, FileError>>;
  /**
   * Deletes one version. `{ deleted: false }` when it's already gone:
   * deleted, or purged by retention.
   */
  deleteVersion(
    tenantId: TenantId,
    fileId: FileId,
    version: number,
  ): Promise<Result<FileDeleteOutcome, FileError>>;
  /**
   * A keep mark on one version: it can't be deleted, and retention never
   * picks it. Pinning a pinned version changes nothing. Each pin and
   * unpin is kept in the file's pin history. A deleted or purged version
   * is `file-version-not-found`.
   */
  pinVersion(
    tenantId: TenantId,
    fileId: FileId,
    version: number,
    input: FilePinInput,
  ): Promise<Result<FileVersion, FileError>>;
  /** Takes a version's pin off. Unpinning a version with none changes nothing. */
  unpinVersion(
    tenantId: TenantId,
    fileId: FileId,
    version: number,
    input: FilePinInput,
  ): Promise<Result<FileVersion, FileError>>;
  /** Every pin and unpin of the file's versions, newest first. */
  pinHistory(
    tenantId: TenantId,
    fileId: FileId,
    cursor?: Cursor,
    limit?: number,
  ): Promise<Result<FilePinChangePage, FileError>>;
}

/** A version by its number, or Latest. */
export type FileVersionSelector = number | 'latest';

/** How a version was made. */
export type FileVersionMadeVia = 'upload' | 'restore' | 'tool' | 'model';

/** A file, with its Latest. */
export interface StoredFile {
  readonly fileId: FileId;
  readonly tenantId: TenantId;
  /** The project it belongs to, which decides who may read and change it. */
  readonly projectId?: ProjectId;
  /** Its name: Latest's. */
  readonly name: string;
  /** Who made version 1: `user:<id>` or `service_account:<id>`. */
  readonly createdBy?: string;
  /** The run that made version 1, when one did. */
  readonly ownerRunId?: RunId;
  readonly latestVersion: number;
  /** The highest number it has had, deleted versions included. */
  readonly highestVersion: number;
  /** Its pinned versions, lowest first. */
  readonly pinnedVersions: readonly number[];
  readonly latest: FileVersion;
  readonly createdAt: Timestamp;
  /** When its newest version was made, or its Latest last moved. */
  readonly updatedAt: Timestamp;
}

/** One version of a file. */
export interface FileVersion {
  readonly fileId: FileId;
  readonly version: number;
  /** The blob holding its bytes. Two versions of one file can share one. */
  readonly blobId: ArtifactId;
  /** The file's name when this version was made. */
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  /** `sha256`, hex-encoded, lowercase. */
  readonly hash: string;
  readonly tags: Readonly<Record<string, string>>;
  /** Latest when this version was made. Absent on version 1. */
  readonly parentVersion?: number;
  /** The version a restore copied the bytes of. */
  readonly restoredFrom?: number;
  readonly madeVia: FileVersionMadeVia;
  /** Who made it: `user:<id>` or `service_account:<id>`, or `run:<id>` for a run's tool or model. */
  readonly createdBy?: string;
  /** For a version a run made: the run, its tool call's key and the tool. */
  readonly runId?: RunId;
  readonly callKey?: string;
  readonly toolId?: string;
  readonly createdAt: Timestamp;
  /** When the next version was made. Absent on the highest. */
  readonly supersededAt?: Timestamp;
  readonly pin?: FilePin;
  readonly deletedAt?: Timestamp;
  /**
   * When retention dropped its bytes. Its number, hash, size and maker
   * stay, so the runs that used it still name it.
   */
  readonly purgedAt?: Timestamp;
}

/** A version's keep mark. */
export interface FilePin {
  /** `user:<id>` or `service_account:<id>`. */
  readonly by: string;
  readonly at: Timestamp;
  readonly reason?: string;
}

/** One entry of a file's pin history. Entries are only ever added. */
export interface FilePinChange {
  readonly changeId: string;
  readonly fileId: FileId;
  readonly version: number;
  readonly change: 'pin' | 'unpin';
  readonly by: string;
  readonly at: Timestamp;
  readonly reason?: string;
}

/** Who made a version, when a run's tool or model did. */
interface FileVersionMaker {
  /** Default `upload`. `restore` is `restoreVersion`'s own. */
  readonly madeVia?: Exclude<FileVersionMadeVia, 'restore'>;
  readonly runId?: RunId;
  readonly callKey?: string;
  readonly toolId?: string;
}

/** Version 1 of a new file: a blob put as `BlobStorageBinding.put` puts one. */
export interface FileCreateInput extends BlobPutInput, FileVersionMaker {}

/** A new version's bytes. Its project is its file's. */
export interface FileVersionAddInput
  extends Omit<BlobPutInput, 'name' | 'ownerRunId' | 'projectId'>,
    FileVersionMaker {
  /** The version the writer read. When Latest isn't it, nothing is written. */
  readonly expectedVersion?: number;
  /** A new name for the file. Default: Latest's. */
  readonly name?: string;
}

export interface FileRestoreInput {
  /** As on `FileVersionAddInput`. */
  readonly expectedVersion?: number;
  /** Who restored it: `user:<id>` or `service_account:<id>`. */
  readonly createdBy?: string;
}

export interface FilePinInput {
  /** `user:<id>` or `service_account:<id>`. */
  readonly by: string;
  readonly reason?: string;
}

/** A write's version, and whether it made one: `false` when the bytes were Latest's. */
export interface FileVersionWrite {
  readonly version: FileVersion;
  readonly created: boolean;
}

export interface FileVersionRead {
  readonly version: FileVersion;
  readonly stream: ReadableStream<Uint8Array>;
}

export interface FileFilter {
  /** Files whose version 1 this run made. */
  readonly ownerRunId?: RunId;
  /** Files whose Latest has this type, exactly. */
  readonly contentType?: string;
  /** As `BlobFilter.scope`: files are content, so they sit in projects. */
  readonly scope?: Scope;
}

export interface FileListPage {
  readonly data: readonly StoredFile[];
  readonly nextCursor?: Cursor;
}

export interface FileVersionPage {
  readonly data: readonly FileVersion[];
  readonly nextCursor?: Cursor;
}

export interface FilePinChangePage {
  readonly data: readonly FilePinChange[];
  readonly nextCursor?: Cursor;
}

export interface FileDeleteOutcome {
  readonly deleted: boolean;
}

/**
 * Discriminated error union. `@kindgi/api` maps each `code` to an HTTP
 * status.
 */
export type FileError =
  | { readonly code: 'file-not-found'; readonly message: string; readonly fileId: string }
  | {
      readonly code: 'file-version-not-found';
      readonly message: string;
      readonly fileId: string;
      readonly version: FileVersionSelector;
    }
  | {
      readonly code: 'file-version-conflict';
      readonly message: string;
      readonly fileId: string;
      readonly expectedVersion: number;
      readonly latestVersion: number;
    }
  | {
      readonly code: 'file-version-pinned';
      readonly message: string;
      readonly fileId: string;
      /** A pinned version: the one named, or for a whole file's delete, its lowest. */
      readonly version: number;
    }
  | {
      readonly code: 'file-last-version';
      readonly message: string;
      readonly fileId: string;
      readonly version: number;
    }
  | Exclude<BlobError, { readonly code: 'blob-not-found' | 'artifact-in-file' }>;
