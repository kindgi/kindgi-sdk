// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  AZURE_KEY_ID_VAR,
  AZURE_VAULT_URL_VAR,
  CORS_ORIGINS_VAR,
  KINDGI_ENV_SCHEMA,
  PUBLIC_TOKEN_KEY_PATH_VAR,
  packEndpointHostAllowed,
  parseAzureKeyId,
  parseAzureVaultUrl,
  parseCorsOrigins,
  parsePackEndpointHosts,
  parsePackEndpointKmsKey,
  parsePackRouting,
  parsePackServiceToken,
  parsePackTenantId,
  parsePublicUrl,
} from '../src/index.js';

describe('parseAzureVaultUrl', () => {
  test("a vault's https origin; a trailing slash or whitespace is dropped; unset is undefined", () => {
    expect(parseAzureVaultUrl('https://my-kindgi-secrets.vault.azure.net')).toBe(
      'https://my-kindgi-secrets.vault.azure.net',
    );
    expect(parseAzureVaultUrl(' https://v.vault.azure.cn/\n')).toBe('https://v.vault.azure.cn');
    expect(parseAzureVaultUrl(undefined)).toBeUndefined();
    expect(parseAzureVaultUrl('')).toBeUndefined();
  });

  test.each([
    ['my-vault.vault.azure.net'],
    ['http://my-vault.vault.azure.net'],
    ['https://my-vault.vault.azure.net/secrets/x'],
    ['https://my-vault.vault.azure.net/?api-version=7.5'],
  ])('refuses %j', (raw) => {
    expect(() => parseAzureVaultUrl(raw)).toThrow(
      `${AZURE_VAULT_URL_VAR} must be a Key Vault's URL with nothing after the host, like https://my-kindgi-secrets.vault.azure.net. Got: ${raw}.`,
    );
  });
});

describe('parseAzureKeyId', () => {
  test('a versionless key URL: the key, its vault and its name; a trailing slash is dropped', () => {
    const expected = {
      keyUrl: 'https://my-vault.vault.azure.net/keys/kindgi-secrets',
      vaultUrl: 'https://my-vault.vault.azure.net',
      keyName: 'kindgi-secrets',
    };
    expect(parseAzureKeyId('https://my-vault.vault.azure.net/keys/kindgi-secrets')).toEqual(
      expected,
    );
    expect(parseAzureKeyId(' https://my-vault.vault.azure.net/keys/kindgi-secrets/\n')).toEqual(
      expected,
    );
  });

  test("another Azure cloud's vault, or a Managed HSM", () => {
    expect(parseAzureKeyId('https://v.vault.usgovcloudapi.net/keys/k')?.vaultUrl).toBe(
      'https://v.vault.usgovcloudapi.net',
    );
    expect(parseAzureKeyId('https://h.managedhsm.azure.net/keys/k')?.keyUrl).toBe(
      'https://h.managedhsm.azure.net/keys/k',
    );
  });

  test('unset or blank: undefined', () => {
    expect(parseAzureKeyId(undefined)).toBeUndefined();
    expect(parseAzureKeyId(' ')).toBeUndefined();
  });

  test('a URL pinned to one version is refused, naming the versionless one', () => {
    expect(() =>
      parseAzureKeyId(
        'https://my-vault.vault.azure.net/keys/kindgi-secrets/0123456789abcdef0123456789abcdef',
      ),
    ).toThrow(
      `${AZURE_KEY_ID_VAR} names one version of the key (0123456789abcdef0123456789abcdef). Give the key without it, https://my-vault.vault.azure.net/keys/kindgi-secrets: new secrets are wrapped with the key's current version, so a pinned version would outlive the key's rotation.`,
    );
  });

  test.each([
    ['my-vault/keys/k'],
    ['http://my-vault.vault.azure.net/keys/k'],
    ['https://my-vault.vault.azure.net/secrets/k'],
    ['https://my-vault.vault.azure.net/keys/'],
    ['https://my-vault.vault.azure.net/keys/under_score'],
    ['https://my-vault.vault.azure.net/keys/k?api-version=7.5'],
    ['https://user:pw@my-vault.vault.azure.net/keys/k'],
    ['https://my-vault.vault.azure.net/keys/k/v/extra'],
  ])('refuses %j', (raw) => {
    expect(() => parseAzureKeyId(raw)).toThrow(
      `${AZURE_KEY_ID_VAR} must be a Key Vault key's URL without a version, like https://my-vault.vault.azure.net/keys/kindgi-secrets. Got: ${raw}.`,
    );
  });
});

