// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `.env.<envName>` set / unset primitives — re-exported from the shared
 * `@kindgi/dotenv-file` package so `kindgi env` and the dev-mode
 * `SecretBinding` in `@kindgi/secrets-dotenv` agree on the write shape.
 */

export { EnvValueNotRepresentableError, setKey, unsetKey } from '@kindgi/dotenv-file';
