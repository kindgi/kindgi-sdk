// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  BASE_URLS,
  EXTRA_BODY_PREFIX,
  EXTRA_BODY_RESERVED,
  OPENAI_COMPAT_ADAPTER_ID,
  createOpenAICompatModelProvider,
  openAICompatAdapterFactory,
  openAICompatBaseUrl,
  openAICompatExtraBody,
} from './provider.js';
export type { OpenAICompatProviderOptions } from './provider.js';
export type { ModelProvider } from '@kindgi/capabilities';
