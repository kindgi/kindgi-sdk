// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor } from '@kindgi/types';

/**
 * What every list call answers: the wire's page — `data`, `hasMore` and
 * `nextCursor` — as the API and the Python client have it.
 */
export interface ListPage<T> {
  readonly data: readonly T[];
  /** Whether there's another page (`nextCursor` names it). */
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

/** A page as the list routes send it. */
export interface WirePage<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

/** The client's page from a wire page. */
export function listPage<T>(page: WirePage<T>): ListPage<T> {
  return {
    data: page.data,
    hasMore: page.hasMore,
    ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as Cursor }),
  };
}
