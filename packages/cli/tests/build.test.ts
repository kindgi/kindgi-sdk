// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi build` tests. Every side effect flows through the
 * injectable `BuildRunners` seam so these tests never spawn real
 * esbuild, real tar, real docker, or a live build-server. The
 * `kindgi.config.ts` loader is likewise injected — no dynamic
 * `import()` of Node 22 --experimental-strip-types is required.
 *
 * Test fake `BuildRunners`:
 *   - `runLocalIndexer` — returns a canned IndexResult; writes bytes
 *     to `outputPath` so the command's `readFile(expectedIndexPath)`
 *     step finds them.
 *   - `esbuildBundle` — no-op; returns fixed sizes.
 *   - `writeContainerfile` — captures the call.
 *   - `tarPack` — synthesizes fake tarball bytes.
 *   - `postBuild` — returns a { buildJobId, status: 'queued' } by
 *     default; per-test overrides simulate idempotent replays.
 *   - `streamBuildLogs` — returns a fixed terminal payload; per-test
 *     overrides simulate integrity gate PASS/FAIL cases.
 *   - `pullImageIndex` — optional; when present returns fake server
 *     bytes matching the local expected bytes.
 *   - `signEnvelope` — returns a canned signature.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_UV_IMAGE_REF, PYTHON_PACK_SERVICE_COMMAND } from '../src/build/python-image.js';
import type {
  BuildRunners,
  DockerBuildOptions,
  EsbuildBundleResult,
  LocalIndexResult,
  PostBuildResult,
  PullImageIndexResult,
  SignResult,
  TarPackResult,
  TerminalPayload,
} from '../src/build/runners.js';
import { type RunCliInputs, runCli } from '../src/main.js';

let cwd: string;
let home: string;
let packDir: string;

// A fixed pack config resolved by the test loader. Includes an
// `environments.staging` block naming a build endpoint + signing key
// path so the resolver can complete without more surface.
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

const SAMPLE_INDEX = {
  v: 1,
  packId: 'my-pack',
  packVersion: '0.1.0',
  artifactVersion: '20260921.1',
  publishedAt: '1970-01-01T00:00:00.000Z',
  tools: [
    {
      id: 'my-pack.echo',
      input: { type: 'object' },
      output: { type: 'object' },
      modulePath: 'tools/echo/index.js',
    },
  ],
  guardrails: [],
  agents: [],
  flows: [],
};

