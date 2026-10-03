// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Conformance tests for `@kindgi/env-schema`. Covers:
 *
 *   - `envVarsForTarget` filters by predicate (backend + KMS axes).
 *   - `renderEnvExample` produces well-formed dotenv output with
 *     comments, group headers, and required-vs-optional prefixing.
 *   - `validateEnvForTarget` enumerates every missing required var
 *     (not just the first).
 *   - Schema integrity — no duplicate names, every entry has an
 *     example, `allowedValues` when set includes the `example`.
 */

import { describe, expect, test } from 'vitest';

import {
  type EnvTarget,
  type EnvVarSpec,
  KINDGI_ENV_SCHEMA,
  LICENSE_KEY_VAR,
  envVarsForTarget,
  renderEnvExample,
  validateEnvForTarget,
} from '../src/index.js';

// ---------- envVarsForTarget ----------

describe('envVarsForTarget', () => {
  test('empty target returns only always-applicable vars (core group)', () => {
    const vars = envVarsForTarget({});
    // All core vars apply universally.
    for (const v of vars) {
      expect(v.appliesTo({})).toBe(true);
    }
    // No postgres-only vars in the empty-target result.
    const names = vars.map((v) => v.name);
    expect(names).not.toContain('KINDGI_SECRETS_BACKEND_KMS');
    expect(names).not.toContain('KINDGI_SECRETS_AAD_KEY_PATH');
  });

  test('backend=postgres includes backend-scoped vars but not vendor-specific ones', () => {
    const vars = envVarsForTarget({ secretsBackend: 'postgres' });
    const names = vars.map((v) => v.name);
    expect(names).toContain('KINDGI_SECRETS_BACKEND_KMS');
    expect(names).toContain('KINDGI_SECRETS_AAD_KEY_PATH');
    // KMS not chosen yet → vendor-specific vars omitted.
    expect(names).not.toContain('KINDGI_SECRETS_GCP_PROJECT_ID');
  });

  test('backend=postgres + kms=gcp includes every GCP var', () => {
    const vars = envVarsForTarget({ secretsBackend: 'postgres', secretsBackendKms: 'gcp' });
    const names = vars.map((v) => v.name);
    for (const expected of [
      'KINDGI_SECRETS_BACKEND',
      'KINDGI_SECRETS_BACKEND_KMS',
      'KINDGI_SECRETS_AAD_KEY_PATH',
      'KINDGI_SECRETS_GCP_PROJECT_ID',
      'KINDGI_SECRETS_GCP_LOCATION_ID',
      'KINDGI_SECRETS_GCP_KEY_RING_ID',
      'KINDGI_SECRETS_GCP_KEY_ID',
    ]) {
      expect(names).toContain(expected);
    }
  });

  test('backend=dotenv includes its directory (required) and file list, and no KMS vars', () => {
    const vars = envVarsForTarget({ secretsBackend: 'dotenv' });
    const byName = new Map(vars.map((v) => [v.name, v]));
    expect(byName.get('KINDGI_SECRETS_DOTENV_DIR')?.required).toBe(true);
    expect(byName.get('KINDGI_SECRETS_DOTENV_FILES')?.required).toBe(false);
    expect(byName.has('KINDGI_SECRETS_BACKEND_KMS')).toBe(false);
    expect(byName.has('KINDGI_SECRETS_AAD_KEY_PATH')).toBe(false);
    expect(validateEnvForTarget({}, { secretsBackend: 'dotenv' })).toEqual({
      ok: false,
      missing: ['KINDGI_SECRETS_DOTENV_DIR'],
    });
  });

  test('KINDGI_DEV applies everywhere and takes the boolean values', () => {
    const dev = envVarsForTarget({}).find((v) => v.name === 'KINDGI_DEV');
    expect(dev?.allowedValues).toEqual(['true', 'false', '1', '0']);
    expect(dev?.required).toBe(false);
  });

  test('KINDGI_TENANT_HOST_ACCESS: the server only, optional, local or deployed', () => {
    const access = envVarsForTarget({}).find((v) => v.name === 'KINDGI_TENANT_HOST_ACCESS');
    expect(access).toMatchObject({ group: 'core', required: false });
    expect(access?.allowedValues).toEqual(['local', 'deployed']);
    expect(
      envVarsForTarget({ component: 'pack-service' }).some(
        (v) => v.name === 'KINDGI_TENANT_HOST_ACCESS',
      ),
    ).toBe(false);
  });

  test("the server's bind host and its development settings: optional, server only", () => {
    const server = envVarsForTarget({});
    const host = server.find((v) => v.name === 'KINDGI_API_HOST');
    expect(host).toMatchObject({ group: 'core', required: false });
    for (const name of ['KINDGI_PACK_DIR', 'KINDGI_DEV_CONSOLE_LOGIN', 'KINDGI_DEV_HOST_ALIAS']) {
      expect(server.find((v) => v.name === name)).toMatchObject({ group: 'dev', required: false });
    }
    expect(server.find((v) => v.name === 'KINDGI_DEV_CONSOLE_LOGIN')?.allowedValues).toEqual([
      'true',
      'false',
      '1',
      '0',
    ]);
    const packService = envVarsForTarget({ component: 'pack-service' }).map((v) => v.name);
    for (const name of [
      'KINDGI_API_HOST',
      'KINDGI_PACK_DIR',
      'KINDGI_DEV_CONSOLE_LOGIN',
      'KINDGI_DEV_HOST_ALIAS',
    ]) {
      expect(packService).not.toContain(name);
    }
  });

  test('KINDGI_ENV applies everywhere and is optional (development mode defaults it)', () => {
    const env = envVarsForTarget({}).find((v) => v.name === 'KINDGI_ENV');
    expect(env?.group).toBe('core');
    expect(env?.required).toBe(false);
  });

  test('backend=none does not include any secrets-scoped required var', () => {
    const vars = envVarsForTarget({ secretsBackend: 'none' });
    for (const v of vars) {
      if (v.required) {
        // No required var should exist under backend=none.
        expect(v.name).not.toMatch(/^KINDGI_SECRETS_/);
      }
    }
  });

  test('kms=aws (unwired for now) still filters against the postgres predicate', () => {
    // KMS filter is over `secretsBackend + secretsBackendKms` — aws will
    // gate through the postgres+aws vendor group when one exists.
    // Today no `aws` var group exists in the schema, but the postgres-
    // scoped vars still apply.
    const vars = envVarsForTarget({ secretsBackend: 'postgres', secretsBackendKms: 'aws' });
    const names = vars.map((v) => v.name);
    expect(names).toContain('KINDGI_SECRETS_AAD_KEY_PATH');
    // GCP vars only apply to gcp, not aws.
    expect(names).not.toContain('KINDGI_SECRETS_GCP_PROJECT_ID');
  });
});

