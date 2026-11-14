// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The runtime's environment under `kindgi dev`: everything the Kindgi
 * runtime container is told, written to `<pack>/.kindgi/dev/runtime.env`
 * (mode 0600) and handed to `docker run --env-file`. The runtime reads
 * nothing else from the developer's machine. Names are
 * `@kindgi/env-schema`'s.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { TENANT_EGRESS_NO_PROXY_VAR, TENANT_EGRESS_PROXY_VAR } from '@kindgi/env-schema';
import { LOCAL_ENV_NAME, readPackEnv } from '@kindgi/secrets-dotenv';

import { writePrivateFile } from '../private-file.js';

/** Where the pack directory is mounted in the runtime container. */
export const RUNTIME_PACK_DIR = '/pack';
/** Where read-only credential files are mounted in the runtime container. */
export const RUNTIME_GOOGLE_CREDENTIALS = '/run/kindgi/google-credentials.json';
export const RUNTIME_PUBLIC_TOKEN_KEY = '/run/kindgi/public-token-signing.pem';
export const RUNTIME_EXPORT_SIGNING_KEY = '/run/kindgi/export-signing.pem';
/** Where the connections' key files are mounted in the runtime container. */
export const RUNTIME_SECRETS_LOCAL_KEY = '/run/kindgi/secrets-local.key';
export const RUNTIME_SECRETS_AAD_KEY = '/run/kindgi/secrets-aad.key';

/** `<pack>/.kindgi/dev/runtime.env`. */
export function runtimeEnvPath(packDir: string): string {
  return join(packDir, '.kindgi', 'dev', 'runtime.env');
}

export interface RuntimeEnvInput {
  /** The port the API listens on, as the runtime sees it. */
  readonly apiPort: number;
  /** `KINDGI_API_HOST`: bind loopback (Linux host networking, or a server on the host). */
  readonly apiHost?: string;
  /**
   * `KINDGI_PUBLIC_URL`: where the developer reaches the runtime
   * (`http://127.0.0.1:<port>`), which its banner names. In a container
   * that's the published port, not the one the runtime binds.
   */
  readonly publicUrl: string;
  /**
   * `KINDGI_DEV_HOST_ALIAS`: where loopback calls go when the runtime
   * can't see the host's loopback (Docker Desktop: `host.docker.internal`).
   */
  readonly hostAlias?: string;
  /** The pack directory, as the runtime sees it (`/pack` in the container). */
  readonly packDir: string;
  /** Postgres, as the runtime reaches it. */
  readonly databaseUrl: string;
  readonly tenantId: string;
  readonly token: string;
  readonly seedUserId: string;
  /** The pack service's front (`http://127.0.0.1:<port>`; through the alias from a container). */
  readonly packService: { readonly url: string; readonly token: string };
  /** `dev.envFiles`; default `.env`, `.env.local`. */
  readonly localEnvFiles?: readonly string[];
  /** Browser origins allowed on the run progress routes. */
  readonly corsOrigins: readonly string[];
  /** The developer's public run token key file, as the runtime sees it. */
  readonly publicTokenKeyPath?: string;
  /** The developer's export signing key file, as the runtime sees it. */
  readonly exportSigningKeyPath?: string;
  /** The developer's Google Application Default Credentials, as the runtime sees them. */
  readonly googleCredentialsPath?: string;
  /**
   * The key files for connections' token sets, as the runtime sees them:
   * one pair per dev database, which `kindgi dev` makes. With them the
   * runtime keeps token sets in that database (`KINDGI_CONNECTIONS_STORE=postgres`);
   * without them connections are off.
   */
  readonly connectionKeys?: { readonly localKeyPath: string; readonly aadKeyPath: string };
  /**
   * `KINDGI_LOG_*`: the levels `kindgi dev` shows, and `KINDGI_LOG_FORMAT=json`
   * when `kindgi dev` reads the runtime's output (the container's). A
   * runtime the developer runs (`--runtime-url`) writes to their terminal,
   * which picks the format. An older runtime ignores the names.
   */
  readonly log?: Readonly<Record<string, string>>;
  /**
   * `KINDGI_TENANT_EGRESS_PROXY` and `KINDGI_TENANT_EGRESS_NO_PROXY`, as
   * `kindgi dev` has them (`tenantEgressOf`).
   */
  readonly tenantEgress?: Readonly<Record<string, string>>;
  /**
   * Values from the shell for `${VAR}` references the pack's env files
   * make and don't define. On the machine the server reads them from the
   * shell; in the container this is its shell.
   */
  readonly shellReferences: Readonly<Record<string, string>>;
}

/** Names whose shell value is a path on the host: never handed to the container. */
const HOST_PATH_NAMES: ReadonlySet<string> = new Set(['GOOGLE_APPLICATION_CREDENTIALS']);

