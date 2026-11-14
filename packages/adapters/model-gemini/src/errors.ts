// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { ApiError } from '@google/genai';
import {
  ModelProviderError,
  isTransport,
  kindOf,
  modelProviderError,
  refusedConnection,
  withCauses,
} from '@kindgi/adapter-model-shared';

/**
 * A failed call as the shared typed error (`ModelProviderError`), with what
 * the SDK threw as its `cause`. A response that refuses it: its kind from the
 * status and the vendor's words (the response's body), and its message as it
 * was. No response (a dropped or refused connection, DNS, TLS) is `network`:
 * the SDK's `fetch failed` doesn't say why, so what its causes add follows
 * it. A connection the runtime refuses (its egress or body-size rule) says
 * its own words. The call's abort, and anything else, are the caller's to
 * see as they are.
 */
export function typedFailure(error: unknown, abortSignal?: AbortSignal): unknown {
  if (error instanceof ApiError) {
    const { status, message } = error;
    return new ModelProviderError(kindOf({ status, words: message }), status, message, {
      cause: error,
    });
  }
  if (abortSignal?.aborted === true) return error;
  const refused = refusedConnection(error);
  if (refused !== undefined) return modelProviderError(refused, error);
  if (error instanceof Error && isTransport(error)) {
    return modelProviderError({ words: withCauses(error.message, error) }, error);
  }
  return error;
}
