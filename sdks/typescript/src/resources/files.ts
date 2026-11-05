// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, FileId, RunId } from '@kindgi/types';

import type {
  DeleteFileResult,
  FilePinChange,
  FileVersion,
  FileVersionWrite,
  StoredFile,
} from '../generated/api.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import { bytesHeaders, rawRequest, uploadForm } from '../raw-request.js';
import type { Transport } from '../transport.js';

/**
 * Files the runtime keeps, with every edit as a version.
 *
 * A file's id is the `blobId` of its version 1's bytes, and names the file
 * through every later version. Version numbers start at 1, only grow, and
 * are never reused. Latest is the highest version that isn't deleted.
 * Every file belongs to a project: reading it needs `read` there (or `run`,
 * for a file of the caller's own), and changing it needs `write`. A file
 * the caller can't read is `404 file-not-found`, as if absent.
 *
 * On a runtime that doesn't keep files, every call is
 * `404 route-not-found`.
 */
export interface FilesClient {
  /**
   * The files the caller can read, newest change first, each with its
   * Latest (no bytes). Deleted files aren't listed.
   *
   * @wire GET /v1/files
   */
  list(filter?: ListFilesFilter): Promise<ListPage<StoredFile>>;

  /**
   * Store a file as its version 1. It belongs to `ownerRunId`'s project,
   * else `projectId`, else the project the caller's API key is limited to,
   * else the workspace's default project. Over the runtime's cap (default
   * 100 MiB) is `413 file-too-large`.
   *
   * @wire POST /v1/files (multipart)
   */
  create(input: CreateFileInput, options?: MutationOptions): Promise<FileVersionWrite>;

  /**
   * The file, with its Latest (no bytes).
   *
   * @wire GET /v1/files/:fileId
   */
  get(fileId: FileId | string): Promise<StoredFile>;

  /**
   * Delete the file and every version: a soft delete, kept until a
   * retention policy for `file_version` purges it. `deleted: false` when
   * it was already gone. A pinned version refuses it with
   * `409 file-version-pinned`.
   *
   * @wire DELETE /v1/files/:fileId
   */
  delete(fileId: FileId | string, options?: MutationOptions): Promise<DeleteFileResult>;

  /**
   * Every pin and unpin of the file's versions, newest first.
   *
   * @wire GET /v1/files/:fileId/pin-history
   */
  pinHistory(fileId: FileId | string, filter?: FilesPageFilter): Promise<ListPage<FilePinChange>>;

  /** A file's versions: list, add, read, download, restore, delete, pin and unpin. */
  readonly versions: FileVersionsClient;
}

export interface FileVersionsClient {
  /**
   * Every version, newest first, deleted and purged ones included: a
   * number is never left out of the history.
   *
   * @wire GET /v1/files/:fileId/versions
   */
  list(fileId: FileId | string, filter?: FilesPageFilter): Promise<ListPage<FileVersion>>;

  /**
   * Add the file's next version, which becomes Latest. With
   * `expectedVersion`, a Latest that isn't it is `409 file-version-conflict`
   * and nothing is written; without it, the last write wins. Bytes that are
   * already Latest's add nothing: the answer is Latest, with
   * `created: false`.
   *
   * @wire POST /v1/files/:fileId/versions (multipart)
   */
  add(
    fileId: FileId | string,
    input: AddFileVersionInput,
    options?: MutationOptions,
  ): Promise<FileVersionWrite>;

  /**
   * One version's record, without its bytes: a deleted or purged one too.
   *
   * @wire GET /v1/files/:fileId/versions/:version
   */
  get(fileId: FileId | string, version: FileVersionSelector): Promise<FileVersion>;

  /**
   * One version's bytes, streamed, and what the headers say. A deleted or
   * purged version is `404 file-version-not-found`: a fixed version never
   * falls back to Latest.
   *
   * @wire GET /v1/files/:fileId/versions/:version/content
   */
  download(fileId: FileId | string, version: FileVersionSelector): Promise<DownloadedFileVersion>;

