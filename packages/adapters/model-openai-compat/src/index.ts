// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  BASE_URLS,
  EXTRA_BODY_PREFIX,
  EXTRA_BODY_RESERVED,
  OPENAI_COMPAT_ADAPTER_ID,
  OPENAI_COMPAT_APIS,
  createOpenAICompatModelProvider,
  openAICompatAdapterEntry,
  openAICompatCheckConfig,
  defaultOpenAICompatApi,
  openAICompatAdapterFactory,
  openAICompatApi,
  openAICompatBaseUrl,
  openAICompatExtraBody,
} from './provider.js';
export { EXTRA_BODY_RESERVED_RESPONSES } from './responses.js';
export type { OpenAICompatApi, OpenAICompatProviderOptions } from './provider.js';
export type { ModelProvider } from '@kindgi/capabilities';