describe('parsePackServiceToken', () => {
  test('without its surrounding whitespace: a secret stored with a trailing newline matches', () => {
    expect(parsePackServiceToken('3f9ac0ffee')).toBe('3f9ac0ffee');
    expect(parsePackServiceToken('3f9ac0ffee\n')).toBe('3f9ac0ffee');
    expect(parsePackServiceToken('  3f9ac0ffee\r\n')).toBe('3f9ac0ffee');
    expect(parsePackServiceToken('a+b/c=')).toBe('a+b/c=');
  });

  test('unset or blank: undefined', () => {
    expect(parsePackServiceToken(undefined)).toBeUndefined();
    expect(parsePackServiceToken('')).toBeUndefined();
    expect(parsePackServiceToken(' \n')).toBeUndefined();
  });

  test.each([['two words'], ['tab\tinside'], ['line\nbreak'], ['caf\u00e9'], ['nul\u0000']])(
    "refuses %j, which a header can't carry",
    (raw) => {
      expect(() => parsePackServiceToken(raw)).toThrow(
        'KINDGI_PACK_SERVICE_TOKEN may hold only printable ASCII without spaces (it travels in an HTTP header). Use a random value such as `openssl rand -hex 32`.',
      );
    },
  );
});

describe('parseCorsOrigins', () => {
  test('exact origins, trimmed, deduplicated; unset or empty is none', () => {
    expect(
      parseCorsOrigins(' https://app.example.com, http://localhost:3000,https://app.example.com '),
    ).toEqual(['https://app.example.com', 'http://localhost:3000']);
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins(' ')).toEqual([]);
  });

  test.each([
    'https://app.example.com/',
    'https://app.example.com/path',
    'https://*.example.com',
    '*',
    'app.example.com',
    'ftp://app.example.com',
    'https://App.example.com',
  ])('refuses %s', (origin) => {
    expect(() => parseCorsOrigins(origin)).toThrow(
      /KINDGI_CORS_ORIGINS entries must be exact origins/,
    );
  });
});

describe('variable names', () => {
  test('both are in the schema', () => {
    const names = KINDGI_ENV_SCHEMA.map((v) => v.name);
    expect(names).toContain(PUBLIC_TOKEN_KEY_PATH_VAR);
    expect(names).toContain(CORS_ORIGINS_VAR);
  });
});

describe('parsePublicUrl (T219)', () => {
  test('unset or empty: undefined', () => {
    expect(parsePublicUrl(undefined)).toBeUndefined();
    expect(parsePublicUrl('  ')).toBeUndefined();
  });

  test('an http(s) URL, trimmed, without its trailing slash', () => {
    expect(parsePublicUrl(' http://127.0.0.1:4001/ ')).toBe('http://127.0.0.1:4001');
    expect(parsePublicUrl('https://kindgi.example.com')).toBe('https://kindgi.example.com');
    expect(parsePublicUrl('https://example.com/kindgi/')).toBe('https://example.com/kindgi');
  });

  test('anything else is refused, naming the variable', () => {
    for (const bad of [
      'kindgi.example.com',
      'ftp://kindgi.example.com',
      'https://user:pass@kindgi.example.com',
      'https://kindgi.example.com/?a=1',
      'https://kindgi.example.com/#top',
    ]) {
      expect(() => parsePublicUrl(bad)).toThrow(/^KINDGI_PUBLIC_URL must be an http\(s\) URL/);
    }
  });
});

describe('parsePackTenantId', () => {
  test('a tenant id, without its surrounding whitespace; unset or blank is undefined (no pin)', () => {
    expect(parsePackTenantId(' 4fc847d5-95b4-4c68-bf9d-618a241c9771\n')).toBe(
      '4fc847d5-95b4-4c68-bf9d-618a241c9771',
    );
    expect(parsePackTenantId('4FC847D5-95B4-4C68-BF9D-618A241C9771')).toBe(
      '4FC847D5-95B4-4C68-BF9D-618A241C9771',
    );
    expect(parsePackTenantId(undefined)).toBeUndefined();
    expect(parsePackTenantId(' ')).toBeUndefined();
  });

  test.each([
    ['t-1'],
    ['acme'],
    ['two words'],
    ['caf\u00e9'],
    ['nul\u0000'],
    ['4fc847d5-95b4-4c68-bf9d-618a241c977'],
    ['4fc847d5-95b4-4c68-bf9d-618a241c9771x'],
    ['{4fc847d5-95b4-4c68-bf9d-618a241c9771}'],
    ['4fc847d595b44c68bf9d618a241c9771'],
  ])('refuses %j at startup: not a tenant id, so it would refuse every call', (raw) => {
    expect(() => parsePackTenantId(raw)).toThrow(
      "KINDGI_PACK_TENANT_ID must be the tenant's id, a UUID",
    );
  });

  test.each([['00000000-0000-4000-8000-000000000000'], [' 00000000-0000-4000-8000-000000000000 ']])(
    'refuses %j, the id no tenant has',
    (raw) => {
      expect(() => parsePackTenantId(raw)).toThrow('the id no tenant has');
    },
  );
});

