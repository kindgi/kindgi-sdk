// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/dotenv-file` — dotenv files the way applications read them,
 * written the way people edit them.
 *
 *   - **Read** (`parse.ts`): `dotenv`'s grammar (verified against the
 *     version Next.js bundles), returned as structured lines so edits
 *     round-trip losslessly.
 *   - **Expand** (`expand.ts`): `${VAR}` / `${VAR:-default}` / `\$`,
 *     agreeing with `dotenv-expand` wherever its versions agree.
 *   - **Layer** (`layers.ts`): several files (`.env` < `.env.local`) as
 *     one view, with per-key origin.
 *   - **Write** (`serialize.ts`): `setKey` / `unsetKey` touch one key and
 *     keep every other byte; values are quoted so they read back
 *     exactly.
 *
 * Zero runtime dependencies and no filesystem access — callers read and
 * write the files. See `README.md`.
 */

export {
  type ExpandDiagnostic,
  type ExpandOptions,
  type ExpandResult,
  expandEnv,
} from './expand.js';
export {
  type EnvDiagnostic,
  type EnvLayer,
  type LayeredEnv,
  readEnv,
  readEnvLayers,
} from './layers.js';
export {
  DOTENV_KEY_REGEX,
  ENV_KEY_REGEX,
  type EnvLine,
  envLinesToRecord,
  parseEntryRaw,
  parseEnvFile,
} from './parse.js';
export {
  EnvValueNotRepresentableError,
  renderEntry,
  serializeEnvFile,
  setKey,
  unsetKey,
} from './serialize.js';
