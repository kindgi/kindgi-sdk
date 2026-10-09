// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A secret in a cloud secret manager, read and written with the platform's
 * own identity, for `kindgi license renew` and `enroll`:
 *
 * - `gcp:projects/<project>/secrets/<name>`: Google Secret Manager. Reads
 *   `versions/latest`, writes a new version (`:addVersion`), so the
 *   runtime's `latest` reference picks it up at its next start. The token
 *   comes from the metadata server (Cloud Run, GCE) or, elsewhere, `gcloud
 *   auth print-access-token` (CI, a person).
 * - `azure:https://<vault>.vault.azure.net/secrets/<name>`: Azure Key
 *   Vault. Reads the current version, writes a new one. The token comes
 *   from the managed identity (Container Apps and App Service's
 *   `IDENTITY_ENDPOINT`, else IMDS), with `KINDGI_AZURE_CLIENT_ID` for a
 *   user-assigned one, or, elsewhere, `az account get-access-token`.
 *
 * A value is never in a message; a failure names the secret and the
 * answer's status, and what to check.
 */

import type { SecretStore } from './stores.js';

/** How a cloud store reaches its API and its identity: injected in tests. */
export interface CloudDeps {
  readonly fetch: typeof fetch;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Runs a command (`gcloud`, `az`) and returns its stdout; throws when it fails. */
  readonly run: (command: string, args: readonly string[]) => Promise<string>;
}

const GCP_REF = /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/secrets\/([A-Za-z0-9_-]{1,255})$/;
/** A Key Vault secret's URL, in the public, China or US Government cloud. */
const AZURE_REF =
  /^https:\/\/([a-z0-9-]{3,24})\.(vault\.azure\.net|vault\.azure\.cn|vault\.usgovcloudapi\.net)\/secrets\/([A-Za-z0-9-]{1,127})$/;
/** How long a metadata endpoint may take before it's taken as not there (not on that platform). */
const METADATA_TIMEOUT_MS = 1500;
const CALL_TIMEOUT_MS = 30_000;

export class CloudSecretError extends Error {}

// ---- Google Secret Manager -----------------------------------------------------

export function gcpSecretStore(ref: string, deps: CloudDeps): SecretStore | undefined {
  const m = GCP_REF.exec(ref);
  if (m === null) return undefined;
  const project = m[1] ?? '';
  const name = m[2] ?? '';
  const base = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}`;
  const describe = `the Secret Manager secret ${name} (project ${project})`;
  const token = () => gcpToken(deps);
  return {
    async read() {
      const res = await call(
        deps,
        `${base}/versions/latest:access`,
        { method: 'GET' },
        await token(),
      );
      if (res.status === 404) return undefined;
      if (!res.ok)
        throw await refused(res, describe, gcpHint(name, 'roles/secretmanager.secretAccessor'));
      const body = (await res.json()) as { payload?: { data?: string } };
      const value = Buffer.from(body.payload?.data ?? '', 'base64')
        .toString('utf8')
        .trim();
      return value === '' ? undefined : value;
    },
    async write(value) {
      const res = await call(
        deps,
        `${base}:addVersion`,
        {
          method: 'POST',
          body: JSON.stringify({
            payload: { data: Buffer.from(value, 'utf8').toString('base64') },
          }),
        },
        await token(),
      );
      if (!res.ok)
        throw await refused(res, describe, gcpHint(name, 'roles/secretmanager.secretVersionAdder'));
    },
    describe,
  };
}

function gcpHint(name: string, role: string): string {
  return `The identity running this needs ${role} on the secret ${name}.`;
}

/** The metadata server's token (Cloud Run, GCE), else gcloud's. */
async function gcpToken(deps: CloudDeps): Promise<string> {
  const fromMetadata = await metadata(
    deps,
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { 'Metadata-Flavor': 'Google' },
  );
  if (fromMetadata !== undefined) return fromMetadata;
  try {
    const token = (await deps.run('gcloud', ['auth', 'print-access-token'])).trim();
    if (token !== '') return token;
  } catch {
    // Said below.
  }
  throw new CloudSecretError(
    "No Google identity here: not on Cloud Run or GCE (no metadata server), and `gcloud auth print-access-token` gave nothing. Run it where the deployment's identity is, or sign in with gcloud.",
  );
}

// ---- Azure Key Vault --------------------------------------------------------------

export function azureSecretStore(ref: string, deps: CloudDeps): SecretStore | undefined {
  const m = AZURE_REF.exec(ref);
  if (m === null) return undefined;
  const vault = m[1] ?? '';
  const suffix = m[2] ?? 'vault.azure.net';
  const name = m[3] ?? '';
  const url = `${ref}?api-version=7.4`;
  const describe = `the Key Vault secret ${name} (vault ${vault})`;
  const token = () => azureToken(deps, suffix);
  return {
    async read() {
      const res = await call(deps, url, { method: 'GET' }, await token());
      if (res.status === 404) return undefined;
      if (!res.ok) throw await refused(res, describe, azureHint(vault, 'Key Vault Secrets User'));
      const value = ((await res.json()) as { value?: string }).value?.trim() ?? '';
      return value === '' ? undefined : value;
    },
    async write(value) {
      const res = await call(
        deps,
        url,
        { method: 'PUT', body: JSON.stringify({ value }) },
        await token(),
      );
      if (!res.ok) {
        throw await refused(
          res,
          describe,
          azureHint(vault, 'a role with Microsoft.KeyVault/vaults/secrets/setSecret/action'),
        );
      }
    },
    describe,
  };
}

function azureHint(vault: string, role: string): string {
  return `The identity running this needs ${role} on that secret (or the vault ${vault}), and the vault's network rules must let it in.`;
}