describe('envVarsForTarget — the pack service', () => {
  const PACK_SERVICE_VARS = [
    'KINDGI_PACK_SERVICE_TOKEN',
    'KINDGI_PACK_INDEX',
    'KINDGI_PACK_SERVICE_MAX_CONCURRENCY',
    'KINDGI_PACK_ENV_CHECK',
  ];

  test("component=pack-service is the pack service's vars and none of the server's", () => {
    const names = envVarsForTarget({ component: 'pack-service' }).map((v) => v.name);
    expect(names.sort()).toEqual([...PACK_SERVICE_VARS].sort());
  });

  test('a server target without a pack transport offers the URL only', () => {
    for (const target of [{}, { component: 'server' as const }]) {
      const names = envVarsForTarget(target).map((v) => v.name);
      expect(names).toContain('KINDGI_PACK_SERVICE_URL');
      expect(names).not.toContain('KINDGI_PACK_SERVICE_TOKEN');
      expect(names).not.toContain('KINDGI_PACK_CALL_TIMEOUT_MS');
      expect(names).not.toContain('KINDGI_PACK_INDEX');
    }
  });

  test('packTransport=http adds the token (required) and the call timeout', () => {
    const vars = envVarsForTarget({ packTransport: 'http' });
    const token = vars.find((v) => v.name === 'KINDGI_PACK_SERVICE_TOKEN');
    expect(token?.required).toBe(true);
    expect(vars.map((v) => v.name)).toContain('KINDGI_PACK_CALL_TIMEOUT_MS');
  });

  test('the pack service gets none of the server vars, whatever else the target says', () => {
    const names = envVarsForTarget({
      component: 'pack-service',
      secretsBackend: 'postgres',
      secretsBackendKms: 'gcp',
      packTransport: 'http',
    }).map((v) => v.name);
    expect(names.sort()).toEqual([...PACK_SERVICE_VARS].sort());
  });
});

// ---------- validateEnvForTarget ----------

