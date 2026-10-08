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
 * parsed the same way, as the application beside the pack. A key added
 * to `.env` by hand is a secret the pack can resolve; nothing needs to be
 * copied anywhere. Other environments read `.env.<envName>`.
 *
 * ## Semantics
 *
 *   - **Reads** (`list`, `get`, `resolve`, `getVersion`, `listVersions`):
 *     the merged, `${VAR}`-expanded view. `KINDGI_*` names are Kindgi
 *     runtime config and are invisible here. Version metadata is
 *     synthetic (`versionId: 1`) — dotenv files don't version.
 *   - **`set`**: writes the highest-precedence file (`.env.local` by
 *     default) via `@kindgi/dotenv-file`'s `setKey` — one line changes,
 *     every other byte stays. `create-new` returns `already-exists` when
 *     the name is defined in ANY of the files. Refuses `KINDGI_*` and the
 *     reserved `kindgi.` prefix. Files are written atomically, mode 0600.
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
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  SecretBinding,
  SecretError,
  SecretGetInput,
  SecretGetVersionInput,
  SecretListInput,
  SecretListPage,
  SecretListVersionsInput,
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
import { ENV_KEY_REGEX, EnvValueNotRepresentableError, setKey } from '@kindgi/dotenv-file';
import type { Result } from '@kindgi/types';

import {
  type PackEnv,
  displayEnvPath,
  isRuntimeKey,
  packValues,
  readFileOrNull,
  readPackEnv,
} from './pack-env.js';

export {
  DEFAULT_LOCAL_ENV_FILES,
  LOCAL_ENV_NAME,
  type PackEnv,
  type PackEnvFiles,
  type PackEnvFilesInput,
  RUNTIME_KEY_PREFIX,
  type ReadPackEnvInput,
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

const FILE_MODE = 0o600;

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
      return {
        kind: 'err',
        error: {
          code: 'secret-not-found',
          message: `No secret "${input.name}" for env "${input.envName as unknown as string}" in ${filesLabel(env)} at ${packDir}`,
          name: input.name,
        },
      };
    }
    return {
      kind: 'ok',
      value: { name: input.name, versionId: 1, value: secrets[input.name] ?? '' },
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
    const refused = refusedName(input.name);
    if (refused !== undefined) return storeError(refused);
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

    const failure = await writeKey(env.files.write, input.name, input.value);
    if (failure !== undefined) return storeError(failure);

    // Authorization-tuple hook (`enqueueTuples`) — invoked ONLY on fresh
    // insert per the SecretBinding contract. Dev mode has no transaction
    // or outbox to persist to, but the hook runs so the caller's
    // side-effects (if any) still happen.
    if (!existing) void input.enqueueTuples(randomUUID());

    return { kind: 'ok', record: toRecord(input), versionId: 1 };
  }

  /** `setKey` into `file` and write it back atomically; the error message on failure. */
  async function writeKey(file: string, name: string, value: string): Promise<string | undefined> {
    const label = displayEnvPath(packDir, file);
    let contents: string;
    try {
      contents = setKey((await readFileOrNull(file)) ?? '', name, value).contents;
    } catch (err) {
      if (err instanceof EnvValueNotRepresentableError) return err.message;
      return `Failed to read ${label}: ${(err as Error).message}`;
    }
    try {
      await writeAtomic(file, contents);
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

  return { list, get, resolve, getVersion, listVersions, set, rotate, revoke };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function refusedName(name: string): string | undefined {
  if (isRuntimeKey(name)) {
    return `"${name}" is Kindgi runtime config (KINDGI_*), not a pack secret. Set it in your shell or env file directly.`;
  }
  if (name.startsWith(RESERVED_SECRET_NAME_PREFIX)) {
    return `Name "${name}" uses the reserved "${RESERVED_SECRET_NAME_PREFIX}" prefix; framework-internal only.`;
  }
  if (!ENV_KEY_REGEX.test(name)) {
    return `Invalid secret name "${name}" for an env file — must match ${ENV_KEY_REGEX.source}.`;
  }
  return undefined;
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

/** Write-tmp + rename, mode 0600 (chmod again: rename can keep a looser mode). */
async function writeAtomic(target: string, contents: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, contents, { mode: FILE_MODE });
  await rename(tmp, target);
  await chmod(target, FILE_MODE);
}
