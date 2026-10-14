// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `@kindgi/secrets-dotenv` — dev-mode `SecretBinding` backed by the
 * pack's env files.
 *
 * In local development (`kindgi dev`) the Kindgi runtime uses this binding
 * for two roles: model adapters (Anthropic, OpenAI-compat, …) `resolve`
 * their API key at agent-turn time, and the `/v1/secrets/*` routes
 * (`@kindgi/api`) read and write through it.
 *
 * ## Which files
 *
 * See `pack-env.ts`. For `local` (the environment `kindgi dev` runs as)
 * the binding reads the project's own env files — `.env`, then
 * `.env.local` on top, overridable via `dev.envFiles` — the same files,
 * parsed the same way, as the application beside the pack, and then
 * Kindgi's own `.kindgi/secrets.env` on top of those. A key added to
 * `.env` by hand is a secret the pack can resolve; nothing needs to be
 * copied anywhere. Other environments read `.env.<envName>`.
 *
 * ## Semantics
 *
 *   - **Reads** (`list`, `get`, `resolve`, `getVersion`, `listVersions`):
 *     the merged, `${VAR}`-expanded view. `KINDGI_*` names are Kindgi
 *     runtime config and are invisible here. Version metadata is
 *     synthetic (`versionId: 1`) — dotenv files don't version. A file
 *     that exists but can't be read is left out, and a `resolve` that
 *     misses says which.
 *   - **`set`**: for `local`, writes Kindgi's `.kindgi/secrets.env`, a
 *     file the application doesn't load; with `appEnvFile`, the app's
 *     highest-precedence file (`.env.local` by default) instead, for a
 *     value the app reads too. Either way via `@kindgi/dotenv-file`'s
 *     `setKey` — one line changes, every other byte stays. `create-new`
 *     returns `already-exists` when the name is defined in ANY of the
 *     files. Before reading any file it refuses, as the caller's `400`, a
 *     name that isn't an env-file key, `KINDGI_*` or the reserved `kindgi.`
 *     prefix (`refusedName`), and a value no env-file quoting can hold so
 *     it reads back unchanged (`refusedValue`). Kindgi's file is written
 *     atomically, mode 0600; an app file keeps its mode.
 *   - **`rotate` / `revoke`**: not supported — the answer is "edit the
 *     env file", and the error says which files.
 *   - **Scope-blind**: dotenv files are flat, so the `Scope` on every
 *     input is ignored. Durable secret stores honor scope.
 *
 * ## NOT for production
 *
 * Plaintext on disk, no audit events, no versioning, no concurrent-write
 * safety, a filesystem read on every `resolve`. Deployments use a
 * durable, encrypted `SecretBinding` or an external secrets provider.
 */

import { randomUUID } from 'node:crypto';

import type {
  SecretBinding,
  SecretError,
  SecretGetInput,
  SecretGetVersionInput,
  SecretListInput,
  SecretListPage,
  SecretListVersionsInput,
  SecretNameRefusal,
  SecretRecord,
  SecretResolveInput,
  SecretResolveOutcome,
  SecretRevokeInput,
  SecretRevokeOutcome,
  SecretRotateInput,
  SecretRotateOutcome,
  SecretSetInput,
  SecretSetOutcome,
  SecretVersionPage,
  SecretVersionRecord,
} from '@kindgi/api';
import { RESERVED_SECRET_NAME_PREFIX } from '@kindgi/api';
import {
  ENV_KEY_REGEX,
  EnvValueNotRepresentableError,
  renderEntry,
  setKey,
} from '@kindgi/dotenv-file';
import type { Result } from '@kindgi/types';

import {
  type PackEnv,
  describeUnreadable,
  displayEnvPath,
  isRuntimeKey,
  packValues,
  readFileOrNull,
  readPackEnv,
} from './pack-env.js';
import { SECRETS_FILE_MODE, existingMode, writeAtomic } from './write-file.js';

export {
  type CopiedName,
  type CopyToKindgiFileInput,
  type CopyToKindgiFileResult,
  copyToKindgiFile,
  namesInAppFiles,
} from './copy.js';
export {
  DEFAULT_LOCAL_ENV_FILES,
  KINDGI_SECRETS_FILE,
  LOCAL_ENV_NAME,
  type PackEnv,
  type PackEnvFiles,
  type PackEnvFilesInput,
  RUNTIME_KEY_PREFIX,
  type ReadPackEnvInput,
  type UnreadableEnvFile,
  describeUnreadable,
  displayEnvPath,
  isRuntimeKey,
  packValues,
  readFileOrNull,
  readPackEnv,
  resolvePackEnvFiles,
  runtimeValues,
} from './pack-env.js';

