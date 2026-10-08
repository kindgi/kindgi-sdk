// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The Google credentials `kindgi dev` gives the runtime, for Vertex AI
 * (the `gemini` provider preset): only those `KINDGI_DEV_GOOGLE_CREDENTIALS`
 * names, read like the other dev settings (the shell, then the pack's env
 * files), and mounted read-only.
 *
 *   - `adc`: gcloud's application-default login
 *     (`gcloud auth application-default login`);
 *   - an absolute path: that credentials file (a service-account key, an
 *     impersonated-credentials file);
 *   - `off`, or unset: none. Nothing is mounted and nothing is set in the
 *     runtime's environment.
 *
 * Neither this machine's application-default login nor a shell's
 * `GOOGLE_APPLICATION_CREDENTIALS` reaches the runtime on its own: either
 * may be an account set up for other work. When a Vertex provider has no
 * credentials, `kindgi dev` and `kindgi doctor` say how to give it some.
 *
 * Who the credentials are is read from the file, offline; no token is read
 * or printed.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const DEV_GOOGLE_CREDENTIALS_VAR = 'KINDGI_DEV_GOOGLE_CREDENTIALS';

/** The Vertex AI provider preset's id, and its adapter. */
export const VERTEX_PROVIDER_ID = 'gemini';
const GEMINI_ADAPTER_ID = '@kindgi/adapter-model-gemini';

export interface DevGoogleCredentials {
  /** The file on this machine, mounted read-only into the runtime. */
  readonly path: string;
  /** Whose they are, in words: an account, never a secret. */
  readonly who: string;
}

export type DevGoogleCredentialsOutcome =
  | { readonly kind: 'ok'; readonly credentials: DevGoogleCredentials | undefined }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The credentials `value` (`KINDGI_DEV_GOOGLE_CREDENTIALS`) names, or none.
 * An error says what to fix: a value that's none of the three forms, a
 * login that isn't there, a file that isn't a Google credentials file.
 */
export function resolveDevGoogleCredentials(
  value: string | undefined,
  hostEnv: Readonly<Record<string, string | undefined>>,
): DevGoogleCredentialsOutcome {
  const raw = value?.trim() ?? '';
  if (raw === '' || raw === 'off') return { kind: 'ok', credentials: undefined };
  let path: string;
  if (raw === 'adc') {
    const adc = gcloudApplicationDefaultPath(hostEnv);
    if (adc === undefined || !existsSync(adc)) {
      return {
        kind: 'error',
        message: `${DEV_GOOGLE_CREDENTIALS_VAR}=adc, but there's no gcloud application-default login${adc !== undefined ? ` at ${adc}` : ''}. Run \`gcloud auth application-default login\`, or set ${DEV_GOOGLE_CREDENTIALS_VAR} to a credentials file's absolute path.`,
      };
    }
    path = adc;
  } else if (isAbsolute(raw)) {
    if (!existsSync(raw) || !statSync(raw).isFile()) {
      return {
        kind: 'error',
        message: `${DEV_GOOGLE_CREDENTIALS_VAR}="${raw}" isn't a file.`,
      };
    }
    path = raw;
  } else {
    return {
      kind: 'error',
      message: `${DEV_GOOGLE_CREDENTIALS_VAR} must be \`adc\` (your gcloud application-default login), the absolute path of a Google credentials file, or \`off\`. Got "${raw}".`,
    };
  }
  const who = describeGoogleCredentials(path);
  if (who === undefined) {
    return {
      kind: 'error',
      message: `${DEV_GOOGLE_CREDENTIALS_VAR}: ${path} isn't a Google credentials file (JSON with a "type").`,
    };
  }
  return { kind: 'ok', credentials: { path, who } };
}

/**
 * Where `gcloud auth application-default login` writes: under
 * `CLOUDSDK_CONFIG` when set, else `%APPDATA%\gcloud` on Windows, else
 * `~/.config/gcloud`.
 */
export function gcloudApplicationDefaultPath(
  hostEnv: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const file = 'application_default_credentials.json';
  const config = hostEnv.CLOUDSDK_CONFIG;
  if (config !== undefined && config !== '') return join(config, file);
  if (process.platform === 'win32') {
    const appData = hostEnv.APPDATA;
    return appData === undefined || appData === '' ? undefined : join(appData, 'gcloud', file);
  }
  const home = hostEnv.HOME;
  return home === undefined || home === '' ? undefined : join(home, '.config', 'gcloud', file);
}

/**
 * Whose credentials the file holds, from its non-secret fields only;
 * `undefined` when it isn't a Google credentials file.
 */
export function describeGoogleCredentials(path: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const file = parsed as Readonly<Record<string, unknown>>;
  const text = (key: string): string | undefined =>
    typeof file[key] === 'string' && file[key] !== '' ? (file[key] as string) : undefined;
  const type = text('type');
  if (type === undefined) return undefined;
  const quota = text('quota_project_id');
  const withQuota = (who: string): string =>
    quota === undefined ? who : `${who}, quota project ${quota}`;
  switch (type) {
    case 'service_account':
      return `service account ${text('client_email') ?? '(no client_email)'}`;
    case 'authorized_user': {
      const account = text('account');
      return withQuota(
        account === undefined
          ? 'your gcloud application-default login (a user account)'
          : `your gcloud application-default login, ${account}`,
      );
    }
    case 'impersonated_service_account': {
      const url = text('service_account_impersonation_url') ?? '';
      const target = /\/serviceAccounts\/([^/:]+)/.exec(url)?.[1];
      return withQuota(`impersonating ${target ?? 'a service account'}`);
    }
    case 'external_account':
      return 'an external account (workload identity federation)';
    default:
      return `a "${type}" credentials file`;
  }
}

/**
 * Whether a registration is Vertex AI: the Gemini adapter, not on the
 * Gemini Developer API (`api: developer`, the `gemini-api` preset).
 */
export function isVertexRegistration(input: {
  readonly adapter_id?: string;
  readonly adapter_config?: Readonly<Record<string, unknown>>;
}): boolean {
  return input.adapter_id === GEMINI_ADAPTER_ID && input.adapter_config?.api !== 'developer';
}

/**
 * The line that says how to give Vertex providers credentials. `ids`
 * names them; `GOOGLE_APPLICATION_CREDENTIALS` in the shell is offered
 * when set.
 */
export function vertexCredentialsHint(
  ids: readonly string[],
  hostEnv: Readonly<Record<string, string | undefined>>,
): string {
  const named = ids.length === 1 ? `Provider ${ids[0]}` : `Providers ${ids.join(', ')}`;
  const shell = hostEnv.GOOGLE_APPLICATION_CREDENTIALS;
  const fromShell =
    shell !== undefined && shell !== ''
      ? `, or ${DEV_GOOGLE_CREDENTIALS_VAR}=$GOOGLE_APPLICATION_CREDENTIALS`
      : ' (or a credentials file)';
  return `${named} (Vertex AI) ${ids.length === 1 ? 'has' : 'have'} no Google credentials: set ${DEV_GOOGLE_CREDENTIALS_VAR}=adc${fromShell}, in the pack's .env or the shell, and restart kindgi dev.`;
}