/** The runtime container's environment, by name. */
export function buildRuntimeEnv(input: RuntimeEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    KINDGI_DEV: 'true',
    KINDGI_ENV: LOCAL_ENV_NAME,
    ...input.log,
    KINDGI_API_PORT: String(input.apiPort),
    ...(input.apiHost !== undefined && { KINDGI_API_HOST: input.apiHost }),
    KINDGI_PUBLIC_URL: input.publicUrl,
    ...(input.hostAlias !== undefined && { KINDGI_DEV_HOST_ALIAS: input.hostAlias }),
    KINDGI_DATABASE_URL: input.databaseUrl,
    KINDGI_TENANT_ID: input.tenantId,
    KINDGI_API_TOKEN: input.token,
    KINDGI_SEED_USER_ID: input.seedUserId,
    KINDGI_PACK_DIR: input.packDir,
    // Artifacts' files in the pack's dev directory (gitignored), where the
    // runtime sees it: /pack in the container, the pack itself otherwise.
    KINDGI_ARTIFACTS: `local:${input.packDir}/.kindgi/dev/artifacts`,
    KINDGI_DEV_CONSOLE_LOGIN: 'true',
    KINDGI_SECRETS_BACKEND: 'dotenv',
    KINDGI_SECRETS_DOTENV_DIR: input.packDir,
    ...(input.localEnvFiles !== undefined && {
      KINDGI_SECRETS_DOTENV_FILES: input.localEnvFiles.join(','),
    }),
    KINDGI_PACK_SERVICE_URL: input.packService.url,
    KINDGI_PACK_SERVICE_TOKEN: input.packService.token,
    ...(input.corsOrigins.length > 0 && { KINDGI_CORS_ORIGINS: input.corsOrigins.join(',') }),
    ...(input.publicTokenKeyPath !== undefined && {
      KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH: input.publicTokenKeyPath,
    }),
    ...(input.exportSigningKeyPath !== undefined && {
      KINDGI_EXPORT_SIGNING_KEY_PATH: input.exportSigningKeyPath,
    }),
    ...(input.googleCredentialsPath !== undefined && {
      GOOGLE_APPLICATION_CREDENTIALS: input.googleCredentialsPath,
    }),
    ...input.tenantEgress,
    // Token sets in the dev database, under keys only this database's
    // runtime uses. The local key is a dev key on one machine: that's
    // what the ack says.
    ...(input.connectionKeys !== undefined && {
      KINDGI_CONNECTIONS_STORE: 'postgres',
      KINDGI_SECRETS_BACKEND_KMS: 'libsodium',
      KINDGI_SECRETS_LOCAL_KEY_PATH: input.connectionKeys.localKeyPath,
      KINDGI_SECRETS_AAD_KEY_PATH: input.connectionKeys.aadKeyPath,
      KINDGI_SECRETS_LOCAL_KEY_ACK: 'single-node',
    }),
  };
  for (const [name, value] of Object.entries(input.shellReferences)) {
    // The runtime's own settings come from kindgi dev, never from a
    // reference; a host path to credentials means nothing in the
    // container (they're mounted, at a path of its own).
    if (name.startsWith('KINDGI_') || name in env || HOST_PATH_NAMES.has(name)) continue;
    env[name] = value;
  }
  return env;
}

/**
 * The shell values the runtime needs for the pack's `${VAR}` references:
 * names the env files refer to without defining, that the shell has.
 */
export async function shellReferencesOf(input: {
  readonly packDir: string;
  readonly localEnvFiles?: readonly string[];
  readonly shellEnv: Readonly<Record<string, string | undefined>>;
}): Promise<Record<string, string>> {
  const files = await readPackEnv({
    packDir: input.packDir,
    envName: LOCAL_ENV_NAME,
    ...(input.localEnvFiles !== undefined && { localEnvFiles: input.localEnvFiles }),
  });
  const out: Record<string, string> = {};
  for (const d of files.diagnostics) {
    if (d.kind !== 'unresolved') continue;
    const value = input.shellEnv[d.ref];
    if (value !== undefined) out[d.ref] = value;
  }
  return out;
}

/** The tenant egress proxy settings `kindgi dev` hands on from its own environment. */
const TENANT_EGRESS_NAMES: readonly string[] = [
  TENANT_EGRESS_PROXY_VAR,
  TENANT_EGRESS_NO_PROXY_VAR,
];

/**
 * The runtime's tenant egress proxy, for a machine whose network lets
 * traffic out only through one: `KINDGI_TENANT_EGRESS_PROXY` and
 * `KINDGI_TENANT_EGRESS_NO_PROXY` from `kindgi dev`'s own environment,
 * each only when set and not empty, as they are. The runtime checks them
 * when it starts, and refuses a proxy URL that carries credentials. They
 * go only into `runtime.env`, never into what `kindgi dev` prints or logs.
 */
export function tenantEgressOf(
  hostEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of TENANT_EGRESS_NAMES) {
    const value = hostEnv[name];
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

/**
 * Write the env file `docker run --env-file` reads: `NAME=value` lines,
 * taken literally (no quotes, no expansion), mode 0600, since it holds
 * the API token: a new file that replaces the old one (`writePrivateFile`).
 * A value with a line break can't be written.
 */
export async function writeRuntimeEnv(
  path: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const lines = Object.entries(env).map(([name, value]) => {
    if (/[\r\n]/.test(value)) {
      throw new Error(`${name} has a line break, which an env file can't hold.`);
    }
    return `${name}=${value}`;
  });
  await mkdir(dirname(path), { recursive: true });
  await writePrivateFile(
    path,
    `# Written by kindgi dev for the Kindgi runtime container. Holds the dev token: keep it private.\n${lines.join('\n')}\n`,
  );
}
