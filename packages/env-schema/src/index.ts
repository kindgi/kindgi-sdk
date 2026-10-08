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
  AUTH_PRIVATE_IDP_ORIGINS_VAR,
  AUTH_SECRET_PATH_VAR,
  AUTH_SECRET_VAR,
  CORS_ORIGINS_VAR,
  PUBLIC_URL_VAR,
  SESSION_IDLE_TIMEOUT_MS_VAR,
  CONSOLE_TOKEN_SIGN_IN_VAR,
  SESSION_TTL_MS_VAR,
  LICENSE_KEY_VAR,
  PACK_SERVICE_TOKEN_VAR,
  PUBLIC_TOKEN_KEY_PATH_VAR,
  PUBLIC_TOKEN_KEY_VAR,
  parseCorsOrigins,
  parsePublicUrl,
  parsePackServiceToken,
} from './values.js';
