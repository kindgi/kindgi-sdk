// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  carriesCredential,
  describePackEnvPlan,
  plainSecretReason,
  planPackEnv,
  readEnvironmentEnv,
  renderGcloud,
  renderTerraform,
} from '../src/env/pack-env-plan.js';

const config = (env: unknown, production: unknown): Record<string, unknown> => ({
  pack: { id: 'acme.app', version: '1.0.0' },
  env,
  environments: { production: { endpoint: 'https://api.example.com', env: production } },
});

describe('plain values that are secrets', () => {
  test('a URL with a password carries a credential; one without, or any other value, does not', () => {
    expect(carriesCredential('postgres://app:s3cret@db.internal:5432/app')).toBe(true);
    expect(carriesCredential('redis://:s3cret@cache:6379')).toBe(true);
    expect(carriesCredential('postgres://app@db.internal/app')).toBe(false);
    expect(carriesCredential('https://api.example.com/v1')).toBe(false);
    expect(carriesCredential('info')).toBe(false);
  });

  test('refused by its name or by a credential inside it', () => {
    expect(plainSecretReason('STRIPE_API_KEY', 'x')).toBe('STRIPE_API_KEY is named like a secret');
    expect(plainSecretReason('DATABASE_URL', 'postgres://u:p@h/db')).toBe(
      "DATABASE_URL's value has a credential in it (a URL with a password)",
    );
    expect(plainSecretReason('LOG_LEVEL', 'info')).toBeUndefined();
  });
});

describe('readEnvironmentEnv', () => {
  test('strings are values; { secret, version, project? } are references', () => {
    const { sources, problems } = readEnvironmentEnv(
      config(undefined, {
        LOG_LEVEL: 'info',
        DATABASE_URL: { secret: 'acme-db-url', version: '3' },
        SHARED_TOKEN: { secret: 'shared-token', version: 'latest', project: '123456789012' },
      }),
      'production',
    );
    expect(problems).toEqual([]);
    expect(Object.fromEntries(sources)).toEqual({
      LOG_LEVEL: { kind: 'value', value: 'info' },
      DATABASE_URL: { kind: 'secret', secret: 'acme-db-url', version: '3' },
      SHARED_TOKEN: {
        kind: 'secret',
        secret: 'shared-token',
        version: 'latest',
        project: '123456789012',
      },
    });
  });

  test.each([
    [{ A: 3 }, 'environments.production.env.A must be a string or { secret, version, project? }'],
    [
      { A: { secret: 'a/b', version: '1' } },
      'environments.production.env.A.secret must be a Secret Manager secret id',
    ],
    [
      { A: { secret: 'a', version: 'v1' } },
      'environments.production.env.A.version must be a version number',
    ],
    [
      { A: { secret: 'a', version: '1', project: 'acme-prod' } },
      'environments.production.env.A.project must be a project number',
    ],
    [
      { A: { secret: 'a', version: '1', key: 'x' } },
      'environments.production.env.A takes secret, version and project, not key',
    ],
  ])('refuses %j', (env, message) => {
    const { problems } = readEnvironmentEnv(config(undefined, env), 'production');
    expect(problems.join('\n')).toContain(message);
  });

  test('no environment, or no env in it: no sources', () => {
    expect(readEnvironmentEnv(undefined, 'production').sources.size).toBe(0);
    expect(readEnvironmentEnv(config(undefined, undefined), 'staging').sources.size).toBe(0);
  });
});