describe('validateEnvForTarget — the pack service', () => {
  test('the server with an HTTP pack transport needs the token', () => {
    expect(
      validateEnvForTarget(
        { KINDGI_PACK_SERVICE_URL: 'http://pack:8080' },
        { packTransport: 'http' },
      ),
    ).toEqual({ ok: false, missing: ['KINDGI_PACK_SERVICE_TOKEN'] });
    expect(
      validateEnvForTarget(
        { KINDGI_PACK_SERVICE_URL: 'http://pack:8080', KINDGI_PACK_SERVICE_TOKEN: 't' },
        { packTransport: 'http' },
      ),
    ).toEqual({ ok: true });
  });

  test('the pack service needs the token', () => {
    expect(validateEnvForTarget({}, { component: 'pack-service' })).toEqual({
      ok: false,
      missing: ['KINDGI_PACK_SERVICE_TOKEN'],
    });
  });
});

describe('validateEnvForTarget', () => {
  test('empty env with empty target → ok (no required core vars)', () => {
    expect(validateEnvForTarget({}, {})).toEqual({ ok: true });
  });

  test('backend=postgres + kms=gcp with full env → ok', () => {
    const env = {
      KINDGI_SECRETS_BACKEND_KMS: 'gcp',
      KINDGI_SECRETS_AAD_KEY_PATH: '/etc/kindgi/aad.key',
      KINDGI_SECRETS_GCP_PROJECT_ID: 'my-proj',
      KINDGI_SECRETS_GCP_LOCATION_ID: 'us-central1',
      KINDGI_SECRETS_GCP_KEY_RING_ID: 'kindgi',
      KINDGI_SECRETS_GCP_KEY_ID: 'secrets-kek',
    };
    expect(
      validateEnvForTarget(env, { secretsBackend: 'postgres', secretsBackendKms: 'gcp' }),
    ).toEqual({ ok: true });
  });

  test('backend=postgres + kms=gcp with partial env → returns EVERY missing var, not just first', () => {
    const result = validateEnvForTarget(
      { KINDGI_SECRETS_GCP_PROJECT_ID: 'my-proj' },
      { secretsBackend: 'postgres', secretsBackendKms: 'gcp' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The 4 other required vars are missing. The AAD key is one of two
    // names (a path or the value), which the server checks itself.
    expect(result.missing).toEqual(
      expect.arrayContaining([
        'KINDGI_SECRETS_BACKEND_KMS',
        'KINDGI_SECRETS_GCP_LOCATION_ID',
        'KINDGI_SECRETS_GCP_KEY_RING_ID',
        'KINDGI_SECRETS_GCP_KEY_ID',
      ]),
    );
    expect(result.missing).not.toContain('KINDGI_SECRETS_GCP_PROJECT_ID');
    expect(result.missing).not.toContain('KINDGI_SECRETS_AAD_KEY_PATH');
  });

  test('the key sources come in pairs, a path or the value, neither required on its own', () => {
    const postgres = new Map(
      envVarsForTarget({ secretsBackend: 'postgres' }).map((v) => [v.name, v]),
    );
    expect(postgres.get('KINDGI_SECRETS_AAD_KEY_PATH')?.required).toBe(false);
    expect(postgres.get('KINDGI_SECRETS_AAD_KEY')?.required).toBe(false);
    const server = new Map(envVarsForTarget({}).map((v) => [v.name, v]));
    expect(server.has('KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH')).toBe(true);
    expect(server.has('KINDGI_PUBLIC_TOKEN_SIGNING_KEY')).toBe(true);
  });

  test('KINDGI_LICENSE_KEY is a server variable the schema leaves optional (the server requires it outside development mode)', () => {
    const key = envVarsForTarget({}).find((v) => v.name === LICENSE_KEY_VAR);
    expect(key?.required).toBe(false);
    expect(key?.appliesTo({})).toBe(true);
    expect(key?.example).toBe('');
  });

  test('the server and registry auth modes', () => {
    const http = new Map(envVarsForTarget({ packTransport: 'http' }).map((v) => [v.name, v]));
    expect(http.get('KINDGI_PACK_SERVICE_AUTH')?.allowedValues).toEqual([
      'token',
      'google-id-token',
    ]);
    expect(envVarsForTarget({}).map((v) => v.name)).not.toContain('KINDGI_PACK_SERVICE_AUTH');
    const server = new Map(envVarsForTarget({}).map((v) => [v.name, v]));
    expect(server.get('KINDGI_IMAGE_REGISTRY_AUTH')?.allowedValues).toEqual(['static', 'google']);
  });

  test('empty string is treated as missing', () => {
    const result = validateEnvForTarget(
      { KINDGI_SECRETS_BACKEND_KMS: '' },
      { secretsBackend: 'postgres' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toContain('KINDGI_SECRETS_BACKEND_KMS');
  });

  test('optional vars unset → still ok', () => {
    // KINDGI_API_PORT is optional; missing is fine.
    expect(validateEnvForTarget({}, {})).toEqual({ ok: true });
  });
});

// ---------- renderEnvExample ----------

describe('renderEnvExample', () => {
  test('emits header + group section for known groups', () => {
    const vars = envVarsForTarget({ secretsBackend: 'postgres', secretsBackendKms: 'gcp' });
    const out = renderEnvExample(vars);
    expect(out).toContain('Generated by `kindgi env init`');
    expect(out).toContain('---- Core server config ----');
    expect(out).toContain('---- Secrets backend selection ----');
    expect(out).toContain('---- GCP vendor config');
    // Development settings come last, under their own header.
    expect(out).toContain('---- Development (`kindgi dev`; each needs `KINDGI_DEV=true`) ----');
    expect(out.indexOf('---- Development')).toBeGreaterThan(out.indexOf('---- GCP vendor config'));
  });

  test('required vars are uncommented; optional vars are commented out', () => {
    const vars = envVarsForTarget({ secretsBackend: 'postgres', secretsBackendKms: 'gcp' });
    const out = renderEnvExample(vars);
    // Required example: uncommented.
    expect(out).toContain('KINDGI_SECRETS_GCP_PROJECT_ID=my-proj');
    // Optional core var: commented out.
    expect(out).toContain('# KINDGI_API_PORT=4000');
  });

  test('includes description as comment for every var', () => {
    const vars = envVarsForTarget({});
    const out = renderEnvExample(vars);
    // First core var's description text.
    expect(out).toContain('HTTP port the Kindgi API server listens on');
  });

  test('emits allowed values as a comment when set', () => {
    const vars = envVarsForTarget({});
    const out = renderEnvExample(vars);
    expect(out).toContain('Allowed values: true | false | 1 | 0');
  });

  test('empty var list → still emits the header (no crash)', () => {
    const out = renderEnvExample([]);
    expect(out).toContain('Generated by `kindgi env init`');
  });
});

// ---------- schema integrity ----------

describe('KINDGI_ENV_SCHEMA — integrity', () => {
  test('no duplicate var names', () => {
    const names = KINDGI_ENV_SCHEMA.map((v) => v.name);
    const set = new Set(names);
    expect(set.size).toBe(names.length);
  });

  test('every var has a non-empty name + description', () => {
    for (const v of KINDGI_ENV_SCHEMA) {
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.description.length).toBeGreaterThan(0);
    }
  });

  test('every var has an example (empty string permitted for caller-must-fill cases)', () => {
    for (const v of KINDGI_ENV_SCHEMA) {
      expect(typeof v.example).toBe('string');
    }
  });

  test('every var name uses the KINDGI_ prefix — no exceptions', () => {
    // The prefix separates Kindgi's runtime config from the host app's
    // (and the agents') vars when both share one `.env`. An un-prefixed
    // name like `DATABASE_URL` would pick up the host app's value.
    const unprefixed = KINDGI_ENV_SCHEMA.filter((v) => !v.name.startsWith('KINDGI_')).map(
      (v) => v.name,
    );
    expect(unprefixed).toEqual([]);
  });

  test('allowedValues (when set) includes the example', () => {
    for (const v of KINDGI_ENV_SCHEMA) {
      if (v.allowedValues === undefined) continue;
      if (v.example === '') continue;
      expect(v.allowedValues).toContain(v.example);
    }
  });

  test('appliesTo is stable across calls (pure function)', () => {
    const target: EnvTarget = { secretsBackend: 'postgres', secretsBackendKms: 'gcp' };
    for (const v of KINDGI_ENV_SCHEMA) {
      const first = v.appliesTo(target);
      const second = v.appliesTo(target);
      expect(first).toBe(second);
    }
  });
});

// ---------- injectable schema override ----------

describe('injectable schema override', () => {
  test('caller can pass a custom schema subset', () => {
    const custom: readonly EnvVarSpec[] = [
      {
        name: 'CUSTOM_ONE',
        description: 'test',
        example: 'x',
        required: true,
        appliesTo: () => true,
      },
    ];
    const vars = envVarsForTarget({}, custom);
    expect(vars).toHaveLength(1);
    expect(vars[0]?.name).toBe('CUSTOM_ONE');

    const validate = validateEnvForTarget({}, {}, custom);
    expect(validate.ok).toBe(false);
    if (validate.ok) return;
    expect(validate.missing).toEqual(['CUSTOM_ONE']);
  });
});
