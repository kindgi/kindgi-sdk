// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/** At most `limit` UTF-16 units, never ending in half a character. */
export function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // A high surrogate at the end would be half a character.
  const last = text.charCodeAt(limit - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
  return text.slice(0, end);
}
