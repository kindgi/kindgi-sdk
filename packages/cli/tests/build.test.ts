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

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { KindgiClient } from '@kindgi/client';

import { BuildServiceRefusal, PACK_IMAGE_DOCS_URL } from '../src/build/hosted.js';
import {
  DEFAULT_JAVA_BUILD_IMAGE_REF,
  DEFAULT_JAVA_RUNTIME_IMAGE_REF,
  JAVA_PACK_SERVICE_COMMAND,
} from '../src/build/java-image.js';
import type { LoadedInstallOptions, LoadedInstallOutcome } from '../src/build/loaded-install.js';
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
import {
  DEFAULT_SCALA_BUILD_IMAGE_REF,
  SCALA_PACK_SERVICE_COMMAND,
} from '../src/build/scala-image.js';
import { cliPinWarning } from '../src/cli-pin.js';
import { buildTimeDefaults } from '../src/commands/build.js';
import { loadEnvelopeReal } from '../src/deploy/envelope-loader.js';
import type { DeployRunners } from '../src/deploy/runners.js';
import { type RunCliInputs, runCli } from '../src/main.js';
import { CLI_VERSION } from '../src/version-info.js';
import { fakeRateLimitWaits } from './rate-limit-waits.js';

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
    /** The install each context was written for. */
    contextInstalls: unknown[];
    /** Roots `hostPnpmVersion` was asked about. */
    hostPnpmCalls: string[];
    /** What `loadedInstall` was asked to cut down. */
    loadedInstallCalls: LoadedInstallOptions[];
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
      authorization?: string | undefined;
      packId?: string | undefined;
      projectId?: string | undefined;
    };
    /** The `authorization` each stream was opened with. */
    streamAuthorizations: (string | undefined)[];
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
  /** Thrown by the first `postBuild` calls, in order; later calls answer as usual. */
  readonly postThrows?: readonly unknown[];
  /** Thrown by `streamBuildLogs`. */
  readonly streamThrows?: unknown;
  /** The packed pack's size, in bytes (default: a few bytes). */
  readonly tarballSize?: number;
  /** What `loadedInstall` answers (default: the install, cut down to 3 of 9 packages). */
  readonly loadedInstall?: LoadedInstallOutcome;
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
    contextInstalls: [],
    hostPnpmCalls: [],
    loadedInstallCalls: [],
    contextExtensionFiles: [],
    postCalls: 0,
    streamCalls: 0,
    pullCalls: 0,
    signCalls: 0,
    onLogLines: [],
    streamAuthorizations: [],
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
      state.contextInstalls.push(o.install);
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
      const bytes =
        opts.tarballSize !== undefined
          ? new Uint8Array(opts.tarballSize)
          : new TextEncoder().encode('fake-tarball-bytes');
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
        authorization: o.authorization,
        packId: o.packId,
        projectId: o.projectId,
      };
      state.capturedFetchImpl = o.fetchImpl;
      const thrown = opts.postThrows?.[state.postCalls - 1];
      if (thrown !== undefined) throw thrown;
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
      state.streamAuthorizations.push(o.authorization);
      if (opts.streamThrows !== undefined) throw opts.streamThrows;
      o.onLog('docker buildx running');
      o.onLog('pushing image');
      return defaultTerminal;
    },
    hostPnpmVersion: async (root) => {
      state.hostPnpmCalls.push(root);
      if (opts.hostPnpm instanceof Error) throw opts.hostPnpm;
      return opts.hostPnpm ?? '10.28.0';
    },
    loadedInstall: async (o) => {
      state.loadedInstallCalls.push(o);
      return (
        opts.loadedInstall ?? {
          kind: 'reduced',
          install: {
            ...o.install,
            workspace: false,
            reduced: {
              written: { 'package.json': '{}\n' },
              copied: [],
              kept: 3,
              total: 9,
              leftOut: ['next'],
            },
          },
        }
      );
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

  test('--out inside the pack root is accepted', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', '--out=inside-out', `--path=${packDir}`],
    });
    expect(out.stderr).not.toContain('outside the pack root');
    expect(out.exitCode).toBe(0);
  });

  test('--out outside the pack root is refused', async () => {
    const fixtures = makeFixtures();
    const outside = join(cwd, 'outside-out');
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--out=${outside}`, `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('outside the pack root');
  });

  test('--out via an in-pack symlink that escapes the pack root is refused', async () => {
    const fixtures = makeFixtures();
    const target = join(cwd, 'symlink-target');
    await mkdir(target, { recursive: true });
    const link = join(packDir, 'escape');
    await symlink(target, link);
    const out = await runCli({
      ...baseInputs(fixtures),
      // `escape` is lexically inside packDir; only resolving the symlink
      // reveals it points outside — a lexical-only check would accept it.
      argv: ['build', '--env=staging', `--out=${link}`, `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('outside the pack root');
  });

  test('--out via a dangling in-pack symlink pointing outside the pack root is refused', async () => {
    const fixtures = makeFixtures();
    // A symlink inside the pack whose target does NOT exist and points
    // outside: realpath can't resolve it, so only reading the link (not an
    // opaque ENOENT, not a lexical in-pack check) reveals the escape.
    const link = join(packDir, 'dangle');
    await symlink(join(cwd, 'dangling-target'), link);
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--out=${link}`, `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('outside the pack root');
  });

  test('--out equal to the pack root is refused', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--out=${packDir}`, `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('is the pack root');
  });
});

describe('kindgi build --hosted', () => {
  const API = 'https://platform.example.com';
  const KEY = 'kgi_tk_test-key';
  /** The CLI's API URL and key, as `kindgi auth login` or the env gives them. */
  const loggedIn = { KINDGI_API_URL: API, KINDGI_API_TOKEN: KEY };
  /** A Kindgi Cloud env block: no `endpoint`, as the API is the CLI's own address. */
  const cloud = (): Record<string, unknown> => ({
    environments: {
      staging: { signingKey: join(home, 'signing-key.pem'), tenantId: 'tenant-acme-staging' },
    },
  });
  /** A client whose `whoami` names the key's tenant. */
  const whoamiClient =
    (calls: { url: string; token: string }[]) => (url: string, token: string) => {
      calls.push({ url, token });
      return {
        identity: { whoami: async () => ({ tenantId: 'tenant-of-the-key', userId: 'u-1' }) },
      } as unknown as KindgiClient;
    };

  test("builds at the API's /cloud with the key, the pack's id and the project label, checked by hash", async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: { ...loggedIn, KINDGI_TENANT_ID: 'env-tenant' } }, cloud()),
      argv: ['build', '--hosted', '--project=p-1', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    // The CLI's own address is the API.
    expect(fixtures.state.capturedPostBody).toMatchObject({
      endpoint: `${API}/cloud`,
      authorization: `Bearer ${KEY}`,
      packId: 'my-pack',
      projectId: 'p-1',
    });
    expect(fixtures.state.streamAuthorizations).toEqual([`Bearer ${KEY}`]);
    // The image stays in the workspace's repository: no pull.
    expect(fixtures.state.pullCalls).toBe(0);
    expect(out.stderr).toContain(`Build:       hosted (${API}/cloud)`);
  });

  test("the env block's `build: 'hosted'` is the same; a self-hosted build server never gets the key", async () => {
    const hosted = makeFixtures();
    const out = await runCli({
      ...baseInputs(
        hosted,
        { env: loggedIn },
        {
          environments: {
            staging: {
              endpoint: API,
              build: 'hosted',
              signingKey: join(home, 'signing-key.pem'),
              tenantId: 't-1',
            },
          },
        },
      ),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(hosted.state.capturedPostBody).toMatchObject({
      endpoint: `${API}/cloud`,
      authorization: `Bearer ${KEY}`,
    });

    const selfHosted = makeFixtures();
    const plain = await runCli({
      ...baseInputs(selfHosted, { env: loggedIn }),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(plain.exitCode, plain.stderr).toBe(0);
    expect(selfHosted.state.capturedPostBody).toMatchObject({
      endpoint: 'https://build.staging.example.com',
      authorization: undefined,
      packId: undefined,
    });
    expect(selfHosted.state.streamAuthorizations).toEqual([undefined]);
  });

  test("--env=prod with prod's `build: 'hosted'` and no `kindgi dev` file here: hosted, the env block read all the same", async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(
        fixtures,
        { env: loggedIn },
        {
          environments: {
            prod: { build: 'hosted', signingKey: join(home, 'signing-key.pem'), tenantId: 't-1' },
          },
        },
      ),
      argv: ['build', '--env=prod', `--path=${packDir}`],
    });
    expect(existsSync(join(cwd, '.kindgirc.json'))).toBe(false);
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.capturedPostBody).toMatchObject({
      endpoint: `${API}/cloud`,
      authorization: `Bearer ${KEY}`,
    });
    expect(out.stderr).toContain(`Build:       hosted (${API}/cloud)`);
  });

  test("an env block's `endpoint` other than the CLI's own address is refused, naming both; nothing is built", async () => {
    const STAGING = 'https://api.staging.example.com';
    for (const [env, flags, from] of [
      [loggedIn, [], 'from KINDGI_API_URL'],
      [{ KINDGI_API_TOKEN: KEY }, [`--url=${API}`], 'from --url'],
    ] as const) {
      const fixtures = makeFixtures();
      const out = await runCli({
        ...baseInputs(fixtures, { env }),
        argv: ['build', '--hosted', '--env=staging', `--path=${packDir}`, ...flags],
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `kindgi build --hosted sends your API key to ${API}, the address it's for (${from}), and environments.staging.endpoint names another: ${STAGING}. The key goes only to its own address: remove environments.staging.endpoint (Kindgi Cloud needs none), or sign in to ${STAGING} with \`kindgi auth login --url ${STAGING} --token <its key>\`.`,
      );
      expect(fixtures.state.esbuildCalls).toBe(0);
      expect(fixtures.state.postCalls).toBe(0);
    }
  });

  test.each([
    'https://PLATFORM.Example.com',
    'https://platform.example.com:443',
    'https://platform.example.com/',
  ])('an env block `endpoint` of %s is the same address: built there', async (endpoint) => {
    const fixtures = makeFixtures();
    const block = { endpoint, signingKey: join(home, 'signing-key.pem'), tenantId: 't-1' };
    const out = await runCli({
      ...baseInputs(fixtures, { env: loggedIn }, { environments: { staging: block } }),
      argv: ['build', '--hosted', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.capturedPostBody?.endpoint).toBe(`${API}/cloud`);
  });

  test("with no API address set it stops before building; the env block's `endpoint` isn't taken for one", async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: { KINDGI_API_TOKEN: KEY } }),
      argv: ['build', '--hosted', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'kindgi build --hosted goes to the API your key is for, and no API address is set. Run `kindgi auth login --url <url> --token <its key>`, export KINDGI_API_URL, or pass --url <url>.',
    );
    expect(fixtures.state.esbuildCalls).toBe(0);
    expect(fixtures.state.postCalls).toBe(0);
  });

  test.each([
    [
      [],
      'prod',
      'pass --signing-key ~/.kindgi/keys/<id>.pem, or set signingKey in an env block of kindgi.config.ts and pick that block with --env=<name> (with no --env, the block is `staging`)',
    ],
    [
      ['--env=prod'],
      'prod',
      'set environments.prod.signingKey to ~/.kindgi/keys/<id>.pem in kindgi.config.ts, or pass --signing-key ~/.kindgi/keys/<id>.pem',
    ],
    [
      [],
      'staging',
      'set environments.staging.signingKey to ~/.kindgi/keys/<id>.pem in kindgi.config.ts, or pass --signing-key ~/.kindgi/keys/<id>.pem',
    ],
  ])(
    "no key, flags %j, and only a `%s` block: the hint names the block picked, never one that isn't there",
    async (flags, block, hint) => {
      const fixtures = makeFixtures();
      const out = await runCli({
        ...baseInputs(
          fixtures,
          { env: { ...loggedIn, KINDGI_TENANT_ID: 'env-tenant' } },
          { environments: { [block]: { build: 'hosted', tenantId: 't-1' } } },
        ),
        argv: ['build', '--hosted', ...flags, `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(`(once). Then ${hint}. (--skip-sign`);
      expect(fixtures.state.postCalls).toBe(0);
    },
  );

  describe('with a stored key', () => {
    const STORED = 'kgi_tk_stored';
    const OTHER = 'https://other.example.com';
    const homeFile = () => join(home, '.kindgi/config.json');
    const folderFile = () => join(cwd, '.kindgirc.json');
    async function store(path: string, saved: Record<string, unknown>) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(saved), 'utf8');
    }
    const hostedBuild = (fixtures: Fixtures, env: Record<string, string>, ...flags: string[]) =>
      runCli({
        ...baseInputs(fixtures, { env: { KINDGI_TENANT_ID: 'env-tenant', ...env } }, cloud()),
        argv: ['build', '--hosted', '--env=staging', `--path=${packDir}`, ...flags],
      });

    test.each([
      [{ KINDGI_API_URL: OTHER }, [], 'KINDGI_API_URL', undefined],
      [{}, [`--url=${OTHER}`], '--url', undefined],
      [{}, [], 'the apiUrl in <folder>', { apiUrl: OTHER }],
    ] as const)(
      "the CLI address elsewhere than the key's (%j %j) is refused, naming both; nothing is built",
      async (env, flags, named, folder) => {
        await store(homeFile(), { apiUrl: API, token: STORED });
        if (folder !== undefined) await store(folderFile(), folder);
        const where = named.replace('<folder>', folderFile());
        const fixtures = makeFixtures();
        const out = await hostedBuild(fixtures, env, ...flags);
        expect(out.exitCode).toBe(1);
        expect(out.stderr).toContain(
          `kindgi build --hosted would send the API key stored in ${homeFile()}, which is for ${API}, to ${OTHER}, which ${where} names. The key goes only to its own address: point ${where} at ${API}, or sign in to ${OTHER} with \`kindgi auth login --url ${OTHER} --token <its key>\`.`,
        );
        expect(fixtures.state.esbuildCalls).toBe(0);
        expect(fixtures.state.postCalls).toBe(0);
      },
    );

    test.each([
      { apiUrl: 'http://127.0.0.1:4000', token: 'kgi_tk_dev' },
      {
        apiUrl: 'http://192.168.1.20:4000',
        token: 'kgi_tk_dev',
        packServicePort: 4100,
        packServiceToken: 'kgi_ps_dev',
      },
    ])(
      "a `kindgi dev` runtime's .kindgirc.json (%j) isn't read: built at the signed-in address, with its key",
      async (devFile) => {
        await store(homeFile(), { apiUrl: API, token: STORED });
        await store(folderFile(), devFile);
        const fixtures = makeFixtures();
        const out = await hostedBuild(fixtures, {});
        expect(out.exitCode, out.stderr).toBe(0);
        expect(fixtures.state.capturedPostBody).toMatchObject({
          endpoint: `${API}/cloud`,
          authorization: `Bearer ${STORED}`,
        });
      },
    );
  });

  test("with no tenant set, the signature names the key's own tenant (whoami)", async () => {
    const fixtures = makeFixtures();
    const calls: { url: string; token: string }[] = [];
    const out = await runCli({
      ...baseInputs(
        fixtures,
        { env: loggedIn, clientFactory: whoamiClient(calls) },
        {
          environments: { staging: { endpoint: API, signingKey: join(home, 'signing-key.pem') } },
        },
      ),
      argv: ['build', '--hosted', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls).toEqual([{ url: API, token: KEY }]);
    expect(out.stderr).toContain('Tenant:      tenant-of-the-key');
  });

  test.each([
    [['--local'], '--local builds with this machine'],
    [['--endpoint=https://build.example.com'], '--endpoint names another build server'],
    [['--registry-push-creds=ref'], '--registry-push-creds is for a build server'],
  ])('--hosted with %s is refused, saying why', async (extra, why) => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: loggedIn }),
      argv: ['build', '--hosted', ...extra, '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(why);
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('--project without --hosted is refused', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: loggedIn }),
      argv: ['build', '--project=p-1', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('--project goes with --hosted');
  });

  test('without an API key it stops before building', async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: { KINDGI_API_URL: API } }, cloud()),
      argv: ['build', '--hosted', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('sends your API key to the build service, and none is set');
    expect(fixtures.state.tarCalls).toBe(0);
  });

  test('a pack over 30 MiB packed is never sent, and the message links what the image needs', async () => {
    const fixtures = makeFixtures({ tarballSize: 30 * 1024 * 1024 + 1 });
    const out = await runCli({
      ...baseInputs(fixtures, { env: loggedIn }, cloud()),
      argv: ['build', '--hosted', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "over the 30 MiB the hosted build service takes, so it wasn't sent",
    );
    expect(out.stderr).toContain(PACK_IMAGE_DOCS_URL);
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('a 429 with Retry-After is waited out and the build sent again', async () => {
    const fixtures = makeFixtures({
      postThrows: [new BuildServiceRefusal(429, 'rate-limit-exceeded', 'One build at a time.', 10)],
    });
    const waits = fakeRateLimitWaits();
    const out = await runCli({
      ...baseInputs(fixtures, { env: loggedIn, rateLimitWaits: waits.seam }, cloud()),
      argv: ['build', '--hosted', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.postCalls).toBe(2);
    expect(waits.sleeps).toEqual([10_000]);
  });

  test('any other refusal is printed plainly: its message, its code and the wait it asks', async () => {
    const fixtures = makeFixtures({
      postThrows: [
        new BuildServiceRefusal(503, 'build-queue-busy', 'The build queue is full.', 30),
      ],
    });
    const out = await runCli({
      ...baseInputs(fixtures, { env: loggedIn }, cloud()),
      argv: ['build', '--hosted', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'The build service refused the build (HTTP 503, build-queue-busy): The build queue is full. Try again in 30 s.',
    );
  });

  test("a refusal while following the build's log is printed the same way", async () => {
    const fixtures = makeFixtures({
      streamThrows: new BuildServiceRefusal(403, 'tenant-suspended', 'The workspace is suspended.'),
    });
    const out = await runCli({
      ...baseInputs(fixtures, { env: loggedIn }, cloud()),
      argv: ['build', '--hosted', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'The build service refused the build (HTTP 403, tenant-suspended): The workspace is suspended.',
    );
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
    // No build steps: the image installs production dependencies only.
    expect(out.stderr).toContain('    ✓ Install: production dependencies only\n');
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
    // No --signer-key-id and no `signerKeyId` in the env block: the key file's name.
    expect(parsed.signerKeyId).toBe('signing-key');
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
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T09:05:03.042Z'));
    try {
      await runCli({
        ...baseInputs(fixtures),
        argv: ['build', '--env=staging', `--path=${packDir}`],
      });
    } finally {
      vi.useRealTimers();
    }
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
    // Unpinned, the build server's build signs the build time too.
    expect(parsed.artifactVersion).toBe('20261008.090503');
    expect(parsed.publishedAt).toBe('2026-10-08T09:05:03.042Z');
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

  test('no key set: refused before anything is built, saying how to make and trust one; --skip-sign needs none', async () => {
    const noKey = {
      environments: {
        staging: {
          build: 'https://build.staging.example.com',
          registry: 'ghcr.io/acme',
          tenantId: 'tenant-acme-staging',
        },
      },
    };
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, {}, noKey),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "No signing key is set. Make a key with `kindgi key create <id>`, and add it to the runtime's trust list with `kindgi key trust <id>` (once). Then set environments.staging.signingKey to ~/.kindgi/keys/<id>.pem in kindgi.config.ts, or pass --signing-key ~/.kindgi/keys/<id>.pem.",
    );
    expect(fixtures.state.esbuildCalls).toBe(0);
    expect(fixtures.state.postCalls).toBe(0);

    const skipped = makeFixtures();
    const unsigned = await runCli({
      ...baseInputs(skipped, {}, noKey),
      argv: ['build', '--env=staging', '--skip-sign', `--path=${packDir}`],
    });
    expect(unsigned.exitCode, unsigned.stderr).toBe(0);
  });

  test.each([
    [[], 'environments.staging.signingKey', () => join(home, 'signing-key.pem')],
    [
      ['--signing-key=~/.kindgi/keys/acme-agency.pem'],
      '--signing-key',
      () => join(home, '.kindgi/keys/acme-agency.pem'),
    ],
    [['--local', '--push'], 'environments.staging.signingKey', () => join(home, 'signing-key.pem')],
  ])(
    "a key file that isn't there (%s): refused before anything is built, naming it",
    async (flags, from, path) => {
      await rm(join(home, 'signing-key.pem'));
      const fixtures = makeFixtures();
      const out = await runCli({
        ...baseInputs(fixtures),
        argv: ['build', '--env=staging', ...flags, `--path=${packDir}`],
      });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain(
        `The signing key ${path()} (${from}) isn't there. Make a key with \`kindgi key create <id>\``,
      );
      expect(fixtures.state.esbuildCalls).toBe(0);
      expect(fixtures.state.postCalls).toBe(0);
      expect(fixtures.state.dockerBuilds).toHaveLength(0);
    },
  );

  test("a key path that isn't a file is refused before anything is built, naming it", async () => {
    const dir = join(home, '.kindgi/keys');
    await mkdir(dir, { recursive: true });
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--signing-key=${dir}`, `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      `The signing key ${dir} (--signing-key) isn't a file. Name the key's .pem file, as \`kindgi key create <id>\` writes it: ~/.kindgi/keys/<id>.pem.`,
    );
    expect(fixtures.state.esbuildCalls).toBe(0);
    expect(fixtures.state.postCalls).toBe(0);
  });

  test("--local without --push signs nothing, so a missing key file doesn't stop it", async () => {
    await rm(join(home, 'signing-key.pem'));
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--local', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.signCalls).toBe(0);
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

  const fixed = ['--artifact-version=20260921.1', '--published-at=1970-01-01T00:00:00.000Z'];

  test('streamed, each line goes out as it comes, as the same text, and the outcome leaves them out', async () => {
    const argv = ['build', '--env=staging', `--path=${packDir}`, ...fixed];
    const kept = await runCli({ ...baseInputs(makeFixtures()), argv });
    expect(kept.exitCode, kept.stderr).toBe(0);

    const streamed: string[] = [];
    const fixtures = makeFixtures();
    const { streamBuildLogs } = fixtures.runners;
    let beforeLogs = '';
    fixtures.runners = {
      ...fixtures.runners,
      streamBuildLogs: async (o) => {
        beforeLogs = streamed.join('');
        return streamBuildLogs(o);
      },
    };
    const out = await runCli({
      ...baseInputs(fixtures, { progress: (text) => streamed.push(text) }),
      argv,
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(beforeLogs).toContain('  Environment: staging\n');
    expect(beforeLogs).toContain('    → Streaming build logs\n');
    expect(beforeLogs).not.toContain('docker buildx running');
    expect(streamed.every((text) => text.endsWith('\n') && !text.slice(0, -1).includes('\n'))).toBe(
      true,
    );
    expect(streamed.join('')).toBe(kept.stderr);
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout)).toEqual(JSON.parse(kept.stdout));
  });

  test.each([
    {
      failure: 'the build fails',
      opts: {},
      logs: async (o: { readonly onLog: (line: string) => void }): Promise<TerminalPayload> => {
        o.onLog('step 3/7: npm ci exited 1');
        return {
          status: 'failed',
          error: { code: 'docker-build-failed', message: 'buildx returned non-zero' },
        };
      },
      said: /Environment: staging\n[\s\S]* {8}step 3\/7: npm ci exited 1\nBuild failed: \[docker-build-failed\]/,
    },
    {
      failure: 'the log stream breaks',
      opts: { streamThrows: new Error('the stream closed') },
      said: /Environment: staging\n[\s\S]* {4}→ Streaming build logs\nthe stream closed\n$/,
    },
    {
      failure: "the image's index isn't the local one",
      opts: { serverIndexBytes: new TextEncoder().encode('{"v":1,"packId":"other"}') },
      said: /Environment: staging\n[\s\S]* {2}Verifying build output\nIntegrity gate FAILED/,
    },
  ])('when $failure, the error comes after what the build did up to it', async (c) => {
    const fixtures = makeFixtures(c.opts);
    if (c.logs !== undefined) fixtures.runners = { ...fixtures.runners, streamBuildLogs: c.logs };
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toMatch(c.said);
    expect(fixtures.state.signCalls).toBe(0);
  });

  test('--quiet: no progress, streamed or kept; an error still shows', async () => {
    const streamed: string[] = [];
    const progress = (text: string): void => {
      streamed.push(text);
    };
    const argv = ['build', '--env=staging', `--path=${packDir}`, '--quiet'];
    const ok = await runCli({ ...baseInputs(makeFixtures(), { progress }), argv });
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(ok.stderr).toBe('');
    const failed = makeFixtures({ streamThrows: new Error('the stream closed') });
    for (const inputs of [baseInputs(failed, { progress }), baseInputs(failed)]) {
      const out = await runCli({ ...inputs, argv });
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toBe('the stream closed\n');
    }
    expect(streamed).toEqual([]);
  });

  test('--json: the summary alone on stdout, the progress on stderr as it comes', async () => {
    const streamed: string[] = [];
    const out = await runCli({
      ...baseInputs(makeFixtures(), { progress: (text) => streamed.push(text) }),
      argv: ['build', '--env=staging', `--path=${packDir}`, '--json'],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ buildJobId: 'bld-xxx', signed: true });
    expect(streamed.join('')).toContain('  Deploy envelope written to');
    expect(out.stderr).toBe('');
  });
});

describe("kindgi deploy's inline build, as it goes", () => {
  const fixed = ['--artifact-version=20260921.1', '--published-at=1970-01-01T00:00:00.000Z'];
  const missing = '  Envelope missing — running `kindgi build --env=staging` inline...\n';

  /** A deploy with no envelope yet: it reads the one its build writes, and the server takes it. */
  async function deploy(
    fixtures: Fixtures,
    flags: readonly string[] = [],
    progress?: (text: string) => void,
  ) {
    await rm(join(packDir, '.kindgi', 'build', 'deploy-envelope.json'), { force: true });
    let posts = 0;
    const deployRunners: DeployRunners = {
      loadEnvelope: loadEnvelopeReal,
      postDeployment: async () => {
        posts += 1;
        return {
          kind: 'created',
          status: 201,
          record: {
            deploymentId: 'dep-01H8XM',
            tenantId: 'tenant-acme-staging',
            imageRef: `ghcr.io/acme/my-pack@${PUSHED_DIGEST}`,
            imageDigest: PUSHED_DIGEST,
            artifactVersion: '20260921.1',
            indexHash: `sha256:${SAMPLE_INDEX_HASH_HEX}`,
            signerKeyId: 'staging',
            signerPublicKey: 'base64publickey',
            signature: 'base64signature',
            publishedAt: '1970-01-01T00:00:00.000Z',
            activatedAt: '2026-09-21T14:32:07.104Z',
            primitives: { tools: 1, guardrails: 0, agents: 0, flows: 0 },
          },
        };
      },
    };
    const out = await runCli({
      ...baseInputs(fixtures, {
        env: { KINDGI_TENANT_ID: 'env-tenant', KINDGI_API_TOKEN: 'test-bearer-token' },
        deployRunners,
        ...(progress !== undefined && { progress }),
      }),
      argv: ['deploy', '--env=staging', `--path=${packDir}`, ...fixed, ...flags],
    });
    return { out, posts };
  }

  /** Fixtures whose build server fails the build. */
  const failing = (): Fixtures => {
    const fixtures = makeFixtures();
    fixtures.runners = {
      ...fixtures.runners,
      streamBuildLogs: async (o): Promise<TerminalPayload> => {
        o.onLog('step 3/7: npm ci exited 1');
        return {
          status: 'failed',
          error: { code: 'docker-build-failed', message: 'buildx returned non-zero' },
        };
      },
    };
    return fixtures;
  };

  test("streamed, the build's lines go out as they come, between deploy's, as the same text", async () => {
    const kept = await deploy(makeFixtures());
    expect(kept.out.exitCode, kept.out.stderr).toBe(0);
    expect(kept.posts).toBe(1);
    expect(kept.out.stderr).toContain(`${missing}\n  Environment: staging\n`);

    const streamed: string[] = [];
    const fixtures = makeFixtures();
    const { streamBuildLogs } = fixtures.runners;
    let beforeLogs = '';
    fixtures.runners = {
      ...fixtures.runners,
      streamBuildLogs: async (o) => {
        beforeLogs = streamed.join('');
        return streamBuildLogs(o);
      },
    };
    const run = await deploy(fixtures, [], (text) => streamed.push(text));
    expect(run.out.exitCode, run.out.stderr).toBe(0);
    expect(beforeLogs).toContain(missing);
    expect(beforeLogs).toContain('  Uploading to build service\n');
    expect(beforeLogs).toContain('    → Streaming build logs\n');
    expect(beforeLogs).not.toContain('201 Created');
    expect(streamed.join('')).toBe(kept.out.stderr);
    expect(run.out.stderr).toBe('');
    expect(JSON.parse(run.out.stdout)).toEqual(JSON.parse(kept.out.stdout));
  });

  test('--quiet: nothing from the build or from deploy, streamed or kept, and it still deploys', async () => {
    const streamed: string[] = [];
    for (const progress of [undefined, (text: string) => streamed.push(text)]) {
      const run = await deploy(makeFixtures(), ['--quiet'], progress);
      expect(run.out.exitCode, run.out.stderr).toBe(0);
      expect(run.posts).toBe(1);
      expect(run.out.stdout).toBe('');
      expect(run.out.stderr).toBe('');
    }
    expect(streamed).toEqual([]);
  });

  test('--quiet: an inline build that fails says its error alone, streamed or kept', async () => {
    const streamed: string[] = [];
    for (const progress of [undefined, (text: string) => streamed.push(text)]) {
      const run = await deploy(failing(), ['--quiet'], progress);
      expect(run.out.exitCode).toBe(1);
      expect(run.posts).toBe(0);
      expect(run.out.stderr).toMatch(
        /^Inline `kindgi build` failed \(exit 1\):\n\nBuild failed: \[docker-build-failed\]/,
      );
      expect(run.out.stderr).not.toContain('step 3/7');
    }
    expect(streamed).toEqual([]);
  });

  test("an inline build that fails: its error comes after deploy's lines and the build's, streamed or kept", async () => {
    const kept = await deploy(failing());
    expect(kept.out.exitCode).toBe(1);
    expect(kept.posts).toBe(0);
    expect(kept.out.stderr).toMatch(
      /^\n {2}Environment: staging\n[\s\S]*Envelope missing[^\n]*\n\n {2}Environment: staging\n[\s\S]* {8}step 3\/7: npm ci exited 1\nInline `kindgi build` failed \(exit 1\):\n\nBuild failed: \[docker-build-failed\]/,
    );

    const streamed: string[] = [];
    const run = await deploy(failing(), [], (text) => streamed.push(text));
    expect(run.out.exitCode).toBe(1);
    expect(run.out.stderr.startsWith('Inline `kindgi build` failed (exit 1):')).toBe(true);
    expect(`${streamed.join('')}${run.out.stderr}`).toBe(kept.out.stderr);
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

  test('--out outside the pack root is accepted (the Python indexer takes the pack dir, not <out>/dist)', async () => {
    await pythonPack();
    const fixtures = makeFixtures();
    withPython(fixtures);
    const outside = join(cwd, 'outside-py');
    const out = await runCli({
      ...baseInputs(fixtures, {}, { language: 'python', dev: { python: ['/opt/py/bin/python'] } }),
      argv: ['build', '--env=staging', `--out=${outside}`, `--path=${packDir}`],
    });
    expect(out.stderr).not.toContain('outside the pack root');
    expect(out.exitCode).toBe(0);
  });

  test('--out that contains the pack root is refused (a Python pack too, not only TypeScript)', async () => {
    await pythonPack();
    const fixtures = makeFixtures();
    withPython(fixtures);
    // cwd is the parent of packDir; building here would write dist/, the
    // Containerfile and context/ beside the pack. A Python pack has no
    // outside-root rule, so only the contains-the-pack-root guard refuses it.
    const out = await runCli({
      ...baseInputs(fixtures, {}, { language: 'python', dev: { python: ['/opt/py/bin/python'] } }),
      argv: ['build', '--env=staging', `--out=${cwd}`, `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('contains the pack root');
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

/** The JVM build runners, recording what they're called with (Java and Scala packs). */
function withJvm(fixtures: Fixtures, compileErrors?: readonly string[], indexEnv?: unknown) {
  const calls = {
    prepared: [] as unknown[],
    indexed: [] as unknown[],
    images: [] as (readonly string[])[],
    languages: [] as string[],
    declared: [] as (readonly string[])[],
    files: [] as (readonly string[])[],
  };
  fixtures.runners = {
    ...fixtures.runners,
    jvm: {
      prepare: async (o) => {
        calls.prepared.push(o.code);
        return compileErrors === undefined
          ? { kind: 'ok' }
          : { kind: 'err', errors: compileErrors };
      },
      runLocalIndexer: async (o) => {
        calls.indexed.push(o.code);
        await writeFile(
          o.outputPath,
          indexEnv === undefined
            ? SAMPLE_INDEX_BYTES
            : JSON.stringify({ ...SAMPLE_INDEX, env: indexEnv }),
        );
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
        calls.images.push([o.buildImageRef, o.runtimeImageRef]);
        calls.languages.push(o.language);
        calls.declared.push(o.declaredEnv);
        await writeFile(o.outputPath, `# ${o.language} containerfile\n`, 'utf8');
      },
      writeContext: async (o) => {
        calls.files.push(o.files);
      },
    },
  };
  return calls;
}

describe('kindgi build — a Java pack', () => {
  async function javaPack(withPom = true): Promise<void> {
    await rm(join(packDir, 'kindgi.config.ts'));
    await rm(join(packDir, 'package.json'));
    await rm(join(packDir, 'package-lock.json'));
    await writeFile(
      join(packDir, 'kindgi.config.json'),
      JSON.stringify({ language: 'java', pack: { id: 'my-pack', version: '0.1.0' } }),
      'utf8',
    );
    if (withPom) await writeFile(join(packDir, 'pom.xml'), '<project/>\n', 'utf8');
    await mkdir(join(packDir, 'src', 'main', 'java', 'acme', 'tools'), { recursive: true });
    await writeFile(
      join(packDir, 'src', 'main', 'java', 'acme', 'tools', 'Echo.java'),
      'x',
      'utf8',
    );
    await mkdir(join(packDir, 'target', 'classes'), { recursive: true });
    await writeFile(join(packDir, 'target', 'classes', 'Echo.class'), 'x', 'utf8');
    await writeFile(join(packDir, '.env'), 'SECRET=1\n', 'utf8');
  }

  function withJava(fixtures: Fixtures, compileErrors?: readonly string[]) {
    return withJvm(fixtures, compileErrors);
  }

  const JAVA_CONFIG = { language: 'java', dev: { javaHome: '/opt/jdk-17', maven: ['mvn'] } };

  test("compiles and indexes with the pack's JDK, ships the pack root, then builds, checks and signs", async () => {
    await javaPack();
    const fixtures = makeFixtures();
    const calls = withJava(fixtures);
    const out = await runCli({
      ...baseInputs(fixtures, {}, JAVA_CONFIG),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const code = {
      language: 'java',
      java: '/opt/jdk-17/bin/java',
      javaHome: '/opt/jdk-17',
      maven: ['mvn'],
      workDir: join(packDir, '.kindgi/build/java'),
    };
    expect(calls.prepared).toEqual([code]);
    expect(calls.indexed).toEqual([code]);
    expect(calls.images).toEqual([[DEFAULT_JAVA_BUILD_IMAGE_REF, DEFAULT_JAVA_RUNTIME_IMAGE_REF]]);
    expect(calls.declared).toEqual([[]]);
    expect(calls.files).toEqual([
      ['kindgi.config.json', 'pom.xml', 'src/main/java/acme/tools/Echo.java'],
    ]);
    expect(fixtures.state.esbuildCalls).toBe(0);
    expect(fixtures.state.tarCalls).toBe(1);
    expect(fixtures.state.postCalls).toBe(1);
    expect(fixtures.state.signCalls).toBe(1);
  });

  test('streamed, a pin to another CLI is said before the first line, and not again', async () => {
    await javaPack();
    await writeFile(
      join(packDir, 'kindgi.config.json'),
      JSON.stringify({ language: 'java', cli: '0.0.1', pack: { id: 'my-pack', version: '0.1.0' } }),
      'utf8',
    );
    const fixtures = makeFixtures();
    withJava(fixtures);
    const streamed: string[] = [];
    const out = await runCli({
      ...baseInputs(fixtures, { progress: (text) => streamed.push(text) }, JAVA_CONFIG),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(streamed[0]).toBe(`${cliPinWarning('0.0.1', CLI_VERSION)}\n`);
    expect(streamed[1]).toBe('  Environment: staging\n');
    expect(streamed.join('').split('pins the Kindgi CLI')).toHaveLength(2);
    expect(out.stderr).toBe('');
  });

  test('--out outside the pack root is accepted (the JVM indexer compiles into <out>/java with an explicit classpath)', async () => {
    await javaPack();
    const fixtures = makeFixtures();
    withJava(fixtures);
    const outside = join(cwd, 'outside-java');
    const out = await runCli({
      ...baseInputs(fixtures, {}, JAVA_CONFIG),
      argv: ['build', '--env=staging', `--out=${outside}`, `--path=${packDir}`],
    });
    expect(out.stderr).not.toContain('outside the pack root');
    expect(out.exitCode, out.stderr).toBe(0);
  });

  test("the image's launcher keeps the names the index declares, required and optional", async () => {
    await javaPack();
    const env = { optional: ['CACHE_DIR'], required: ['A_URL', 'B_KEY'] };
    // The image's index is the local one (the integrity gate).
    const fixtures = makeFixtures({
      serverIndexBytes: new TextEncoder().encode(JSON.stringify({ ...SAMPLE_INDEX, env })),
    });
    const calls = withJvm(fixtures, undefined, env);
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { ...JAVA_CONFIG, environments: {} }),
      argv: ['build', '--local', '--artifact-version=20261007.1', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(calls.declared).toEqual([['A_URL', 'B_KEY', 'CACHE_DIR']]);
  });

  test("a pack that doesn't compile stops before indexing, with javac's located errors", async () => {
    await javaPack();
    const fixtures = makeFixtures();
    const calls = withJava(fixtures, ['src/main/java/acme/tools/Echo.java:3:1: class expected']);
    const out = await runCli({
      ...baseInputs(fixtures, {}, JAVA_CONFIG),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("The pack didn't compile");
    expect(out.stderr).toContain('src/main/java/acme/tools/Echo.java:3:1: class expected');
    expect(calls.indexed).toEqual([]);
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('without pom.xml the build stops before uploading', async () => {
    await javaPack(false);
    const fixtures = makeFixtures();
    withJava(fixtures);
    const out = await runCli({
      ...baseInputs(fixtures, {}, JAVA_CONFIG),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('No pom.xml');
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('--local builds with Docker and names the pack service it runs', async () => {
    await javaPack();
    const fixtures = makeFixtures();
    withJava(fixtures);
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { ...JAVA_CONFIG, environments: {} }),
      argv: ['build', '--local', '--artifact-version=20261007.1', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.dockerBuilds[0]).toMatchObject({ tag: 'kindgi-pack/my-pack:20261007.1' });
    expect(out.stderr).toContain(`(the pack service: ${JAVA_PACK_SERVICE_COMMAND.join(' ')})`);
  });
});

describe('kindgi build — a Scala pack', () => {
  async function scalaPack(withBuild = true): Promise<void> {
    await rm(join(packDir, 'kindgi.config.ts'));
    await rm(join(packDir, 'package.json'));
    await rm(join(packDir, 'package-lock.json'));
    await writeFile(
      join(packDir, 'kindgi.config.json'),
      JSON.stringify({ language: 'scala', pack: { id: 'my-pack', version: '0.1.0' } }),
      'utf8',
    );
    if (withBuild) await writeFile(join(packDir, 'build.sbt'), 'scalaVersion := "3.3.8"\n', 'utf8');
    const files: Record<string, string> = {
      'project/build.properties': 'sbt.version=1.12.15\n',
      'src/main/scala/acme/tools/Echo.scala': 'object Echo',
      // Build output, build-server state and credentials stay out of the image.
      'target/scala-3.3.8/classes/acme/tools/Echo$.class': 'x',
      'project/target/active.json': '{}',
      'project/project/target/x': 'x',
      '.bsp/sbt.json': '{}',
      'credentials.sbt': 'credentials += ???',
      '.env': 'SECRET=1\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(packDir, rel)), { recursive: true });
      await writeFile(join(packDir, rel), text, 'utf8');
    }
  }

  const SCALA_CONFIG = { language: 'scala', dev: { javaHome: '/opt/jdk-17' } };

  test("compiles and indexes with the pack's JDK and sbt, ships the pack root, builds with the sbt image", async () => {
    await scalaPack();
    const fixtures = makeFixtures();
    const calls = withJvm(fixtures);
    const out = await runCli({
      ...baseInputs(fixtures, {}, SCALA_CONFIG),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const code = {
      language: 'scala',
      java: '/opt/jdk-17/bin/java',
      javaHome: '/opt/jdk-17',
      sbt: ['sbt'],
      workDir: join(packDir, '.kindgi/build/scala'),
    };
    expect(calls.prepared).toEqual([code]);
    expect(calls.indexed).toEqual([code]);
    expect(calls.languages).toEqual(['scala']);
    expect(calls.images).toEqual([[DEFAULT_SCALA_BUILD_IMAGE_REF, DEFAULT_JAVA_RUNTIME_IMAGE_REF]]);
    expect(calls.files).toEqual([
      [
        'build.sbt',
        'kindgi.config.json',
        'project/build.properties',
        'src/main/scala/acme/tools/Echo.scala',
      ],
    ]);
    expect(out.stderr).toContain('Indexing (Scala — /opt/jdk-17; sbt)');
    expect(out.stderr).toContain('classes and dependencies from build.sbt');
  });

  test('without build.sbt the build stops before uploading', async () => {
    await scalaPack(false);
    const fixtures = makeFixtures();
    withJvm(fixtures);
    const out = await runCli({
      ...baseInputs(fixtures, {}, SCALA_CONFIG),
      argv: ['build', '--env=staging', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('No build.sbt');
    expect(fixtures.state.postCalls).toBe(0);
  });

  test('--local names the pack service the image runs', async () => {
    await scalaPack();
    const fixtures = makeFixtures();
    withJvm(fixtures);
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { ...SCALA_CONFIG, environments: {} }),
      argv: ['build', '--local', '--artifact-version=20261008.1', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain(`(the pack service: ${SCALA_PACK_SERVICE_COMMAND.join(' ')})`);
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

  test("streamed, Docker's build log goes out as it comes", async () => {
    const streamed: string[] = [];
    const fixtures = makeFixtures();
    const { dockerBuild } = fixtures.runners;
    let beforeBuild = '';
    fixtures.runners = {
      ...fixtures.runners,
      dockerBuild: async (o: DockerBuildOptions) => {
        beforeBuild = streamed.join('');
        return dockerBuild?.(o) ?? { kind: 'err', message: 'no docker' };
      },
    };
    const out = await runCli({
      ...baseInputs(
        fixtures,
        { env: {}, progress: (text) => streamed.push(text) },
        { environments: {} },
      ),
      argv: ['build', '--local', '--artifact-version=20261002.1', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(beforeBuild).toContain('  Building kindgi-pack/my-pack:20261002.1\n');
    expect(streamed).toContain('        #1 [system] FROM node\n');
    expect(streamed.join('')).toContain('docker run --rm -p 8080:8080');
    expect(out.stderr).toBe('');
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

  test('an indexer warning is printed and the pack still builds', async () => {
    const message =
      'guardrails/cites.ts: check "cites" doesn\'t start with this pack\'s id ("my-pack."). Name it "my-pack.checks.<name>" so it can\'t collide with another pack\'s check in the same tenant. The pack builds as it is.';
    const fixtures = makeFixtures({
      indexOutcome: {
        kind: 'ok',
        packId: 'my-pack',
        packVersion: '0.1.0',
        counts: { tools: 1, guardrails: 1, agents: 0, flows: 0 },
        fileErrors: [],
        warnings: [{ code: 'check-id-unprefixed', message, filePath: 'guardrails/cites.ts' }],
        index: SAMPLE_INDEX,
      } as LocalIndexResult,
    });
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { environments: {} }),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(0);
    expect(`${out.stdout}${out.stderr}`).toContain(`⚠ ${message}`);
    expect(fixtures.state.dockerBuilds).toHaveLength(1);
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

describe("kindgi build — image.dependencies: 'loaded'", () => {
  test('the bundler is asked for it, and the build says which dependencies the image keeps', async () => {
    const fixtures = makeFixtures();
    const modes: (string | undefined)[] = [];
    const runners: BuildRunners = {
      ...fixtures.runners,
      esbuildBundle: async (o) => {
        modes.push(o.dependencies);
        return fixtures.runners.esbuildBundle(o);
      },
    };
    const out = await runCli({
      ...baseInputs(
        fixtures,
        { env: {} },
        { environments: {}, image: { dependencies: 'loaded', keep: ['pino-pretty'] } },
      ),
      buildRunners: runners,
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(modes).toEqual(['loaded']);
    expect(out.stderr).toContain(
      "✓ Dependencies: only what the pack loads (image.dependencies: 'loaded'), and pino-pretty",
    );
    expect(fixtures.state.containerfileImages[0]).toMatchObject({
      dependencies: 'loaded',
      keep: ['pino-pretty'],
    });
  });

  test('the install is cut down to what the pack loads, and the image is built from that', async () => {
    const fixtures = makeFixtures();
    const runners: BuildRunners = {
      ...fixtures.runners,
      esbuildBundle: async (o) => ({
        ...(await fixtures.runners.esbuildBundle(o)),
        externals: ['pino'],
      }),
    };
    const out = await runCli({
      ...baseInputs(
        fixtures,
        { env: {} },
        { environments: {}, image: { dependencies: 'loaded', keep: ['pino-pretty'] } },
      ),
      buildRunners: runners,
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.loadedInstallCalls).toHaveLength(1);
    expect(fixtures.state.loadedInstallCalls[0]).toMatchObject({
      packDir,
      externals: ['pino'],
      image: { dependencies: 'loaded', keep: ['pino-pretty'] },
    });
    const cut = { workspace: false, reduced: { kept: 3, total: 9 } };
    expect(fixtures.state.containerfileInstalls[0]).toMatchObject(cut);
    expect(fixtures.state.contextInstalls[0]).toMatchObject(cut);
    expect(out.stderr).toContain(
      "    ✓ Install: only what the pack loads, 3 of the lockfile's 9 packages; production dependencies only\n" +
        "      Left out 1 of the pack's own dependencies its tools don't import: next\n",
    );
  });

  test("an install kindgi build can't cut down: the full one, trimmed after, and the build says why", async () => {
    const fixtures = makeFixtures({
      loadedInstall: {
        kind: 'fallback',
        reason: "the lockfile is version 6.0, which kindgi build doesn't read",
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { environments: {}, image: { dependencies: 'loaded' } }),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.containerfileInstalls[0]).not.toHaveProperty('reduced');
    expect(fixtures.state.contextInstalls[0]).not.toHaveProperty('reduced');
    expect(out.stderr).toContain(
      '    ✓ Install: production dependencies only, then trimmed to what the pack loads\n' +
        "      It downloads the app's whole install first, since the lockfile is version 6.0, which kindgi build doesn't read.\n",
    );
  });

  test("a package the pack loads that the app's install doesn't have as it says: refused before any image is built", async () => {
    const fixtures = makeFixtures({
      loadedInstall: {
        kind: 'err',
        message:
          'pino in node_modules is 9.1.0, and pnpm-lock.yaml has 9.2.0: run pnpm install, then kindgi build again.',
      },
    });
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { environments: {}, image: { dependencies: 'loaded' } }),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      'pnpm-lock.yaml has 9.2.0: run pnpm install, then kindgi build again.\n',
    );
    expect(fixtures.state.containerfileCalls).toBe(0);
    expect(fixtures.state.dockerBuilds).toHaveLength(0);
  });

  test("'all': the app's install, uncut", async () => {
    const fixtures = makeFixtures();
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { environments: {} }),
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(fixtures.state.loadedInstallCalls).toHaveLength(0);
    expect(fixtures.state.containerfileInstalls[0]).not.toHaveProperty('reduced');
    expect(out.stderr).toContain('    ✓ Install: production dependencies only\n');
  });

  test("a computed import in the pack's code, and no image.keep: refused before any image is built", async () => {
    const fixtures = makeFixtures();
    const runners: BuildRunners = {
      ...fixtures.runners,
      esbuildBundle: async (o) => ({
        ...(await fixtures.runners.esbuildBundle(o)),
        computedImports: [
          { file: join(packDir, 'tools', 'load.ts'), line: 4, text: 'return import(name);' },
        ],
      }),
    };
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { environments: {}, image: { dependencies: 'loaded' } }),
      buildRunners: runners,
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('tools/load.ts:4  return import(name);');
    expect(out.stderr).toContain(
      "Name the packages these load in image.keep, or set image.dependencies: 'all'.",
    );
    expect(fixtures.state.dockerBuilds).toHaveLength(0);
  });

  test("the default, 'all': said, and a computed import is the app's own business", async () => {
    const fixtures = makeFixtures();
    const runners: BuildRunners = {
      ...fixtures.runners,
      esbuildBundle: async (o) => ({
        ...(await fixtures.runners.esbuildBundle(o)),
        computedImports: [
          { file: join(packDir, 'tools', 'load.ts'), line: 4, text: 'return import(name);' },
        ],
      }),
    };
    const out = await runCli({
      ...baseInputs(fixtures, { env: {} }, { environments: {} }),
      buildRunners: runners,
      argv: ['build', '--local', `--path=${packDir}`],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.stderr).toContain("✓ Dependencies: all of the app's production dependencies");
    expect(out.stderr).not.toContain('computed name');
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
        dependencies: 'all',
        keep: [],
        keepIfInstalled: [],
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

describe('kindgi build — the artifact version and publish time', () => {
  // What the runtime's deploy route accepts.
  const ARTIFACT_VERSION_RE = /^\d{8}\.\d+$/;

  test('default to the build time: YYYYMMDD.HHMMSS and the ISO time, both UTC', () => {
    expect(buildTimeDefaults(new Date('2026-10-08T09:05:03.042Z'))).toEqual({
      artifactVersion: '20261008.090503',
      publishedAt: '2026-10-08T09:05:03.042Z',
    });
    expect(buildTimeDefaults(new Date('2026-01-02T03:04:05.006Z')).artifactVersion).toBe(
      '20260102.030405',
    );
    for (const at of ['2026-10-08T00:00:00.000Z', '2026-10-08T23:59:59.999Z']) {
      expect(buildTimeDefaults(new Date(at)).artifactVersion).toMatch(ARTIFACT_VERSION_RE);
    }
  });

  test('sort in build order within a day, and across midnight', () => {
    const times = [
      '2026-10-08T00:00:00.000Z',
      '2026-10-08T00:00:01.000Z',
      '2026-10-08T00:59:59.999Z',
      '2026-10-08T09:59:59.000Z',
      '2026-10-08T10:00:00.000Z',
      '2026-10-08T23:59:59.999Z',
      '2026-10-09T00:00:00.000Z',
    ];
    const versions = times.map((at) => buildTimeDefaults(new Date(at)).artifactVersion);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort()).toEqual(versions);
    const sameDay = versions.slice(0, -1).map((v) => Number(v.split('.')[1]));
    expect([...sameDay].sort((a, b) => a - b)).toEqual(sameDay);
  });

  test('two unpinned builds the same day get their own versions, tags and publish times', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const builds = [];
      for (const at of ['2026-10-08T09:05:03.042Z', '2026-10-08T09:05:04.510Z']) {
        vi.setSystemTime(new Date(at));
        const fixtures = makeFixtures();
        const seen: { artifactVersion: string; publishedAt: string }[] = [];
        const runners: BuildRunners = {
          ...fixtures.runners,
          runLocalIndexer: async (o) => {
            seen.push({ artifactVersion: o.artifactVersion, publishedAt: o.publishedAt });
            return fixtures.runners.runLocalIndexer(o);
          },
          writeContainerfile: async (o) => {
            seen.push({ artifactVersion: o.artifactVersion, publishedAt: o.publishedAt });
            return fixtures.runners.writeContainerfile(o);
          },
        };
        const out = await runCli({
          ...baseInputs({ ...fixtures, runners }),
          argv: ['build', '--local', '--push', '--env=staging', `--path=${packDir}`],
        });
        expect(out.exitCode, out.stderr).toBe(0);
        const envelope = JSON.parse(
          await readFile(join(packDir, '.kindgi/build/deploy-envelope.json'), 'utf8'),
        ) as Record<string, unknown>;
        builds.push({ tag: fixtures.state.dockerBuilds[0]?.tag, envelope, seen });
      }
      expect(builds.map((b) => b.tag)).toEqual([
        'ghcr.io/acme/my-pack:20261008.090503',
        'ghcr.io/acme/my-pack:20261008.090504',
      ]);
      expect(builds.map((b) => b.envelope)).toMatchObject([
        { artifactVersion: '20261008.090503', publishedAt: '2026-10-08T09:05:03.042Z' },
        { artifactVersion: '20261008.090504', publishedAt: '2026-10-08T09:05:04.510Z' },
      ]);
      // The local index, the image and the signature get the same values.
      for (const { envelope, seen } of builds) {
        expect(seen).toHaveLength(2);
        for (const values of seen) {
          expect(values).toEqual({
            artifactVersion: envelope.artifactVersion,
            publishedAt: envelope.publishedAt,
          });
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test('a pinned build uses both flags as given, whenever it runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const envelopes = [];
      for (const at of ['2026-10-08T09:05:03.042Z', '2026-10-09T17:00:00.000Z']) {
        vi.setSystemTime(new Date(at));
        const fixtures = makeFixtures();
        const out = await runCli({
          ...baseInputs(fixtures),
          argv: [
            'build',
            '--local',
            '--push',
            '--env=staging',
            '--artifact-version=20261008.7',
            '--published-at=2026-10-08T12:00:00.000Z',
            `--path=${packDir}`,
          ],
        });
        expect(out.exitCode, out.stderr).toBe(0);
        expect(fixtures.state.dockerBuilds[0]?.tag).toBe('ghcr.io/acme/my-pack:20261008.7');
        envelopes.push(
          JSON.parse(await readFile(join(packDir, '.kindgi/build/deploy-envelope.json'), 'utf8')),
        );
      }
      expect(envelopes[0]).toMatchObject({
        artifactVersion: '20261008.7',
        publishedAt: '2026-10-08T12:00:00.000Z',
      });
      expect(envelopes[1]).toEqual(envelopes[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('--published-at as a date is its start in UTC, as deploy takes it; a loose one is refused', async () => {
    const fixtures = makeFixtures();
    const argv = ['build', '--local', '--push', '--env=staging', `--path=${packDir}`];
    const out = await runCli({
      ...baseInputs(fixtures),
      argv: [...argv, '--published-at=2026-10-08'],
    });
    expect(out.exitCode, out.stderr).toBe(0);
    const envelope = JSON.parse(
      await readFile(join(packDir, '.kindgi/build/deploy-envelope.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(envelope.publishedAt).toBe('2026-10-08T00:00:00.000Z');

    const refused = makeFixtures();
    const loose = await runCli({ ...baseInputs(refused), argv: [...argv, '--published-at=Oct 8'] });
    expect(loose.exitCode).toBe(2);
    expect(loose.stderr).toContain('--published-at must be an ISO 8601 time with a zone');
    expect(refused.state.dockerBuilds).toEqual([]);
  });
});