  /**
   * Add a version with this version's bytes as Latest, recording what it
   * was restored from. Nothing is removed. `expectedVersion` and
   * `created: false` work as in `add`.
   *
   * @wire POST /v1/files/:fileId/versions/:version/restore
   */
  restore(
    fileId: FileId | string,
    version: number,
    input?: RestoreFileVersionInput,
    options?: MutationOptions,
  ): Promise<FileVersionWrite>;

  /**
   * Delete one version: a soft delete, and its number is never reused.
   * Deleting Latest moves Latest to the next live version down. A pinned
   * version is `409 file-version-pinned`; the file's last live version is
   * `409 file-last-version` (delete the file instead).
   *
   * @wire DELETE /v1/files/:fileId/versions/:version
   */
  delete(
    fileId: FileId | string,
    version: number,
    options?: MutationOptions,
  ): Promise<DeleteFileResult>;

  /**
   * A keep mark on one version, with who and why: it can't be deleted, and
   * retention never purges it. It never moves Latest. Pinning a pinned
   * version changes nothing.
   *
   * @wire POST /v1/files/:fileId/versions/:version/pin
   */
  pin(
    fileId: FileId | string,
    version: number,
    input?: PinFileVersionInput,
    options?: MutationOptions,
  ): Promise<FileVersion>;

  /**
   * Take a version's pin off, kept in the pin history with who and why.
   * Unpinning a version with no pin changes nothing.
   *
   * @wire POST /v1/files/:fileId/versions/:version/unpin
   */
  unpin(
    fileId: FileId | string,
    version: number,
    input?: PinFileVersionInput,
    options?: MutationOptions,
  ): Promise<FileVersion>;
}

/** A version number from 1, or `'latest'` for Latest. */
export type FileVersionSelector = number | 'latest';

/** How much of a list, and from where. */
export interface FilesPageFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
}

export interface ListFilesFilter extends FilesPageFilter {
  /** Only the files whose version 1 this run made. */
  readonly ownerRunId?: RunId | string;
  /** Only one project's files. */
  readonly projectId?: string;
  /** Only the files whose Latest has this type, exactly. */
  readonly contentType?: string;
}

/** Input for `files.create` (`POST /v1/files`, multipart). */
export interface CreateFileInput {
  /** The bytes. */
  readonly body: Blob | Uint8Array | string;
  /** Default: `file`. */
  readonly name?: string;
  /** Default: the Blob's type, else `application/octet-stream`. */
  readonly contentType?: string;
  /** Labels for this version. */
  readonly tags?: Readonly<Record<string, string>>;
  /** The run that produced it: the file belongs to its project. */
  readonly ownerRunId?: RunId | string;
  /** With no `ownerRunId`: the project it belongs to. */
  readonly projectId?: string;
  /** sha256, hex, lowercase: the upload is refused when the bytes differ. */
  readonly expectedHash?: string;
}

/** Input for `files.versions.add` (`POST /v1/files/{fileId}/versions`, multipart). */
export interface AddFileVersionInput {
  /** The bytes. */
  readonly body: Blob | Uint8Array | string;
  /** A different name for the file. Default: Latest's. */
  readonly name?: string;
  /** Default: the Blob's type, else `application/octet-stream`. */
  readonly contentType?: string;
  /** Labels for this version. */
  readonly tags?: Readonly<Record<string, string>>;
  /** The version the writer read: when Latest isn't it, nothing is written. */
  readonly expectedVersion?: number;
  /** sha256, hex, lowercase: the upload is refused when the bytes differ. */
  readonly expectedHash?: string;
}

export interface RestoreFileVersionInput {
  /** As in `add`: when Latest isn't it, nothing is written. */
  readonly expectedVersion?: number;
}

export interface PinFileVersionInput {
  /** Why, kept in the pin history. */
  readonly reason?: string;
}

/** What `files.versions.download` returns: the bytes, streamed, and what the headers say. */
export interface DownloadedFileVersion {
  readonly fileId: string;
  /** The version served: Latest's number when `'latest'` was asked for. */
  readonly version: number;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  /** sha256, hex, lowercase. */
  readonly hash: string;
  readonly body: ReadableStream<Uint8Array>;
}

interface MutationOptions {
  readonly idempotencyKey?: string;
}

