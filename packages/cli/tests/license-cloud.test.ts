// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Secrets in Google Secret Manager and Azure Key Vault, through stand-ins
 * for their APIs and identity endpoints: the requests each store makes,
 * where its token comes from (the platform's identity first, then the
 * cloud's CLI), and what a refusal says. Never a real cloud, never this
 * machine's credentials.
 */

import { describe, expect, test } from 'vitest';

import type { CloudDeps } from '../src/license/cloud.js';
import { SecretRefError, secretStoreFor } from '../src/license/stores.js';

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

/** A cloud: `routes` answer by URL prefix; anything else is unreachable (no such endpoint here). */
function cloud(
  routes: Record<string, (req: Seen) => { status: number; body?: unknown }>,
  env: Record<string, string> = {},
  cli: Record<string, string> = {},
) {
  const seen: Seen[] = [];
  const ran: string[] = [];
  const deps: CloudDeps = {
    env,
    fetch: (async (input: string, init?: RequestInit) => {
      const req: Seen = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(init?.body !== undefined && { body: JSON.parse(String(init.body)) }),
      };
      seen.push(req);
      const route = Object.keys(routes).find((prefix) => req.url.startsWith(prefix));
      if (route === undefined) throw new TypeError('fetch failed');
      const { status, body } = routes[route]?.(req) ?? { status: 500 };
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
    run: async (command, args) => {
      ran.push([command, ...args].join(' '));
      const out = cli[command];
      if (out === undefined) throw new Error(`${command}: not found`);
      return `${out}\n`;
    },
  };
  return { deps, seen, ran };
}

const GCP_METADATA =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const SM = 'https://secretmanager.googleapis.com/v1/projects/acme-prod/secrets/kindgi-license-key';
const GCP_REF = 'gcp:projects/acme-prod/secrets/kindgi-license-key';

describe('Google Secret Manager', () => {
  test('on Cloud Run: the metadata server’s token; latest read, a new version added', async () => {
    const c = cloud({
      [GCP_METADATA]: () => ({ status: 200, body: { access_token: 'ya29.metadata' } }),
      [`${SM}/versions/latest:access`]: () => ({
        status: 200,
        body: { payload: { data: Buffer.from('kgi_lk_current.sig\n').toString('base64') } },
      }),
      [`${SM}:addVersion`]: () => ({ status: 200, body: { name: `${SM}/versions/7` } }),
    });
    const store = secretStoreFor(GCP_REF, { cloud: c.deps });
    expect(await store.read()).toBe('kgi_lk_current.sig');
    await store.write('kgi_lk_next.sig');
    const add = c.seen.find((r) => r.url.endsWith(':addVersion'));
    expect(add?.method).toBe('POST');
    expect(add?.headers.authorization).toBe('Bearer ya29.metadata');
    expect(add?.body).toEqual({
      payload: { data: Buffer.from('kgi_lk_next.sig').toString('base64') },
    });
    expect(c.seen.find((r) => r.url === GCP_METADATA)?.headers['Metadata-Flavor']).toBe('Google');
    expect(c.ran).toEqual([]);
    expect(store.describe).toBe('the Secret Manager secret kindgi-license-key (project acme-prod)');
  });

  test('elsewhere (CI, a laptop): gcloud’s token; no secret yet reads as none', async () => {
    const c = cloud(
      { [`${SM}/versions/latest:access`]: () => ({ status: 404 }) },
      {},
      { gcloud: 'ya29.gcloud' },
    );
    expect(await secretStoreFor(GCP_REF, { cloud: c.deps }).read()).toBeUndefined();
    expect(c.ran).toEqual(['gcloud auth print-access-token']);
    expect(c.seen.at(-1)?.headers.authorization).toBe('Bearer ya29.gcloud');
  });

  test('refused: the status, the reason, and the role it needs; no identity at all: said', async () => {
    const c = cloud({
      [GCP_METADATA]: () => ({ status: 200, body: { access_token: 't' } }),
      [SM]: () => ({ status: 403, body: { error: { status: 'PERMISSION_DENIED' } } }),
    });
    const store = secretStoreFor(GCP_REF, { cloud: c.deps });
    await expect(store.read()).rejects.toThrow(
      'the Secret Manager secret kindgi-license-key (project acme-prod) answered 403 (PERMISSION_DENIED). The identity running this needs roles/secretmanager.secretAccessor on the secret kindgi-license-key.',
    );
    await expect(store.write('kgi_lk_never.printed')).rejects.toThrow(
      'roles/secretmanager.secretVersionAdder',
    );
    await expect(store.write('kgi_lk_never.printed')).rejects.not.toThrow('never.printed');
    const nowhere = cloud({});
    await expect(secretStoreFor(GCP_REF, { cloud: nowhere.deps }).read()).rejects.toThrow(
      'No Google identity here',
    );
  });
});

const VAULT = 'https://acme-kindgi.vault.azure.net/secrets/license-key';

describe('Azure Key Vault', () => {
  test('in Container Apps: its identity endpoint, a user-assigned client id; read and a new version', async () => {
    const c = cloud(
      {
        'http://localhost:42356/msi/token': (req) => {
          expect(req.headers['X-IDENTITY-HEADER']).toBe('identity-header');
          return { status: 200, body: { access_token: 'eyJ.ca' } };
        },
        [VAULT]: (req) =>
          req.method === 'GET'
            ? { status: 200, body: { value: 'kgi_lk_current.sig' } }
            : { status: 200, body: { id: `${VAULT}/abc` } },
      },
      {
        IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
        IDENTITY_HEADER: 'identity-header',
        KINDGI_AZURE_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
        AZURE_CLIENT_SECRET: 'must-never-be-used',
      },
    );
    const store = secretStoreFor(`azure:${VAULT}`, { cloud: c.deps });
    expect(await store.read()).toBe('kgi_lk_current.sig');
    await store.write('kgi_lk_next.sig');
    const token = new URL(c.seen[0]?.url ?? '');
    expect(Object.fromEntries(token.searchParams)).toEqual({
      resource: 'https://vault.azure.net',
      'api-version': '2019-08-01',
      client_id: '11111111-2222-3333-4444-555555555555',
    });
    const put = c.seen.find((r) => r.method === 'PUT');
    expect(put?.url).toBe(`${VAULT}?api-version=7.4`);
    expect(put?.body).toEqual({ value: 'kgi_lk_next.sig' });
    expect(put?.headers.authorization).toBe('Bearer eyJ.ca');
    expect(JSON.stringify(c.seen)).not.toContain('must-never-be-used');
  });

  test('on a VM: IMDS; elsewhere: az; another cloud’s vault asks for that cloud’s resource', async () => {
    const imds = cloud({
      'http://169.254.169.254/metadata/identity/oauth2/token': () => ({
        status: 200,
        body: { access_token: 'eyJ.imds' },
      }),
      [VAULT]: () => ({ status: 404 }),
    });
    expect(await secretStoreFor(`azure:${VAULT}`, { cloud: imds.deps }).read()).toBeUndefined();
    expect(imds.seen[0]?.headers.Metadata).toBe('true');

    const china = 'https://acme.vault.azure.cn/secrets/license-key';
    const laptop = cloud(
      { [china]: () => ({ status: 200, body: { value: 'v' } }) },
      {},
      { az: 'eyJ.az' },
    );
    expect(await secretStoreFor(`azure:${china}`, { cloud: laptop.deps }).read()).toBe('v');
    expect(laptop.ran).toEqual([
      'az account get-access-token --resource https://vault.azure.cn --query accessToken -o tsv',
    ]);
  });

  test('refused: the status and the role; no identity: said', async () => {
    const c = cloud(
      { [VAULT]: () => ({ status: 403, body: { error: { code: 'Forbidden' } } }) },
      {},
      { az: 't' },
    );
    await expect(secretStoreFor(`azure:${VAULT}`, { cloud: c.deps }).write('x')).rejects.toThrow(
      'the Key Vault secret license-key (vault acme-kindgi) answered 403 (Forbidden). The identity running this needs a role with Microsoft.KeyVault/vaults/secrets/setSecret/action',
    );
    await expect(
      secretStoreFor(`azure:${VAULT}`, { cloud: cloud({}).deps }).read(),
    ).rejects.toThrow('No Azure identity here');
  });
});

test('a cloud reference that isn’t one is refused like any other', () => {
  for (const ref of [
    'gcp:acme-prod/kindgi-license-key',
    'gcp:projects/ACME/secrets/x',
    'azure:https://acme.vault.azure.net/keys/license-key',
    'azure:http://acme.vault.azure.net/secrets/license-key',
    'azure:https://acme.example.com/secrets/license-key',
  ]) {
    expect(() => secretStoreFor(ref), ref).toThrow(SecretRefError);
  }
});
