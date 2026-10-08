// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../src/main.js';

let home: string;
let cwd: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-cwd-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const API = 'https://kindgi.acme.example';

async function run(argv: readonly string[], client: Record<string, unknown>) {
  return runCli({
    argv: [...argv, `--url=${API}`, '--token=t'],
    env: {},
    cwd,
    home,
    clientFactory: () => client as never,
  });
}

function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const rec =
    (name: string, result: unknown = { ok: true }) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result;
    };
  return { calls, rec };
}

const REDIRECT = `${API}/auth/sso/callback/idp-abc`;
const OIDC_URLS = {
  providerId: 'acme-google',
  kind: 'oidc',
  signIn: { redirectUri: REDIRECT },
  registered: false,
};
const SAML_URLS = {
  providerId: 'acme-saml',
  kind: 'saml',
  signIn: {
    spEntityId: `${API}/auth/sso/saml2/sp/metadata?providerId=idp-def`,
    acsUrl: `${API}/auth/sso/saml2/sp/acs/idp-def`,
    spMetadataUrl: `${API}/auth/sso/saml2/sp/metadata?providerId=idp-def`,
  },
  registered: false,
};

describe('kindgi sso providers start', () => {
  test('OIDC: the redirect URI and a message for IT, then the finish command', async () => {
    const { calls, rec } = recorder();
    const out = await run(['sso', 'providers', 'start', 'acme-google', '--kind=oidc'], {
      auth: { providers: { signIn: rec('signIn', OIDC_URLS) } },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['signIn', 'acme-google', { kind: 'oidc' }]]);
    expect(out.stdout).toContain(`Redirect URI:  ${REDIRECT}`);
    expect(out.stdout).toContain('never by email or chat');
    expect(out.stdout).toContain('Step by step: https://docs.kindgi.com/guides/sso/oidc/');
    expect(out.stdout).toContain(
      'kindgi sso providers finish acme-google --kind=oidc --issuer=<issuer> --client-id=<client-id> --client-secret-ref=<NAME>',
    );
  });

  test("--idp adds that identity provider's steps and implies --kind=oidc", async () => {
    const { calls, rec } = recorder();
    const out = await run(['sso', 'providers', 'start', 'acme-google', '--idp=google'], {
      auth: { providers: { signIn: rec('signIn', OIDC_URLS) } },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([['signIn', 'acme-google', { kind: 'oidc' }]]);
    expect(out.stdout).toContain('Audience: Internal');
    expect(out.stdout).toContain('Step by step: https://docs.kindgi.com/guides/sso/google/');
    expect(out.stdout).toContain('Issuer: https://accounts.google.com');
    const entra = await run(['sso', 'providers', 'start', 'acme-entra', '--idp=entra'], {
      auth: { providers: { signIn: rec('signIn', OIDC_URLS) } },
    });
    expect(entra.stdout).toContain('single tenant');
    expect(entra.stdout).toContain('never `common`');
    expect(entra.stdout).toContain('https://docs.kindgi.com/guides/sso/entra-id/');
  });

  test('SAML: the ACS URL, entity ID and metadata URL', async () => {
    const { rec } = recorder();
    const out = await run(['sso', 'providers', 'start', 'acme-saml', '--kind=saml'], {
      auth: { providers: { signIn: rec('signIn', SAML_URLS) } },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stdout).toContain(`ACS URL (single sign-on URL):  ${SAML_URLS.signIn.acsUrl}`);
    expect(out.stdout).toContain(`Entity ID (audience):          ${SAML_URLS.signIn.spEntityId}`);
    expect(out.stdout).toContain('--kind=saml --idp-metadata=@<metadata.xml>');
    expect(out.stdout).toContain('Step by step: https://docs.kindgi.com/guides/sso/saml/');
  });

  test('--json prints the URLs as they came; a bad --idp or --kind is refused', async () => {
    const { rec } = recorder();
    const client = { auth: { providers: { signIn: rec('signIn', OIDC_URLS) } } };
    const json = await run(
      ['sso', 'providers', 'start', 'acme-google', '--kind=oidc', '--json'],
      client,
    );
    expect(JSON.parse(json.stdout)).toEqual(OIDC_URLS);
    const idp = await run(['sso', 'providers', 'start', 'x', '--idp=ping'], client);
    expect(idp.exitCode).toBe(1);
    expect(idp.stderr).toContain('--idp must be one of: google, entra, okta, keycloak');
    const kind = await run(['sso', 'providers', 'start', 'x', '--kind=ldap'], client);
    expect(kind.exitCode).toBe(1);
    expect(kind.stderr).toContain('--kind must be `oidc` or `saml`');
  });
});

describe('kindgi sso providers finish / update', () => {
  test('finish registers from the flags: domains comma-separated or repeated', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'sso',
        'providers',
        'finish',
        'acme-okta',
        '--kind=oidc',
        '--issuer=https://acme.okta.example',
        '--client-id=client-1',
        '--client-secret-ref=ACME_OKTA_SECRET',
        '--domains=acme.com,acme.co.uk',
        '--domains=acme.de',
        '--name=Acme Okta',
      ],
      { auth: { providers: { register: rec('register', { providerId: 'acme-okta' }) } } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      [
        'register',
        {
          providerId: 'acme-okta',
          kind: 'oidc',
          displayName: 'Acme Okta',
          issuer: 'https://acme.okta.example',
          clientId: 'client-1',
          clientSecretRef: 'ACME_OKTA_SECRET',
          domains: ['acme.com', 'acme.co.uk', 'acme.de'],
        },
      ],
    ]);
  });

  test('finish SAML reads the metadata from a file; --kind is required', async () => {
    const { calls, rec } = recorder();
    const file = join(cwd, 'idp.xml');
    await writeFile(file, '<EntityDescriptor entityID="https://idp.acme.example"/>');
    const client = {
      auth: { providers: { register: rec('register', { providerId: 'acme-saml' }) } },
    };
    const out = await run(
      ['sso', 'providers', 'finish', 'acme-saml', '--kind=saml', `--idp-metadata=@${file}`],
      client,
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls[0]?.[1]).toMatchObject({
      providerId: 'acme-saml',
      kind: 'saml',
      idpMetadataXml: '<EntityDescriptor entityID="https://idp.acme.example"/>',
    });
    const inline = await run(
      ['sso', 'providers', 'finish', 'acme-saml', '--kind=saml', '--idp-metadata=<xml/>'],
      client,
    );
    expect(inline.stderr).toContain('--idp-metadata takes a file');
    const noKind = await run(['sso', 'providers', 'finish', 'acme-saml'], client);
    expect(noKind.exitCode).toBe(1);
    expect(noKind.stderr).toContain('--kind=oidc|saml is required');
  });

  test('update sends only the changes; --remove sends null', async () => {
    const { calls, rec } = recorder();
    const out = await run(
      [
        'sso',
        'providers',
        'update',
        'acme-okta',
        '--client-secret-ref=ACME_OKTA_SECRET_2',
        '--remove=displayName',
      ],
      { auth: { providers: { update: rec('update', { providerId: 'acme-okta', provider: {} }) } } },
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['update', 'acme-okta', { clientSecretRef: 'ACME_OKTA_SECRET_2', displayName: null }],
    ]);
    const nothing = await run(['sso', 'providers', 'update', 'acme-okta'], {
      auth: { providers: { update: rec('update') } },
    });
    expect(nothing.exitCode).toBe(1);
    expect(nothing.stderr).toContain('Nothing to change');
  });
});