const SAMPLE_INDEX_BYTES = new TextEncoder().encode(JSON.stringify(SAMPLE_INDEX));
const PUSHED_DIGEST = `sha256:${'ab'.repeat(32)}`;
const SAMPLE_INDEX_HASH_HEX = (() => {
  // Import at test setup time; keep this synchronous.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return `sha256:${createHash('sha256').update(SAMPLE_INDEX_BYTES).digest('hex')}`;
})();

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'kindgi-cli-build-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'kindgi-cli-build-cwd-'));
  packDir = join(cwd, 'sample-pack');
  await mkdir(packDir, { recursive: true });
  // Write a placeholder signing key — the test fake signEnvelope never
  // reads it, but the command's readFile() call still runs.
  await writeFile(
    join(home, 'signing-key.pem'),
    '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
    'utf8',
  );
  // A `kindgi.config.ts` — the injected loader returns the
  // in-memory config regardless of file contents, but the presence of
  // this file is what makes packDir a valid pack root for future
  // filesystem checks.
  await writeFile(join(packDir, 'kindgi.config.ts'), 'export default {};\n', 'utf8');
  // A `package.json` — src/build/pack-root.ts's resolver walks up
  // looking for one to distinguish standalone vs augment packs. Real
  // packs always have this; the tests just need to reflect that.
  await writeFile(
    join(packDir, 'package.json'),
    '{"name": "test-pack", "version": "0.1.0"}\n',
    'utf8',
  );
  // The lockfile the image installs from (`host-install.ts`).
  await writeFile(join(packDir, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

// ---------- fake BuildRunners + fixtures ----------

interface Fixtures {
  runners: BuildRunners;
  readonly state: {
    esbuildCalls: number;
    containerfileCalls: number;
    contextCalls: number;
    tarCalls: number;
    dockerBuilds: DockerBuildOptions[];
    pullOptions: { pull?: boolean | undefined; imageRef: string; platform?: string | undefined }[];
    containerfileImages: unknown[];
    /** The install each Containerfile was written for. */
    containerfileInstalls: unknown[];
    /** Roots `hostPnpmVersion` was asked about. */
    hostPnpmCalls: string[];
    contextExtensionFiles: (readonly string[])[];
    postCalls: number;
    streamCalls: number;
    pullCalls: number;
    signCalls: number;
    capturedFetchImpl?: typeof fetch;
    capturedPostBody?: {
      endpoint: string;
      buildTarget: string;
      tarballSha256: string;
    };
    capturedSignedMessage?: Uint8Array;
    onLogLines: string[];
  };
}

interface FixtureOptions {
  readonly indexOutcome?: LocalIndexResult;
  readonly postOutcome?: PostBuildResult;
  readonly terminal?: TerminalPayload;
  readonly serverIndexBytes?: Uint8Array;
  readonly serverIndexHash?: string;
  /** Set the terminal via idempotent replay on postBuild (no SSE). */
  readonly postReplay?: boolean;
  /** Skip the pull runner slot entirely — simulate CI without Docker. */
  readonly omitPullRunner?: boolean;
  /** What the host's `pnpm --version` gives (default 10.28.0), or why it fails. */
  readonly hostPnpm?: string | Error;
}

function makeFixtures(opts: FixtureOptions = {}): Fixtures {
  const state: Fixtures['state'] = {
    esbuildCalls: 0,
    containerfileCalls: 0,
    contextCalls: 0,
    tarCalls: 0,
    dockerBuilds: [],
    pullOptions: [],
    containerfileImages: [],
    containerfileInstalls: [],
    hostPnpmCalls: [],
    contextExtensionFiles: [],
    postCalls: 0,
    streamCalls: 0,
    pullCalls: 0,
    signCalls: 0,
    onLogLines: [],
  };
  const indexOutcome: LocalIndexResult =
    opts.indexOutcome ??
    ({
      kind: 'ok',
      packId: 'my-pack',
      packVersion: '0.1.0',
      counts: { tools: 1, guardrails: 0, agents: 0, flows: 0 },
      fileErrors: [],
      index: SAMPLE_INDEX,
    } as LocalIndexResult);

  const serverHash = opts.serverIndexHash ?? SAMPLE_INDEX_HASH_HEX;
  const defaultTerminal: TerminalPayload = opts.terminal ?? {
    status: 'completed',
    imageRef:
      'ghcr.io/acme/kindgi-pack-staging:abc@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    imageDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    indexJson: SAMPLE_INDEX,
    indexHash: serverHash,
    buildLogsUrl: '/v1/build/bld-xxx/stream',
  };

  const runners: BuildRunners = {
    runLocalIndexer: async (o) => {
      // Write the actual sample bytes to disk so the command's
      // `readFile(expectedIndexPath)` for the integrity check gets a
      // matching hash.
      await writeFile(o.outputPath, SAMPLE_INDEX_BYTES);
      return indexOutcome;
    },
    esbuildBundle: async () => {
      state.esbuildCalls += 1;
      const res: EsbuildBundleResult = {
        emitted: ['dist/tools/echo/index.mjs', 'dist/kindgi-index.mjs'],
        totalBytes: 2048,
        externals: [],
        bundleMap: { 'tools/echo/index.ts': 'tools/echo/index.mjs' },
      };
      return res;
    },
    writeContainerfile: async (o) => {
      state.containerfileCalls += 1;
      state.containerfileImages.push(o.image);
      state.containerfileInstalls.push(o.install);
      // Actually write it — the tarPack step reads the file.
      await writeFile(o.outputPath, '# fake containerfile\n', 'utf8');
    },
    writeContext: async (o) => {
      state.contextCalls += 1;
      state.contextExtensionFiles.push(o.extensionFiles);
      await mkdir(o.contextDir, { recursive: true });
    },
    dockerBuild: async (o) => {
      state.dockerBuilds.push(o);
      o.onLog?.('#1 [system] FROM node');
      return o.push === true
        ? { kind: 'ok', imageId: PUSHED_DIGEST, digest: PUSHED_DIGEST }
        : { kind: 'ok', imageId: 'sha256:feedfacefeedfacefeedfacefeedface' };
    },
    tarPack: async (o) => {
      state.tarCalls += 1;
      const bytes = new TextEncoder().encode('fake-tarball-bytes');
      await writeFile(o.outputPath, bytes);
      const res: TarPackResult = { path: o.outputPath, bytes, size: bytes.length };
      return res;
    },
    postBuild: async (o) => {
      state.postCalls += 1;
      state.capturedPostBody = {
        endpoint: o.endpoint,
        buildTarget: o.buildTarget,
        tarballSha256: o.tarballSha256,
      };
      state.capturedFetchImpl = o.fetchImpl;
      if (opts.postOutcome !== undefined) return opts.postOutcome;
      const res: PostBuildResult = opts.postReplay
        ? {
            buildJobId: 'bld-idempotent',
            status: 'completed',
            buildLogsUrl: '/v1/build/bld-idempotent/stream',
            terminal: defaultTerminal,
          }
        : {
            buildJobId: 'bld-xxx',
            status: 'queued',
            buildLogsUrl: '/v1/build/bld-xxx/stream',
          };
      return res;
    },
    streamBuildLogs: async (o) => {
      state.streamCalls += 1;
      o.onLog('docker buildx running');
      o.onLog('pushing image');
      return defaultTerminal;
    },
    hostPnpmVersion: async (root) => {
      state.hostPnpmCalls.push(root);
      if (opts.hostPnpm instanceof Error) throw opts.hostPnpm;
      return opts.hostPnpm ?? '10.28.0';
    },
    signEnvelope: async (o) => {
      state.signCalls += 1;
      state.capturedSignedMessage = o.message;
      const res: SignResult = {
        signatureBase64:
          'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n',
      };
      return res;
    },
  };

  if (!opts.omitPullRunner) {
    (runners as { pullImageIndex?: BuildRunners['pullImageIndex'] }).pullImageIndex = async (o) => {
      state.pullCalls += 1;
      state.pullOptions.push({
        imageRef: o.imageRef,
        pull: o.pull,
        ...(o.platform !== undefined && { platform: o.platform }),
      });
      const res: PullImageIndexResult = {
        bytes: opts.serverIndexBytes ?? SAMPLE_INDEX_BYTES,
      };
      return res;
    };
  }

  return { runners, state };
}

// ---------- runCli helper ----------

function baseInputs(
  fixtures: Fixtures,
  extra: Partial<RunCliInputs> = {},
  overrides: Record<string, unknown> = {},
): RunCliInputs {
  return {
    argv: [],
    env: { KINDGI_TENANT_ID: 'env-tenant' },
    cwd,
    home,
    buildRunners: fixtures.runners,
    buildConfigLoader: async () => testConfig(overrides),
    ...extra,
  };
}

// ---------- tests ----------

describe('kindgi build — argument resolution', () => {
  test('resolves --env=staging block from kindgi.config.ts', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.capturedPostBody?.endpoint).toBe('https://build.staging.example.com');
    expect(fixtures.state.capturedPostBody?.buildTarget).toBe('staging');
  });

  test('--endpoint flag overrides the env block build URL', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: [
        'build',
        '--env=staging',
        '--endpoint=https://override.example.com',
        `--path=${packDir}`,
      ],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.capturedPostBody?.endpoint).toBe('https://override.example.com');
  });

  test('missing endpoint (no env block, no flag) → clear error', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=nonexistent', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('could not resolve a build-server endpoint');
  });

  test('missing tenantId (unknown env, no env var, no flag) → clear error', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }),
      argv: [
        'build',
        '--env=nonexistent',
        '--endpoint=https://build.example.com',
        `--path=${packDir}`,
      ],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('could not resolve a tenantId');
  });

  test('KINDGI_TENANT_ID env var provides tenantId when env block is absent', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: { KINDGI_TENANT_ID: 'via-env-var' } }),
      argv: [
        'build',
        '--env=nonexistent',
        '--endpoint=https://build.example.com',
        `--path=${packDir}`,
        '--skip-sign',
      ],
    });
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as { tenantId?: string };
    // Signature body contains tenantId when we did sign; when we
    // --skip-sign the summary shows tenantId=... via the envelope.
    // We assert via reading the envelope file directly:
    void summary;
    const envelope = JSON.parse(
      await readFile(join(packDir, '.kindgi/build/deploy-envelope.json'), 'utf8'),
    ) as { tenantId: string };
    expect(envelope.tenantId).toBe('via-env-var');
  });
});

