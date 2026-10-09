// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  BEDROCK_ADAPTER_ID,
  BEDROCK_AUTHS,
  type BedrockAuth,
  type BedrockConfig,
  bedrockRuntimeEndpoint,
  readBedrockConfig,
} from './config.js';
export { bedrockAdapterEntry, bedrockAdapterFactory, bedrockCheckConfig } from './entry.js';
