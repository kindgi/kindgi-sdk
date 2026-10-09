// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  AZURE_OPENAI_ADAPTER_ID,
  AZURE_OPENAI_APIS,
  AZURE_OPENAI_AUTHS,
  AZURE_OPENAI_CLOUDS,
  type AzureOpenAIApi,
  type AzureOpenAIAuth,
  type AzureOpenAIConfig,
  azureCloudOf,
  readAzureOpenAIConfig,
} from './config.js';
export {
  AZURE_OPENAI_SCOPE,
  IDENTITY_TIMEOUT_MS,
  azureOpenAIAdapterEntry,
  azureOpenAIAdapterFactory,
  azureOpenAICheckConfig,
} from './entry.js';