export interface CreateDotenvSecretBindingOptions {
  /** Pack root — the directory holding `kindgi.config.ts`. */
  readonly packDir: string;
  /**
   * Files read for `local`, lowest precedence first (relative to
   * `packDir`). Defaults to `.env`, `.env.local`. Set it from
   * `dev.envFiles` in `kindgi.config.ts`.
   */
  readonly localEnvFiles?: readonly string[];
  /**
   * Fallback for `${VAR}` references no file defines — typically the
   * process environment. Never overrides a file's own value.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function createDotenvSecretBinding(
  options: CreateDotenvSecretBindingOptions,
): SecretBinding {
  const { packDir } = options;

  const load = (envName: SecretRecord['envName']): Promise<PackEnv> =>
    readPackEnv({
      packDir,
      envName: envName as unknown as string,
      ...(options.localEnvFiles !== undefined && { localEnvFiles: options.localEnvFiles }),
      ...(options.env !== undefined && { env: options.env }),
    });

  const secretsOf = async (envName: SecretRecord['envName']): Promise<Record<string, string>> =>
    packValues((await load(envName)).values);

  const filesLabel = (env: PackEnv): string =>
    env.files.read.map((p) => displayEnvPath(packDir, p)).join(', ');

  async function get(input: SecretGetInput): Promise<SecretRecord | null> {
    return Object.hasOwn(await secretsOf(input.envName), input.name) ? toRecord(input) : null;
  }

  async function list(input: SecretListInput): Promise<SecretListPage> {
    const prefix = input.namePrefix;
    const names = Object.keys(await secretsOf(input.envName))
      .filter((k) => prefix === undefined || k.startsWith(prefix))
      .sort();
    return {
      data: names
        .slice(0, input.limit)
        .map((name) => toRecord({ scope: input.scope, envName: input.envName, name })),
    };
  }

  async function resolve(
    input: SecretResolveInput,
  ): Promise<Result<SecretResolveOutcome, SecretError>> {
    // Attribution context is a no-op here — durable stores use it for
    // the compliance-evidence audit event (see `@kindgi/compliance`).
    void input.resolveContext;
    const env = await load(input.envName);
    const secrets = packValues(env.values);
    if (!Object.hasOwn(secrets, input.name)) {
      const unread =
        env.unreadable.length > 0
          ? ` (couldn't read ${describeUnreadable(packDir, env.unreadable)})`
          : '';
      return {
        kind: 'err',
        error: {
          code: 'secret-not-found',
          message: `No secret "${input.name}" for env "${input.envName as unknown as string}" in ${filesLabel(env)} at ${packDir}${unread}`,
          name: input.name,
        },
      };
    }
    return {
      kind: 'ok',
      // Scope-blind: the value is the same at every scope, so it's read at
      // the one asked for (an `exact` read included: there's no walk).
      value: {
        name: input.name,
        versionId: 1,
        value: secrets[input.name] ?? '',
        scope: input.scope,
      },
    };
  }

  async function getVersion(input: SecretGetVersionInput): Promise<SecretVersionRecord | null> {
    if (input.versionId !== 1) return null;
    return Object.hasOwn(await secretsOf(input.envName), input.name) ? toVersion(input) : null;
  }

  async function listVersions(input: SecretListVersionsInput): Promise<SecretVersionPage> {
    return Object.hasOwn(await secretsOf(input.envName), input.name)
      ? { data: [toVersion(input)] }
      : { data: [] };
  }

  async function set(input: SecretSetInput): Promise<SecretSetOutcome> {
    const refused = refusedWrite(input.name, input.value);
    if (refused !== undefined) return { kind: 'error', ...refused };
    // dotenv only ever exposes version 1, so any other ifVersion is stale.
    if (input.ifVersion !== undefined && input.ifVersion !== 1) {
      return { kind: 'version-conflict', currentVersion: 1 };
    }

    let env: PackEnv;
    try {
      env = await load(input.envName);
    } catch (err) {
      return storeError(`Failed to read env files: ${(err as Error).message}`);
    }
    const existing = Object.hasOwn(env.values, input.name);
    if (input.writeMode === 'create-new' && existing) {
      return { kind: 'already-exists', record: toRecord(input) };
    }

    const toApp = input.appEnvFile === true;
    const target = toApp ? env.files.appWrite : env.files.write;
    const failure = await writeKey(target, input.name, input.value, toApp);
    if (failure !== undefined) return storeError(failure);

    // Authorization-tuple hook (`enqueueTuples`) — invoked ONLY on fresh
    // insert per the SecretBinding contract. Dev mode has no transaction
    // or outbox to persist to, but the hook runs so the caller's
    // side-effects (if any) still happen.
    if (!existing) void input.enqueueTuples(randomUUID());

    return { kind: 'ok', record: toRecord(input), versionId: 1 };
  }

  /**
   * `setKey` into `file` and write it back atomically; the error message on
   * failure. An app's file keeps its mode (it's the app's); Kindgi's is 0600.
   */
  async function writeKey(
    file: string,
    name: string,
    value: string,
    keepMode: boolean,
  ): Promise<string | undefined> {
    const label = displayEnvPath(packDir, file);
    let contents: string;
    try {
      // `set` refused a value `setKey` can't write (`refusedValue`), so only the read throws.
      contents = setKey((await readFileOrNull(file)) ?? '', name, value).contents;
    } catch (err) {
      return `Failed to read ${label}: ${(err as Error).message}`;
    }
    try {
      await writeAtomic(file, contents, keepMode ? await existingMode(file) : SECRETS_FILE_MODE);
      return undefined;
    } catch (err) {
      return `Failed to write ${label}: ${(err as Error).message}`;
    }
  }

