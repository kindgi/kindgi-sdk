// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack tool's file store: the binding `POST /v1/file-uploads` calls.
 *
 * A pack tool that declares `storesFiles` gets a file upload with each
 * call: a link and a token (`kgi_fu_…`) that names that one call. The pack
 * service's runner posts each file the handler stores to the link, with
 * the token in `Authorization: Bearer`, and the runtime checks the bytes
 * and stores them as a file the call's run owns.
 *
 * The runtime implements the binding; `@kindgi/api` holds no reference to
 * how tokens or files are stored.
 */

import type { FileNotShownReason, FileValue, Result } from '@kindgi/types';

/** A file a pack tool's call stores, as the route read it. */
export interface FileUploadInput {
  /** The token from `Authorization: Bearer`, as it came. */
  readonly token: string;
  /** The name from `Kindgi-File-Name`, decoded; empty when there's none. */
  readonly name: string;
  /** The declared type, from `Content-Type`; empty when there's none. Only the bytes decide. */
  readonly contentType: string;
  /** The body, or `too-large` when it passed `FILE_UPLOAD_MAX_BYTES` and wasn't read to its end. */
  readonly bytes: Uint8Array | 'too-large';
}

/**
 * What a store answers once the token matches: the stored file, or why
 * nothing was stored (`type`, `size`, or `limit`: the call has stored its
 * most). The same bytes again in the same call answer the first file.
 */
export type FileUploadAnswer =
  | { readonly file: FileValue }
  | { readonly notStored: Extract<FileNotShownReason, 'type' | 'size' | 'limit'> };

/** Why a store isn't taken. */
export type FileUploadRefusal =
  /** No such token, or the secret doesn't match: the two are never told apart. */
  | { readonly code: 'file-upload-not-found' }
  /** The call has answered, its time has passed, or its run has ended. */
  | { readonly code: 'file-upload-closed' }
  /**
   * The run's tenant is closing or suspended, or its state can't be read
   * (`unreadable`, which fails closed). Nothing is stored. Answered as
   * every write of a frozen tenant is.
   */
  | { readonly code: 'tenant-frozen'; readonly state: 'closing' | 'suspended' | 'unreadable' }
  /** The run's project is suspended, which cancels its runs: nothing is stored. */
  | { readonly code: 'project-suspended' };

export interface FileUploadBinding {
  /**
   * Store one file for the call the token names. The tenant, project, run
   * and call come from the token's record, never from the request.
   *
   * Once the token matches, before anything else, it refuses a store for a
   * run whose tenant is closing or suspended or whose state can't be read
   * (`tenant-frozen`), or whose project is suspended (`project-suspended`),
   * as `createApp`'s `tenantStates` and `projectSuspended` would say, and
   * a closed upload (`file-upload-closed`). Only to a caller whose token
   * matched. Then `too-large` bytes answer `size`.
   */
  store(input: FileUploadInput): Promise<Result<FileUploadAnswer, FileUploadRefusal>>;
}
