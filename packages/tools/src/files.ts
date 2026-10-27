// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { FileNotShownReason, FileValue } from '@kindgi/types';

/**
 * Files a tool stores.
 *
 * A tool that declares `storesFiles: true` gets `ctx.files` with each call:
 * it fetches a file (a mail's attachment, say) and stores it, and the
 * runtime checks the bytes, stores them as a file the call's run owns, and
 * answers a file value. The tool returns that value in its result's
 * top-level `files`, and an agent is shown the file.
 *
 * In-process, the runtime binds `files` itself. In a pack service the
 * runner sends the bytes to the call's upload link (pack protocol 2.10.0),
 * and the handler never sees the link or its token.
 */

/** The most files one call may store: the call's later stores answer `limit`. */
export const MAX_STORED_FILES_PER_CALL = 10;

/** A file a tool stores: its name, the type its source declares, and its bytes. */
export interface FileToStore {
  /** Its name, as its source gives it. An empty one is stored as `unnamed`. */
  readonly name: string;
  /** The type its source declares. The runtime checks the bytes, and only they decide. */
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/**
 * Why a store kept nothing: `type` (the bytes aren't a type a model is
 * shown), `size` (over the type's limit), or `limit` (the call has stored
 * `MAX_STORED_FILES_PER_CALL` files).
 */
export type FileNotStoredReason = Extract<FileNotShownReason, 'type' | 'size' | 'limit'>;

/**
 * What `files.store` answers: the stored file, to return in the result's
 * top-level `files`, or why nothing was stored, to return as the file's
 * `notShown` reason.
 */
export type FileStoreAnswer =
  | { readonly file: FileValue }
  | { readonly notStored: FileNotStoredReason };

/** A call's file store (`ToolContext.files`). */
export interface FileStore {
  /**
   * Store one file for this call. Storing the same bytes again in the same
   * call, a re-run of it included, answers the first file and stores
   * nothing new. Rejects when the store can't be reached; the call then
   * fails as any throw fails it.
   */
  store(file: FileToStore): Promise<FileStoreAnswer>;
}