describe('kindgi build — pipeline stages fire in order', () => {
  test('happy path: esbuild → indexer → containerfile → context → tar → post → stream → sign → envelope', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.esbuildCalls).toBe(1);
    expect(fixtures.state.containerfileCalls).toBe(1);
    expect(fixtures.state.contextCalls).toBe(1);
    expect(fixtures.state.tarCalls).toBe(1);
    expect(fixtures.state.postCalls).toBe(1);
    expect(fixtures.state.streamCalls).toBe(1);
    expect(fixtures.state.signCalls).toBe(1);
    expect(fixtures.state.dockerBuilds).toEqual([]);
    // Pull runner fires once because integrity gate is on + docker is
    // available (fake).
    expect(fixtures.state.pullCalls).toBe(1);

    // Deploy envelope written to disk.
    const envelopePath = join(packDir, '.kindgi/build/deploy-envelope.json');
    const raw = await readFile(envelopePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      readonly $schema: string;
      readonly imageRef: string;
      readonly signature?: string;
      readonly signerKeyId?: string;
      readonly indexHash: string;
      readonly tenantId: string;
    };
    expect(parsed.$schema).toBe('kindgi-deploy-envelope/v1');
    expect(parsed.imageRef).toContain('ghcr.io/acme/');
    expect(parsed.signature).toBeTruthy();
    expect(parsed.signerKeyId).toBeTruthy();
    expect(parsed.tenantId).toBe('tenant-acme-staging');
  });

  test('idempotent replay short-circuits the SSE stream step', async () => {
    const fixtures = makeFixtures({ postReplay: true });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    // POST fired; stream did NOT.
    expect(fixtures.state.postCalls).toBe(1);
    expect(fixtures.state.streamCalls).toBe(0);
    // Sign still fires because we have a terminal payload.
    expect(fixtures.state.signCalls).toBe(1);
  });
});