describe('parsePackRouting', () => {
  test('unset or blank is single; per-deployment as given', () => {
    expect(parsePackRouting(undefined)).toBe('single');
    expect(parsePackRouting('')).toBe('single');
    expect(parsePackRouting('per-deployment')).toBe('per-deployment');
  });

  test('anything else fails at startup, naming the setting', () => {
    expect(() => parsePackRouting('per-tenant')).toThrow('KINDGI_PACK_ROUTING');
  });
});

describe('KINDGI_PACK_ENDPOINT_KMS_KEY', () => {
  test("a Cloud KMS key's full name: its parts, the provider read from the form", () => {
    expect(
      parsePackEndpointKmsKey(
        ' projects/acme-prod/locations/us-central1/keyRings/kindgi/cryptoKeys/pack_endpoints\n',
      ),
    ).toEqual({
      provider: 'gcp',
      projectId: 'acme-prod',
      locationId: 'us-central1',
      keyRingId: 'kindgi',
      cryptoKeyId: 'pack_endpoints',
    });
    expect(
      parsePackEndpointKmsKey('projects/p/locations/global/keyRings/r/cryptoKeys/k/'),
    ).toMatchObject({ provider: 'gcp', cryptoKeyId: 'k' });
  });

  test("a Key Vault key's URL, with a trailing slash dropped", () => {
    expect(
      parsePackEndpointKmsKey('https://my-vault.vault.azure.net/keys/kindgi-pack-endpoints/'),
    ).toEqual({
      provider: 'azure',
      keyUrl: 'https://my-vault.vault.azure.net/keys/kindgi-pack-endpoints',
    });
  });

  test('unset or blank is undefined', () => {
    expect(parsePackEndpointKmsKey(undefined)).toBeUndefined();
    expect(parsePackEndpointKmsKey('  ')).toBeUndefined();
  });

  test('one version of either key is refused, naming the key without it', () => {
    expect(() =>
      parsePackEndpointKmsKey('projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/3'),
    ).toThrow(
      'KINDGI_PACK_ENDPOINT_KMS_KEY names one version of the key (3). Give the key without it, projects/p/locations/l/keyRings/r/cryptoKeys/k: new tokens are sealed',
    );
    expect(() =>
      parsePackEndpointKmsKey('https://my-vault.vault.azure.net/keys/kindgi/0123abcd'),
    ).toThrow(
      'KINDGI_PACK_ENDPOINT_KMS_KEY names one version of the key (0123abcd). Give the key without it, https://my-vault.vault.azure.net/keys/kindgi: new tokens are sealed',
    );
  });

  test('any other value is refused, naming both forms', () => {
    for (const raw of [
      'kindgi-pack-endpoints',
      'projects/p/locations/l/keyRings/r',
      'projects/p/locations/l/keyRings/r/cryptoKeys/k/extra',
      'projects/p/locations/l/keyRings/r w/cryptoKeys/k',
      '//cloudkms.googleapis.com/projects/p/locations/l/keyRings/r/cryptoKeys/k',
      'http://my-vault.vault.azure.net/keys/kindgi',
    ]) {
      expect(() => parsePackEndpointKmsKey(raw), raw).toThrow(
        /^KINDGI_PACK_ENDPOINT_KMS_KEY must be a Cloud KMS key's full name \(projects\/.*\) or a Key Vault key's URL \(https:\/\/.*\), without a version\. Got: /,
      );
    }
    expect(() =>
      parsePackEndpointKmsKey('https://my-vault.vault.azure.net/secrets/kindgi'),
    ).toThrow(
      "KINDGI_PACK_ENDPOINT_KMS_KEY must be a Key Vault key's URL without a version, like https://my-vault.vault.azure.net/keys/kindgi-pack-endpoints.",
    );
  });

  test('the secrets key keeps its own name in its errors', () => {
    expect(() => parseAzureKeyId('https://v.vault.azure.net/keys/k/1')).toThrow(
      'KINDGI_SECRETS_AZURE_KEY_ID names one version of the key (1). Give the key without it, https://v.vault.azure.net/keys/k: new secrets are wrapped',
    );
  });
});

