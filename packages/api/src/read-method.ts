// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Whether `method` reads: GET or HEAD. Hono answers a HEAD with its
 * route's GET handler (the GET's status and headers, without the body),
 * while `c.req.method` still says HEAD. So whatever a check asks of a GET,
 * it asks of a HEAD too: the same right, never less and never more.
 */
export function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}
