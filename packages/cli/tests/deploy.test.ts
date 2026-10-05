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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { DEPLOY_ENVELOPE_SCHEMA } from '../src/build/envelope.js';
import type {
  DeployRunners,
  DeploymentRecord,
  LoadEnvelopeResult,
  PostDeploymentOptions,
  PostDeploymentResult,
  RunBuildOptions,
  RunBuildResult,
  SyncSecretsOptions,
  SyncSecretsResult,
} from '../src/deploy/runners.js';
import { type RunCliInputs, runCli } from '../src/main.js';

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
    capturedPost?: PostDeploymentOptions;
    capturedBuild?: RunBuildOptions;
    capturedSync?: SyncSecretsOptions;
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
}

function makeFixtures(opts: FixtureOptions = {}): Fixtures {
  const state: Fixtures['state'] = {
    loadCalls: 0,
    postCalls: 0,
    buildCalls: 0,
    syncCalls: 0,
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
    expect(out.stderr).toContain('Dry run');
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
});