describe('KINDGI_PACK_ENDPOINT_HOSTS', () => {
  const allowed = parsePackEndpointHosts('*.packs.internal, pack.internal');

  test('unset or blank: none, so every endpoint is refused', () => {
    expect(parsePackEndpointHosts(undefined)).toEqual([]);
    expect(packEndpointHostAllowed('pack.internal', parsePackEndpointHosts(''))).toBe(false);
  });

  test('`*.` matches exactly one more label in front of the domain', () => {
    expect(allowed[0]).toEqual({ kind: 'suffix', suffix: 'packs.internal' });
    expect(packEndpointHostAllowed('kp-abcdefghijklmnopqrst.packs.internal', allowed)).toBe(true);
    expect(packEndpointHostAllowed('KP-ABC.PACKS.INTERNAL', allowed)).toBe(true);
    expect(packEndpointHostAllowed('packs.internal', allowed)).toBe(false);
    expect(packEndpointHostAllowed('a.b.packs.internal', allowed)).toBe(false);
    expect(packEndpointHostAllowed('kp-x.other.internal', allowed)).toBe(false);
    expect(packEndpointHostAllowed('evilpacks.internal', allowed)).toBe(false);
  });

  test.each([
    ['*.run.app'],
    ['*.a.run.app'],
    ['*.us-central1.run.app'],
    ['pack.internal, *.europe-west1.run.app'],
  ])("refuses %j at startup: Cloud Run's shared domain admits anyone's service", (raw) => {
    expect(() => parsePackEndpointHosts(raw)).toThrow(
      /KINDGI_PACK_ENDPOINT_HOSTS refuses "\*\.(?:[a-z0-9-]+\.)?run\.app": run\.app is Cloud Run's shared domain.*List the exact hosts, or name one project with `\*-<project number>\.<region>\.run\.app`/,
    );
  });

  test.each([['*-uc.a.run.app'], ['*-abc.us-central1.run.app'], ['*-123abc.run.app']])(
    "refuses %j at startup: under run.app, a tail other than a project number admits anyone's service",
    (raw) => {
      expect(() => parsePackEndpointHosts(raw)).toThrow(
        `KINDGI_PACK_ENDPOINT_HOSTS refuses "${raw}": run.app is Cloud Run's shared domain`,
      );
    },
  );

  test('a tail outside run.app may be any label', () => {
    expect(parsePackEndpointHosts('*-anything.packs.internal')).toEqual([
      { kind: 'tail', tail: 'anything', domain: 'packs.internal' },
    ]);
  });

  test('on Cloud Run, the tail form and exact hosts are taken; a domain that only ends in run.app is not Cloud Run', () => {
    expect(
      parsePackEndpointHosts(
        '*-123456789012.us-central1.run.app, kp-abc-123456789012.us-central1.run.app, *.notrun.app',
      ),
    ).toEqual([
      { kind: 'tail', tail: '123456789012', domain: 'us-central1.run.app' },
      { kind: 'exact', host: 'kp-abc-123456789012.us-central1.run.app' },
      { kind: 'suffix', suffix: 'notrun.app' },
    ]);
  });

  test("`*-<tail>.` matches one more label that ends with `-<tail>`: one Cloud Run project, not anyone's", () => {
    const project = parsePackEndpointHosts('*-123456789012.us-central1.run.app');
    expect(project).toEqual([
      { kind: 'tail', tail: '123456789012', domain: 'us-central1.run.app' },
    ]);
    expect(
      packEndpointHostAllowed('kp-abcdefghijklmnopqrst-123456789012.us-central1.run.app', project),
    ).toBe(true);
    // The same service name in someone else's project: refused.
    expect(
      packEndpointHostAllowed('kp-abcdefghijklmnopqrst-999999999999.us-central1.run.app', project),
    ).toBe(false);
    expect(packEndpointHostAllowed('kp-x123456789012.us-central1.run.app', project)).toBe(false);
    expect(packEndpointHostAllowed('123456789012.us-central1.run.app', project)).toBe(false);
    expect(packEndpointHostAllowed('a.kp-x-123456789012.us-central1.run.app', project)).toBe(false);
  });

  test('an exact host matches only itself', () => {
    expect(packEndpointHostAllowed('pack.internal', allowed)).toBe(true);
    expect(packEndpointHostAllowed('x.pack.internal', allowed)).toBe(false);
  });

  test.each([
    ['https://x.run.app'],
    ['x.run.app:443'],
    ['x.run.app/path'],
    ['*'],
    ['*.app'],
    ['localhost'],
    ['Upper.Example.com'],
    ['*-.us-central1.run.app'],
    ['*-123'],
    ['*-12_3.run.app'],
  ])('refuses %j at startup', (raw) => {
    expect(() => parsePackEndpointHosts(raw)).toThrow(
      'KINDGI_PACK_ENDPOINT_HOSTS takes host names',
    );
  });
});