  async function rotate(
    input: SecretRotateInput,
  ): Promise<Result<SecretRotateOutcome, SecretError>> {
    const env = await load(input.envName);
    return {
      kind: 'err',
      error: {
        code: 'secret-operation-unsupported',
        message: `Dev secrets live in your env files (${filesLabel(env)}) and have no versions to rotate. Edit the value there, or run \`kindgi secrets set ${input.name} --write-mode=add-version\`.`,
      },
    };
  }

  async function revoke(
    input: SecretRevokeInput,
  ): Promise<Result<SecretRevokeOutcome, SecretError>> {
    const env = await load(input.envName);
    return {
      kind: 'err',
      error: {
        code: 'secret-operation-unsupported',
        message: `Dev secrets live in your env files (${filesLabel(env)}) and have no revocation. Remove ${input.name} from those files.`,
      },
    };
  }

  return {
    list,
    get,
    resolve,
    getVersion,
    listVersions,
    set,
    rotate,
    revoke,
    writesAppEnvFiles: true,
    nameRefusal: refusedName,
  };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * A name `set` can't write, and why: a caller's mistake (a `400`), never the
 * store failing. Reads still find a key typed into `.env` by hand that
 * Kindgi wouldn't write (`acme-key`).
 */
function refusedName(name: string): SecretNameRefusal | undefined {
  if (isRuntimeKey(name)) {
    return {
      code: 'secret-name-invalid',
      message: `"${name}" is Kindgi runtime config (KINDGI_*), not a pack secret. Set it in your shell or env file directly.`,
    };
  }
  if (name.startsWith(RESERVED_SECRET_NAME_PREFIX)) {
    return {
      code: 'reserved-name-prefix',
      message: `Name "${name}" uses the reserved "${RESERVED_SECRET_NAME_PREFIX}" prefix; framework-internal only.`,
    };
  }
  if (!ENV_KEY_REGEX.test(name)) {
    const like = envKeyLike(name);
    return {
      code: 'secret-name-invalid',
      message: `Under \`kindgi dev\`, a secret is a key in your env files, so its name is capital letters, digits and underscores, not starting with a digit (${ENV_KEY_REGEX.source}). "${name}" isn't one${like === undefined ? '' : `: use "${like}"`}.`,
    };
  }
  return undefined;
}

/** Why `set` can't write this secret, before any file is read: its name, or its value. */
function refusedWrite(
  name: string,
  value: string,
): SecretNameRefusal | ReturnType<typeof refusedValue> {
  return refusedName(name) ?? refusedValue(name, value);
}

/**
 * A value `set` can't write so that it reads back unchanged, and why: a
 * caller's mistake (a `400`), never the store failing. No env-file quoting
 * holds a value with a double quote, or a backslash followed by `n` or `r`,
 * together with a carriage return or with both a single quote and a
 * backtick (`@kindgi/dotenv-file`'s `renderEntry`). The message never quotes
 * the value.
 */
function refusedValue(
  name: string,
  value: string,
): { readonly code: 'secret-value-invalid'; readonly message: string } | undefined {
  try {
    renderEntry(name, value);
    return undefined;
  } catch (err) {
    if (!(err instanceof EnvValueNotRepresentableError)) throw err;
    return {
      code: 'secret-value-invalid',
      message: `Under \`kindgi dev\`, a secret is a key in your env files, and no env-file quoting can hold the value for ${name} so that it reads back unchanged: it has a double quote, or a backslash followed by n or r, together with a carriage return or with both a single quote and a backtick. Store it encoded (base64, say), or without one of those characters.`,
    };
  }
}

/**
 * `name` as an env-file key Kindgi writes (`acme-key` → `ACME_KEY`), when
 * that makes one with a letter or digit of the name's in it (`--` makes
 * none).
 */
function envKeyLike(name: string): string | undefined {
  const like = name
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/^(?=[0-9])/, '_');
  return ENV_KEY_REGEX.test(like) && /[A-Z0-9]/.test(like) && !isRuntimeKey(like)
    ? like
    : undefined;
}

function storeError(message: string): SecretSetOutcome {
  return { kind: 'error', code: 'secret-store-error', message };
}

function toRecord(input: {
  readonly scope: SecretRecord['scope'];
  readonly envName: SecretRecord['envName'];
  readonly name: string;
}): SecretRecord {
  const iso = new Date(0).toISOString();
  return {
    scope: input.scope,
    envName: input.envName,
    name: input.name,
    currentVersion: 1,
    createdAt: iso,
    updatedAt: iso,
  };
}

function toVersion(input: {
  readonly scope: SecretRecord['scope'];
  readonly envName: SecretRecord['envName'];
  readonly name: string;
}): SecretVersionRecord {
  return {
    scope: input.scope,
    envName: input.envName,
    name: input.name,
    versionId: 1,
    value: null,
    createdAt: new Date(0).toISOString(),
  };
}
