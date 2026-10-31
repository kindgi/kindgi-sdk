// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi deploy` tests. Every side effect flows through the
 * injectable `DeployRunners` seam so these tests never read a real
 * envelope file off disk, never hit a live api-server, and never
 * invoke the real inline-build path. The `kindgi.config.ts` loader
 * is likewise injected.
 *
 * Coverage:
 *
 *   - Config resolution (env-block > flag > env-var > error).
 *   - Envelope loading (explicit --from-envelope, auto-detect,
 *     inline-build fallback).
 *   - POST body shape (tenantId stripped; every required field present).
 *   - Idempotency-Key derivation (default sha256 of body; --idempotency-key override).
 *   - 201 Created vs 200 replayed vs 4xx wire-error vs transport-error.
 *   - --dry-run does NOT invoke the POST runner.
 *   - Secrets warning path (.env.<envName> detected).
 *   - Missing token / missing endpoint / missing envelope + build failure.
 *   - --tenant mismatch with envelope refuses to POST.
 *   - Unsigned envelope refused unless --dry-run.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { DEPLOY_ENVELOPE_SCHEMA } from '../src/build/envelope.js';
import { postDeploymentReal } from '../src/deploy/post.js';
import type {
  CountKeptBuildsOptions,
  CountKeptBuildsResult,
  DeployRunners,
  DeploymentEndpointRecord,
  DeploymentRecord,
  EnvironmentOrderRow,
  GetDeploymentResult,
  GetPackEnvResult,
  LoadEnvelopeResult,
  PostDeploymentOptions,
  PostDeploymentResult,
  RunBuildOptions,
  RunBuildResult,
  SyncSecretsOptions,
  SyncSecretsResult,
} from '../src/deploy/runners.js';
import type { DeploySource } from '../src/deploy/source.js';
import type { PackEnvNameRecord } from '../src/env/pack-env-hint.js';
import { type RunCliInputs, runCli } from '../src/main.js';
import { CLI_VERSION } from '../src/version-info.js';
import { fakeRateLimitWaits } from './rate-limit-waits.js';

let cwd: string;
let home: string;
let packDir: string;

function testConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pack: { id: 'my-pack', version: '0.1.0' },
    environments: {
      staging: {
        endpoint: 'https://api.staging.example.com',
        build: 'https://build.staging.example.com',
        registry: 'ghcr.io/acme',
        signingKey: join(home, 'signing-key.pem'),
        tenantId: 'tenant-acme-staging',
      },
    },
    ...overrides,
  };
}

// A canonical signed envelope the fake `loadEnvelope` returns.
function makeEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: DEPLOY_ENVELOPE_SCHEMA,
    imageRef:
      'ghcr.io/acme/kindgi-pack-staging@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    artifactVersion: '20260921.1',
    index: {
      v: 1,
      packId: 'my-pack',
      packVersion: '0.1.0',
      tools: [{ id: 'my-pack.echo' }],
      guardrails: [],
      agents: [{ id: 'my-pack.agent' }],
      flows: [],
    },
    indexHash: 'sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    tenantId: 'tenant-acme-staging',
    publishedAt: '1970-01-01T00:00:00.000Z',
    signerKeyId: 'staging',
    signerPublicKey: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n',
    signature:
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ...overrides,
  };
}

function makeDeploymentRecord(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    deploymentId: 'dep-01H8XM',
    tenantId: 'tenant-acme-staging',
    imageRef:
      'ghcr.io/acme/kindgi-pack-staging@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    artifactVersion: '20260921.1',
    indexHash: 'sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    signerKeyId: 'staging',
    signerPublicKey: 'base64publickey',
    signature: 'base64signature',
    publishedAt: '1970-01-01T00:00:00.000Z',
    activatedAt: '2026-09-21T14:32:07.104Z',
    primitives: { tools: 1, guardrails: 0, agents: 1, flows: 0 },
    ...overrides,
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-deploy-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-deploy-cwd-'));
  packDir = join(cwd, 'sample-pack');
  await mkdir(packDir, { recursive: true });
  await writeFile(join(home, 'signing-key.pem'), 'fake-pem', 'utf8');
  await writeFile(join(packDir, 'kindgi.config.ts'), 'export default {};\n', 'utf8');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

// ---------- fake DeployRunners ----------

interface Fixtures {
  runners: DeployRunners;
  readonly state: {
    loadCalls: number;
    postCalls: number;
    buildCalls: number;
    syncCalls: number;
    findCalls: number;
    listCalls: number;
    /** The endpoint each served-env lookup asked. */
    servedCalls: string[];
    capturedPost?: PostDeploymentOptions;
    capturedFindSlug?: string;
    capturedBuild?: RunBuildOptions;
    capturedSync?: SyncSecretsOptions;
    /** The folder `readSource` was asked about. */
    sourceAsked?: string;
  };
}

interface FixtureOptions {
  readonly envelope?: Record<string, unknown>;
  readonly loadResult?: LoadEnvelopeResult;
  readonly postResult?: PostDeploymentResult;
  readonly buildResult?: RunBuildResult;
  readonly syncResult?: SyncSecretsResult;
  readonly writeEnvelopeAt?: string;
  /** Skip attaching a runBuild runner (simulates default production wiring). */
  readonly omitBuildRunner?: boolean;
  /** Skip attaching a syncSecrets runner. Off by default; --sync-secrets
   * tests that expect the runner to be present rely on the default. */
  readonly omitSyncRunner?: boolean;
  /** The tenant's projects, for `--project <slug>`; absent: no lookup runner. */
  readonly projects?: readonly { id: string; name: string; slug: string; orgId?: string }[];
  /** The environment orders the token reads; with `projects`, the reads a refusal into a later environment makes. */
  readonly orders?: readonly EnvironmentOrderRow[];
  /** Which of those reads answers an error. */
  readonly failedList?: 'projects' | 'orders';
  /** What the runtime says it serves (whoami's `servedEnv`); absent: no lookup runner. */
  readonly servedEnv?: { readonly envName: string; readonly refusesOtherEnvs: boolean };
  /** Where `readSource` says the pack lives in git, `null` for nowhere; absent: no such runner. */
  readonly source?: DeploySource | null;
}

function makeFixtures(opts: FixtureOptions = {}): Fixtures {
  const state: Fixtures['state'] = {
    loadCalls: 0,
    postCalls: 0,
    buildCalls: 0,
    syncCalls: 0,
    findCalls: 0,
    listCalls: 0,
    servedCalls: [],
  };
  const envelope = opts.envelope ?? makeEnvelope();
  const runners: DeployRunners = {
    loadEnvelope: async (_o) => {
      state.loadCalls += 1;
      if (opts.loadResult !== undefined) return opts.loadResult;
      return {
        kind: 'ok',
        envelope: envelope as never,
      };
    },
    postDeployment: async (o) => {
      state.postCalls += 1;
      state.capturedPost = o;
      if (opts.postResult !== undefined) return opts.postResult;
      return {
        kind: 'created',
        status: 201,
        record: makeDeploymentRecord(),
      };
    },
  };
  if (opts.source !== undefined) {
    const source = opts.source;
    (runners as { readSource?: DeployRunners['readSource'] }).readSource = async (dir) => {
      state.sourceAsked = dir;
      return source ?? undefined;
    };
  }
  if (opts.servedEnv !== undefined) {
    const served = opts.servedEnv;
    (runners as { servedEnv?: DeployRunners['servedEnv'] }).servedEnv = async (o) => {
      state.servedCalls.push(o.endpoint);
      return served;
    };
  }
  if (opts.projects !== undefined) {
    const projects = opts.projects;
    (runners as { findProjects?: DeployRunners['findProjects'] }).findProjects = async (o) => {
      state.findCalls += 1;
      state.capturedFindSlug = o.slug;
      return {
        kind: 'ok',
        projects: projects
          .filter((p) => p.slug === o.slug)
          .map(({ id, name, orgId }) => ({ id, name, ...(orgId !== undefined && { orgId }) })),
      };
    };
  }
  if (opts.projects !== undefined && opts.orders !== undefined) {
    const { projects, orders } = opts;
    const failed = { kind: 'error', message: 'GET answered 503' } as const;
    (runners as { listProjects?: DeployRunners['listProjects'] }).listProjects = async () => {
      state.listCalls += 1;
      return opts.failedList === 'projects' ? failed : { kind: 'ok', projects };
    };
    (
      runners as { listEnvironmentOrders?: DeployRunners['listEnvironmentOrders'] }
    ).listEnvironmentOrders = async () => {
      state.listCalls += 1;
      return opts.failedList === 'orders' ? failed : { kind: 'ok', orders };
    };
  }
  if (!opts.omitSyncRunner) {
    (runners as { syncSecrets?: DeployRunners['syncSecrets'] }).syncSecrets = async (o) => {
      state.syncCalls += 1;
      state.capturedSync = o;
      if (opts.syncResult !== undefined) return opts.syncResult;
      const added = o.body.secrets.filter((s) => 'value' in s).length;
      const resolved = o.body.secrets.length - added;
      return {
        kind: 'ok',
        status: 200,
        response: {
          resolved,
          added,
          references: o.body.secrets.map((s, i) => ({
            name: s.name,
            ref: 'ref' in s ? s.ref : `secret:${o.body.envName}/${s.name}#1`,
            version: i + 1,
          })),
        },
      };
    };
  }
  if (!opts.omitBuildRunner) {
    (runners as { runBuild?: DeployRunners['runBuild'] }).runBuild = async (o) => {
      state.buildCalls += 1;
      state.capturedBuild = o;
      // If asked to write an envelope, do so — the command re-checks
      // the disk after the build runs.
      if (opts.writeEnvelopeAt !== undefined) {
        await mkdir(join(opts.writeEnvelopeAt, '..'), { recursive: true }).catch(() => undefined);
        await writeFile(opts.writeEnvelopeAt, JSON.stringify(envelope, null, 2), 'utf8');
      }
      if (opts.buildResult !== undefined) return opts.buildResult;
      return {
        kind: 'ok',
        envelopePath: opts.writeEnvelopeAt ?? join(packDir, '.kindgi/build/deploy-envelope.json'),
        banner: '  (mock build banner)',
      };
    };
  }
  return { runners, state };
}

// ---------- runCli helper ----------

function baseInputs(
  fixtures: Fixtures,
  extra: Partial<RunCliInputs> = {},
  configOverrides: Record<string, unknown> = {},
): RunCliInputs {
  return {
    argv: [],
    env: {
      KINDGI_API_TOKEN: 'test-bearer-token',
    },
    cwd,
    home,
    deployRunners: fixtures.runners,
    buildConfigLoader: async () => testConfig(configOverrides),
    ...extra,
  };
}

/** Convenience: write a valid envelope at the auto-detect location. */
async function writeAutoEnvelope(overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = join(packDir, '.kindgi', 'build');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'deploy-envelope.json');
  await writeFile(path, JSON.stringify(makeEnvelope(overrides), null, 2), 'utf8');
  return path;
}

// ---------- tests ----------

describe('kindgi deploy — argument resolution + config', () => {
  test('resolves --env=staging endpoint from kindgi.config.ts', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.capturedPost?.endpoint).toBe('https://api.staging.example.com');
  });

  test('--endpoint flag overrides the env-block endpoint', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: [
        'deploy',
        '--env=staging',
        '--endpoint=https://override.example.com',
        `--path=${packDir}`,
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.capturedPost?.endpoint).toBe('https://override.example.com');
  });

  test('missing endpoint (no env block, no flag, no env var) → clear error', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=nonexistent', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('could not resolve an API endpoint');
  });

  test('missing bearer token → clear error', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('could not resolve an API token');
  });
});

describe('kindgi deploy — envelope resolution', () => {
  test('auto-detects .kindgi/build/deploy-envelope.json + POSTs', async () => {
    const envelopePath = await writeAutoEnvelope();
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.loadCalls).toBe(1);
    expect(fixtures.state.postCalls).toBe(1);
    expect(fixtures.state.buildCalls).toBe(0);
    expect(out.stderr).toContain('deploy-envelope.json');
    expect(out.stderr).toContain(envelopePath);
  });

  test('--from-envelope <path> reads from an explicit path', async () => {
    const alt = join(cwd, 'custom-envelope.json');
    await writeFile(alt, JSON.stringify(makeEnvelope(), null, 2), 'utf8');
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--from-envelope=${alt}`, `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.loadCalls).toBe(1);
    expect(fixtures.state.capturedPost).toBeDefined();
  });

  test('missing envelope + no --from-envelope → runs `kindgi build` inline', async () => {
    const autoPath = join(packDir, '.kindgi/build/deploy-envelope.json');
    const fixtures = makeFixtures({ writeEnvelopeAt: autoPath });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.buildCalls).toBe(1);
    expect(fixtures.state.postCalls).toBe(1);
    expect(fixtures.state.capturedBuild?.buildArgv).toContain('build');
    expect(fixtures.state.capturedBuild?.buildArgv).toContain('--env=staging');
    expect(out.stderr).toContain('running `kindgi build');
    // Unpinned: the build picks the version and publish time (the build time).
    expect(
      fixtures.state.capturedBuild?.buildArgv.some((a) =>
        /^--(artifact-version|published-at)=/.test(a),
      ),
    ).toBe(false);
  });

  test('an inline build passes --artifact-version and --published-at through', async () => {
    const autoPath = join(packDir, '.kindgi/build/deploy-envelope.json');
    const fixtures = makeFixtures({ writeEnvelopeAt: autoPath });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: [
        'deploy',
        '--env=staging',
        '--artifact-version=20261008.7',
        '--published-at=2026-10-08T12:00:00.000Z',
        `--path=${packDir}`,
      ],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.capturedBuild?.buildArgv).toEqual(
      expect.arrayContaining([
        '--artifact-version=20261008.7',
        '--published-at=2026-10-08T12:00:00.000Z',
      ]),
    );
  });

  test('missing envelope + --from-envelope refuses to build (explicit path takes precedence)', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: [
        'deploy',
        '--env=staging',
        '--from-envelope=/does/not/exist.json',
        `--path=${packDir}`,
      ],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('not found');
    expect(fixtures.state.buildCalls).toBe(0);
    expect(fixtures.state.postCalls).toBe(0);
  });
});

