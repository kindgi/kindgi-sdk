// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { FileNotReadReason, FileNotShownReason, FileValue } from '@kindgi/types';

/**
 * Files a tool stores and reads.
 *
 * A tool that declares `storesFiles: true` gets `ctx.files.store` with each
 * call with an `idempotencyKey`: it fetches a file (a mail's attachment,
 * say) and stores it, and the runtime checks the bytes, stores them as a
 * file the call's run owns, and answers a file value. The tool returns that
 * value in its result's top-level `files`, and an agent is shown the file.
 *
 * A tool that declares `readsFiles: true` gets `ctx.files.read`: it reads
 * the bytes of a file its run may be shown, by the file value's
 * `artifactId`, to parse a PDF, say, or send a photo on.
 *
 * In-process, the runtime binds `files` itself. In a pack service the
 * runner sends and fetches the bytes at the call's tool-files link (pack
 * protocol 2.10.0), and the handler never sees the link or its token.
 */

/** The most files one call may store: the call's later stores answer `limit`. */
export const MAX_STORED_FILES_PER_CALL = 10;

/**
 * The most bytes a stored file may have: the largest any type allows (a
 * PDF's 10 MB). A pack's store of more answers `size` without sending its
 * bytes.
 */
export const MAX_STORED_FILE_BYTES = 10_000_000;

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
 * shown), `size` (over the type's limit), `limit` (the call has stored
 * `MAX_STORED_FILES_PER_CALL` files), or `storage` (the workspace's storage
 * is full).
 */
export type FileNotStoredReason = Extract<
  FileNotShownReason,
  'type' | 'size' | 'limit' | 'storage'
>;

/**
 * What `files.store` answers: the stored file, to return in the result's
 * top-level `files`, or why nothing was stored, to return as the file's
 * `notShown` reason.
 */
export type FileStoreAnswer =
  | { readonly file: FileValue }
  | { readonly notStored: FileNotStoredReason };

/**
 * What `files.read` answers: the file's bytes, as they were stored, or why
 * there are none (`FILE_NOT_READ_REASONS`).
 */
export type FileReadAnswer =
  | { readonly bytes: Uint8Array }
  | { readonly notRead: FileNotReadReason };

/**
 * A call's files (`ToolContext.files`): `store` for a tool that declares
 * `storesFiles`, `read` for one that declares `readsFiles`, both for one
 * that declares both.
 */
export interface FileStore {
  /**
   * Store one file for this call. Storing the same bytes again in the same
   * call, a re-run of it included, answers the first file and stores
   * nothing new. Rejects when the store can't be reached; the call then
   * fails as any throw fails it.
   */
  store?(file: FileToStore): Promise<FileStoreAnswer>;
  /**
   * Read a stored file's bytes, by its file value's `artifactId`: a file
   * the call's run may be shown, such as one in the run's input, in its
   * conversation, or one a tool stored in it. Answers the bytes it was
   * stored with, never a copy made for a model, or why there are none:
   * `rule` for a file the run may not be shown (whether or not the id names
   * a file elsewhere), `gone`, `changed` or `size`. Rejects when the store
   * can't be reached or has no room for the bytes now; the call then fails
   * as any throw fails it.
   */
  read?(artifactId: string): Promise<FileReadAnswer>;
}
