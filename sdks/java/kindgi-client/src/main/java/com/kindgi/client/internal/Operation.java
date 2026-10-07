// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

/**
 * One operation of the API, as the generated operation table ({@code Operations}) lists it.
 *
 * @param id the operation id ({@code runs.start})
 * @param method the HTTP method
 * @param path the path template ({@code /v1/runs/{runId}})
 * @param kind what the answer is
 * @param idempotencyKey whether it takes an {@code Idempotency-Key} (one is generated when the
 *     caller gives none, so a retry never runs it twice)
 */
public record Operation(String id, String method, String path, Kind kind, boolean idempotencyKey) {
  /** What an operation answers. */
  public enum Kind {
    /** A JSON body. */
    JSON,
    /** Server-sent events. */
    SSE,
    /** Bytes. */
    BINARY,
    /** Nothing. */
    EMPTY
  }

  /** @return whether a retry can't do the work twice: a GET, or a call with an idempotency key */
  public boolean safeToRetry() {
    return method.equals("GET") || idempotencyKey;
  }
}
