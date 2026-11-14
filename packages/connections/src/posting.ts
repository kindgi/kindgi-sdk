// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * What the posting tools share: the images a post takes, read from the
 * run's files and checked from their bytes before anything leaves. Not a
 * package subpath.
 */

import type { JsonSchema, ToolContext } from '@kindgi/tools';
import type { FileNotReadReason } from '@kindgi/types';

/** An image a post takes: a file the run may be shown. */
export interface PostImage {
  /** The file value's `artifactId`. */
  readonly file: string;
  /** Words that say what the image shows, for people who can't see it. */
  readonly altText?: string;
}

/** An image's type and size, as its bytes say. */
export interface ImageBytes {
  readonly type: 'jpeg' | 'png' | 'gif';
  readonly width: number;
  readonly height: number;
}

/** The JSON schema of one `PostImage`, with the network's longest `altText`. */
export function postImageSchema(altTextChars: number): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['file'],
    properties: {
      file: { type: 'string', minLength: 1 },
      altText: { type: 'string', maxLength: altTextChars },
    },
  };
}

const NOT_READ: Readonly<Record<FileNotReadReason, string>> = {
  rule: "isn't one this run may be shown",
  gone: 'is gone: it was deleted, or its bytes are missing',
  changed: "isn't the one that was checked when it was stored",
  size: "is over its type's size limit",
};

/**
 * Each image's bytes, in order, and what they are. Throws in words, before
 * anything is posted, when the call can't read files or a file can't be
 * read. A post with no images reads nothing, so it needs no file reads.
 */
export async function readPostImages(
  ctx: Pick<ToolContext, 'files'>,
  images: readonly PostImage[],
): Promise<{ readonly bytes: Uint8Array; readonly image: ImageBytes | undefined }[]> {
  if (images.length === 0) return [];
  const read = ctx.files?.read;
  if (read === undefined) {
    throw new Error(
      "The runtime gives this call no way to read the run's files, so nothing was posted.",
    );
  }
  const out: { readonly bytes: Uint8Array; readonly image: ImageBytes | undefined }[] = [];
  for (const { file } of images) {
    const answer = await read(file);
    if ('notRead' in answer) {
      throw new Error(`The file ${file} ${NOT_READ[answer.notRead]}, so nothing was posted.`);
    }
    out.push({ bytes: answer.bytes, image: imageOf(answer.bytes) });
  }
  return out;
}

/** What an image's bytes say it is: a JPEG, PNG or GIF, and its width and height in pixels. */
export function imageOf(bytes: Uint8Array): ImageBytes | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = jpegSize(view) ?? pngSize(view) ?? gifSize(view);
  return size !== undefined && size.width > 0 && size.height > 0 ? size : undefined;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's size, from its first chunk, `IHDR`. */
function pngSize(view: DataView): ImageBytes | undefined {
  if (view.byteLength < 24 || !PNG_SIGNATURE.every((b, i) => view.getUint8(i) === b)) {
    return undefined;
  }
  if (ascii(view, 12, 4) !== 'IHDR') return undefined;
  return { type: 'png', width: view.getUint32(16), height: view.getUint32(20) };
}

/** A GIF's size, from its logical screen. */
function gifSize(view: DataView): ImageBytes | undefined {
  if (view.byteLength < 10) return undefined;
  const signature = ascii(view, 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return undefined;
  return { type: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/**
 * A JPEG's size, from its first frame header (an `SOF` marker): the
 * segments before it are skipped by their lengths.
 */
function jpegSize(view: DataView): ImageBytes | undefined {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return undefined;
  let at: number | ImageBytes | undefined = 2;
  while (typeof at === 'number') at = jpegStep(view, at);
  return at;
}

/**
 * From the marker at `at`: the frame header's size, else the next
 * marker's place (always further on), else `undefined` when there's no
 * frame header to find.
 */
function jpegStep(view: DataView, at: number): number | ImageBytes | undefined {
  if (at + 4 > view.byteLength || view.getUint8(at) !== 0xff) return undefined;
  const kind = jpegMarker(view.getUint8(at + 1));
  if (kind === 'end') return undefined;
  if (kind === 'fill') return at + 1;
  if (kind === 'bare') return at + 2;
  const length = view.getUint16(at + 2);
  if (length < 2) return undefined;
  if (kind === 'segment') return at + 2 + length;
  if (at + 9 > view.byteLength) return undefined;
  return { type: 'jpeg', height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
}

/**
 * What a JPEG marker is, on the way to the frame header: a fill byte
 * before a marker, a marker with no length (`bare`), the image's end or
 * its data (`end`), a frame header, or any other segment.
 */
function jpegMarker(marker: number): 'fill' | 'bare' | 'end' | 'frame' | 'segment' {
  if (marker === 0xff) return 'fill';
  if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) return 'bare';
  if (marker === 0xd9 || marker === 0xda) return 'end';
  // SOF0 to SOF15, but for DHT (C4), JPG (C8) and DAC (CC), which share the range.
  const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
  return frame ? 'frame' : 'segment';
}

function ascii(view: DataView, at: number, length: number): string {
  let s = '';
  for (let i = at; i < at + length; i++) s += String.fromCharCode(view.getUint8(i));
  return s;
}
