// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  AZURE_KEY_ID_VAR,
  CORS_ORIGINS_VAR,
  KINDGI_ENV_SCHEMA,
  PUBLIC_TOKEN_KEY_PATH_VAR,
  parseAzureKeyId,
  parseCorsOrigins,
  parsePackServiceToken,
  parsePublicUrl,
} from '../src/index.js';

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