export function makeFilesClient(transport: Transport): FilesClient {
  const seg = (s: string | number): string => encodeURIComponent(String(s));
  const page = (filter: FilesPageFilter | undefined) => ({
    ...(filter?.limit !== undefined && { limit: filter.limit }),
    ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
  });
  const idempotency = (options: MutationOptions | undefined) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};
  const idempotencyHeader = (options: MutationOptions | undefined) =>
    options?.idempotencyKey !== undefined
      ? { headers: { 'Idempotency-Key': options.idempotencyKey } }
      : {};

  const versions: FileVersionsClient = {
    async list(fileId, filter) {
      return listPage(
        await transport.request<WirePage<FileVersion>>({
          method: 'GET',
          path: `/v1/files/${seg(fileId)}/versions`,
          query: page(filter),
        }),
      );
    },
    async add(fileId, input, options) {
      const res = await rawRequest(transport, {
        method: 'POST',
        path: `/v1/files/${seg(fileId)}/versions`,
        body: uploadForm(input, {
          expectedVersion:
            input.expectedVersion !== undefined ? String(input.expectedVersion) : undefined,
        }),
        ...idempotencyHeader(options),
      });
      return (await res.json()) as FileVersionWrite;
    },
    async get(fileId, version) {
      return transport.request<FileVersion>({
        method: 'GET',
        path: `/v1/files/${seg(fileId)}/versions/${seg(version)}`,
      });
    },
    async download(fileId, version) {
      const res = await rawRequest(transport, {
        method: 'GET',
        path: `/v1/files/${seg(fileId)}/versions/${seg(version)}/content`,
      });
      return {
        fileId: fileId as string,
        version: Number(res.headers.get('X-Kindgi-File-Version') ?? version),
        ...bytesHeaders(res),
        body: res.body ?? new Response('').body!,
      };
    },
    async restore(fileId, version, input, options) {
      return transport.request<FileVersionWrite>({
        method: 'POST',
        path: `/v1/files/${seg(fileId)}/versions/${seg(version)}/restore`,
        body: input ?? {},
        ...idempotency(options),
      });
    },
    async delete(fileId, version, options) {
      return transport.request<DeleteFileResult>({
        method: 'DELETE',
        path: `/v1/files/${seg(fileId)}/versions/${seg(version)}`,
        ...idempotency(options),
      });
    },
    async pin(fileId, version, input, options) {
      return transport.request<FileVersion>({
        method: 'POST',
        path: `/v1/files/${seg(fileId)}/versions/${seg(version)}/pin`,
        body: input ?? {},
        ...idempotency(options),
      });
    },
    async unpin(fileId, version, input, options) {
      return transport.request<FileVersion>({
        method: 'POST',
        path: `/v1/files/${seg(fileId)}/versions/${seg(version)}/unpin`,
        body: input ?? {},
        ...idempotency(options),
      });
    },
  };

  return {
    async list(filter) {
      return listPage(
        await transport.request<WirePage<StoredFile>>({
          method: 'GET',
          path: '/v1/files',
          query: {
            ...page(filter),
            ...(filter?.ownerRunId !== undefined && { ownerRunId: filter.ownerRunId as string }),
            ...(filter?.projectId !== undefined && { projectId: filter.projectId }),
            ...(filter?.contentType !== undefined && { contentType: filter.contentType }),
          },
        }),
      );
    },
    async create(input, options) {
      const res = await rawRequest(transport, {
        method: 'POST',
        path: '/v1/files',
        body: uploadForm(input, {
          ownerRunId: input.ownerRunId as string | undefined,
          projectId: input.projectId,
        }),
        ...idempotencyHeader(options),
      });
      return (await res.json()) as FileVersionWrite;
    },
    async get(fileId) {
      return transport.request<StoredFile>({
        method: 'GET',
        path: `/v1/files/${seg(fileId)}`,
      });
    },
    async delete(fileId, options) {
      return transport.request<DeleteFileResult>({
        method: 'DELETE',
        path: `/v1/files/${seg(fileId)}`,
        ...idempotency(options),
      });
    },
    async pinHistory(fileId, filter) {
      return listPage(
        await transport.request<WirePage<FilePinChange>>({
          method: 'GET',
          path: `/v1/files/${seg(fileId)}/pin-history`,
          query: page(filter),
        }),
      );
    },
    versions,
  };
}