/**
 * A token for Key Vault (`https://<suffix>`, `vault.azure.net` in the public
 * cloud) from the managed identity, else the Azure CLI's sign-in. Never
 * `AZURE_CLIENT_SECRET` or other bare `AZURE_*` settings.
 */
async function azureToken(deps: CloudDeps, suffix: string): Promise<string> {
  const resource = `https://${suffix}`;
  const clientId = deps.env.KINDGI_AZURE_CLIENT_ID?.trim();
  const endpoint = deps.env.IDENTITY_ENDPOINT;
  const header = deps.env.IDENTITY_HEADER;
  const query = (extra: string) =>
    `resource=${encodeURIComponent(resource)}${extra}${clientId ? `&client_id=${encodeURIComponent(clientId)}` : ''}`;
  if (endpoint !== undefined && endpoint !== '' && header !== undefined && header !== '') {
    // Container Apps, App Service, Functions.
    const token = await metadata(
      deps,
      `${endpoint}?${query('&api-version=2019-08-01')}`,
      { 'X-IDENTITY-HEADER': header },
      CALL_TIMEOUT_MS,
    );
    if (token !== undefined) return token;
    throw new CloudSecretError(
      `The managed identity endpoint gave no token for ${resource}. Is a managed identity assigned to this app${clientId ? ` with client id ${clientId}` : ''}?`,
    );
  }
  const imds = await metadata(
    deps,
    `http://169.254.169.254/metadata/identity/oauth2/token?${query('&api-version=2018-02-01')}`,
    { Metadata: 'true' },
  );
  if (imds !== undefined) return imds;
  try {
    const token = (
      await deps.run('az', [
        'account',
        'get-access-token',
        '--resource',
        resource,
        '--query',
        'accessToken',
        '-o',
        'tsv',
      ])
    ).trim();
    if (token !== '') return token;
  } catch {
    // Said below.
  }
  throw new CloudSecretError(
    "No Azure identity here: no managed identity (IDENTITY_ENDPOINT, IMDS), and `az account get-access-token` gave nothing. Run it where the deployment's identity is, or sign in with az login.",
  );
}

// ---- shared -----------------------------------------------------------------------

/** A token from a metadata endpoint, or `undefined` when there's none (not on that platform). */
async function metadata(
  deps: CloudDeps,
  url: string,
  headers: Record<string, string>,
  timeoutMs = METADATA_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const res = await deps.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const token = ((await res.json()) as { access_token?: string }).access_token;
    return typeof token === 'string' && token !== '' ? token : undefined;
  } catch {
    return undefined;
  }
}

async function call(
  deps: CloudDeps,
  url: string,
  init: { readonly method: string; readonly body?: string },
  token: string,
): Promise<Response> {
  return deps.fetch(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(init.body !== undefined && { body: init.body }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
}

async function refused(res: Response, what: string, hint: string): Promise<CloudSecretError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; status?: string; code?: string };
  };
  const why = body.error?.message ?? body.error?.status ?? body.error?.code;
  return new CloudSecretError(
    `${what} answered ${res.status}${why !== undefined ? ` (${why})` : ''}. ${res.status === 401 || res.status === 403 ? hint : ''}`.trim(),
  );
}
