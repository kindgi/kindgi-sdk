// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Page } from '@kindgi/types';

/**
 * What every list call answers: the wire's page — `data`, `hasMore` and
 * `nextCursor` — as the API and the Python client have it. `items` is the
 * same list under the name the client used first: readable, but not an
 * own enumerable property, so a page serializes with its list once.
 */
export interface ListPage<T> extends Page<T> {
  readonly data: readonly T[];
  /** Whether there's another page (`nextCursor` names it). */
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
  /** @deprecated Use `data`; removed in 0.2. */
  readonly items: readonly T[];
}

/** A page as the list routes send it. */
export interface WirePage<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

/** The client's page from a wire page. */
export function listPage<T>(page: WirePage<T>): ListPage<T> {
  const result = {
    data: page.data,
    hasMore: page.hasMore,
    ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as Cursor }),
  };
  Object.defineProperty(result, 'items', { get: () => result.data, enumerable: false });
  return result as ListPage<T>;
}
