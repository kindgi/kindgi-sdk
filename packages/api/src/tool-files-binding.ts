// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack tool's files: the binding `/v1/tool-files` calls.
 *
 * A pack tool that declares `storesFiles`, `readsFiles` or `updatesFiles`
 * gets the call's tool files with each call: a link and a token
 * (`kgi_tf_…`) that names that one call and what it may do. The pack
 * service's runner posts each file the handler stores to the link, gets
 * each file it reads from the link and the file's id, and posts each new
 * version it adds to `<link>/<fileId>/versions`, with the token in
 * `Authorization: Bearer`. The runtime checks a stored file's bytes and
 * stores them as a file the call's run owns, answers a read under the
 * run's rule, and adds a version under the same rule.
 *
 * The runtime implements the binding; `@kindgi/api` holds no reference to
 * how tokens or files are stored.
 */

import type {
  FileNotReadReason,
  FileNotShownReason,
  FileNotUpdatedReason,
  FileValue,
  Result,
} from '@kindgi/types';

/** A file a pack tool's call stores, as the route has it. */
export interface ToolFileStoreInput {
  /** The token from `Authorization: Bearer`, as it came. */
  readonly token: string;
  /** The name from `Kindgi-File-Name`, decoded; empty when there's none. */
  readonly name: string;
  /** The declared type, from `Content-Type`; empty when there's none. Only the bytes decide. */
  readonly contentType: string;
  /** The body's length, from `Content-Length`; absent when it isn't sent. */
  readonly declaredBytes?: number;
  /**
   * Reads the body, up to `maxBytes` (never past `TOOL_FILE_MAX_BYTES`):
   * its bytes, or `too-large` when it passed them and wasn't read to its
   * end. Nothing reads it until this is called, so a store refused first
   * never takes its bytes.
   */
  readonly body: (maxBytes: number) => Promise<Uint8Array | 'too-large'>;
}

/**
 * What a store answers once the token matches: the stored file, or why
 * nothing was stored (`type`, `size`, `limit`: the call has stored its
 * most, or `storage`: the tenant's storage is full). The same bytes again
 * in the same call answer the first file.
 */
export type ToolFileStoreAnswer =
  | { readonly file: FileValue }
  | { readonly notStored: Extract<FileNotShownReason, 'type' | 'size' | 'limit' | 'storage'> };

/** A file a pack tool's call reads, as the route has it. */
export interface ToolFileReadInput {
  /** The token from `Authorization: Bearer`, as it came. */
  readonly token: string;
  /** The file value's `artifactId`, from the path, as it came. */
  readonly artifactId: string;
}

/**
 * What a read answers once the token matches: the file's bytes, as it was
 * stored, and `release`, which gives back the room they take in the
 * runtime's memory once they're sent; or why there are none.
 */
export type ToolFileReadAnswer =
  | { readonly bytes: Uint8Array; readonly release?: () => void }
  | { readonly notRead: FileNotReadReason };

/** A new version a pack tool's call adds to a file, as the route has it. */
export interface ToolFileUpdateInput {
  /** The token from `Authorization: Bearer`, as it came. */
  readonly token: string;
  /** The file's id, from the path, as it came. */
  readonly fileId: string;
  /**
   * `Kindgi-Expected-Version`: the version the tool read, which must
   * still be Latest. A whole number from 1.
   */
  readonly expectedVersion: number;
  /**
   * The name from `Kindgi-File-Name`, decoded. Absent when there's none,
   * or it's empty: the new version keeps Latest's name.
   */
  readonly name?: string;
  /** The declared type, from `Content-Type`; empty when there's none. Only the bytes decide. */
  readonly contentType: string;
  /** The body's length, from `Content-Length`; absent when it isn't sent. */
  readonly declaredBytes?: number;
  /** Reads the body, as {@link ToolFileStoreInput.body} does. */
  readonly body: (maxBytes: number) => Promise<Uint8Array | 'too-large'>;
}

/**
 * What an update answers once the token matches: the new version
 * (`file`); Latest, when the bytes are Latest's already (`same`); Latest,
 * when it isn't the expected version any more (`conflict`); or why no
 * version was added (`notUpdated`). The same bytes again in the same call,
 * a re-run of it included, answer the first version, even after Latest
 * has moved on.
 */
