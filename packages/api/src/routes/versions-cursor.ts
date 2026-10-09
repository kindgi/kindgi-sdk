// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The blocks and tools `/versions` cursors, as their registry bindings
 * issue them (`BlockListVersionsInput.cursor`,
 * `ToolListVersionsInput.cursor`): url-safe base64 of `{ p, i }` (the last
 * version's publish time as stored, its row id) or, from before, of a bare
 * time. The routes refuse anything else with `400 bad-input`: a binding
 * reads a cursor it didn't issue as no cursor, the first page again, and a
 * client paging until done would start over.
 */

import { isCursorTime } from './pagination.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRegistryVersionsCursor(raw: string): boolean {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  if (!decoded.startsWith('{')) return isCursorTime(decoded);
  try {
    const parsed = JSON.parse(decoded) as { p?: unknown; i?: unknown };
    return (
      typeof parsed.p === 'string' &&
      isCursorTime(parsed.p) &&
      typeof parsed.i === 'string' &&
      UUID_RE.test(parsed.i)
    );
  } catch {
    return false;
  }
}
