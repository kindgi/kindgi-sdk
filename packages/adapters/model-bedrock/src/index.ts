// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  BEDROCK_ADAPTER_ID,
  BEDROCK_AUTHS,
  type BedrockAuth,
  type BedrockConfig,
  bedrockRuntimeEndpoint,
  isBedrockRuntimeHost,
  partitionDnsSuffix,
  readBedrockConfig,
} from './config.js';
export {
  IDENTITY_TIMEOUT_MS,
  bedrockAdapterEntry,
  bedrockAdapterFactory,
  bedrockCheckConfig,
} from './entry.js';
export { NOVA_THINKING_REMOVED, isNovaModel, withoutLeadingThinking } from './nova-thinking.js';
