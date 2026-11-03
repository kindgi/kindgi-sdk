// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** The request's body, at most `max` bytes; `too-large` past it (read no further). */
export async function readCapped(request: Request, max: number): Promise<Uint8Array | 'too-large'> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return 'too-large';
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return 'too-large';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