describe('kindgi deploy — POST body + Idempotency-Key', () => {
  test('strips tenantId + $schema + buildLogsUrl from wire body', async () => {
    await writeAutoEnvelope({ buildLogsUrl: '/v1/build/bld-xxx/stream' });
    const fixtures = makeFixtures();
    await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    const body = fixtures.state.capturedPost?.body as Record<string, unknown> | undefined;
    expect(body).toBeDefined();
    expect(body?.tenantId).toBeUndefined();
    expect(body?.$schema).toBeUndefined();
    expect(body?.buildLogsUrl).toBeUndefined();
    // Every required field present.
    for (const k of [
      'imageRef',
      'artifactVersion',
      'index',
      'indexHash',
      'signerKeyId',
      'signerPublicKey',
      'signature',
      'publishedAt',
    ]) {
      expect(body?.[k]).toBeDefined();
    }
  });

  test('Idempotency-Key defaults to sha256 of canonical POST body', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    const key = fixtures.state.capturedPost?.idempotencyKey;
    expect(key).toBeDefined();
    expect(key?.startsWith('sha256:')).toBe(true);
    expect(key?.length).toBe('sha256:'.length + 64);
    // Determinism: same envelope → same key.
    const fixtures2 = makeFixtures();
    await runCli({
      ...baseInputs(fixtures2),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(fixtures2.state.capturedPost?.idempotencyKey).toBe(key);
  });

  test('inside a git work tree, the body says where the pack lives, and the key covers it', async () => {
    await writeAutoEnvelope();
    const source: DeploySource = {
      repo: 'github.com/acme/agents',
      path: 'packs/support',
      commit: 'a'.repeat(40),
      branch: 'main',
      dirty: false,
    };
    const inGit = makeFixtures({ source });
    await runCli({
      ...baseInputs(inGit),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(inGit.state.sourceAsked).toBe(packDir);
    expect(inGit.state.capturedPost?.body.source).toEqual(source);

    const outside = makeFixtures({ source: null });
    await runCli({
      ...baseInputs(outside),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(outside.state.sourceAsked).toBe(packDir);
    expect(outside.state.capturedPost?.body).not.toHaveProperty('source');
    expect(outside.state.capturedPost?.idempotencyKey).not.toBe(
      inGit.state.capturedPost?.idempotencyKey,
    );
  });

  test('--idempotency-key overrides the derived value', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    await runCli({
      ...baseInputs(fixtures),
      argv: [
        'deploy',
        '--env=staging',
        '--idempotency-key=sha256:cafecafecafe',
        `--path=${packDir}`,
      ],
    });
    expect(fixtures.state.capturedPost?.idempotencyKey).toBe('sha256:cafecafecafe');
  });

  test('POST includes Bearer token via caller-supplied config', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(fixtures.state.capturedPost?.token).toBe('test-bearer-token');
  });
});

describe('kindgi deploy — response handling', () => {
  test('201 Created → exit 0, JSON summary with deployment record', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({
      postResult: {
        kind: 'created',
        status: 201,
        record: makeDeploymentRecord({ deploymentId: 'dep-created-01' }),
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('201 Created');
    expect(out.stderr).toContain('deploymentId:    dep-created-01');
    expect(out.stderr).toContain('primitives:      1 tool');
    const summary = JSON.parse(out.stdout) as { outcome: string; deployment: DeploymentRecord };
    expect(summary.outcome).toBe('created');
    expect(summary.deployment.deploymentId).toBe('dep-created-01');
  });

  test('200 OK (idempotent replay) → exit 0, banner notes replay', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({
      postResult: {
        kind: 'replayed',
        status: 200,
        record: makeDeploymentRecord({ deploymentId: 'dep-replayed-01' }),
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('200 OK (idempotent replay)');
    expect(out.stderr).toContain('previously landed');
    const summary = JSON.parse(out.stdout) as { outcome: string };
    expect(summary.outcome).toBe('replayed');
  });

  test('4xx signature-invalid → exit 1, hint about --tenant', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({
      postResult: {
        kind: 'wire-error',
        status: 400,
        error: {
          code: 'signature-invalid',
          message: 'Ed25519 signature does not match canonical envelope',
        },
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('signature-invalid');
    expect(out.stderr).toContain('--tenant');
  });

  test('413 request-too-large → exit 1, says what to make smaller', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({
      postResult: {
        kind: 'wire-error',
        status: 413,
        error: {
          code: 'request-too-large',
          message: 'The request body is over the limit of 2097152 bytes',
        },
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('The request body is over the limit of 2097152 bytes');
    // The hint wraps to the banner's width.
    expect(out.stderr.replace(/\s+/g, ' ')).toContain(
      'make the largest schemas smaller, or split the pack into two',
    );
  });

  test("4xx signer-not-trusted → exit 1, hint: kindgi key trust <the envelope's key>", async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({
      postResult: {
        kind: 'wire-error',
        status: 403,
        error: { code: 'signer-not-trusted', message: 'not on trust list' },
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('signer-not-trusted');
    expect(out.stderr).toContain('trust list');
    expect(out.stderr).toContain(
      '\n      kindgi key trust staging --url https://api.staging.example.com\n',
    );
    expect(out.stderr).not.toContain('SigningKeyBinding');
    expect(out.stderr).not.toContain('This answer is a replay');
  });

  describe('409 environment-takes-promotions: a deploy into a later environment of its order', () => {
    const STAGING = '11111111-1111-4111-8111-111111111111';
    const QA = '22222222-2222-4222-8222-222222222222';
    const PROD = '33333333-3333-4333-8333-333333333333';
    const projects = [
      { id: STAGING, name: 'Staging', slug: 'acme-staging' },
      { id: QA, name: 'QA', slug: 'acme-qa' },
      { id: PROD, name: 'Prod', slug: 'acme-prod' },
    ];
    const orders = [
      { entries: [{ position: 0 }] },
      {
        entries: [
          { position: 2, projectId: PROD },
          { position: 0, projectId: STAGING },
          { position: 1, projectId: QA },
        ],
      },
    ];
    const refused = (details: { position: number; firstProjectId?: string }) =>
      ({
        kind: 'wire-error',
        status: 409,
        error: {
          code: 'environment-takes-promotions',
          message:
            "This project is a later environment of its environment order (position 2), and a later environment takes builds only by promotion from the one before it. Deploy into the order's first environment and promote the build from there. Nothing was deployed.",
          ...details,
        },
      }) as const;
    /** The pack config: staging (the test default) plus qa and prod, each naming its project. */
    const environments = (staging: Record<string, unknown>) => ({
      environments: {
        staging: { ...staging, project: 'acme-staging' },
        qa: { endpoint: 'https://api.staging.example.com', project: 'acme-qa' },
        prod: { endpoint: 'https://api.staging.example.com', project: PROD },
      },
    });

    test('names the first environment and prints each promote on the way, from the pack config', async () => {
      await writeAutoEnvelope();
      const fixtures = makeFixtures({
        postResult: refused({ position: 2, firstProjectId: STAGING }),
        projects,
        orders,
      });
      const staging = (testConfig().environments as { staging: Record<string, unknown> }).staging;
      const out = await runCli({
        ...baseInputs(fixtures, {}, environments(staging)),
        argv: ['deploy', '--env=staging', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(1);
      expect(fixtures.state.postCalls).toBe(1);
      expect(fixtures.state.listCalls).toBe(2);
      expect(out.stderr).toContain('code:    environment-takes-promotions');
      expect(out.stderr.replace(/\s+/g, ' ')).toContain(
        'Builds reach prod only by promotion from the environment before it. A build enters its environment order at staging, the first environment: deploy there, then promote the build one environment at a time.',
      );
      expect(out.stderr).toContain(
        '\n      kindgi promote --from=staging --to=qa\n      kindgi promote --from=qa --to=prod\n',
      );
    });

    test("two environments that name one project: the config's first names it", async () => {
      await writeAutoEnvelope();
      const fixtures = makeFixtures({
        postResult: refused({ position: 2, firstProjectId: STAGING }),
        projects,
        orders,
      });
      const staging = (testConfig().environments as { staging: Record<string, unknown> }).staging;
      // `preview`, after the others in the config, names staging's project too.
      const config = {
        environments: {
          ...environments(staging).environments,
          preview: { endpoint: 'https://api.staging.example.com', project: STAGING },
        },
      };
      const out = await runCli({
        ...baseInputs(fixtures, {}, config),
        argv: ['deploy', '--env=staging', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        '\n      kindgi promote --from=staging --to=qa\n      kindgi promote --from=qa --to=prod\n',
      );
    });

    test("without the first environment (the caller can't read it), says the rule and where the order is, and reads nothing", async () => {
      await writeAutoEnvelope();
      const fixtures = makeFixtures({ postResult: refused({ position: 1 }), projects, orders });
      const staging = (testConfig().environments as { staging: Record<string, unknown> }).staging;
      const out = await runCli({
        ...baseInputs(fixtures, {}, environments(staging)),
        argv: ['deploy', '--env=staging', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(1);
      expect(fixtures.state.listCalls).toBe(0);
      const text = out.stderr.replace(/\s+/g, ' ');
      expect(text).toContain(
        'A build enters an environment order at its first environment and moves on one environment at a time, by promotion. Deploy into the first environment, then promote the build from there, one `kindgi promote --from=<environment> --to=<the next one>` at a time. `kindgi environments list` shows the order.',
      );
      expect(out.stderr).not.toContain('      kindgi promote --from=');
    });

    test.each(['projects', 'orders'] as const)(
      'when reading the %s fails, says the rule and where the order is',
      async (failedList) => {
        await writeAutoEnvelope();
        const fixtures = makeFixtures({
          postResult: refused({ position: 2, firstProjectId: STAGING }),
          projects,
          orders,
          failedList,
        });
        const staging = (testConfig().environments as { staging: Record<string, unknown> }).staging;
        const out = await runCli({
          ...baseInputs(fixtures, {}, environments(staging)),
          argv: ['deploy', '--env=staging', `--path=${packDir}`],
        });
        expect(out.exitCode).toBe(1);
        expect(fixtures.state.listCalls).toBe(2);
        expect(out.stderr).toContain('code:    environment-takes-promotions');
        expect(out.stderr.replace(/\s+/g, ' ')).toContain(
          '`kindgi environments list` shows the order.',
        );
        expect(out.stderr).not.toContain('      kindgi promote --from=');
      },
    );
  });

  test('a refusal the server replays (a runtime before 0.1.3): says so, and how to retry', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({
      postResult: {
        kind: 'wire-error',
        status: 403,
        idempotentReplay: true,
        error: { code: 'signer-not-trusted', message: 'not on trust list' },
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'This answer is a replay: an earlier request with the same Idempotency-Key',
    );
    expect(out.stderr).toContain('with a new key: --idempotency-key <new value>.');
  });

  test('a deployment answered from the record of an earlier request with the same key says so', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    const created = fixtures.runners.postDeployment;
    const runners = {
      ...fixtures.runners,
      postDeployment: async (o: Parameters<typeof created>[0]) => {
        const result = await created(o);
        return result.kind === 'created' ? { ...result, idempotentReplay: true } : result;
      },
    };
    const out = await runCli({
      ...baseInputs({ ...fixtures, runners }),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain(
      "answered from the server's record of an earlier request with this Idempotency-Key",
    );
  });

  test('5xx → exit 1, retryable hint', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({
      postResult: {
        kind: 'wire-error',
        status: 500,
        error: { code: 'internal-server-error', message: 'boom' },
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('server error');
    expect(out.stderr).toContain("check the runtime's logs, then run the same command again");
  });

  test('transport error → exit 1', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({
      postResult: { kind: 'transport-error', message: 'ECONNREFUSED' },
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('transport failure');
    expect(out.stderr).toContain('ECONNREFUSED');
    expect(out.stderr).toContain("so a deploy that did land isn't registered twice");
  });
});

// ---------- the server's rate limit ----------

/** One answer of the fake server: status, JSON body, headers. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

const created: Answer = { status: 201, body: makeDeploymentRecord() };

/** A `429 rate-limit-exceeded`, from the schema compile budget unless `details` says otherwise. */
function refusal(
  headers: Record<string, string> = {},
  details: unknown = { limit: 'schema-compile-time', budgetMs: 2000 },
): Answer {
  return {
    status: 429,
    headers,
    body: {
      error: {
        code: 'rate-limit-exceeded',
        message: "This minute's schema compile time is used up.",
        details,
        requestId: 'req-1',
      },
    },
  };
}

/**
 * `kindgi deploy` over the real POST, against a server that answers
 * `script` in turn (its last answer repeats). Each request's
 * Idempotency-Key is kept.
 */
async function deployAgainst(script: readonly Answer[]) {
  await writeAutoEnvelope();
  const fixtures = makeFixtures();
  const waits = fakeRateLimitWaits();
  const keys: (string | null)[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get('idempotency-key'));
    const answer = script[Math.min(keys.length, script.length) - 1] as Answer;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json', ...answer.headers },
    });
  }) as typeof fetch;
  const out = await runCli({
    ...baseInputs({
      ...fixtures,
      runners: { ...fixtures.runners, postDeployment: postDeploymentReal },
    }),
    argv: ['deploy', '--env=staging', `--path=${packDir}`],
    fetchImpl,
    rateLimitWaits: waits.seam,
  });
  return { out, keys, lines: waits.lines, sleeps: waits.sleeps };
}

describe("kindgi deploy — the server's rate limit", () => {
  test('a 429 with Retry-After, then 201: one line, deployed, sent twice with the same Idempotency-Key', async () => {
    const run = await deployAgainst([refusal({ 'Retry-After': '23' }), created]);
    expect(run.out.exitCode, run.out.stderr).toBe(0);
    expect(run.lines).toEqual([
      "The server's schema-compile-time limit is reached: sending it again in 23s.\n",
    ]);
    expect(run.sleeps).toEqual([23_000]);
    expect(run.keys).toHaveLength(2);
    expect(run.keys[0]).toMatch(/^sha256:/);
    expect(run.keys[1]).toBe(run.keys[0]);
    expect(run.out.stdout).toContain('dep-01H8XM');
  });

  test("a limit the server doesn't name (the API's request rate) is waited out too", async () => {
    const run = await deployAgainst([refusal({ 'Retry-After': '7' }, {}), created]);
    expect(run.out.exitCode, run.out.stderr).toBe(0);
    expect(run.lines).toEqual(["The server's rate limit is reached: sending it again in 7s.\n"]);
    expect(run.keys).toHaveLength(2);
  });

  test('waits that would pass 10 minutes: it stops and fails as without waiting, after the lines of the waits it made', async () => {
    const wait = refusal({ 'Retry-After': '300' });
    // Finite, so a missing cap shows as a deploy rather than a loop.
    const run = await deployAgainst([wait, wait, wait, wait, created]);
    const once = await deployAgainst([refusal()]);
    expect(run.out.exitCode).toBe(1);
    expect(run.out.stderr).toBe(once.out.stderr);
    expect(run.out.stdout).toBe(once.out.stdout);
    expect(run.out.stderr).toContain('HTTP 429');
    expect(run.out.stderr).toContain('rate-limit-exceeded');
    // 300 s, then 300 s more (10 minutes exactly); a third wait would pass it.
    expect(run.sleeps).toEqual([300_000, 300_000]);
    expect(run.lines).toHaveLength(2);
    expect(run.keys).toHaveLength(3);
    expect(new Set(run.keys).size).toBe(1);
  });

  test("the tenant's hour of image reads is waited out as any limit is; a wait past what it waits fails with the hour's hint", async () => {
    const hour = (retryAfter: string) =>
      refusal({ 'Retry-After': retryAfter }, { limit: 'tenant-unpack-hour' });
    const waited = await deployAgainst([hour('90'), created]);
    expect(waited.out.exitCode, waited.out.stderr).toBe(0);
    expect(waited.lines).toEqual([
      "The server's tenant-unpack-hour limit is reached: sending it again in 90s.\n",
    ]);
    expect(waited.keys).toHaveLength(2);
    const past = await deployAgainst([hour('2400'), created]);
    expect(past.out.exitCode).toBe(1);
    expect(past.keys).toHaveLength(1);
    expect(past.lines).toEqual([]);
    expect(past.out.stderr.replaceAll(/\s+/g, ' ')).toContain(
      "This tenant's image reads unpacked as much as the server allows in an hour.",
    );
  });

  test('a 429 without Retry-After: no wait, it fails at once', async () => {
    const run = await deployAgainst([refusal(), created]);
    expect(run.out.exitCode).toBe(1);
    expect(run.out.stderr).toContain('HTTP 429');
    expect(run.keys).toHaveLength(1);
    expect(run.lines).toEqual([]);
    expect(run.sleeps).toEqual([]);
  });

  test.each([
    {
      name: '409 idempotency-key-in-flight with Retry-After',
      status: 409,
      code: 'idempotency-key-in-flight',
    },
    { name: '400 with Retry-After', status: 400, code: 'validation-failed' },
    { name: '503 with Retry-After', status: 503, code: 'service-unavailable' },
    { name: 'a 429 with another code and Retry-After', status: 429, code: 'runs-pending' },
  ])('$name: no wait', async ({ status, code }) => {
    const run = await deployAgainst([
      {
        status,
        headers: { 'Retry-After': '5' },
        body: { error: { code, message: 'Not this time.' } },
      },
      created,
    ]);
    expect(run.out.exitCode).toBe(1);
    expect(run.keys).toHaveLength(1);
    expect(run.lines).toEqual([]);
  });

  test('a 429 the server replays from an earlier request (a runtime before 0.1.3): no wait', async () => {
    const run = await deployAgainst([
      refusal({ 'Retry-After': '23', 'X-Idempotent-Replay': 'true' }),
      created,
    ]);
    expect(run.out.exitCode).toBe(1);
    expect(run.keys).toHaveLength(1);
    expect(run.lines).toEqual([]);
  });
});

describe('kindgi deploy — dry-run + safety gates', () => {
  test('--dry-run prints the curl-equivalent + body, does NOT POST', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', '--dry-run', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.postCalls).toBe(0);
    expect(out.stderr).toContain('  Dry run — would POST the following:\n');
    expect(out.stderr).toContain('curl -X POST');
    expect(out.stderr).toContain('/v1/deployments');
    expect(out.stderr).toContain('Idempotency-Key: sha256:');
    // JSON summary marks dryRun.
    const summary = JSON.parse(out.stdout) as {
      dryRun: boolean;
      wouldPost?: Record<string, unknown>;
    };
    expect(summary.dryRun).toBe(true);
    expect(summary.wouldPost).toBeDefined();
  });

  test('unsigned envelope + no --dry-run → refuses to POST', async () => {
    const unsigned = makeEnvelope();
    (unsigned as Record<string, unknown>).signature = undefined;
    (unsigned as Record<string, unknown>).signerKeyId = undefined;
    (unsigned as Record<string, unknown>).signerPublicKey = undefined;
    await writeAutoEnvelope();
    const dir = join(packDir, '.kindgi', 'build');
    await writeFile(join(dir, 'deploy-envelope.json'), JSON.stringify(unsigned, null, 2), 'utf8');
    const fixtures = makeFixtures({ envelope: unsigned });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('unsigned');
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('unsigned envelope + --dry-run: its warning shows under --quiet too', async () => {
    const unsigned = makeEnvelope();
    (unsigned as Record<string, unknown>).signature = undefined;
    (unsigned as Record<string, unknown>).signerKeyId = undefined;
    (unsigned as Record<string, unknown>).signerPublicKey = undefined;
    await writeAutoEnvelope();
    const dir = join(packDir, '.kindgi', 'build');
    await writeFile(join(dir, 'deploy-envelope.json'), JSON.stringify(unsigned, null, 2), 'utf8');
    for (const quiet of [false, true]) {
      const fixtures = makeFixtures({ envelope: unsigned });
      const out = await runCli({
        ...baseInputs(fixtures),
        argv: [
          'deploy',
          '--env=staging',
          '--dry-run',
          `--path=${packDir}`,
          ...(quiet ? ['--quiet'] : []),
        ],
      });
      expect(fixtures.state.postCalls).toBe(0);
      expect(out.stderr).toContain(
        '  ⚠ Envelope is unsigned — --dry-run is proceeding for inspection only.\n',
      );
      expect(out.stderr.includes('Environment:')).toBe(!quiet);
    }
  });

  test('unsigned envelope + --dry-run: shows the body less the signature, exits 0', async () => {
    const unsigned = makeEnvelope();
    (unsigned as Record<string, unknown>).signature = undefined;
    (unsigned as Record<string, unknown>).signerKeyId = undefined;
    (unsigned as Record<string, unknown>).signerPublicKey = undefined;
    await writeAutoEnvelope();
    const dir = join(packDir, '.kindgi', 'build');
    await writeFile(join(dir, 'deploy-envelope.json'), JSON.stringify(unsigned, null, 2), 'utf8');
    for (const key of [undefined, 'acme-deploy-1']) {
      const fixtures = makeFixtures({ envelope: unsigned });
      const out = await runCli({
        ...baseInputs(fixtures),
        argv: [
          'deploy',
          '--env=staging',
          '--dry-run',
          `--path=${packDir}`,
          ...(key !== undefined ? [`--idempotency-key=${key}`] : []),
        ],
      });
      expect(out.exitCode).toBe(0);
      expect(fixtures.state.postCalls).toBe(0);
      expect(out.stderr).not.toContain('Internal error');
      // The whole lead line: the key is said to be missing only when none was passed.
      expect(out.stderr).toContain(
        key === undefined
          ? '  Dry run — would POST the following, plus the signerKeyId, signerPublicKey and signature a signed build adds, and the Idempotency-Key, which hashes that body:\n'
          : '  Dry run — would POST the following, plus the signerKeyId, signerPublicKey and signature a signed build adds:\n',
      );
      expect(out.stderr).toContain(`"imageRef": "${unsigned.imageRef as string}"`);
      expect(out.stderr).not.toContain('"signature"');
      expect(out.stderr).not.toContain('Idempotency-Key: sha256:');
      expect(out.stderr.includes(`-H "Idempotency-Key: ${key}"`)).toBe(key !== undefined);
      const summary = JSON.parse(out.stdout) as {
        dryRun: boolean;
        idempotencyKey?: string;
        wouldPost: Record<string, unknown>;
      };
      expect(summary.dryRun).toBe(true);
      expect(summary.idempotencyKey).toBe(key);
      expect(summary.wouldPost.imageRef).toBe(unsigned.imageRef);
      expect(summary.wouldPost).not.toHaveProperty('signature');
      expect(summary.wouldPost).not.toHaveProperty('signerKeyId');
      expect(summary.wouldPost).not.toHaveProperty('signerPublicKey');
    }
  });

  test('--tenant mismatch with envelope → refuses to POST', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', '--tenant=DIFFERENT-tenant', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('--tenant mismatch');
    expect(fixtures.state.postCalls).toBe(0);
  });
});

describe('kindgi deploy — its lines, as they come', () => {
  /** The same deploy twice: its lines kept for the outcome, then streamed. */
  async function keptAndStreamed(fixtures: () => Fixtures, argv: readonly string[]) {
    const kept = await runCli({ ...baseInputs(fixtures()), argv: [...argv] });
    const streamed: string[] = [];
    const out = await runCli({
      ...baseInputs(fixtures(), { progress: (text) => streamed.push(text) }),
      argv: [...argv],
    });
    return { kept, streamed: streamed.join(''), writes: streamed, out };
  }

  test('streamed, the same text, one line per write, and the outcome leaves it out', async () => {
    await writeAutoEnvelope();
    const { kept, streamed, writes, out } = await keptAndStreamed(
      () => makeFixtures(),
      ['deploy', '--env=staging', `--path=${packDir}`],
    );
    expect(kept.exitCode, kept.stderr).toBe(0);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(writes.every((text) => text.endsWith('\n') && !text.slice(0, -1).includes('\n'))).toBe(
      true,
    );
    expect(streamed).toBe(kept.stderr);
    expect(streamed).toContain('201 Created');
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout)).toEqual(JSON.parse(kept.stdout));
  });

  /** A deploy that fails: refused by the server, or before it is sent. */
  const failures = [
    {
      failure: 'the server refuses the deployment',
      envelope: makeEnvelope(),
      postResult: {
        kind: 'wire-error',
        status: 413,
        error: {
          code: 'request-too-large',
          message: 'The request body is over the limit of 2097152 bytes',
        },
      } as const,
      error: 'The request body is over the limit of 2097152 bytes',
      starts: '  Registering deployment\n    ✗ POST /v1/deployments  →  HTTP 413\n',
    },
    {
      failure: 'the envelope is unsigned',
      envelope: makeEnvelope({
        signature: undefined,
        signerKeyId: undefined,
        signerPublicKey: undefined,
      }),
      postResult: undefined,
      error: 'deploy-envelope.json is unsigned. The server will refuse the deployment.\n',
      starts: 'deploy-envelope.json is unsigned.',
    },
  ];

  test.each(failures)(
    'when $failure, the error comes after the lines before it, streamed or kept',
    async (c) => {
      await writeAutoEnvelope();
      const { kept, streamed, out } = await keptAndStreamed(
        () =>
          makeFixtures({
            envelope: c.envelope,
            ...(c.postResult !== undefined && { postResult: c.postResult }),
          }),
        ['deploy', '--env=staging', `--path=${packDir}`],
      );
      expect(kept.exitCode).toBe(1);
      expect(out.exitCode).toBe(1);
      expect(kept.stderr.startsWith('\n  Environment: staging\n')).toBe(true);
      expect(kept.stderr.indexOf(c.error)).toBeGreaterThan(kept.stderr.indexOf('  Idempotency:'));
      expect(`${streamed}${out.stderr}`).toBe(kept.stderr);
    },
  );

  test('--quiet: nothing, streamed or kept, and it still deploys', async () => {
    await writeAutoEnvelope();
    const made: Fixtures[] = [];
    const { kept, writes, out } = await keptAndStreamed(() => {
      const fixtures = makeFixtures();
      made.push(fixtures);
      return fixtures;
    }, ['deploy', '--env=staging', `--path=${packDir}`, '--quiet']);
    for (const run of [kept, out]) {
      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe('');
    }
    expect(writes).toEqual([]);
    expect(made.map((f) => f.state.postCalls)).toEqual([1, 1]);
  });

  test.each(failures)('--quiet: when $failure, its error alone, streamed or kept', async (c) => {
    await writeAutoEnvelope();
    const { kept, writes, out } = await keptAndStreamed(
      () =>
        makeFixtures({
          envelope: c.envelope,
          ...(c.postResult !== undefined && { postResult: c.postResult }),
        }),
      ['deploy', '--env=staging', `--path=${packDir}`, '--quiet'],
    );
    expect(writes).toEqual([]);
    expect(kept.exitCode).toBe(1);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe(kept.stderr);
    expect(kept.stderr.startsWith(c.starts)).toBe(true);
    expect(kept.stderr).toContain(c.error);
    expect(kept.stderr).not.toContain('Environment:');
  });
});

describe('kindgi deploy — secrets sync', () => {
  test('.env.<envName> present, --sync-secrets NOT passed → informational hint only, no sync fired', async () => {
    await writeAutoEnvelope();
    await writeFile(
      join(packDir, '.env.staging'),
      '# comment\nSTRIPE_KEY=pk_xxx\nDB_URL=postgres://x\n',
      'utf8',
    );
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    // New hint: mentions the flag + entry count.
    expect(out.stderr).toContain('.env.staging');
    expect(out.stderr).toContain('2 keys');
    expect(out.stderr).toContain('--sync-secrets is OFF');
    // Runner was NOT invoked.
    expect(fixtures.state.syncCalls).toBe(0);
  });

  test('no .env.<envName> → no secrets warning emitted', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.stderr).not.toContain('.env.staging');
    expect(out.stderr).not.toContain('--sync-secrets');
    expect(fixtures.state.syncCalls).toBe(0);
  });

  test('--sync-secrets passed + .env.<envName> present → POSTs to /v1/deployments/:id/secrets', async () => {
    await writeAutoEnvelope();
    await writeFile(
      join(packDir, '.env.staging'),
      'API_URL=https://api.example.com\nFOO=bar\n',
      'utf8',
    );
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', '--sync-secrets', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.syncCalls).toBe(1);
    const captured = fixtures.state.capturedSync;
    expect(captured).toBeDefined();
    expect(captured?.deploymentId).toBe('dep-01H8XM');
    expect(captured?.body.envName).toBe('staging');
    expect(captured?.body.secrets).toHaveLength(2);
    expect(captured?.body.secrets[0]).toEqual({
      name: 'API_URL',
      value: 'https://api.example.com',
    });
    expect(captured?.body.secrets[1]).toEqual({ name: 'FOO', value: 'bar' });
    // Banner reports the sync.
    expect(out.stderr).toContain('Syncing 2 secrets');
    expect(out.stderr).toContain('200 OK');
    expect(out.stderr).toContain('resolved=0 added=2');
  });

  test('--sync-secrets with no --env, not hosted: the env is staging, as before', async () => {
    await writeAutoEnvelope();
    await writeFile(join(packDir, '.env.staging'), 'FOO=bar\n', 'utf8');
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--sync-secrets', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.syncCalls).toBe(1);
    expect(fixtures.state.capturedSync?.body.envName).toBe('staging');
  });

  test('--sync-secrets passed + secret-shaped keys → loud warning to switch to `kindgi secrets set`', async () => {
    await writeAutoEnvelope();
    await writeFile(
      join(packDir, '.env.staging'),
      'STRIPE_KEY=pk_live_x\nDB_PASSWORD=hunter2\nHARMLESS=ok\n',
      'utf8',
    );
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', '--sync-secrets', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('secret-shaped keys detected');
    expect(out.stderr).toContain('STRIPE_KEY');
    expect(out.stderr).toContain('DB_PASSWORD');
    // Non-shaped keys should NOT be listed in the warning line.
    expect(out.stderr).toContain('kindgi secrets set');
    // Sync still runs.
    expect(fixtures.state.syncCalls).toBe(1);
    expect(fixtures.state.capturedSync?.body.secrets).toHaveLength(3);
  });

  test('--quiet: secret-shaped keys are warned about all the same', async () => {
    await writeAutoEnvelope();
    await writeFile(join(packDir, '.env.staging'), 'STRIPE_KEY=pk_live_x\nHARMLESS=ok\n', 'utf8');
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', '--sync-secrets', `--path=${packDir}`, '--quiet'],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.syncCalls).toBe(1);
    expect(out.stderr).toBe(
      '  ! secret-shaped keys detected in .env.staging: STRIPE_KEY\n' +
        '    Keep secrets out of .env files: store them with `kindgi secrets`.\n' +
        '    Consider: kindgi secrets set --env=staging <name> <value>\n\n',
    );
  });

  test('--sync-secrets reads values the way the app does (quotes, comments) and never sends KINDGI_*', async () => {
    await writeAutoEnvelope();
    await writeFile(
      join(packDir, '.env.staging'),
      "HOST=api.example.com\nURL='https://${HOST}/v1'\nNOTE=keep # dropped\nKINDGI_API_TOKEN=kgi_bt_x\n",
      'utf8',
    );
    const fixtures = makeFixtures();
    await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', '--sync-secrets', `--path=${packDir}`],
    });
    expect(fixtures.state.capturedSync?.body.secrets).toEqual([
      { name: 'HOST', value: 'api.example.com' },
      { name: 'URL', value: 'https://api.example.com/v1' },
      { name: 'NOTE', value: 'keep' },
    ]);
  });

  test('--env=local never syncs — the project env files stay on the machine', async () => {
    await writeAutoEnvelope();
    await writeFile(join(packDir, '.env'), 'APP_SECRET=do-not-push\n', 'utf8');
    await writeFile(join(packDir, '.env.local'), 'OTHER=x\n', 'utf8');
    const fixtures = makeFixtures();
    await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=local', '--sync-secrets', `--path=${packDir}`],
    });
    expect(fixtures.state.syncCalls).toBe(0);
  });

  test('--sync-secrets set but no .env.<envName> present → no sync, banner explains skip', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', '--sync-secrets', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('no `.env.<envName>` entries to sync. Skipping');
    expect(fixtures.state.syncCalls).toBe(0);
  });

  test('--sync-secrets set + sync fails → deploy still exit 0, banner reports the failure', async () => {
    await writeAutoEnvelope();
    await writeFile(join(packDir, '.env.staging'), 'FOO=bar\n', 'utf8');
    const fixtures = makeFixtures({
      syncResult: {
        kind: 'wire-error',
        status: 403,
        error: { code: 'permission-denied', message: 'missing secrets:write' },
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', '--sync-secrets', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('403 permission-denied');
    expect(out.stderr).toContain('The deployment landed OK');
  });

  test.each([
    {
      failure: 'the server refuses it',
      syncResult: {
        kind: 'wire-error',
        status: 403,
        error: { code: 'permission-denied', message: 'missing secrets:write' },
      } as const,
      said: '    ✗ 403 permission-denied: missing secrets:write\n',
    },
    {
      failure: 'it never reaches the server',
      syncResult: { kind: 'transport-error', message: 'connect ECONNREFUSED' } as const,
      said: '    ✗ transport error: connect ECONNREFUSED\n',
    },
  ])(
    'a sync that fails ($failure) is an error: said under --quiet too, and the exit code stays 0',
    async (c) => {
      const failed = `${c.said}      The deployment landed OK; only the secret sync failed. Retry with\n      \`kindgi deploy --sync-secrets\` (idempotent).\n\n`;
      for (const quiet of [false, true]) {
        await writeAutoEnvelope();
        await writeFile(join(packDir, '.env.staging'), 'FOO=bar\n', 'utf8');
        const fixtures = makeFixtures({ syncResult: c.syncResult });
        const out = await runCli({
          ...baseInputs(fixtures),
          argv: [
            'deploy',
            '--env=staging',
            '--sync-secrets',
            `--path=${packDir}`,
            ...(quiet ? ['--quiet'] : []),
          ],
        });
        expect(out.exitCode, out.stderr).toBe(0);
        expect(fixtures.state.syncCalls).toBe(1);
        expect(out.stdout === '').toBe(quiet);
        expect(quiet ? out.stderr : out.stderr.slice(out.stderr.indexOf('    ✗'))).toBe(failed);
      }
    },
  );
});

describe('kindgi deploy — envelope validation', () => {
  test('bad JSON in envelope surfaces envelope-invalid-json error', async () => {
    const dir = join(packDir, '.kindgi', 'build');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'deploy-envelope.json'), '{ not json', 'utf8');
    const fixtures = makeFixtures({
      loadResult: {
        kind: 'err',
        code: 'envelope-invalid-json',
        message: 'Unexpected token in JSON at position 2',
        path: join(dir, 'deploy-envelope.json'),
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('envelope-invalid-json');
    expect(out.stderr).toContain('Regenerate with `kindgi build');
    expect(fixtures.state.postCalls).toBe(0);
  });
});

describe("kindgi deploy — the pack service's env (preflight)", () => {
  const created = () =>
    makeFixtures({
      postResult: { kind: 'created', status: 201, record: makeDeploymentRecord() },
    });
  /** The test config, with the pack's env declared and staging's env values. */
  const withEnv = (stagingEnv: Record<string, unknown>): Record<string, unknown> => {
    const base = testConfig();
    const staging = (base.environments as { staging: Record<string, unknown> }).staging;
    return {
      env: { required: ['DATABASE_URL'], optional: ['LOG_LEVEL'] },
      environments: { staging: { ...staging, env: stagingEnv } },
    };
  };

  test('every required name has a value or reference: it deploys, and shows the plan', async () => {
    await writeAutoEnvelope();
    const fixtures = created();
    const out = await runCli({
      ...baseInputs(
        fixtures,
        {},
        withEnv({ DATABASE_URL: { secret: 'acme-db-url', version: '3' } }),
      ),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.postCalls).toBe(1);
    expect(out.stderr).toContain("The pack service's env in staging:");
    expect(out.stderr).toContain('secret acme-db-url:3');
  });

  test('a required name without a value: refused before anything is sent', async () => {
    await writeAutoEnvelope();
    const fixtures = created();
    const out = await runCli({
      ...baseInputs(fixtures, {}, withEnv({ LOG_LEVEL: 'info' })),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(fixtures.state.postCalls).toBe(0);
    expect(out.stderr).toContain(
      'DATABASE_URL is required by the pack and has no value in environments.staging.env',
    );
    expect(out.stderr).toContain('--allow-missing-env');
  });

  test('--allow-missing-env deploys anyway, saying what is missing', async () => {
    await writeAutoEnvelope();
    const fixtures = created();
    const out = await runCli({
      ...baseInputs(fixtures, {}, withEnv({})),
      argv: ['deploy', '--env=staging', '--allow-missing-env', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.postCalls).toBe(1);
    expect(out.stderr).toContain('--allow-missing-env: deploying without DATABASE_URL');
  });

  test('a secret in the clear is refused, whatever the flags, and never printed', async () => {
    await writeAutoEnvelope();
    const fixtures = created();
    const out = await runCli({
      ...baseInputs(fixtures, {}, withEnv({ DATABASE_URL: 'postgres://app:s3cret@db/app' })),
      argv: ['deploy', '--env=staging', '--allow-missing-env', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(fixtures.state.postCalls).toBe(0);
    expect(out.stderr).toContain('gives a secret in the clear');
    expect(out.stderr).not.toContain('s3cret');
  });

  test('a pack that declares no env deploys as before, with no plan', async () => {
    await writeAutoEnvelope();
    const fixtures = created();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain("The pack service's env");
  });

  test.each([
    {
      refusal: 'a required name without a value',
      stagingEnv: { LOG_LEVEL: 'info' },
      flags: [],
      error:
        'kindgi deploy: DATABASE_URL is required by the pack and has no value in environments.staging.env',
    },
    {
      refusal: 'a secret in the clear',
      stagingEnv: { DATABASE_URL: 'postgres://app:s3cret@db/app' },
      flags: ['--allow-missing-env'],
      error:
        "kindgi deploy: the pack service's env for staging gives a secret in the clear or is malformed (above).",
    },
  ])('--quiet: $refusal says the plan, then the error, and nothing else', async (c) => {
    await writeAutoEnvelope();
    const fixtures = created();
    const out = await runCli({
      ...baseInputs(fixtures, {}, withEnv(c.stagingEnv)),
      argv: ['deploy', '--env=staging', `--path=${packDir}`, ...c.flags, '--quiet'],
    });
    expect(out.exitCode).toBe(1);
    expect(fixtures.state.postCalls).toBe(0);
    expect(out.stderr.startsWith("  The pack service's env in staging:\n")).toBe(true);
    expect(out.stderr).toContain(`\n\n${c.error}`);
    expect(out.stderr).not.toContain('Environment:');
    expect(out.stderr).not.toContain('s3cret');
  });

  test('--quiet: a plan that deploys says its warnings alone, --allow-missing-env among them', async () => {
    const warnings =
      "  ⚠ environments.staging.env.EXTRA isn't declared in env.required or env.optional, so it isn't injected\n\n" +
      '  ⚠ --allow-missing-env: deploying without DATABASE_URL\n\n';
    for (const quiet of [false, true]) {
      await writeAutoEnvelope();
      const fixtures = created();
      const out = await runCli({
        ...baseInputs(fixtures, {}, withEnv({ EXTRA: 'x' })),
        argv: [
          'deploy',
          '--env=staging',
          '--allow-missing-env',
          `--path=${packDir}`,
          ...(quiet ? ['--quiet'] : []),
        ],
      });
      expect(out.exitCode, out.stderr).toBe(0);
      expect(fixtures.state.postCalls).toBe(1);
      if (quiet) expect(out.stderr).toBe(warnings);
      else {
        expect(out.stderr).toContain("  The pack service's env in staging:\n");
        expect(out.stderr).toContain(warnings);
      }
    }
  });
});

describe('kindgi deploy --project: one project per client', () => {
  const ACME = '3f2b8c1e-4a5d-4e6f-9a0b-1c2d3e4f5a6b';
  const GLOBEX = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
  const projects = [
    { id: ACME, name: 'Acme shop', slug: 'acme-shop' },
    { id: GLOBEX, name: 'Globex shop', slug: 'globex-shop' },
    { id: '11111111-2222-4333-8444-555555555555', name: 'Shared', slug: 'shop', orgId: 'org-a' },
    { id: '66666666-7777-4888-8999-aaaaaaaaaaaa', name: 'Shared', slug: 'shop', orgId: 'org-b' },
  ];
  const deploy = async (fixtures: Fixtures, ...flags: string[]) =>
    runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`, ...flags],
    });
  const body = (fixtures: Fixtures) =>
    fixtures.state.capturedPost?.body as Record<string, unknown> | undefined;

  test('an id goes as it is, without a lookup', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({ projects });
    const out = await deploy(fixtures, `--project=${GLOBEX}`);
    expect(out.exitCode).toBe(0);
    expect(body(fixtures)?.projectId).toBe(GLOBEX);
    expect(fixtures.state.findCalls).toBe(0);
  });

  test('a slug is looked up, and its id is sent', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({ projects });
    const out = await deploy(fixtures, '--project=acme-shop');
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.capturedFindSlug).toBe('acme-shop');
    expect(body(fixtures)?.projectId).toBe(ACME);
  });

  test('without --project: tenant-wide, no projectId sent', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({ projects });
    await deploy(fixtures);
    expect(body(fixtures)).toBeDefined();
    expect(body(fixtures)?.projectId).toBeUndefined();
  });

  test('a slug of no project is refused, saying where to see them and how to make one; nothing is sent', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({ projects });
    const out = await deploy(fixtures, '--project=initech-shop');
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain(
      '--project initech-shop: no project of this tenant has that slug. `kindgi projects list` shows them; `kindgi projects create --name=<name> --slug=initech-shop` makes one.',
    );
    expect(fixtures.state.postCalls).toBe(0);
    // A slug `projects create` wouldn't take isn't offered as one.
    const upper = await deploy(makeFixtures({ projects }), '--project=Initech');
    expect(upper.stderr).toContain(
      '`kindgi projects create --name=<name> --slug=<slug>` makes one.',
    );
  });

  test('a slug two orgs share is refused, naming both ids; nothing is sent', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({ projects });
    const out = await deploy(fixtures, '--project=shop');
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('2 projects of this tenant have that slug');
    expect(out.stderr).toContain('11111111-2222-4333-8444-555555555555');
    expect(out.stderr).toContain('66666666-7777-4888-8999-aaaaaaaaaaaa');
    expect(out.stderr).toContain('Pass the id.');
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('two projects, two requests: the Idempotency-Key follows the project', async () => {
    await writeAutoEnvelope();
    const a = makeFixtures({ projects });
    await deploy(a, `--project=${ACME}`);
    const b = makeFixtures({ projects });
    await deploy(b, `--project=${GLOBEX}`);
    expect(a.state.capturedPost?.idempotencyKey).toBeDefined();
    expect(a.state.capturedPost?.idempotencyKey).not.toBe(b.state.capturedPost?.idempotencyKey);
  });

  test('--dry-run shows the project in the body it would send', async () => {
    await writeAutoEnvelope();
    const fixtures = makeFixtures({ projects });
    const out = await deploy(fixtures, '--project=acme-shop', '--dry-run');
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.postCalls).toBe(0);
    const summary = JSON.parse(out.stdout) as { wouldPost?: Record<string, unknown> };
    expect(summary.wouldPost?.projectId).toBe(ACME);
  });

  test("an unsigned envelope's --dry-run shows the project too", async () => {
    const unsigned = { signature: undefined, signerKeyId: undefined, signerPublicKey: undefined };
    await writeAutoEnvelope(unsigned);
    const fixtures = makeFixtures({ projects, envelope: makeEnvelope(unsigned) });
    const out = await deploy(fixtures, '--project=acme-shop', '--dry-run');
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.postCalls).toBe(0);
    const summary = JSON.parse(out.stdout) as { wouldPost?: Record<string, unknown> };
    expect(summary.wouldPost?.projectId).toBe(ACME);
    expect(summary.wouldPost).not.toHaveProperty('signature');
  });
});

describe('kindgi deploy --hosted: build there, then wait for the pack service', () => {
  const PROJECT = '3f2b8c1e-4a5d-4e6f-9a0b-1c2d3e4f5a6b';
  const pending = (problem?: string): DeploymentEndpointRecord => ({
    status: 'pending',
    since: '2026-10-13T08:00:00.000Z',
    ...(problem !== undefined && { problem: { code: problem, since: '2026-10-13T08:00:01.000Z' } }),
  });
  const ready: DeploymentEndpointRecord = { status: 'ready', since: '2026-10-13T08:00:30.000Z' };
  const cleared: DeploymentEndpointRecord = {
    status: 'cleared',
    since: '2026-10-13T08:00:30.000Z',
  };
  const waiting = (problem?: string): DeploymentEndpointRecord => ({
    ...cleared,
    waiting: true,
    ...(problem !== undefined && { problem: { code: problem, since: '2026-10-13T08:00:31.000Z' } }),
  });
  const retired = (reason: string): DeploymentEndpointRecord => ({ ...cleared, retired: reason });

  /**
   * Fixtures whose deploy answers with `first`, and whose reads of the
   * deployment answer `reads` in turn (then the last again); the clock
   * moves on by each sleep.
   */
  function hostedFixtures(
    first: DeploymentEndpointRecord | undefined,
    reads: readonly (DeploymentEndpointRecord | 'error')[],
    opts: FixtureOptions & { readonly repeat?: boolean } = {},
  ) {
    const record = makeDeploymentRecord(first !== undefined ? { endpoint: first } : {});
    const fixtures = makeFixtures({
      ...opts,
      // A repeat deploy of the same image: the server answers with the deployment it has.
      postResult:
        opts.repeat === true
          ? { kind: 'replayed', status: 200, record }
          : { kind: 'created', status: 201, record },
    });
    let clock = 0;
    const sleeps: number[] = [];
    const readIds: string[] = [];
    const runners: DeployRunners = {
      ...fixtures.runners,
      getDeployment: async (o): Promise<GetDeploymentResult> => {
        readIds.push(o.deploymentId);
        const next = reads[Math.min(readIds.length - 1, reads.length - 1)];
        if (next === undefined || next === 'error') {
          return { kind: 'error', message: 'GET … answered HTTP 503' };
        }
        return { kind: 'ok', record: makeDeploymentRecord({ endpoint: next }) };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    };
    return { fixtures: { ...fixtures, runners }, sleeps, readIds };
  }

  const API = 'https://platform.example.com';
  /** Signed in to Kindgi Cloud: the API's address and its key. */
  const signedIn = { KINDGI_API_URL: API, KINDGI_API_TOKEN: 'test-bearer-token' };
  /** A Kindgi Cloud env block: no `endpoint`, as the API is the CLI's own address. */
  const cloud = (): Record<string, unknown> => ({
    environments: {
      staging: { signingKey: join(home, 'signing-key.pem'), tenantId: 'tenant-acme-staging' },
    },
  });
  const deploy = (fixtures: Fixtures, ...flags: string[]) =>
    runCli({
      ...baseInputs(fixtures, { env: signedIn }, cloud()),
      argv: ['deploy', '--env=staging', `--path=${packDir}`, ...flags],
    });

  test('the inline build runs hosted, with the project; then it waits, saying each new state once', async () => {
    const auto = join(packDir, '.kindgi/build/deploy-envelope.json');
    const run = hostedFixtures(
      pending(),
      [pending(), pending('capacity-unavailable'), pending('capacity-unavailable'), ready],
      { writeEnvelopeAt: auto },
    );
    const out = await deploy(run.fixtures, '--hosted', `--project=${PROJECT}`);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(run.fixtures.state.capturedPost?.endpoint).toBe(API);
    expect(run.fixtures.state.capturedBuild?.buildArgv).toEqual(
      expect.arrayContaining(['--hosted', `--project=${PROJECT}`]),
    );
    expect(run.readIds).toEqual(['dep-01H8XM', 'dep-01H8XM', 'dep-01H8XM', 'dep-01H8XM']);
    expect(run.sleeps).toEqual([2_000, 2_000, 2_000, 2_000]);
    const waited = out.stderr.slice(out.stderr.indexOf('Waiting for the pack service'));
    expect(waited.split('\n').slice(0, 4)).toEqual([
      'Waiting for the pack service',
      '    … pending',
      '    … pending (capacity-unavailable): there is no room for another pack service just now',
      '    ✓ ready',
    ]);
    const summary = JSON.parse(out.stdout) as { packService?: DeploymentEndpointRecord };
    expect(summary.packService).toEqual(ready);
  });

  test.each([
    [
      'pack-env-secret-capacity',
      'a name the pack reads from its env is set as a secret, and there is no room for a pack service that can be given one just now',
    ],
    [
      'pack-env-secret-too-large',
      'a secret the pack reads from its env is over 32 KiB, the most a pack service can be given',
    ],
    [
      'pack-env-secret-unreadable',
      "a secret the pack reads from its env can't be read just now: the platform's team is told, and it's tried again",
    ],
    [
      'pack-env-secrets-unaudited',
      "the platform can't give the pack its secrets just now: its team is told, and it's tried again",
    ],
  ])('a pack service waiting on its secrets (%s) says why', async (problem, why) => {
    await writeAutoEnvelope();
    const run = hostedFixtures(pending(), [pending(problem), ready]);
    const out = await deploy(run.fixtures, '--hosted', `--project=${PROJECT}`);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain(`    … pending (${problem}): ${why}`);
  });

  test('streamed, each state goes out when it is seen, not at the end', async () => {
    await writeAutoEnvelope();
    const run = hostedFixtures(pending(), [pending(), pending('capacity-unavailable'), ready]);
    const streamed: string[] = [];
    const atRead: string[] = [];
    const { getDeployment } = run.fixtures.runners;
    if (getDeployment === undefined) throw new Error('hostedFixtures reads the deployment');
    const runners: DeployRunners = {
      ...run.fixtures.runners,
      getDeployment: async (o) => {
        atRead.push(streamed.join(''));
        return getDeployment(o);
      },
    };
    const out = await runCli({
      ...baseInputs(
        { ...run.fixtures, runners },
        { env: signedIn, progress: (text) => streamed.push(text) },
        cloud(),
      ),
      argv: ['deploy', '--env=staging', `--path=${packDir}`, '--hosted', `--project=${PROJECT}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(atRead).toHaveLength(3);
    expect(atRead[0]).toContain('201 Created');
    expect(atRead[0]).toContain('Waiting for the pack service\n');
    expect(atRead[2]).toContain('    … pending (capacity-unavailable)');
    expect(atRead[2]).not.toContain('✓ ready');
    expect(streamed.join('')).toContain('    ✓ ready\n');
    expect(out.stderr).toBe('');
  });

  test("the env block's `build: 'hosted'` waits too; without either, nothing waits", async () => {
    await writeAutoEnvelope();
    const hosted = hostedFixtures(pending(), [ready]);
    const viaConfig = await runCli({
      ...baseInputs(
        hosted.fixtures,
        { env: signedIn },
        {
          environments: {
            staging: {
              endpoint: API,
              build: 'hosted',
              signingKey: join(home, 'signing-key.pem'),
            },
          },
        },
      ),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(viaConfig.exitCode, viaConfig.stderr).toBe(0);
    expect(hosted.readIds).toHaveLength(1);

    const plain = hostedFixtures(pending(), [ready]);
    const out = await deploy(plain.fixtures);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(plain.readIds).toHaveLength(0);
    expect(out.stderr).not.toContain('Waiting for the pack service');
  });

  test("--env=prod with prod's `build: 'hosted'` and no `kindgi dev` file here: hosted, so it waits", async () => {
    await writeAutoEnvelope();
    const hosted = hostedFixtures(pending(), [ready]);
    const out = await runCli({
      ...baseInputs(
        hosted.fixtures,
        { env: signedIn },
        {
          environments: {
            prod: { endpoint: API, build: 'hosted', signingKey: join(home, 'signing-key.pem') },
          },
        },
      ),
      argv: ['deploy', '--env=prod', `--path=${packDir}`],
    });
    expect(existsSync(join(cwd, '.kindgirc.json'))).toBe(false);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(hosted.readIds).toHaveLength(1);
    expect(out.stderr).toContain('Waiting for the pack service');
  });

  test('a deployment with no pack service of its own has nothing to wait for', async () => {
    await writeAutoEnvelope();
    const run = hostedFixtures(undefined, [ready]);
    const out = await deploy(run.fixtures, '--hosted');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(run.readIds).toHaveLength(0);
  });

  /** `hostedFixtures` whose runtime counts the kept builds with `answer`, and the reads it was asked. */
  function counting(run: ReturnType<typeof hostedFixtures>, answer: CountKeptBuildsResult) {
    const asked: CountKeptBuildsOptions[] = [];
    const runners: DeployRunners = {
      ...run.fixtures.runners,
      countKeptBuilds: async (o) => {
        asked.push(o);
        return answer;
      },
    };
    return { fixtures: { ...run.fixtures, runners }, asked };
  }

  const KEPT_LINES = [
    '    Each keeps its pack service while something it serves is registered, pinned or',
    '    running, or until a newer build ships it. To let old ones go, unregister what',
    '    nothing calls:',
    '      kindgi tools|agents|flows unregister <id> <version>',
    '      kindgi guardrails unregister <guardrail-id>',
    '    `kindgi deployments get <deployment-id>` says what keeps each one.',
  ];

  test('once its pack service is ready, it says how many builds the project keeps, and how to let old ones go', async () => {
    await writeAutoEnvelope();
    const run = counting(hostedFixtures(pending(), [ready]), { kind: 'ok', keptBuilds: 7 });
    const out = await deploy(run.fixtures, '--hosted', `--project=${PROJECT}`);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(run.asked.map((o) => o.projectId)).toEqual([PROJECT]);
    const after = out.stderr.slice(out.stderr.indexOf('    ✓ ready'));
    expect(after.split('\n').slice(2, 9)).toEqual([
      '  Builds kept in this project: 7',
      ...KEPT_LINES,
    ]);
    expect((JSON.parse(out.stdout) as { keptBuilds?: number }).keptBuilds).toBe(7);
  });

  test('a deploy that names no project says the workspace’s, as its answer names no project', async () => {
    await writeAutoEnvelope();
    const run = counting(hostedFixtures(pending(), [ready]), { kind: 'ok', keptBuilds: 12 });
    const out = await deploy(run.fixtures, '--hosted');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(run.asked).toHaveLength(1);
    expect('projectId' in (run.asked[0] ?? {})).toBe(false);
    expect(out.stderr).toContain('  Builds kept in this workspace: 12\n');
  });

  test('a runtime that doesn’t count them (one service for every build, or older) says nothing of them', async () => {
    await writeAutoEnvelope();
    const run = counting(hostedFixtures(pending(), [ready]), { kind: 'ok' });
    const out = await deploy(run.fixtures, '--hosted', `--project=${PROJECT}`);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).not.toContain('Builds kept');
    const summary = JSON.parse(out.stdout) as object;
    expect('keptBuilds' in summary || 'keptBuildsError' in summary).toBe(false);
  });

  test('a count that can’t be read is said, with why, and the deploy still succeeds', async () => {
    await writeAutoEnvelope();
    const run = counting(hostedFixtures(pending(), [ready]), {
      kind: 'error',
      message: 'GET … answered HTTP 503',
    });
    const out = await deploy(run.fixtures, '--hosted', `--project=${PROJECT}`);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain("  Couldn't count the builds kept: GET … answered HTTP 503\n");
    const summary = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(summary.keptBuildsError).toBe('GET … answered HTTP 503');
    expect('keptBuilds' in summary).toBe(false);
  });

  test('no count when the wait fails, nor without a pack service to wait for', async () => {
    await writeAutoEnvelope();
    const failed = counting(hostedFixtures(pending(), [cleared]), { kind: 'ok', keptBuilds: 1 });
    expect((await deploy(failed.fixtures, '--hosted')).exitCode).toBe(1);
    expect(failed.asked).toHaveLength(0);
    const none = counting(hostedFixtures(undefined, [ready]), { kind: 'ok', keptBuilds: 1 });
    expect((await deploy(none.fixtures, '--hosted')).exitCode).toBe(0);
    expect(none.asked).toHaveLength(0);
  });

  test('a cleared pack service from a server that says neither (before 0.1.9) fails, naming the deployment', async () => {
    await writeAutoEnvelope();
    const run = hostedFixtures(pending(), [cleared]);
    const out = await deploy(run.fixtures, '--hosted');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "The deployment's pack service was taken down (cleared). deploymentId dep-01H8XM.",
    );
  });

  test('--quiet: a wait that ends ready says nothing; one that fails says its error alone', async () => {
    await writeAutoEnvelope();
    const waits = hostedFixtures(pending(), [pending('capacity-unavailable'), ready]);
    const fine = await deploy(waits.fixtures, '--hosted', '--quiet');
    expect(fine.exitCode, fine.stderr).toBe(0);
    expect(waits.readIds).toHaveLength(2);
    expect(fine.stdout).toBe('');
    expect(fine.stderr).toBe('');
    const failed = await deploy(
      hostedFixtures(pending(), [cleared]).fixtures,
      '--hosted',
      '--quiet',
    );
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toBe(
      "The deployment's pack service was taken down (cleared). deploymentId dep-01H8XM.\n",
    );
  });

  test('a repeat deploy of an image a suspension took down, once lifted: it waits for the service to come back', async () => {
    await writeAutoEnvelope();
    const run = hostedFixtures(waiting(), [waiting(), waiting('service-start-failed'), ready], {
      repeat: true,
    });
    const out = await deploy(run.fixtures, '--hosted');
    expect(out.exitCode, out.stderr).toBe(0);
    const waited = out.stderr.slice(out.stderr.indexOf('Waiting for the pack service'));
    expect(waited.split('\n').slice(0, 4)).toEqual([
      'Waiting for the pack service',
      '    … cleared, waiting for its pack service again',
      "    … cleared, waiting for its pack service again (service-start-failed): the pack's image was deployed but didn't start",
      '    ✓ ready',
    ]);
  });

  test('still waiting after 5 minutes: it stops as for a pending one, with the last state', async () => {
    await writeAutoEnvelope();
    const run = hostedFixtures(waiting(), [waiting('capacity-unavailable')], { repeat: true });
    const out = await deploy(run.fixtures, '--hosted');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "The pack service isn't ready after 5 minutes: cleared, waiting for its pack service again (capacity-unavailable): there is no room for another pack service just now. deploymentId dep-01H8XM.",
    );
  });

  test('a repeat deploy of a superseded image fails at once, saying no call reaches it', async () => {
    await writeAutoEnvelope();
    const run = hostedFixtures(retired('superseded'), [ready], { repeat: true });
    const out = await deploy(run.fixtures, '--hosted');
    expect(out.exitCode).toBe(1);
    expect(run.readIds).toHaveLength(0);
    expect(out.stderr).toContain(
      "The deployment's pack service was taken down (cleared, superseded): a later deploy ships every tool version and check this one does, so no new call reaches it. deploymentId dep-01H8XM.",
    );
  });

  test('suspended again while it waits: it stops with the reason', async () => {
    await writeAutoEnvelope();
    const run = hostedFixtures(waiting(), [waiting(), retired('pack-suspended')], { repeat: true });
    const out = await deploy(run.fixtures, '--hosted');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "The deployment's pack service was taken down (cleared, pack-suspended): its pack is suspended, until it's restored. deploymentId dep-01H8XM.",
    );
  });

  test.each([
    ['tenant-closing', 'your workspace is closing'],
    ['tenant-suspended', "your workspace is suspended, until it's restored"],
    ['project-suspended', "its project is suspended, until it's restored"],
    ['a-later-reason', 'none is wanted for it now'],
  ])('retired %s: it says so', async (reason, why) => {
    await writeAutoEnvelope();
    const run = hostedFixtures(pending(), [retired(reason)]);
    const out = await deploy(run.fixtures, '--hosted');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      `The deployment's pack service was taken down (cleared, ${reason}): ${why}. deploymentId dep-01H8XM.`,
    );
  });

  test('not ready after 5 minutes: it stops, with the last state and how to wait again', async () => {
    await writeAutoEnvelope();
    const run = hostedFixtures(pending(), [pending('tenant-not-provisioned')]);
    const out = await deploy(run.fixtures, '--hosted');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "The pack service isn't ready after 5 minutes: pending (tenant-not-provisioned): your workspace has nowhere to run pack services yet. deploymentId dep-01H8XM.",
    );
    expect(out.stderr).toContain('Run the same `kindgi deploy --hosted` again to keep waiting');
    expect(run.sleeps.reduce((a, b) => a + b, 0)).toBe(5 * 60 * 1000);
  });

  test('three reads in a row that fail: it stops, saying why', async () => {
    await writeAutoEnvelope();
    const run = hostedFixtures(pending(), ['error', 'error', 'error']);
    const out = await deploy(run.fixtures, '--hosted');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "Couldn't read the deployment while waiting for its pack service: GET … answered HTTP 503. deploymentId dep-01H8XM.",
    );
    expect(run.readIds).toHaveLength(3);
  });

  test('--hosted with --build-endpoint is refused before anything runs', async () => {
    const run = hostedFixtures(pending(), [ready]);
    const out = await deploy(
      run.fixtures,
      '--hosted',
      '--build-endpoint=https://build.example.com',
    );
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('--build-endpoint names another build server');
    expect(run.fixtures.state.buildCalls).toBe(0);
    expect(run.fixtures.state.postCalls).toBe(0);
  });

  test.each([
    ['--hosted', ['--hosted'], cloud],
    [
      "the env block's `build: 'hosted'`",
      [],
      () => ({
        environments: {
          staging: { endpoint: API, build: 'hosted', signingKey: join(home, 'signing-key.pem') },
        },
      }),
    ],
  ])(
    '--sync-secrets on a hosted deploy (%s) with no --env is refused, naming --env; nothing is built or sent',
    async (_, flags, config) => {
      await writeAutoEnvelope();
      await writeFile(join(packDir, '.env.staging'), 'FOO=bar\n', 'utf8');
      const run = hostedFixtures(pending(), [ready]);
      const out = await runCli({
        ...baseInputs(run.fixtures, { env: signedIn }, config()),
        argv: ['deploy', ...flags, '--sync-secrets', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        "--sync-secrets on a hosted deploy needs --env. A hosted runtime reads a deployment's secrets in the env it serves; without --env, the values in .env.staging would go up under staging.",
      );
      expect(run.fixtures.state.buildCalls).toBe(0);
      expect(run.fixtures.state.postCalls).toBe(0);
      expect(run.fixtures.state.syncCalls).toBe(0);
    },
  );

  test('a hosted deploy with --env syncs under that env; with no --env and no --sync-secrets it deploys', async () => {
    await writeAutoEnvelope();
    await writeFile(join(packDir, '.env.staging'), 'FOO=from-staging\n', 'utf8');
    await writeFile(join(packDir, '.env.production'), 'FOO=from-production\n', 'utf8');
    const named = hostedFixtures(pending(), [ready]);
    const synced = await runCli({
      ...baseInputs(
        named.fixtures,
        { env: signedIn },
        {
          environments: {
            production: {
              signingKey: join(home, 'signing-key.pem'),
              tenantId: 'tenant-acme-production',
            },
          },
        },
      ),
      argv: ['deploy', '--env=production', '--hosted', '--sync-secrets', `--path=${packDir}`],
    });
    expect(synced.exitCode, synced.stderr).toBe(0);
    expect(named.fixtures.state.syncCalls).toBe(1);
    expect(named.fixtures.state.capturedSync?.body.envName).toBe('production');
    expect(named.fixtures.state.capturedSync?.body.secrets).toEqual([
      { name: 'FOO', value: 'from-production' },
    ]);

    const plain = hostedFixtures(pending(), [ready]);
    const out = await runCli({
      ...baseInputs(plain.fixtures, { env: signedIn }, cloud()),
      argv: ['deploy', '--hosted', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(plain.fixtures.state.postCalls).toBe(1);
    expect(plain.fixtures.state.syncCalls).toBe(0);
  });

  test('on a runtime that refuses other envs, --sync-secrets under another env is refused before anything is built or sent', async () => {
    await writeAutoEnvelope();
    await writeFile(join(packDir, '.env.staging'), 'FOO=bar\n', 'utf8');
    const run = hostedFixtures(pending(), [ready], {
      servedEnv: { envName: 'prod', refusesOtherEnvs: true },
    });
    const out = await deploy(run.fixtures, '--hosted', '--sync-secrets');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'env-not-served: this runtime keeps its values under `prod` only, so the secrets in .env.staging under `staging` would never be read. Use --env=prod.\n',
    );
    expect(run.fixtures.state.servedCalls).toEqual([API]);
    expect(run.fixtures.state.buildCalls).toBe(0);
    expect(run.fixtures.state.postCalls).toBe(0);
    expect(run.fixtures.state.syncCalls).toBe(0);
  });

  test.each([
    ['under the env it serves', 'prod', { envName: 'prod', refusesOtherEnvs: true }],
    ['on a runtime that takes any env', 'staging', { envName: 'prod', refusesOtherEnvs: false }],
  ])('--sync-secrets %s: synced', async (_, envName, servedEnv) => {
    await writeAutoEnvelope();
    await writeFile(join(packDir, `.env.${envName}`), 'FOO=bar\n', 'utf8');
    const run = hostedFixtures(pending(), [ready], { servedEnv });
    const out = await runCli({
      ...baseInputs(
        run.fixtures,
        { env: signedIn },
        {
          environments: {
            [envName]: { signingKey: join(home, 'signing-key.pem'), tenantId: 'tenant-acme' },
          },
        },
      ),
      argv: ['deploy', `--env=${envName}`, '--hosted', '--sync-secrets', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(run.fixtures.state.capturedSync?.body.envName).toBe(envName);
  });

  test('without --sync-secrets, to an environment that names no project, the runtime is not asked what it serves', async () => {
    await writeAutoEnvelope();
    const run = hostedFixtures(pending(), [ready], {
      servedEnv: { envName: 'prod', refusesOtherEnvs: true },
    });
    const out = await deploy(run.fixtures, '--hosted');
    expect(out.exitCode, out.stderr).toBe(0);
    expect(run.fixtures.state.servedCalls).toEqual([]);
  });

  describe("a pack environment's project, on a runtime that keeps its values under one env", () => {
    const REFUSES = { envName: 'prod', refusesOtherEnvs: true };
    const projects = [{ id: PROJECT, name: 'Acme staging 1', slug: 'acme-staging-1' }];
    /** staging-1 names its project, by slug; staging names none. */
    const placed = (): Record<string, unknown> => ({
      environments: {
        'staging-1': {
          signingKey: join(home, 'signing-key.pem'),
          tenantId: 'tenant-acme',
          project: 'acme-staging-1',
        },
        staging: { signingKey: join(home, 'signing-key.pem'), tenantId: 'tenant-acme' },
      },
    });
    const deployTo = (fixtures: Fixtures, env: string, ...flags: string[]) =>
      runCli({
        ...baseInputs(fixtures, { env: signedIn }, placed()),
        argv: ['deploy', `--env=${env}`, '--hosted', `--path=${packDir}`, ...flags],
      });
    const body = (fixtures: Fixtures) =>
      fixtures.state.capturedPost?.body as Record<string, unknown> | undefined;

    test('the deploy goes to that project, and its secrets under the env the runtime serves', async () => {
      await writeAutoEnvelope();
      await writeFile(join(packDir, '.env.staging-1'), 'FOO=from-staging-1\n', 'utf8');
      const run = hostedFixtures(pending(), [ready], { servedEnv: REFUSES, projects });
      const out = await deployTo(run.fixtures, 'staging-1', '--sync-secrets');
      expect(out.exitCode, out.stderr).toBe(0);
      expect(run.fixtures.state.servedCalls).toEqual([API]);
      expect(body(run.fixtures)?.projectId).toBe(PROJECT);
      expect(run.fixtures.state.capturedSync?.body.envName).toBe('prod');
      expect(run.fixtures.state.capturedSync?.body.secrets).toEqual([
        { name: 'FOO', value: 'from-staging-1' },
      ]);
      expect(out.stderr).toContain(
        '  Project:     acme-staging-1  (environments.staging-1.project)\n  Secrets:     under prod, the env the runtime serves\n',
      );
    });

    test('without --sync-secrets it still goes to that project, and the build carries it', async () => {
      const run = hostedFixtures(pending(), [ready], {
        servedEnv: REFUSES,
        projects,
        writeEnvelopeAt: join(packDir, '.kindgi/build/deploy-envelope.json'),
      });
      const out = await deployTo(run.fixtures, 'staging-1');
      expect(out.exitCode, out.stderr).toBe(0);
      expect(body(run.fixtures)?.projectId).toBe(PROJECT);
      expect(run.fixtures.state.capturedBuild?.buildArgv).toEqual(
        expect.arrayContaining([`--project=${PROJECT}`]),
      );
      expect(run.fixtures.state.syncCalls).toBe(0);
      expect(out.stderr).not.toContain('Secrets:     under');
    });

    test('--project naming another project is refused before anything is built or sent', async () => {
      await writeAutoEnvelope();
      const other = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
      const run = hostedFixtures(pending(), [ready], { servedEnv: REFUSES, projects });
      const out = await deployTo(run.fixtures, 'staging-1', `--project=${other}`);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `--project ${other} isn't the staging-1 environment's project, acme-staging-1 (environments.staging-1.project). Leave --project out, or deploy with the --env whose project it is.\n`,
      );
      expect(run.fixtures.state.buildCalls).toBe(0);
      expect(run.fixtures.state.postCalls).toBe(0);
    });

    test('--project naming the same project, by id, is that project', async () => {
      await writeAutoEnvelope();
      const run = hostedFixtures(pending(), [ready], { servedEnv: REFUSES, projects });
      const out = await deployTo(run.fixtures, 'staging-1', `--project=${PROJECT}`);
      expect(out.exitCode, out.stderr).toBe(0);
      expect(body(run.fixtures)?.projectId).toBe(PROJECT);
    });

    test('a slug that names no project is refused, saying where it came from', async () => {
      const run = hostedFixtures(pending(), [ready], { servedEnv: REFUSES, projects: [] });
      const out = await deployTo(run.fixtures, 'staging-1');
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        'environments.staging-1.project acme-staging-1: no project of this tenant has that slug.',
      );
      expect(run.fixtures.state.buildCalls).toBe(0);
    });

    test('on a runtime that takes any env, the project and the env are as before', async () => {
      await writeAutoEnvelope();
      await writeFile(join(packDir, '.env.staging-1'), 'FOO=bar\n', 'utf8');
      const run = hostedFixtures(pending(), [ready], {
        servedEnv: { envName: 'prod', refusesOtherEnvs: false },
        projects,
      });
      const out = await deployTo(run.fixtures, 'staging-1', '--sync-secrets');
      expect(out.exitCode, out.stderr).toBe(0);
      expect(body(run.fixtures)?.projectId).toBeUndefined();
      expect(run.fixtures.state.capturedSync?.body.envName).toBe('staging-1');
      expect(run.fixtures.state.findCalls).toBe(0);
    });

    test('to an environment that names no project, --sync-secrets is refused, saying how to name one', async () => {
      await writeAutoEnvelope();
      await writeFile(join(packDir, '.env.staging'), 'FOO=bar\n', 'utf8');
      const run = hostedFixtures(pending(), [ready], { servedEnv: REFUSES, projects });
      const out = await deployTo(run.fixtures, 'staging', '--sync-secrets');
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        "The pack's environment staging names no project: add `environments.staging.project` to kindgi.config.ts, and --env=staging stores values in that project.\nThe pack's environments: staging-1 (project acme-staging-1). --env=<one of them> stores a value in its project.\n",
      );
      expect(run.fixtures.state.buildCalls).toBe(0);
      expect(run.fixtures.state.syncCalls).toBe(0);
    });
  });

  test("a project that isn't there fails before any build", async () => {
    const run = hostedFixtures(pending(), [ready], {
      projects: [{ id: PROJECT, name: 'Acme shop', slug: 'acme-shop' }],
    });
    const out = await deploy(run.fixtures, '--hosted', '--project=initech-shop');
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain('no project of this tenant has that slug');
    expect(run.fixtures.state.buildCalls).toBe(0);
  });

  test.each([
    [[], 'environments.staging.endpoint', 'https://api.staging.example.com'],
    [['--endpoint=https://override.example.com'], '--endpoint', 'https://override.example.com'],
  ])(
    "an address other than the CLI's own (%s) is refused, naming both; nothing is built or sent",
    async (flags, where, other) => {
      const run = hostedFixtures(pending(), [ready]);
      const out = await runCli({
        ...baseInputs(run.fixtures, { env: signedIn }),
        argv: ['deploy', '--hosted', '--env=staging', `--path=${packDir}`, ...flags],
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `kindgi deploy --hosted sends your API key to ${API}, the address it's for (from KINDGI_API_URL), and ${where} names another: ${other}. The key goes only to its own address: remove ${where} (Kindgi Cloud needs none), or sign in to ${other} with \`kindgi auth login --url ${other} --token <its key>\`.`,
      );
      expect(run.fixtures.state.buildCalls).toBe(0);
      expect(run.fixtures.state.postCalls).toBe(0);
    },
  );

  test('the same address, however it is written, is the address: sent there', async () => {
    await writeAutoEnvelope();
    const run = hostedFixtures(pending(), [ready]);
    const out = await deploy(
      run.fixtures,
      '--hosted',
      '--endpoint=https://Platform.EXAMPLE.com:443/',
    );
    expect(out.exitCode, out.stderr).toBe(0);
    expect(run.fixtures.state.capturedPost?.endpoint).toBe(API);
  });

  test('with no API address set it stops before building, saying how to set one', async () => {
    const run = hostedFixtures(pending(), [ready]);
    const out = await runCli({
      ...baseInputs(run.fixtures, {}, cloud()),
      argv: ['deploy', '--hosted', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'kindgi deploy --hosted goes to the API your key is for, and no API address is set. Run `kindgi auth login --url <url> --token <its key>`, export KINDGI_API_URL, or pass --url <url>.',
    );
    expect(run.fixtures.state.buildCalls).toBe(0);
    expect(run.fixtures.state.postCalls).toBe(0);
  });

  describe('with a stored key', () => {
    const STORED = 'kgi_tk_stored';
    const OTHER = 'https://other.example.com';
    const homeFile = () => join(home, '.kindgi/config.json');
    const folderFile = () => join(cwd, '.kindgirc.json');
    async function store(path: string, saved: Record<string, unknown>) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(saved), 'utf8');
    }
    const hostedDeploy = (fixtures: Fixtures, env: Record<string, string>, ...flags: string[]) =>
      runCli({
        ...baseInputs(fixtures, { env }, cloud()),
        argv: ['deploy', '--hosted', '--env=staging', `--path=${packDir}`, ...flags],
      });

    test.each([
      [{ KINDGI_API_URL: OTHER }, [], 'KINDGI_API_URL', undefined],
      [{}, [`--url=${OTHER}`], '--url', undefined],
      [{}, [], 'the apiUrl in <folder>', { apiUrl: OTHER }],
    ] as const)(
      "the CLI address elsewhere than the key's (%j %j) is refused, naming both; nothing is built or sent",
      async (env, flags, named, folder) => {
        await store(homeFile(), { apiUrl: API, token: STORED });
        if (folder !== undefined) await store(folderFile(), folder);
        const where = named.replace('<folder>', folderFile());
        const run = hostedFixtures(pending(), [ready]);
        const out = await hostedDeploy(run.fixtures, env, ...flags);
        expect(out.exitCode).toBe(1);
        expect(out.stderr).toContain(
          `kindgi deploy --hosted would send the API key stored in ${homeFile()}, which is for ${API}, to ${OTHER}, which ${where} names. The key goes only to its own address: point ${where} at ${API}, or sign in to ${OTHER} with \`kindgi auth login --url ${OTHER} --token <its key>\`.`,
        );
        expect(run.fixtures.state.buildCalls).toBe(0);
        expect(run.fixtures.state.postCalls).toBe(0);
      },
    );

    test("an env block's `endpoint` elsewhere names the file the CLI's own address is from", async () => {
      await store(homeFile(), { apiUrl: API, token: STORED });
      const run = hostedFixtures(pending(), [ready]);
      const out = await runCli({
        ...baseInputs(run.fixtures, { env: {} }),
        argv: ['deploy', '--hosted', '--env=staging', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `kindgi deploy --hosted sends your API key to ${API}, the address it's for (from ${homeFile()}), and environments.staging.endpoint names another: https://api.staging.example.com.`,
      );
      expect(run.fixtures.state.postCalls).toBe(0);
    });

    test('a stored key with no address stored beside it is refused; the fix is to sign in', async () => {
      await store(homeFile(), { token: STORED });
      const run = hostedFixtures(pending(), [ready]);
      const out = await hostedDeploy(run.fixtures, { KINDGI_API_URL: API });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `kindgi deploy --hosted would send the API key stored in ${homeFile()} to ${API}, and no address is stored with that key, so nothing shows it's for ${API}. The key goes only to its own address: add "apiUrl": "${API}" beside it in ${homeFile()}, if it's that server's key, or sign in to ${API} with \`kindgi auth login --url ${API} --token <its key>\`.`,
      );
      expect(run.fixtures.state.buildCalls).toBe(0);
      expect(run.fixtures.state.postCalls).toBe(0);
    });

    test.each(['http://localhost:4000', 'http://127.0.0.1:4000/', 'http://[::1]:4000'])(
      "a folder's .kindgirc.json at a local runtime (%s) isn't read: sent to the signed-in address, with its key",
      async (local) => {
        await writeAutoEnvelope();
        await store(homeFile(), { apiUrl: API, token: STORED });
        await store(folderFile(), { apiUrl: local, token: 'kgi_tk_dev' });
        const run = hostedFixtures(pending(), [ready]);
        const out = await hostedDeploy(run.fixtures, {});
        expect(out.exitCode, out.stderr).toBe(0);
        expect(run.fixtures.state.capturedPost).toMatchObject({ endpoint: API, token: STORED });
      },
    );

    test("with only a local runtime's .kindgirc.json, it stops, saying that file isn't read", async () => {
      await store(folderFile(), { apiUrl: 'http://127.0.0.1:4000', token: 'kgi_tk_dev' });
      const run = hostedFixtures(pending(), [ready]);
      const out = await hostedDeploy(run.fixtures, {});
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `kindgi deploy --hosted goes to the API your key is for, and no API address is set. ${folderFile()} points this folder at a \`kindgi dev\` runtime (http://127.0.0.1:4000), which isn't a hosted target, so kindgi deploy --hosted doesn't read it. Run \`kindgi auth login --url <url> --token <its key>\`, export KINDGI_API_URL, or pass --url <url>.`,
      );
      expect(run.fixtures.state.buildCalls).toBe(0);
      expect(run.fixtures.state.postCalls).toBe(0);
    });

    test('with only a .kindgirc.json `kindgi dev` wrote and no address in it, it stops, naming no address', async () => {
      await store(folderFile(), { token: 'kgi_tk_dev', packServicePort: 4100 });
      const run = hostedFixtures(pending(), [ready]);
      const out = await hostedDeploy(run.fixtures, {});
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `kindgi deploy --hosted goes to the API your key is for, and no API address is set. ${folderFile()} points this folder at a \`kindgi dev\` runtime, which isn't a hosted target, so kindgi deploy --hosted doesn't read it. Run \`kindgi auth login --url <url> --token <its key>\`, export KINDGI_API_URL, or pass --url <url>.`,
      );
      expect(run.fixtures.state.buildCalls).toBe(0);
      expect(run.fixtures.state.postCalls).toBe(0);
    });

    test("the .kindgirc.json `kindgi dev --runtime-url` wrote at another address isn't read either", async () => {
      await writeAutoEnvelope();
      await store(homeFile(), { apiUrl: API, token: STORED });
      await store(folderFile(), {
        apiUrl: 'http://192.168.1.20:4000',
        token: 'kgi_tk_dev',
        tenantId: 'tenant-acme-dev',
        packServicePort: 4100,
        packServiceToken: 'kgi_ps_dev',
      });
      const run = hostedFixtures(pending(), [ready]);
      const out = await hostedDeploy(run.fixtures, {});
      expect(out.exitCode, out.stderr).toBe(0);
      expect(run.fixtures.state.capturedPost).toMatchObject({ endpoint: API, token: STORED });
    });

    test("a folder's .kindgirc.json at another address is read as it is: its address, its key", async () => {
      await writeAutoEnvelope();
      await store(homeFile(), { apiUrl: OTHER, token: STORED });
      await store(folderFile(), { apiUrl: API, token: 'kgi_tk_folder' });
      const run = hostedFixtures(pending(), [ready]);
      const out = await hostedDeploy(run.fixtures, {});
      expect(out.exitCode, out.stderr).toBe(0);
      expect(run.fixtures.state.capturedPost).toMatchObject({
        endpoint: API,
        token: 'kgi_tk_folder',
      });
    });
  });

  describe("the pack service's env on Kindgi Cloud", () => {
    /** Cloud's env block, with the pack's env declared and staging's `env` block as given. */
    const declared = (stagingEnv?: Record<string, unknown>): Record<string, unknown> => {
      const base = cloud();
      const staging = (base.environments as { staging: Record<string, unknown> }).staging;
      return {
        env: { required: ['API_BASE', 'SHOP_URL'], optional: ['LOG_LEVEL'] },
        environments: {
          staging: { ...staging, ...(stagingEnv !== undefined && { env: stagingEnv }) },
        },
      };
    };
    const hostedWith = (fixtures: Fixtures, config: Record<string, unknown>, ...flags: string[]) =>
      runCli({
        ...baseInputs(fixtures, { env: signedIn }, config),
        argv: ['deploy', '--env=staging', `--path=${packDir}`, '--hosted', ...flags],
      });
    const name = (n: string, extra: Partial<PackEnvNameRecord> = {}): PackEnvNameRecord => ({
      name: n,
      required: true,
      kind: 'env',
      scope: { kind: 'project', id: PROJECT },
      missing: false,
      ...extra,
    });
    const unset = (n: string): PackEnvNameRecord =>
      name(n, { kind: null, scope: null, missing: true, problem: 'missing' });
    /** `hostedFixtures`, whose reads of the deployment's env answer `packEnv` in turn (then the last again). */
    function withPackEnv(
      run: ReturnType<typeof hostedFixtures>,
      packEnv: readonly (GetPackEnvResult | readonly PackEnvNameRecord[])[],
    ) {
      const reads: string[] = [];
      const runners: DeployRunners = {
        ...run.fixtures.runners,
        getPackEnv: async (o): Promise<GetPackEnvResult> => {
          reads.push(o.deploymentId);
          const next = packEnv[Math.min(reads.length - 1, packEnv.length - 1)];
          if (next === undefined) return { kind: 'not-served' };
          if (!Array.isArray(next)) return next as GetPackEnvResult;
          const data = next as readonly PackEnvNameRecord[];
          return {
            kind: 'ok',
            packEnv: {
              envName: 'prod',
              data,
              ...(data.some((n) => n.problem !== undefined) && { problem: 'pack-env-missing' }),
            },
          };
        },
      };
      return { ...run, fixtures: { ...run.fixtures, runners }, packEnvReads: reads };
    }

    test('environments.<env>.env in kindgi.config: refused before anything is built or sent, naming each name and how to set it', async () => {
      await writeAutoEnvelope();
      const run = hostedFixtures(pending(), [ready]);
      const out = await hostedWith(
        run.fixtures,
        declared({
          API_BASE: 'https://api.acme.test',
          SHOP_URL: { secret: 'acme-shop-url', version: '2' },
          EXTRA: 'x',
        }),
        `--project=${PROJECT}`,
      );
      expect(out.exitCode).toBe(1);
      expect(run.fixtures.state.postCalls).toBe(0);
      expect(run.fixtures.state.capturedBuild).toBeUndefined();
      expect(out.stderr).toContain(
        `kindgi deploy: on Kindgi Cloud the pack service gets the env values set in your workspace, not environments.staging.env in kindgi.config (API_BASE, EXTRA, SHOP_URL). Set each with \`kindgi env set NAME <value> --scope=project:${PROJECT} --env=staging\` (a secret with \`kindgi secrets set NAME --scope=project:${PROJECT} --env=staging\`), then remove environments.staging.env from kindgi.config and deploy again.`,
      );
    });

    test('a tenant-wide hosted deploy is told to set them at the tenant; a malformed block is refused too', async () => {
      await writeAutoEnvelope();
      const run = hostedFixtures(pending(), [ready]);
      const out = await hostedWith(run.fixtures, declared({ API_BASE: 'https://api.acme.test' }));
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('`kindgi env set NAME <value> --scope=tenant --env=staging`');
      expect(out.stderr).not.toContain('kindgi secrets set');
      const malformed = hostedFixtures(pending(), [ready]);
      const bad = await hostedWith(malformed.fixtures, declared({ API_BASE: 42 }));
      expect(bad.exitCode).toBe(1);
      expect(malformed.fixtures.state.postCalls).toBe(0);
      expect(bad.stderr).toContain('not environments.staging.env in kindgi.config. Set each with');
    });

    test("no environments.<env>.env: kindgi.config's required names aren't checked; the server says what's missing, and it waits", async () => {
      await writeAutoEnvelope();
      const run = withPackEnv(
        hostedFixtures(pending(), [
          pending('pack-env-missing'),
          pending('pack-env-missing'),
          ready,
        ]),
        [
          [unset('API_BASE'), unset('SHOP_URL')],
          [unset('API_BASE'), unset('SHOP_URL')],
          [unset('SHOP_URL')],
        ],
      );
      const out = await hostedWith(run.fixtures, declared(), `--project=${PROJECT}`);
      expect(out.exitCode, out.stderr).toBe(0);
      expect(out.stderr).not.toContain('has no value in environments.staging.env');
      expect(run.packEnvReads).toEqual(['dep-01H8XM', 'dep-01H8XM']);
      const waited = out.stderr.slice(out.stderr.indexOf('Waiting for the pack service'));
      expect(waited.split('\n').slice(0, 5)).toEqual([
        'Waiting for the pack service',
        '    … pending',
        `      API_BASE and SHOP_URL aren't set for prod. Set each with \`kindgi env set NAME <value> --scope=project:${PROJECT} --env=prod\`.`,
        "    … pending (pack-env-missing): a name the pack needs in its env isn't set",
        '    ✓ ready',
      ]);
    });

    test('a name set only as a secret, or both ways: it says which, and where', async () => {
      await writeAutoEnvelope();
      const run = withPackEnv(hostedFixtures(pending(), [ready]), [
        [
          name('API_BASE', { kind: 'secret', problem: 'secret-not-yet' }),
          name('SHOP_URL', {
            scope: { kind: 'tenant' },
            problem: 'ambiguous',
            secretScope: { kind: 'org', id: 'org-1' },
          }),
        ],
      ]);
      const out = await hostedWith(run.fixtures, declared(), `--project=${PROJECT}`);
      expect(out.exitCode, out.stderr).toBe(0);
      expect(out.stderr).toContain(
        "      API_BASE is set only as a secret, which this server keeps out of a pack service's environment: a tool reads it per call (`ctx.secrets`).",
      );
      expect(out.stderr).toContain(
        "      SHOP_URL is set both as a secret (org org-1) and as a plain value (tenant): remove one, so it's clear which the pack service gets.",
      );
    });

    test("a server that doesn't give pack services their env: nothing more is said", async () => {
      await writeAutoEnvelope();
      const run = withPackEnv(hostedFixtures(pending(), [ready]), [{ kind: 'not-served' }]);
      const out = await hostedWith(run.fixtures, declared(), `--project=${PROJECT}`);
      expect(out.exitCode, out.stderr).toBe(0);
      const waited = out.stderr.slice(out.stderr.indexOf('Waiting for the pack service'));
      expect(waited.split('\n').slice(0, 3)).toEqual([
        'Waiting for the pack service',
        '    … pending',
        '    ✓ ready',
      ]);
    });

    test('a read of where each value is set that fails is said, with why, and not again while the reason is the same; the deploy goes on', async () => {
      await writeAutoEnvelope();
      const message =
        'GET https://api.acme.example/v1/deployments/dep-01H8XM/pack-env answered HTTP 403 (forbidden)';
      const run = withPackEnv(hostedFixtures(pending(), [pending('pack-env-missing'), ready]), [
        { kind: 'error', message },
      ]);
      const out = await hostedWith(run.fixtures, declared(), `--project=${PROJECT}`);
      expect(out.exitCode, out.stderr).toBe(0);
      expect(run.packEnvReads).toEqual(['dep-01H8XM', 'dep-01H8XM']);
      const waited = out.stderr.slice(out.stderr.indexOf('Waiting for the pack service'));
      expect(waited.split('\n').slice(0, 5)).toEqual([
        'Waiting for the pack service',
        '    … pending',
        `      Couldn't read where each value is set: ${message}`,
        "    … pending (pack-env-missing): a name the pack needs in its env isn't set",
        '    ✓ ready',
      ]);
    });

    test('a read the stop cuts short says nothing more: the wait says it stopped', async () => {
      await writeAutoEnvelope();
      const controller = new AbortController();
      const run = hostedFixtures(pending(), [ready]);
      const runners: DeployRunners = {
        ...run.fixtures.runners,
        getPackEnv: async (): Promise<GetPackEnvResult> => {
          controller.abort();
          return {
            kind: 'error',
            message:
              'GET https://api.acme.example/v1/deployments/dep-01H8XM/pack-env failed: This operation was aborted',
          };
        },
      };
      const out = await runCli({
        ...baseInputs(
          { ...run.fixtures, runners },
          { env: signedIn, stopSignal: controller.signal },
          declared(),
        ),
        argv: ['deploy', '--env=staging', `--path=${packDir}`, '--hosted', `--project=${PROJECT}`],
      });
      expect(out.exitCode, out.stderr).toBe(1);
      expect(out.stderr).not.toContain("Couldn't read where each value is set");
      expect(out.stderr).toContain('Stopped waiting for the pack service: pending.');
    });
  });
});

describe("kindgi deploy: the stored API key goes only to the address it's for", () => {
  const OWN = 'https://platform.example.com';
  const STAGING = 'https://api.staging.example.com';
  const STORED = 'kgi_tk_stored';
  /** `kindgi auth login`'s file: an address and the key for it. */
  async function signIn(saved: Record<string, string> = { apiUrl: OWN, token: STORED }) {
    await mkdir(join(home, '.kindgi'), { recursive: true });
    await writeFile(join(home, '.kindgi/config.json'), JSON.stringify(saved), 'utf8');
  }
  const deploy = (fixtures: Fixtures, env: Record<string, string>, ...flags: string[]) =>
    runCli({
      ...baseInputs(fixtures, { env }),
      argv: ['deploy', '--env=staging', `--path=${packDir}`, ...flags],
    });
  const folderFile = async (saved: Record<string, string>) =>
    writeFile(join(cwd, '.kindgirc.json'), JSON.stringify(saved), 'utf8');
  /** An env block with no `endpoint`: the deploy goes to the CLI's own address. */
  const noEndpoint = (): Record<string, unknown> => ({
    environments: {
      staging: { signingKey: join(home, 'signing-key.pem'), tenantId: 'tenant-acme-staging' },
    },
  });

  test("the env block's `endpoint` elsewhere is refused, naming both and the fixes; nothing is sent", async () => {
    await writeAutoEnvelope();
    await signIn();
    const fixtures = makeFixtures();
    const out = await deploy(fixtures, {});
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      `kindgi deploy would send the API key stored in ${join(home, '.kindgi/config.json')}, which is for ${OWN}, to ${STAGING}, which environments.staging.endpoint names. The key goes only to its own address: point environments.staging.endpoint at ${OWN}, sign in to ${STAGING} with \`kindgi auth login --url ${STAGING} --token <its key>\`, or give that server's key with --token or KINDGI_API_TOKEN.`,
    );
    expect(fixtures.state.postCalls).toBe(0);
    expect(fixtures.state.syncCalls).toBe(0);
  });

  test('--endpoint elsewhere is refused the same way, naming --endpoint', async () => {
    await writeAutoEnvelope();
    await signIn({ apiUrl: STAGING, token: STORED });
    const fixtures = makeFixtures();
    const out = await deploy(fixtures, {}, '--endpoint=https://override.example.com');
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      `to https://override.example.com, which --endpoint names. The key goes only to its own address: point --endpoint at ${STAGING},`,
    );
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('a key given for the command goes where the command says: --token, or an exported KINDGI_API_TOKEN', async () => {
    await writeAutoEnvelope();
    await signIn();
    for (const [env, flags] of [
      [{}, ['--token=kgi_tk_staging']],
      [{ KINDGI_API_TOKEN: 'kgi_tk_staging' }, []],
    ] as const) {
      const fixtures = makeFixtures();
      const out = await deploy(fixtures, env, ...flags);
      expect(out.exitCode, out.stderr).toBe(0);
      expect(fixtures.state.capturedPost).toMatchObject({
        endpoint: STAGING,
        token: 'kgi_tk_staging',
      });
    }
  });

  test('its own address, however it is written: sent, with the stored key', async () => {
    await writeAutoEnvelope();
    await signIn({ apiUrl: 'HTTPS://API.Staging.Example.com:443/', token: STORED });
    const fixtures = makeFixtures();
    const out = await deploy(fixtures, {});
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.capturedPost).toMatchObject({ endpoint: STAGING, token: STORED });
  });

  test("from a `kindgi dev` folder, the env block's `endpoint` at the signed-in address: the key signed in for it, not the folder's", async () => {
    await writeAutoEnvelope();
    await signIn({ apiUrl: STAGING, token: STORED });
    await folderFile({ apiUrl: 'http://127.0.0.1:4000', token: 'kgi_tk_dev' });
    const fixtures = makeFixtures();
    const out = await deploy(fixtures, {});
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.capturedPost).toMatchObject({ endpoint: STAGING, token: STORED });
  });

  test('from a `kindgi dev` folder, --url at the signed-in address: the key signed in for it', async () => {
    await writeAutoEnvelope();
    await signIn({ apiUrl: STAGING, token: STORED });
    await folderFile({ apiUrl: 'http://127.0.0.1:4000', token: 'kgi_tk_dev' });
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, noEndpoint()),
      argv: ['deploy', '--env=staging', `--path=${packDir}`, `--url=${STAGING}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.capturedPost).toMatchObject({ endpoint: STAGING, token: STORED });
  });

  test("from a `kindgi dev` folder with no endpoint named: the dev runtime, with the folder's key, and stderr's first line says how to reach the signed-in address", async () => {
    const dev = 'http://127.0.0.1:4000';
    await writeAutoEnvelope();
    await signIn();
    await folderFile({ apiUrl: dev, token: 'kgi_tk_dev' });
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, noEndpoint()),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.capturedPost).toMatchObject({ endpoint: dev, token: 'kgi_tk_dev' });
    expect(out.stderr.split('\n')[0]).toBe(
      `kindgi deploy goes to the kindgi dev runtime at ${dev} (${join(cwd, '.kindgirc.json')} says so). For ${OWN}, pass --hosted.`,
    );
  });

  test('from a `kindgi dev` folder, the dev runtime named by --endpoint or the env block: no line', async () => {
    const dev = 'http://127.0.0.1:4000';
    await writeAutoEnvelope();
    await signIn();
    await folderFile({ apiUrl: dev, token: 'kgi_tk_dev' });
    const atDev = {
      environments: {
        staging: {
          endpoint: dev,
          signingKey: join(home, 'signing-key.pem'),
          tenantId: 'tenant-acme-staging',
        },
      },
    };
    for (const [config, flags] of [
      [noEndpoint(), [`--endpoint=${dev}`]],
      [atDev, []],
    ] as const) {
      const fixtures = makeFixtures();
      const out = await runCli({
        ...baseInputs(fixtures, { env: {} }, config),
        argv: ['deploy', '--env=staging', `--path=${packDir}`, ...flags],
      });
      expect(out.exitCode, out.stderr).toBe(0);
      expect(fixtures.state.capturedPost).toMatchObject({ endpoint: dev, token: 'kgi_tk_dev' });
      expect(out.stderr).not.toContain('goes to the kindgi dev runtime');
    }
  });

  test("`kindgi dev`'s .kindgirc.json: 127.0.0.1 and localhost are one address, another port isn't", async () => {
    await writeAutoEnvelope();
    await writeFile(
      join(cwd, '.kindgirc.json'),
      JSON.stringify({ apiUrl: 'http://127.0.0.1:4000', token: STORED }),
      'utf8',
    );
    const local = (endpoint: string) => ({
      environments: {
        dev: {
          endpoint,
          signingKey: join(home, 'signing-key.pem'),
          tenantId: 'tenant-acme-staging',
        },
      },
    });
    const same = makeFixtures();
    const ok = await runCli({
      ...baseInputs(same, { env: {} }, local('http://localhost:4000/')),
      argv: ['deploy', '--env=dev', `--path=${packDir}`],
    });
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(same.state.capturedPost?.endpoint).toBe('http://localhost:4000/');

    const other = makeFixtures();
    const refused = await runCli({
      ...baseInputs(other, { env: {} }, local('http://localhost:4001')),
      argv: ['deploy', '--env=dev', `--path=${packDir}`],
    });
    expect(refused.exitCode).toBe(1);
    // A key signed in for it would be found from this folder too (storedKeyFor).
    expect(refused.stderr).toContain(
      `kindgi deploy would send the API key stored in ${join(cwd, '.kindgirc.json')}, which is for http://127.0.0.1:4000, to http://localhost:4001, which environments.dev.endpoint names. The key goes only to its own address: point environments.dev.endpoint at http://127.0.0.1:4000, sign in to http://localhost:4001 with \`kindgi auth login --url http://localhost:4001 --token <its key>\`, or give that server's key with --token or KINDGI_API_TOKEN.`,
    );
    expect(other.state.postCalls).toBe(0);
  });

  test.each([
    [
      'the home file',
      () => signIn({ token: STORED }),
      () => join(home, '.kindgi/config.json'),
      () =>
        `add "apiUrl": "${STAGING}" beside it in ${join(home, '.kindgi/config.json')}, if it's that server's key, sign in to ${STAGING} with \`kindgi auth login --url ${STAGING} --token <its key>\``,
    ],
    [
      "a folder's .kindgirc.json",
      async () => {
        await signIn();
        await folderFile({ token: STORED });
      },
      () => join(cwd, '.kindgirc.json'),
      () =>
        `add "apiUrl": "${STAGING}" beside it in ${join(cwd, '.kindgirc.json')}, if it's that server's key, sign in to ${STAGING} with \`kindgi auth login --url ${STAGING} --token <its key>\``,
    ],
  ])(
    'a stored key with no address stored beside it (%s) is refused; nothing is sent',
    async (_, store, file, fix) => {
      await writeAutoEnvelope();
      await store();
      const fixtures = makeFixtures();
      const out = await deploy(fixtures, {});
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `kindgi deploy would send the API key stored in ${file()} to ${STAGING}, and no address is stored with that key, so nothing shows it's for ${STAGING}. The key goes only to its own address: ${fix()}, or give that server's key with --token or KINDGI_API_TOKEN.`,
      );
      expect(fixtures.state.postCalls).toBe(0);
    },
  );

  test.each([
    [{ KINDGI_API_URL: STAGING }, [], 'KINDGI_API_URL', () => {}],
    [{}, [`--url=${STAGING}`], '--url', () => {}],
    [{}, [], 'the apiUrl in <folder>', () => folderFile({ apiUrl: STAGING })],
  ] as const)(
    'with no endpoint named, the CLI address elsewhere (%j %j) is refused the same way, naming it',
    async (env, flags, named, setUp) => {
      await writeAutoEnvelope();
      await signIn();
      await setUp();
      const where = named.replace('<folder>', join(cwd, '.kindgirc.json'));
      const fixtures = makeFixtures();
      const out = await runCli({
        ...baseInputs(fixtures, { env }, noEndpoint()),
        argv: ['deploy', '--env=staging', `--path=${packDir}`, ...flags],
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `kindgi deploy would send the API key stored in ${join(home, '.kindgi/config.json')}, which is for ${OWN}, to ${STAGING}, which ${where} names. The key goes only to its own address: point ${where} at ${OWN}, sign in to ${STAGING} with \`kindgi auth login --url ${STAGING} --token <its key>\`, or give that server's key with --token or KINDGI_API_TOKEN.`,
      );
      expect(fixtures.state.postCalls).toBe(0);
    },
  );
});

describe('kindgi deploy — a pack with blocks goes only to a runtime that publishes them', () => {
  const BLOCKS = [
    { id: 'my-pack.reply', version: '1.0.0', kind: 'prompt', content: { template: 'Hi.' } },
    { id: 'my-pack.style', version: '1.0.0', kind: 'settings', content: { values: {} } },
  ];

  /**
   * A runtime whose `/v1/openapi.json` lists `capabilities` (none: no
   * entry), and whose check against what runs passes; the URLs asked.
   */
  function runtime(capabilities?: readonly string[], status = 200) {
    const asked: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      asked.push(String(url));
      if (String(url).endsWith('/v1/deployments/check')) {
        return new Response(JSON.stringify({ replaced: [], notNeeded: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const info = {
        title: 'Kindgi Platform API',
        version: '0.1.0',
        ...(capabilities !== undefined && { 'x-kindgi-capabilities': capabilities }),
      };
      return new Response(JSON.stringify({ openapi: '3.1.0', info }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { fetchImpl, asked };
  }

  async function deployWith(
    fetchImpl: typeof fetch,
    opts: { blocks?: boolean; argv?: string[] } = {},
  ) {
    const index = { ...(makeEnvelope().index as Record<string, unknown>) };
    if (opts.blocks !== false) index.blocks = BLOCKS;
    await writeAutoEnvelope({ index });
    const fixtures = makeFixtures({ envelope: makeEnvelope({ index }) });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`, ...(opts.argv ?? [])],
      fetchImpl,
    });
    return { out, fixtures };
  }

  test('a runtime that lists deploy-publishes-pack-blocks takes it; names it does not know are ignored', async () => {
    const { fetchImpl, asked } = runtime(['some-later-capability', 'deploy-publishes-pack-blocks']);
    const { out, fixtures } = await deployWith(fetchImpl);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(asked).toEqual([
      'https://api.staging.example.com/v1/openapi.json',
      'https://api.staging.example.com/v1/deployments/check',
    ]);
    expect(fixtures.state.postCalls).toBe(1);
  });

  test("a runtime that doesn't is refused before anything is sent, naming this CLI's release", async () => {
    for (const capabilities of [undefined, ['some-later-capability']]) {
      const { fetchImpl } = runtime(capabilities);
      const { out, fixtures } = await deployWith(fetchImpl);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `The runtime at https://api.staging.example.com doesn't publish a pack's blocks (2 blocks in its index); deploy to a runtime with Kindgi ${CLI_VERSION} or later, or remove them.`,
      );
      expect(fixtures.state.postCalls).toBe(0);
    }
  });

  test('a pack without blocks never asks', async () => {
    const { fetchImpl, asked } = runtime();
    const { out, fixtures } = await deployWith(fetchImpl, { blocks: false });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(asked).toEqual([]);
    expect(fixtures.state.postCalls).toBe(1);
  });

  test("an answer that isn't the document is refused too: the deploy can't tell", async () => {
    const { fetchImpl } = runtime(undefined, 404);
    const { out, fixtures } = await deployWith(fetchImpl);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "Couldn't read what the runtime at https://api.staging.example.com does (GET /v1/openapi.json: HTTP 404), which a pack with blocks (2 blocks in its index) needs before it deploys.",
    );
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('--dry-run sends nothing, so asks no capability: only the check against what runs', async () => {
    const { fetchImpl, asked } = runtime();
    const { out } = await deployWith(fetchImpl, { argv: ['--dry-run'] });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(asked).toEqual(['https://api.staging.example.com/v1/deployments/check']);
  });

  test("with no envelope yet, the pack's block files are checked before the build", async () => {
    await mkdir(join(packDir, 'blocks'), { recursive: true });
    await writeFile(join(packDir, 'blocks', 'reply.json'), JSON.stringify(BLOCKS[0]), 'utf8');
    await writeFile(join(packDir, 'blocks', 'style.json'), JSON.stringify(BLOCKS[1]), 'utf8');
    const { fetchImpl } = runtime();
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`],
      fetchImpl,
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("doesn't publish a pack's blocks (blocks/: 2 files)");
    expect(fixtures.state.buildCalls).toBe(0);
    expect(fixtures.state.postCalls).toBe(0);
  });
});

describe("kindgi deploy — the pack's blocks against what runs", () => {
  const PROJECT = '0b3f6a9e-7c1d-4e2a-9b8f-1a2b3c4d5e6f';
  const SANDBOX = '5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
  const BLOCKS = [
    { id: 'my-pack.tone', version: '3.0.0', kind: 'prompt', content: { template: 'Hi.' } },
    { id: 'my-pack.rules', version: '1.0.0', kind: 'settings', content: { values: {} } },
  ];
  const STOP = {
    blockId: 'my-pack.tone',
    inFiles: '3.0.0',
    runs: {
      version: '4.0.0',
      projectId: SANDBOX,
      follows: 'latest',
      by: { kind: 'user', id: 'usr-ana', name: 'Ana' },
      at: '2026-11-05T09:12:00.000Z',
    },
    pr: { url: 'https://github.com/acme/returns/pull/214' },
  };

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  /** A runtime that publishes a pack's blocks and answers the check `check`; each check body sent is kept. */
  function runtime(check: { status: number; body: unknown }) {
    const checks: unknown[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/openapi.json')) {
        return json(200, {
          openapi: '3.1.0',
          info: { 'x-kindgi-capabilities': ['deploy-publishes-pack-blocks'] },
        });
      }
      if (u.endsWith('/v1/deployments/check')) {
        checks.push(JSON.parse(String(init?.body)));
        return json(check.status, check.body);
      }
      if (u.endsWith(`/v1/projects/${SANDBOX}`)) {
        return json(200, { id: SANDBOX, name: 'Support sandbox', slug: 'support-sandbox' });
      }
      return json(404, { error: { code: 'not-found', message: 'Not found', requestId: 'r' } });
    }) as typeof fetch;
    return { fetchImpl, checks };
  }

  async function deployWith(fetchImpl: typeof fetch, argv: readonly string[] = []) {
    const index = { ...(makeEnvelope().index as Record<string, unknown>), blocks: BLOCKS };
    await writeAutoEnvelope({ index });
    const fixtures = makeFixtures({ envelope: makeEnvelope({ index }) });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['deploy', '--env=staging', `--path=${packDir}`, ...argv],
      fetchImpl,
    });
    return { out, fixtures };
  }

  const stopAnswer = {
    status: 409,
    body: {
      error: {
        code: 'deploy-would-put-back-older-blocks',
        message: 'This deploy would put back older versions of blocks than run now.',
        details: { blocks: [STOP] },
        requestId: 'r',
      },
    },
  };

  test("a newer block than the files' that runs now stops the deploy: the table, nothing deployed, exit 1", async () => {
    const { fetchImpl, checks } = runtime(stopAnswer);
    const { out, fixtures } = await deployWith(fetchImpl);
    expect(out.exitCode).toBe(1);
    expect(checks).toEqual([
      {
        agents: ['my-pack.agent'],
        blocks: [
          { id: 'my-pack.tone', version: '3.0.0' },
          { id: 'my-pack.rules', version: '1.0.0' },
        ],
      },
    ]);
    expect(out.stderr).toContain('  Checking my-pack against what runs…\n');
    expect(out.stderr).toContain(
      [
        '✗ Stopped: this deploy would put back older blocks than run now.',
        '',
        '  Block          In your files   Runs now',
        '  my-pack.tone   3.0.0           4.0.0  latest in Support sandbox (Ana, 11-05)',
        '',
        '  Nothing was deployed.',
        '  To keep the newer versions:  merge https://github.com/acme/returns/pull/214, or run `kindgi blocks pull`, then deploy again.',
        '  To drop them on purpose:  kindgi deploy --env=staging --replace=my-pack.tone --reason=<why>',
      ].join('\n'),
    );
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('--dry-run asks the check too, and a stop exits 1 there as well', async () => {
    const { fetchImpl, checks } = runtime(stopAnswer);
    const { out, fixtures } = await deployWith(fetchImpl, ['--dry-run']);
    expect(out.exitCode).toBe(1);
    expect(checks).toHaveLength(1);
    expect(out.stderr).toContain('  Nothing was deployed.');
    expect(out.stderr).not.toContain('--dry-run set. No request sent.');
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('--replace with --reason: the check and the deploy carry each block with the reason, and it says what it puts back', async () => {
    const { fetchImpl, checks } = runtime({
      status: 200,
      body: {
        replaced: [{ blockId: 'my-pack.tone', from: '4.0.0', to: '3.0.0' }],
        notNeeded: ['my-pack.rules'],
      },
    });
    const { out, fixtures } = await deployWith(fetchImpl, [
      `--project=${PROJECT}`,
      '--replace=my-pack.tone',
      '--replace=my-pack.rules',
      '--reason=v4 was a try in the sandbox',
    ]);
    expect(out.exitCode, out.stderr).toBe(0);
    const replace = [
      { blockId: 'my-pack.tone', reason: 'v4 was a try in the sandbox' },
      { blockId: 'my-pack.rules', reason: 'v4 was a try in the sandbox' },
    ];
    expect(checks).toEqual([
      {
        projectId: PROJECT,
        agents: ['my-pack.agent'],
        blocks: [
          { id: 'my-pack.tone', version: '3.0.0' },
          { id: 'my-pack.rules', version: '1.0.0' },
        ],
        replace,
      },
    ]);
    expect(out.stderr).toContain(
      '  my-pack.tone: 4.0.0 runs now, 3.0.0 in your files; put back on purpose (--replace)\n',
    );
    expect(out.stderr).toContain('  my-pack.rules: nothing newer runs; --replace not needed\n');
    expect(fixtures.state.postCalls).toBe(1);
    expect(fixtures.state.capturedPost?.body.projectId).toBe(PROJECT);
    expect(fixtures.state.capturedPost?.body.replace).toEqual(replace);
  });

  test('--replace without --reason, or --reason without --replace, asks nothing and deploys nothing', async () => {
    for (const [argv, said] of [
      [['--replace=my-pack.tone'], 'say why with --reason=<text>'],
      [['--reason=why'], 'it goes with --replace=<block>'],
    ] as const) {
      const { fetchImpl, checks } = runtime(stopAnswer);
      const { out, fixtures } = await deployWith(fetchImpl, argv);
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(said);
      expect(checks).toEqual([]);
      expect(fixtures.state.loadCalls).toBe(0);
    }
  });

  test('a runtime without the check (404, or 501 runs-in-unsupported) deploys as before, and says so in one line', async () => {
    for (const answer of [
      { status: 404, body: { error: { code: 'not-found', message: 'Not found', requestId: 'r' } } },
      {
        status: 501,
        body: { error: { code: 'runs-in-unsupported', message: 'No pins', requestId: 'r' } },
      },
    ]) {
      const { fetchImpl } = runtime(answer);
      const { out, fixtures } = await deployWith(fetchImpl);
      expect(out.exitCode, out.stderr).toBe(0);
      expect(out.stderr).toContain(
        "  This runtime doesn't check blocks against what runs: deploying as before.\n",
      );
      expect(fixtures.state.postCalls).toBe(1);
    }
  });

  const forbidden = {
    status: 403,
    body: {
      error: { code: 'permission-denied', message: 'Needs admin on the tenant', requestId: 'r' },
    },
  };
  const FORBIDDEN_LINE =
    "  This key can't check blocks against what runs here (403): deploying without the check; a runtime that has it still holds it on the deploy.\n";

  test('a key the check refuses (403) deploys without it, and says so in one line', async () => {
    const { fetchImpl, checks } = runtime(forbidden);
    const { out, fixtures } = await deployWith(fetchImpl);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(checks).toHaveLength(1);
    expect(out.stderr).toContain(FORBIDDEN_LINE);
    expect(fixtures.state.postCalls).toBe(1);
  });

  test('--dry-run with a key the check refuses (403) goes on to print the request, sending nothing', async () => {
    const { fetchImpl } = runtime(forbidden);
    const { out, fixtures } = await deployWith(fetchImpl, ['--dry-run']);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain(FORBIDDEN_LINE);
    expect(out.stderr).toContain('--dry-run set. No request sent.');
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('a check the runtime refuses for another reason fails the deploy before anything is sent', async () => {
    const { fetchImpl } = runtime({
      status: 400,
      body: {
        error: { code: 'bad-input', message: '`blocks` must be a list', requestId: 'r' },
      },
    });
    const { out, fixtures } = await deployWith(fetchImpl);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "Couldn't check the pack's blocks against what runs (POST /v1/deployments/check): bad-input: `blocks` must be a list",
    );
    expect(fixtures.state.postCalls).toBe(0);
  });
});