describe('kindgi sso providers test / list / remove', () => {
  test("test: the sign-in link for someone at the provider's first domain", async () => {
    const { calls, rec } = recorder();
    const out = await run(['sso', 'providers', 'test', 'acme-okta'], {
      auth: {
        providers: {
          get: rec('get', { providerId: 'acme-okta', kind: 'oidc', domains: ['acme.com'] }),
        },
        signInOptions: rec('signInOptions', {
          data: [
            { providerId: 'acme-okta', displayName: 'Acme Okta', signInUrl: '/auth/start/idp-abc' },
          ],
        }),
      },
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([
      ['get', 'acme-okta'],
      ['signInOptions', { email: 'someone@acme.com' }],
    ]);
    expect(out.stdout).toContain(`${API}/auth/start/idp-abc`);
  });

  test('test: says why when no sign-in page offers it, and exits 1', async () => {
    const { rec } = recorder();
    const out = await run(['sso', 'providers', 'test', 'acme-okta'], {
      auth: {
        providers: { get: rec('get', { providerId: 'acme-okta', kind: 'oidc' }) },
        signInOptions: rec('signInOptions', { data: [] }),
      },
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('kindgi sso providers update acme-okta --domains=<your-domain>');
  });

  test('list and remove call the client', async () => {
    const { calls, rec } = recorder();
    const client = {
      auth: {
        providers: {
          list: rec('list', {
            data: [{ providerId: 'acme-okta', kind: 'oidc', domains: ['acme.com'] }],
          }),
          unregister: rec('unregister', { providerId: 'acme-okta', unregistered: true }),
        },
      },
    };
    const table = await run(['sso', 'providers', 'list', '--table'], client);
    expect(table.stdout).toMatch(/acme-okta\s+oidc\s+acme\.com/);
    await run(['sso', 'providers', 'remove', 'acme-okta'], client);
    expect(calls).toEqual([['list'], ['unregister', 'acme-okta']]);
  });
});
