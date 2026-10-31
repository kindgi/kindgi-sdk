// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { modelProviderError } from '@kindgi/adapter-model-shared';

/**
 * A failed call as the shared typed error (`ModelProviderError`), its kind
 * from the status and the vendor's words, with the SDK's error as its
 * `cause` and the same message: `modelProviderError` puts the status back
 * in front of the words `APIError` put it in front of. No status is no
 * response (`network`). An abort, and anything that isn't the SDK's API
 * error, is the caller's to see as it is.
 */
export function typedFailure(error: unknown): unknown {
  if (!(error instanceof APIError) || error instanceof APIUserAbortError) return error;
  const { status } = error;
  const prefix = status !== undefined ? `${status} ` : '';
  const words = error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : error.message;
  return modelProviderError({ ...(status !== undefined && { status }), words }, error);
}
