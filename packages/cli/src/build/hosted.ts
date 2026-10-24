// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Building on Kindgi hosted (`kindgi build --hosted`, or the env block's
 * `build: 'hosted'`). The hosted build service speaks the build server's
 * contract (`POST /v1/build`, its log stream and status), at the API's own
 * address under `/cloud`, and takes the CLI's API key. It chooses where
 * the image goes: the workspace's own repository.
 */

/** The env block's `build` value that means the hosted build service. */
export const HOSTED_BUILD = 'hosted';

/** Where the hosted build service is, under the API's address. */
const HOSTED_BUILD_PATH = '/cloud';

/** The largest pack the hosted build service takes, packed. */
export const HOSTED_UPLOAD_MAX_BYTES = 30 * 1024 * 1024;

/** What goes into a pack's image, and how to keep it small. */
export const PACK_IMAGE_DOCS_URL =
  'https://docs.kindgi.com/v0.1/start/existing-app-typescript/#what-the-packs-image-needs';

/** The hosted build service of the API at `apiUrl`. */
export function hostedBuildEndpoint(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}${HOSTED_BUILD_PATH}`;
}

/** A pack too large to send to the hosted build service: the message to print, else undefined. */
export function hostedUploadTooLarge(bytes: number): string | undefined {
  if (bytes <= HOSTED_UPLOAD_MAX_BYTES) return undefined;
  return (
    `The packed pack is ${mebibytes(bytes)}, over the ${mebibytes(HOSTED_UPLOAD_MAX_BYTES)} ` +
    `the hosted build service takes, so it wasn't sent. ${PACK_IMAGE_DOCS_URL} says what the ` +
    "pack's image needs.\n"
  );
}

/**
 * A build service's refusal, `{ error: { code, message } }`, with the
 * answer's status and its `Retry-After`, in seconds, when it has one.
 */
export class BuildServiceRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'BuildServiceRefusal';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A `Retry-After` header in whole seconds, else undefined (an HTTP date isn't waited on). */
export function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

/** How a refusal reads on stderr: its message, its code, and the wait it asked. */
export function describeBuildRefusal(refusal: BuildServiceRefusal): string {
  const wait =
    refusal.retryAfterSeconds !== undefined
      ? ` Try again in ${refusal.retryAfterSeconds} s.`
      : '';
  return `The build service refused the build (HTTP ${refusal.status}, ${refusal.code}): ${refusal.message}${wait}\n`;
}

function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MiB`;
}
