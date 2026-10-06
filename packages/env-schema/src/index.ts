// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export {
  ENV_GROUPS,
  type EnvTarget,
  type EnvVarSpec,
  KINDGI_ENV_SCHEMA,
  envVarsForTarget,
  renderEnvExample,
  validateEnvForTarget,
} from './schema.js';
export {
  CORS_ORIGINS_VAR,
  PUBLIC_URL_VAR,
  LICENSE_KEY_VAR,
  PACK_SERVICE_TOKEN_VAR,
  PUBLIC_TOKEN_KEY_PATH_VAR,
  PUBLIC_TOKEN_KEY_VAR,
  parseCorsOrigins,
  parsePublicUrl,
  parsePackServiceToken,
} from './values.js';
