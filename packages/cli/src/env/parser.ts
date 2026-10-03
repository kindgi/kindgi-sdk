// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Re-exports the shared dotenv parser from `@kindgi/dotenv-file`. The
 * grammar + serialization rules are the same across `kindgi env`
 * subcommands and the dev-mode `SecretBinding` in `@kindgi/secrets-dotenv`
 * — extracting the primitive prevents drift between what the CLI writes
 * and what the binding reads.
 */

export {
  ENV_KEY_REGEX,
  type EnvLine,
  envLinesToRecord,
  parseEnvFile,
  serializeEnvFile,
} from '@kindgi/dotenv-file';
