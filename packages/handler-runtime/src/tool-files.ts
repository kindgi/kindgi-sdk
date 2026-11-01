// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack tool's files (pack protocol 2.10.0). The runtime sends a call of a
 * tool that declares `storesFiles` or `readsFiles` its tool files
 * (`ctx.toolFiles`: a link and a token). The runner keeps them from the
 * handler and gives the handler `files` instead: each store posts the
 * file's bytes to the link, each read gets a file's bytes from the link and
 * the file's id, with the token in `Authorization`, and each answers what
 * the runtime answered. The handler never sees the link or the token.
 */

import {
  type FileNotStoredReason,
  type FileReadAnswer,
  type FileStore,
  type FileStoreAnswer,
  type FileToStore,
  MAX_STORED_FILE_BYTES,
} from '@kindgi/tools';
import {
  FILE_NOT_READ_REASONS,
  type FileNotReadReason,
  bearerValueProblem,
  headerValueProblem,
  isFileValue,
} from '@kindgi/types';

import type { ToolFilesRef } from './protocol.js';

const NOT_STORED_REASONS: ReadonlySet<unknown> = new Set<FileNotStoredReason>([
  'type',
  'size',
  'limit',
  'storage',
]);

const NOT_READ_REASONS: ReadonlySet<unknown> = new Set<FileNotReadReason>(FILE_NOT_READ_REASONS);

/**
 * The call's tool files, when the runtime sent usable ones: an http(s)
 * link and a token fetch can send. Anything else is none, and the handler
 * gets no `files`.
 */
export function toolFilesOf(value: unknown): ToolFilesRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { url, token } = value as { readonly url?: unknown; readonly token?: unknown };
  if (typeof url !== 'string' || !isHttpUrl(url)) return undefined;
  if (typeof token !== 'string' || token.length === 0 || bearerValueProblem(token) !== undefined) {
    return undefined;
  }
  return { url, token };
}

function isHttpUrl(url: string): boolean {
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  return parsed?.protocol === 'https:' || parsed?.protocol === 'http:';
}

/**
 * The files a handler gets from a call's `link`: `store` and
 * `read` as `may` says, from what the tool declares.
 */
export function fileStoreOf(
  link: ToolFilesRef,
  may: { readonly store: boolean; readonly read: boolean },
  signal?: AbortSignal,
): FileStore {
  return Object.freeze({
    ...(may.store && {
      store: async (file: FileToStore): Promise<FileStoreAnswer> => {
        checkFile(file);
        // Over every type's limit: the runtime would answer `size`, so nothing is sent.
        if (file.bytes.byteLength > MAX_STORED_FILE_BYTES) return { notStored: 'size' };
        const response = await fetch(link.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${link.token}`,
            'content-type': sendableType(file.contentType),
            'kindgi-file-name': encodeURIComponent(wellFormed(file.name)),
          },
          body: file.bytes,
          ...(signal !== undefined && { signal }),
        });
        return storeAnswerOf(response);
      },
    }),
    ...(may.read && {
      read: async (artifactId: string): Promise<FileReadAnswer> => {
        if (typeof artifactId !== 'string' || artifactId === '') {
          throw new TypeError("files.read takes a file value's artifactId, a string");
        }
        const response = await fetch(
          `${link.url.replace(/\/+$/, '')}/${encodeURIComponent(wellFormed(artifactId))}`,
          {
            headers: { authorization: `Bearer ${link.token}` },
            ...(signal !== undefined && { signal }),
          },
        );
        return readAnswerOf(response);
      },
    }),
  });
}

/**
 * `text` with each lone surrogate as U+FFFD, as `String.prototype.toWellFormed`
 * (ES2024, past the language version this package compiles to) gives it: a
 * name or an id from JSON can hold one, and `encodeURIComponent` throws on
 * it. An id made so names no file, which the runtime answers `rule`.
 */
function wellFormed(text: string): string {
  return text.replace(/\p{Cs}/gu, '\uFFFD');
}

/** A JavaScript handler's file, checked: TypeScript can't hold it to `FileToStore`. */
function checkFile(file: FileToStore): void {
  if (
    typeof file?.name !== 'string' ||
    typeof file.contentType !== 'string' ||
    !(file.bytes instanceof Uint8Array)
  ) {
    throw new TypeError(
      'files.store takes { name: string, contentType: string, bytes: Uint8Array }',
    );
  }
}

/**
 * The declared type as a header can carry it. The runtime decides by the
 * bytes, so a type fetch would refuse to send (a line break, a character
 * above U+00FF) goes as `application/octet-stream`.
 */
function sendableType(contentType: string): string {
  return contentType === '' || headerValueProblem(contentType) !== undefined
    ? 'application/octet-stream'
    : contentType;
}

/** The runtime's answer to a store, or a throw naming its status and error code. */
async function storeAnswerOf(response: Response): Promise<FileStoreAnswer> {
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status !== 200) throw refused('files.store', response.status, body);
  const answer = body as { readonly file?: unknown; readonly notStored?: unknown } | undefined;
  if (isFileValue(answer?.file)) return { file: answer.file };
  if (NOT_STORED_REASONS.has(answer?.notStored)) {
    return { notStored: answer?.notStored as FileNotStoredReason };
  }
  throw new Error("files.store: the runtime's answer isn't a stored file or a reason");
}

/**
 * The runtime's answer to a read: the bytes (`application/octet-stream`),
 * or why there are none (JSON), or a throw naming its status and error code.
 */
async function readAnswerOf(response: Response): Promise<FileReadAnswer> {
  const type = response.headers.get('content-type') ?? '';
  if (response.status === 200 && /^application\/octet-stream\b/i.test(type)) {
    return { bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status !== 200) throw refused('files.read', response.status, body);
  const notRead = (body as { readonly notRead?: unknown } | undefined)?.notRead;
  if (NOT_READ_REASONS.has(notRead)) return { notRead: notRead as FileNotReadReason };
  throw new Error("files.read: the runtime's answer isn't a file's bytes or a reason");
}

/** A refusal's error, naming the status and the error code; never the token. */
function refused(what: string, status: number, body: unknown): Error {
  const code = (body as { readonly error?: { readonly code?: unknown } } | undefined)?.error?.code;
  return new Error(
    `${what}: the runtime answered ${status}${typeof code === 'string' ? ` (${code})` : ''}`,
  );
}