describe('planPackEnv', () => {
  const declared = {
    required: ['DATABASE_URL', 'STORAGE_BUCKET'],
    optional: ['LOG_LEVEL', 'TRACE'],
  };

  test('each declared name with its source; required first; a required name without one is missing', () => {
    const planned = planPackEnv(
      config(declared, {
        DATABASE_URL: { secret: 'acme-db-url', version: '3' },
        LOG_LEVEL: 'info',
      }),
      'production',
    );
    expect(planned.kind).toBe('ok');
    if (planned.kind !== 'ok') return;
    expect(planned.plan.entries.map((e) => [e.name, e.required, e.source?.kind])).toEqual([
      ['DATABASE_URL', true, 'secret'],
      ['STORAGE_BUCKET', true, undefined],
      ['LOG_LEVEL', false, 'value'],
      ['TRACE', false, undefined],
    ]);
    expect(planned.plan.missing).toEqual(['STORAGE_BUCKET']);
    expect(planned.plan.problems).toEqual([]);
  });

  test('a secret in the clear is a problem; latest and undeclared names are warnings', () => {
    const planned = planPackEnv(
      config(declared, {
        DATABASE_URL: 'postgres://app:s3cret@db/app',
        STORAGE_BUCKET: { secret: 'bucket', version: 'latest' },
        STRAY: 'x',
      }),
      'production',
    );
    if (planned.kind !== 'ok') throw new Error('expected a plan');
    expect(planned.plan.problems).toEqual([
      "DATABASE_URL's value has a credential in it (a URL with a password): give it as { secret, version } in environments.production.env",
    ]);
    expect(planned.plan.warnings).toEqual([
      "STORAGE_BUCKET uses the latest version of bucket: it's read when an instance starts, so a new version needs a new revision",
      "environments.production.env.STRAY isn't declared in env.required or env.optional, so it isn't injected",
    ]);
  });

  test('a malformed declaration is an error, the same check the indexer runs', () => {
    expect(planPackEnv(config({ required: ['KINDGI_ENV'] }, {}), 'production')).toMatchObject({
      kind: 'err',
      message: expect.stringContaining('`KINDGI_*` names configure Kindgi'),
    });
  });

  test('a pack that declares nothing has an empty plan', () => {
    const planned = planPackEnv(config(undefined, { LOG_LEVEL: 'info' }), 'production');
    if (planned.kind !== 'ok') throw new Error('expected a plan');
    expect(planned.plan.entries).toEqual([]);
    expect(planned.plan.missing).toEqual([]);
  });
});

describe('renderings', () => {
  const plan = (() => {
    const planned = planPackEnv(
      config(
        { required: ['DATABASE_URL', 'REGIONS'], optional: ['LOG_LEVEL', 'SHARED_TOKEN'] },
        {
          DATABASE_URL: { secret: 'acme-db-url', version: '3' },
          REGIONS: 'ca,us',
          LOG_LEVEL: 'info',
          SHARED_TOKEN: { secret: 'shared-token', version: '2', project: '123456789012' },
        },
      ),
      'production',
    );
    if (planned.kind !== 'ok') throw new Error('expected a plan');
    return planned.plan;
  })();

  test('Terraform: plain values in env, references in secret_env', () => {
    expect(JSON.parse(renderTerraform(plan))).toEqual({
      env: { REGIONS: 'ca,us', LOG_LEVEL: 'info' },
      secret_env: {
        DATABASE_URL: { secret: 'acme-db-url', version: '3' },
        SHARED_TOKEN: { secret: 'shared-token', version: '2', project: '123456789012' },
      },
    });
  });

  test("gcloud: another delimiter when a value has a comma; another project's secret by its full name", () => {
    expect(renderGcloud(plan)).toBe(
      [
        '--update-env-vars=^@^REGIONS=ca,us@LOG_LEVEL=info \\',
        '--update-secrets=DATABASE_URL=acme-db-url:3,SHARED_TOKEN=projects/123456789012/secrets/shared-token:2',
        '',
      ].join('\n'),
    );
  });

  test('the terminal view: one line per name, then what is missing', () => {
    const planned = planPackEnv(config({ required: ['A_URL'], optional: ['B'] }, {}), 'production');
    if (planned.kind !== 'ok') throw new Error('expected a plan');
    expect(describePackEnvPlan(planned.plan)).toEqual([
      "  The pack service's env in production:",
      `    required  ${'A_URL'.padEnd(28)}  ✗ no value`,
      `    optional  ${'B'.padEnd(28)}  (unset: not injected)`,
      '  ✗ A_URL is required and has no value in environments.production.env',
    ]);
  });
});
