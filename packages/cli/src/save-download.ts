// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Writing a download to a file (`kindgi files download`, `kindgi artifacts
 * download`): the bytes go to a file beside the target, which takes the
 * target's name only once the whole body has arrived with the sha256 the
 * server sent.
 */

import { createHash, randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { placeNew } from './place-file.js';

/** What a download answers: its bytes, and the name and sha256 its headers give. */
export interface Downloaded {
  readonly name: string;
  readonly hash: string;
  readonly body: ReadableStream<Uint8Array>;
}

/** A download's target that's already there, without --force. */
export const existsError = (target: string) =>
  new Error(`${target} exists: pass --force to overwrite it, or -o <file>`);

/**
 * The download's answer, unless the stop comes first: then the stop's
 * reason is thrown at once, and a body that still arrives is cancelled.
 */
export async function unlessStopped<T extends Downloaded>(
  answer: Promise<T>,
  stop: AbortSignal | undefined,
): Promise<T> {
  if (stop === undefined) return answer;
  let onStop = (): void => undefined;
  const stopped = new Promise<never>((_, reject) => {
    onStop = () => reject(stop.reason);
  });
  if (stop.aborted) onStop();
  else stop.addEventListener('abort', onStop, { once: true });
  try {
    return await Promise.race([answer, stopped]);
  } catch (err) {
    if (stop.aborted) void answer.then((got) => got.body.cancel()).catch(() => undefined);
    throw err;
  } finally {
    stop.removeEventListener('abort', onStop);
  }
}

/**
 * The body written to a new file beside `target` (as `kindgi exports
 * create` writes its files), which takes `target`'s name only once the
 * whole body has arrived: the stream ended, with the sha256 the server
 * sent. With `force`, it is renamed over `target`; without, it takes the
 * name only while nothing has it (`placeNew`). Otherwise that file is
 * removed, and `target` is as it was: the stop (`stop`, a Ctrl+C) ends
 * the stream as a cut connection does. `whose` names what the server's
 * sha256 is of (`the artifact's`, `version 3's`). Returns the size and
 * sha256 of the bytes written.
 */
export async function saveWhole(
  got: Downloaded,
  target: string,
  force: boolean,
  stop: AbortSignal | undefined,
  whose: string,
): Promise<{ size: number; hash: string }> {
  const partial = `${target}.${randomBytes(4).toString('hex')}.partial`;
  const file = await open(partial, 'wx').catch(async (err: unknown) => {
    await got.body.cancel();
    throw err;
  });
  const sha256 = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      Readable.fromWeb(got.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          sha256.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      file.createWriteStream(),
      { ...(stop !== undefined && { signal: stop }) },
    );
  } catch (err) {
    await rm(partial, { force: true });
    throw new Error(
      `the download stopped part way (${(err as Error).message}): ${target} wasn't written`,
      { cause: err },
    );
  }
  // The route sends the sha256 as lowercase hex, as digest('hex') gives it.
  const hash = sha256.digest('hex');
  // With no hash header (a proxy may drop it), the stream's end is all there is to go on.
  if (got.hash !== '' && hash !== got.hash) {
    await rm(partial, { force: true });
    throw new Error(
      `the bytes that arrived have the sha256 ${hash}, not ${whose} ${got.hash}: ${target} wasn't written`,
    );
  }
  try {
    await (force ? rename(partial, target) : placeNew(partial, target, () => existsError(target)));
  } finally {
    // Gone after a rename; after a link, its second name; after a failure, the file.
    await rm(partial, { force: true });
  }
  return { size, hash };
}

/** The file a download writes unless `-o` names one: the download's own name, or `id` when that name is no file's. */
export function ownName(name: string, id: string): string {
  const own = basename(name);
  return own === '' || own === '.' || own === '..' ? basename(id) : own;
}
