// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { ApiError } from '@google/genai';
import { ModelProviderError, kindOf } from '@kindgi/adapter-model-shared';

/**
 * A failed call as the shared typed error (`ModelProviderError`), its kind
 * from the status and the vendor's words (the response's body), with the
 * SDK's error as its `cause` and its message as it was. A request that got
 * no response (a fetch that failed) and an abort aren't the SDK's
 * `ApiError`: the caller sees them as they are.
 */
export function typedFailure(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const { status, message } = error;
  return new ModelProviderError(kindOf({ status, words: message }), status, message, {
    cause: error,
  });
}