describe('kindgi build — integrity gate', () => {
  test('hash mismatch → refuses to sign', async () => {
    const fixtures = makeFixtures({ serverIndexHash: 'sha256:beef' });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Integrity gate FAILED');
    expect(out.stderr).toContain('indexHash mismatch');
    expect(fixtures.state.signCalls).toBe(0);
  });

  test('byte-level diff (hash matches but bytes diverge) → refuses to sign', async () => {
    const differentBytes = new TextEncoder().encode('{"tampered":true}');
    const fixtures = makeFixtures({ serverIndexBytes: differentBytes });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Integrity gate FAILED');
    expect(out.stderr).toContain('byte-level diff');
    expect(fixtures.state.signCalls).toBe(0);
  });

  test('--skip-image-pull → hash-only comparison, still signs on hash match', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', '--skip-image-pull', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.pullCalls).toBe(0);
    expect(fixtures.state.signCalls).toBe(1);
    expect(out.stderr).toContain('Image pull SKIPPED');
  });

  test('--skip-integrity-gate → warns loud, still signs, bypasses both diff paths', async () => {
    const fixtures = makeFixtures({ serverIndexHash: 'sha256:beef' });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', '--skip-integrity-gate', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.pullCalls).toBe(0);
    expect(fixtures.state.signCalls).toBe(1);
    expect(out.stderr).toContain('Integrity gate SKIPPED');
    expect(out.stderr).toContain('NOT RECOMMENDED');
  });

  test('CI without pullImageIndex runner defaults to hash-only', async () => {
    const fixtures = makeFixtures({ omitPullRunner: true });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.signCalls).toBe(1);
    expect(out.stderr).toContain('Image pull SKIPPED');
  });
});

describe('kindgi build — signing surface', () => {
  test('signs the canonicalised body (sorted-key JSON, five fields)', async () => {
    const fixtures = makeFixtures();
    await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(fixtures.state.capturedSignedMessage).toBeDefined();
    const text = new TextDecoder().decode(fixtures.state.capturedSignedMessage);
    // Sorted keys: artifactVersion, imageDigest, indexHash, publishedAt, tenantId.
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      'artifactVersion',
      'imageDigest',
      'indexHash',
      'publishedAt',
      'tenantId',
    ]);
    expect(parsed.tenantId).toBe('tenant-acme-staging');
    expect(parsed.publishedAt).toBe('1970-01-01T00:00:00.000Z');
    // Key order in the raw string is sorted (canonical stringify).
    expect(text.indexOf('artifactVersion')).toBeLessThan(text.indexOf('imageDigest'));
    expect(text.indexOf('imageDigest')).toBeLessThan(text.indexOf('indexHash'));
    expect(text.indexOf('publishedAt')).toBeLessThan(text.indexOf('tenantId'));
  });

  test('--skip-sign emits an unsigned envelope with big warning', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', '--skip-sign', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(fixtures.state.signCalls).toBe(0);
    expect(out.stderr).toContain('Signing SKIPPED');

    const envelope = JSON.parse(
      await readFile(join(packDir, '.kindgi/build/deploy-envelope.json'), 'utf8'),
    ) as { signature?: string; signerKeyId?: string };
    expect(envelope.signature).toBeUndefined();
    expect(envelope.signerKeyId).toBeUndefined();
  });
});

