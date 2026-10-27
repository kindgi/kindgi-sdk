// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A pack tool's file store (pack protocol 2.10.0). The runtime sends a call
 * of a tool that declares `storesFiles` a file upload (`ctx.fileUpload`: a
 * link and a token). The runner keeps it from the handler and gives the
 * handler `files.store` instead: each store posts the file's bytes to the
 * link, with the token in `Authorization`, and answers what the runtime
 * answered. The handler never sees the link or the token.
 */

import {
  type FileNotStoredReason,
  type FileStore,
  type FileStoreAnswer,
  type FileToStore,
  MAX_STORED_FILE_BYTES,
} from '@kindgi/tools';
import { bearerValueProblem, headerValueProblem, isFileValue } from '@kindgi/types';

import type { FileUploadRef } from './protocol.js';

const NOT_STORED_REASONS: ReadonlySet<unknown> = new Set<FileNotStoredReason>([
  'type',
  'size',
  'limit',
]);

/**
 * The call's upload, when the runtime sent a usable one: an http(s) link
 * and a token fetch can send. Anything else is no upload, and the handler
 * gets no `files`.
 */
export function fileUploadOf(value: unknown): FileUploadRef | undefined {
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

/** The file store a handler gets for a call that carried `upload`. */
export function fileStoreOf(upload: FileUploadRef, signal?: AbortSignal): FileStore {
  return Object.freeze({
    store: async (file: FileToStore): Promise<FileStoreAnswer> => {
      checkFile(file);
      // Over every type's limit: the runtime would answer `size`, so nothing is sent.
      if (file.bytes.byteLength > MAX_STORED_FILE_BYTES) return { notStored: 'size' };
      const response = await fetch(upload.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${upload.token}`,
          'content-type': sendableType(file.contentType),
          'kindgi-file-name': encodeURIComponent(wellFormed(file.name)),
        },
        body: file.bytes,
        ...(signal !== undefined && { signal }),
      });
      return answerOf(response);
    },
  });
}

/**
 * `text` with each lone surrogate as U+FFFD, as `String.prototype.toWellFormed`
 * (ES2024, past the language version this package compiles to) gives it: a
 * name from JSON can hold one, and `encodeURIComponent` throws on it.
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

/** The runtime's answer, or a throw naming its status and error code. */
async function answerOf(response: Response): Promise<FileStoreAnswer> {
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status === 200) {
    const answer = body as { readonly file?: unknown; readonly notStored?: unknown } | undefined;
    if (isFileValue(answer?.file)) return { file: answer.file };
    if (NOT_STORED_REASONS.has(answer?.notStored)) {
      return { notStored: answer?.notStored as FileNotStoredReason };
    }
    throw new Error("files.store: the runtime's answer isn't a stored file or a reason");
  }
  const code = (body as { readonly error?: { readonly code?: unknown } } | undefined)?.error?.code;
  throw new Error(
    `files.store: the runtime answered ${response.status}${typeof code === 'string' ? ` (${code})` : ''}`,
  );
}