export type ToolFileUpdateAnswer =
  | { readonly file: FileValue }
  | { readonly same: FileValue }
  | { readonly conflict: FileValue }
  | { readonly notUpdated: FileNotUpdatedReason };

/** Why a store, a read or an update isn't taken. */
export type ToolFilesRefusal =
  /**
   * No such token, the secret doesn't match, or the token's call may not
   * do this (a store-only tool's read): never told apart.
   */
  | { readonly code: 'tool-file-token-not-found' }
  /** The call has answered, its time has passed, or its run has ended. */
  | { readonly code: 'tool-file-token-closed' }
  /**
   * The run's tenant is closing or suspended, or its state can't be read
   * (`unreadable`, which fails closed). Nothing is stored. Answered as
   * every write of a frozen tenant is.
   */
  | { readonly code: 'tenant-frozen'; readonly state: 'closing' | 'suspended' | 'unreadable' }
  /** The run's project is suspended, which cancels its runs: nothing is stored. */
  | { readonly code: 'project-suspended' }
  /**
   * The runtime's memory for files has no room for the bytes now: nothing
   * was stored or read. The runner may send it again.
   */
  | { readonly code: 'tool-files-busy' };

export interface ToolFilesBinding {
  /**
   * Store one file for the call the token names. The tenant, project, run
   * and call come from the token's record, never from the request. A token
   * whose call doesn't store files is `tool-file-token-not-found`.
   *
   * Once the token matches, before anything else, it refuses a store for a
   * run whose tenant is closing or suspended or whose state can't be read
   * (`tenant-frozen`), or whose project is suspended (`project-suspended`),
   * as `createApp`'s `tenantStates` and `projectSuspended` would say, and
   * a closed token (`tool-file-token-closed`). Only to a caller whose token
   * matched. Then a declared length past `TOOL_FILE_MAX_BYTES` answers
   * `size` without reading the body; it takes room for the bytes in the
   * runtime's memory (`tool-files-busy` when none comes in time), reads
   * the body (`too-large` answers `size`), stores it, and gives the room
   * back.
   */
  store(input: ToolFileStoreInput): Promise<Result<ToolFileStoreAnswer, ToolFilesRefusal>>;
  /**
   * Read one file for the call the token names, under its run's rule. A
   * token whose call doesn't read files is `tool-file-token-not-found`.
   *
   * Once the token matches: a closed token (`tool-file-token-closed`);
   * then the rule (`rule`: no file of that id the run may be shown), the
   * file's size against its type's limit (`size`), room for its bytes
   * (`tool-files-busy`), and its bytes (`gone`, `changed`). A read isn't
   * refused for a frozen tenant or a suspended project: it writes nothing.
   */
  read(input: ToolFileReadInput): Promise<Result<ToolFileReadAnswer, ToolFilesRefusal>>;
  /**
   * Add a version to one file for the call the token names, under its
   * run's rule. A token whose call doesn't update files is
   * `tool-file-token-not-found`. Absent: every update is
   * `tool-file-token-not-found` (a runtime from before pack protocol
   * 2.13.0).
   *
   * Once the token matches, it refuses as `store` does: `tenant-frozen`,
   * `project-suspended`, then `tool-file-token-closed`. Then it answers in
   * this order:
   *   1. `rule`: the run may not be shown a file of that id, or the id
   *      isn't one;
   *   2. `denied`: the run's principal has no `write` where the file is
   *      (its project, or the tenant for a file with no project), as
   *      `POST /v1/files/{fileId}/versions` asks;
   *   3. `gone`: the file is deleted;
   *   4. `size`, unread, for a declared length past `TOOL_FILE_MAX_BYTES`;
   *      then room for the bytes (`tool-files-busy`), and the body read
   *      (`too-large` answers `size`);
   *   5. the call's first version, for the same bytes again in the same
   *      call;
   *   6. `conflict` (Latest), when Latest isn't `expectedVersion`;
   *   7. `same` (Latest), when the bytes are Latest's;
   *   8. `type`, then `size` for its type, then `storage`, as a store
   *      checks them.
   * The new version keeps Latest's tags, records the call's run, call and
   * tool, and is listed among the run's files.
   */
  update?(input: ToolFileUpdateInput): Promise<Result<ToolFileUpdateAnswer, ToolFilesRefusal>>;
}