describe('kindgi build — indexer + terminal failures', () => {
  test('local indexer failure aborts before POST', async () => {
    const fixtures = makeFixtures({
      indexOutcome: {
        kind: 'err',
        code: 'discovery-empty',
        message: 'no files under tools/',
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Local indexer failed');
    expect(out.stderr).toContain('discovery-empty');
    expect(fixtures.state.postCalls).toBe(0);
    expect(fixtures.state.signCalls).toBe(0);
  });

  test('build server terminal.status=failed → command exits 1 with server error surfaced', async () => {
    const fixtures = makeFixtures();
    // Replace stream runner to emit a failure terminal. Fields on the
    // `BuildRunners` interface are readonly by design; construct a
    // fresh runners object with the override applied to keep the seam
    // contract enforced.
    const overriddenRunners: BuildRunners = {
      ...fixtures.runners,
      streamBuildLogs: vi.fn(async (o) => {
        o.onLog('build starting');
        return {
          status: 'failed',
          error: { code: 'docker-build-failed', message: 'buildx returned non-zero' },
        } satisfies TerminalPayload;
      }),
    };
    fixtures.runners = overriddenRunners;
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Build failed');
    expect(out.stderr).toContain('docker-build-failed');
    expect(fixtures.state.signCalls).toBe(0);
  });
});

describe('kindgi build — output shape', () => {
  test('JSON summary on stdout includes buildJobId, imageRef, indexHash, signerKeyId', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    const summary = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(summary.buildJobId).toBe('bld-xxx');
    expect(summary.imageRef).toContain('ghcr.io/acme/');
    expect(summary.indexHash).toBe(SAMPLE_INDEX_HASH_HEX);
    expect(summary.signed).toBe(true);
    expect(summary.signerKeyId).toBeTruthy();
    expect(summary.envelopePath).toContain('deploy-envelope.json');
    expect(summary.indexCounts).toEqual({ tools: 1, guardrails: 0, agents: 0, flows: 0 });
  });

  test('banner to stderr shows Environment, Build, Target, Signing key', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.stderr).toContain('Environment: staging');
    expect(out.stderr).toContain('Build:       https://build.staging.example.com');
    expect(out.stderr).toContain('Target:      staging');
    expect(out.stderr).toContain('Signing key:');
    expect(out.stderr).toContain('Deploy envelope written to');
  });
});

