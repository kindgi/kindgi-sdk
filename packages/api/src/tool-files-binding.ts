// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack tool's files: the binding `/v1/tool-files` calls.
 *
 * A pack tool that declares `storesFiles` or `readsFiles` gets the call's
 * tool files with each call: a link and a token (`kgi_tf_…`) that names
 * that one call and what it may do. The pack service's runner posts each
 * file the handler stores to the link, and gets each file it reads from
 * the link and the file's id, with the token in `Authorization: Bearer`.
 * The runtime checks a stored file's bytes and stores them as a file the
 * call's run owns, and answers a read under the run's rule.
 *
 * The runtime implements the binding; `@kindgi/api` holds no reference to
 * how tokens or files are stored.
 */

import type { FileNotReadReason, FileNotShownReason, FileValue, Result } from '@kindgi/types';

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

/** Why a store or a read isn't taken. */
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
}