describe('kindgi build — a Python pack', () => {
  async function pythonPack(withLock = true): Promise<void> {
    await rm(join(packDir, 'kindgi.config.ts'));
    await rm(join(packDir, 'package.json'));
    await rm(join(packDir, 'package-lock.json'));
    await writeFile(
      join(packDir, 'pyproject.toml'),
      '[tool.kindgi.pack]\nid = "my-pack"\nversion = "0.1.0"\n',
      'utf8',
    );
    if (withLock) await writeFile(join(packDir, 'uv.lock'), 'version = 1\n', 'utf8');
    await mkdir(join(packDir, 'tools'), { recursive: true });
    await writeFile(join(packDir, 'tools', 'echo.py'), 'x = 1\n', 'utf8');
    await writeFile(join(packDir, '.env'), 'SECRET=1\n', 'utf8');
  }

  function withPython(fixtures: Fixtures) {
    const calls = {
      pythons: [] as (readonly string[])[],
      uvImages: [] as string[],
      files: [] as (readonly string[])[],
      contextDirs: [] as string[],
    };
    fixtures.runners = {
      ...fixtures.runners,
      python: {
        runLocalIndexer: async (o) => {
          calls.pythons.push(o.python);
          await writeFile(o.outputPath, SAMPLE_INDEX_BYTES);
          return {
            kind: 'ok',
            packId: 'my-pack',
            packVersion: '0.1.0',
            counts: { tools: 1, guardrails: 0, agents: 0, flows: 0 },
            fileErrors: [],
            index: SAMPLE_INDEX,
          };
        },
        writeContainerfile: async (o) => {
          calls.uvImages.push(o.uvImageRef);
          await writeFile(o.outputPath, '# python containerfile\n', 'utf8');
        },
        writeContext: async (o) => {
          calls.files.push(o.files);
          calls.contextDirs.push(o.contextDir);
        },
      },
    };
    return calls;
  }

  test("indexes with the pack's Python, ships the pack root, then builds, checks and signs as any pack", async () => {
    await pythonPack();
    const fixtures = makeFixtures();
    const calls = withPython(fixtures);
    const out = await runCli({
      ...baseInputs(fixtures, {}, { language: 'python', dev: { python: ['/opt/py/bin/python'] } }),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(calls.pythons).toEqual([['/opt/py/bin/python']]);
    expect(calls.uvImages).toEqual([DEFAULT_UV_IMAGE_REF]);
    expect(calls.files).toEqual([['pyproject.toml', 'tools/echo.py', 'uv.lock']]);
    expect(calls.contextDirs).toEqual([join(packDir, '.kindgi/build/context')]);
    expect(fixtures.state.esbuildCalls).toBe(0);
    // Its context is tarred as a TypeScript pack's is.
    expect(fixtures.state.tarCalls).toBe(1);
    expect(fixtures.state.postCalls).toBe(1);
    expect(fixtures.state.pullCalls).toBe(1);
    expect(fixtures.state.signCalls).toBe(1);
  });

  test('without uv.lock the build stops before uploading', async () => {
    await pythonPack(false);
    const fixtures = makeFixtures();
    withPython(fixtures);
    const out = await runCli({
      ...baseInputs(fixtures, {}, { language: 'python', dev: { python: ['/opt/py/bin/python'] } }),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('uv lock');
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('--local builds its context with Docker, checks the image index, and says how to run it', async () => {
    await pythonPack();
    const fixtures = makeFixtures();
    const calls = withPython(fixtures);
    const out = await runCli({
      ...baseInputs(
        fixtures,
        { env: {} },
        { language: 'python', dev: { python: ['/opt/py/bin/python'] }, environments: {} },
      ),
      argv: ['build', '--local', '--artifact-version=20261004.1', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls.pythons).toEqual([['/opt/py/bin/python']]);
    expect(fixtures.state.dockerBuilds).toHaveLength(1);
    expect(fixtures.state.dockerBuilds[0]).toMatchObject({
      tag: 'kindgi-pack/my-pack:20261004.1',
      contextDir: calls.contextDirs[0],
      secrets: [],
    });
    expect(fixtures.state.pullOptions).toEqual([
      { imageRef: 'kindgi-pack/my-pack:20261004.1', pull: false },
    ]);
    expect(fixtures.state.esbuildCalls).toBe(0);
    expect(fixtures.state.tarCalls).toBe(0);
    expect(fixtures.state.postCalls).toBe(0);
    expect(fixtures.state.signCalls).toBe(0);
    expect(out.stderr).toContain('matches the local index byte for byte');
    expect(out.stderr).toContain(`(the pack service: ${PYTHON_PACK_SERVICE_COMMAND.join(' ')})`);
  });

  test('--local --push pushes, gates on the pushed image, signs, and writes the envelope', async () => {
    await pythonPack();
    const fixtures = makeFixtures();
    withPython(fixtures);
    const out = await runCli({
      ...baseInputs(fixtures, {}, { language: 'python', dev: { python: ['/opt/py/bin/python'] } }),
      argv: [
        'build',
        '--local',
        '--push',
        '--env=staging',
        '--artifact-version=20261004.1',
        `--path=${packDir}`,
      ],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.dockerBuilds[0]).toMatchObject({
      tag: 'ghcr.io/acme/my-pack:20261004.1',
      platform: 'linux/amd64',
      push: true,
    });
    const imageRef = `ghcr.io/acme/my-pack@${PUSHED_DIGEST}`;
    expect(fixtures.state.pullOptions).toEqual([{ imageRef, pull: true, platform: 'linux/amd64' }]);
    expect(fixtures.state.signCalls).toBe(1);
    const envelope = JSON.parse(
      await readFile(join(packDir, '.kindgi/build/deploy-envelope.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      imageRef,
      imageDigest: PUSHED_DIGEST,
      artifactVersion: '20261004.1',
      indexHash: SAMPLE_INDEX_HASH_HEX,
    });
    expect(envelope.signature).toBeTruthy();
  });
});

describe('kindgi build --local', () => {
  test('builds with Docker — no build service, tenant or signing key — and checks the image index', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { environments: {} }),
      argv: ['build', '--local', '--artifact-version=20261002.1', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.dockerBuilds).toHaveLength(1);
    expect(fixtures.state.dockerBuilds[0]).toMatchObject({
      tag: 'kindgi-pack/my-pack:20261002.1',
      contextDir: join(packDir, '.kindgi/build/context'),
      secrets: [],
    });
    // The image is in the local store already: read, not pulled.
    expect(fixtures.state.pullOptions).toEqual([
      { imageRef: 'kindgi-pack/my-pack:20261002.1', pull: false },
    ]);
    expect(fixtures.state.postCalls).toBe(0);
    expect(fixtures.state.tarCalls).toBe(0);
    expect(fixtures.state.signCalls).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({
      imageRef: 'kindgi-pack/my-pack:20261002.1',
      local: true,
    });
    expect(out.stderr).toContain('matches the local index byte for byte');
    expect(out.stderr).toContain('docker run --rm -p 8080:8080');
  });

  test('a pack import its project lists only in devDependencies is refused before the image is built', async () => {
    await writeFile(
      join(packDir, 'package.json'),
      `${JSON.stringify({ name: 'test-pack', version: '0.1.0', devDependencies: { '@acme/db-client': '1.0.0' } })}\n`,
      'utf8',
    );
    const fixtures = makeFixtures();
    const runners: BuildRunners = {
      ...fixtures.runners,
      esbuildBundle: async (o) => ({
        ...(await fixtures.runners.esbuildBundle(o)),
        externals: ['@acme/db-client'],
      }),
    };
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { environments: {} }),
      buildRunners: runners,
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'The pack imports @acme/db-client, which package.json lists only in devDependencies',
    );
    expect(out.stderr).toContain('move it to dependencies');
    expect(fixtures.state.dockerBuilds).toHaveLength(0);
  });

  test('a module that fails to load locally fails the build, saying which', async () => {
    const fixtures = makeFixtures({
      indexOutcome: {
        kind: 'ok',
        packId: 'my-pack',
        packVersion: '0.1.0',
        counts: { tools: 0, guardrails: 0, agents: 0, flows: 0 },
        fileErrors: [
          {
            code: 'file-import-failed',
            message: 'Failed to import tools/echo/index.ts: Error: boom',
            filePath: 'tools/echo/index.ts',
          },
        ],
        index: SAMPLE_INDEX,
      } as LocalIndexResult,
    });
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { environments: {} }),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('[file-import-failed] Failed to import tools/echo/index.ts');
    expect(fixtures.state.dockerBuilds).toHaveLength(0);
  });

  test("the app's registry config reaches the install as a build secret", async () => {
    await writeFile(join(packDir, '.npmrc'), '//registry.example.com/:_authToken=x\n', 'utf8');
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.dockerBuilds[0]?.secrets).toEqual([
      { id: 'npmrc', src: join(packDir, '.npmrc') },
    ]);
  });

  test("an image whose index isn't the local one fails the build", async () => {
    const fixtures = makeFixtures({
      serverIndexBytes: new TextEncoder().encode('{"v":1,"packId":"other"}'),
    });
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Integrity gate FAILED: the image's index isn't the local one");
  });

  describe('pnpm: the image installs with the pnpm that wrote the lockfile', () => {
    const usePnpm = async (manifest: Record<string, unknown>): Promise<void> => {
      await rm(join(packDir, 'package-lock.json'));
      await writeFile(join(packDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n", 'utf8');
      await writeFile(
        join(packDir, 'package.json'),
        `${JSON.stringify({ name: 'test-pack', version: '0.1.0', ...manifest })}\n`,
        'utf8',
      );
    };

    test("no packageManager: the host's pnpm version, named in the plan", async () => {
      await usePnpm({});
      const fixtures = makeFixtures({ hostPnpm: '10.28.0' });
      const out = await runCli({
        ...baseInputs(fixtures),
        argv: ['build', '--local', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(0);
      expect(fixtures.state.hostPnpmCalls).toEqual([packDir]);
      expect(fixtures.state.containerfileInstalls).toEqual([
        expect.objectContaining({ manager: 'pnpm', hostPnpm: '10.28.0' }),
      ]);
      expect(out.stderr).toContain(
        "Install:     pnpm@10.28.0 (the host's; no packageManager) from pnpm-lock.yaml",
      );
    });

    test('a packageManager wins: the host is not asked', async () => {
      await usePnpm({ packageManager: 'pnpm@12.9.1' });
      const fixtures = makeFixtures();
      const out = await runCli({
        ...baseInputs(fixtures),
        argv: ['build', '--local', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(0);
      expect(fixtures.state.hostPnpmCalls).toEqual([]);
      expect(fixtures.state.containerfileInstalls).toEqual([
        expect.not.objectContaining({ hostPnpm: expect.anything() }),
      ]);
      expect(out.stderr).toContain('Install:     pnpm@12.9.1 from pnpm-lock.yaml');
    });

    test("the host's pnpm version can't be read: refused, saying how to pin it", async () => {
      await usePnpm({});
      const fixtures = makeFixtures({ hostPnpm: new Error('spawn pnpm ENOENT') });
      const out = await runCli({
        ...baseInputs(fixtures),
        argv: ['build', '--local', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `package.json has no packageManager, and kindgi build couldn't read the pnpm version here (pnpm --version in ${packDir}: spawn pnpm ENOENT).`,
      );
      expect(out.stderr).toContain('Add "packageManager": "pnpm@<version>"');
      expect(fixtures.state.esbuildCalls).toBe(0);
      expect(fixtures.state.dockerBuilds).toEqual([]);
    });

    test('a version that is not one is refused too', async () => {
      await usePnpm({});
      const fixtures = makeFixtures({ hostPnpm: 'command not found' });
      const out = await runCli({
        ...baseInputs(fixtures),
        argv: ['build', '--local', `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain('printed "command not found", not a version');
    });
  });

  test('a pack with no lockfile is refused before anything builds', async () => {
    await rm(join(packDir, 'package-lock.json'));
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('No lockfile at or above');
    expect(fixtures.state.esbuildCalls).toBe(0);
    expect(fixtures.state.dockerBuilds).toEqual([]);
  });
});

describe('kindgi build — image extensions', () => {
  const prismaImage = {
    image: {
      extensions: [
        {
          name: 'prisma',
          contextFiles: ['prisma/schema.prisma'],
          postInstall: [{ bin: 'prisma', args: ['generate', '--schema', 'prisma/schema.prisma'] }],
        },
      ],
    },
  };

  test("the config's image reaches the Containerfile and the context", async () => {
    await mkdir(join(packDir, 'prisma'), { recursive: true });
    await writeFile(join(packDir, 'prisma', 'schema.prisma'), 'generator client {}\n', 'utf8');
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, {}, prismaImage),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.containerfileImages).toEqual([
      {
        systemPackages: [],
        buildEnv: {},
        contextFiles: ['prisma/schema.prisma'],
        steps: [
          {
            extension: 'prisma',
            bin: 'prisma',
            args: ['generate', '--schema', 'prisma/schema.prisma'],
          },
        ],
        extensions: ['prisma'],
      },
    ]);
    expect(fixtures.state.contextExtensionFiles).toEqual([['prisma/schema.prisma']]);
    expect(out.stderr).toContain('Image:       prisma extension');
  });

  test("an extension's missing file, or a malformed image, fails before anything builds", async () => {
    const fixtures = makeFixtures();
    const missing = await runCli({
      ...baseInputs(fixtures, {}, prismaImage),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("prisma/schema.prisma (an extension's file) doesn't exist");
    const malformed = await runCli({
      ...baseInputs(fixtures, {}, { image: { systemPackages: 'jq' } }),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain('image.systemPackages');
    expect(fixtures.state.esbuildCalls).toBe(0);
  });
});

describe('kindgi build --local --push', () => {
  test('builds for linux/amd64, pushes, gates on the pushed digest, signs, and writes the envelope', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: [
        'build',
        '--local',
        '--push',
        '--env=staging',
        '--artifact-version=20261003.1',
        `--path=${packDir}`,
      ],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    // The repository: the env block's registry plus the pack id.
    expect(fixtures.state.dockerBuilds[0]).toMatchObject({
      tag: 'ghcr.io/acme/my-pack:20261003.1',
      platform: 'linux/amd64',
      push: true,
    });
    const imageRef = `ghcr.io/acme/my-pack@${PUSHED_DIGEST}`;
    expect(fixtures.state.pullOptions).toEqual([{ imageRef, pull: true, platform: 'linux/amd64' }]);
    expect(fixtures.state.signCalls).toBe(1);
    expect(fixtures.state.postCalls).toBe(0);
    const envelope = JSON.parse(
      await readFile(join(packDir, '.kindgi/build/deploy-envelope.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      $schema: 'kindgi-deploy-envelope/v1',
      imageRef,
      imageDigest: PUSHED_DIGEST,
      artifactVersion: '20261003.1',
      indexHash: SAMPLE_INDEX_HASH_HEX,
      tenantId: 'tenant-acme-staging',
    });
    expect(envelope.signature).toBeTruthy();
    expect(envelope).not.toHaveProperty('buildLogsUrl');
    expect(JSON.parse(out.stdout)).toMatchObject({
      imageRef,
      imageDigest: PUSHED_DIGEST,
      signed: true,
    });
    expect(out.stderr).toContain('kindgi deploy --env=staging');
  });

  test('--push=<repository> and --platform override the defaults', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: [
        'build',
        '--local',
        '--push=registry.example.com/team/app',
        '--platform=linux/arm64',
        '--env=staging',
        `--path=${packDir}`,
      ],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.dockerBuilds[0]).toMatchObject({ platform: 'linux/arm64', push: true });
    expect(fixtures.state.dockerBuilds[0]?.tag.startsWith('registry.example.com/team/app:')).toBe(
      true,
    );
  });

  test('refused: --push without --local, or with no repository to push to', async () => {
    const fixtures = makeFixtures();
    const remote = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--push', '--env=staging', `--path=${packDir}`],
    });
    expect(remote.exitCode).toBe(1);
    expect(remote.stderr).toContain('--push goes with --local');
    const noRegistry = await runCli({
      ...baseInputs(fixtures, {}, { environments: { staging: { tenantId: 't' } } }),
      argv: ['build', '--local', '--push', '--env=staging', `--path=${packDir}`],
    });
    expect(noRegistry.exitCode).toBe(1);
    expect(noRegistry.stderr).toContain('set environments.staging.registry');
    expect(fixtures.state.dockerBuilds).toEqual([]);
  });

  test('without --push, --local still loads the image and writes no envelope', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.dockerBuilds[0]).not.toHaveProperty('push');
    expect(fixtures.state.dockerBuilds[0]).not.toHaveProperty('platform');
    expect(fixtures.state.signCalls).toBe(0);
  });
});
