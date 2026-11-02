// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Production wiring for `kindgi build`. Each `BuildRunners` slot is
 * implemented against real infrastructure (esbuild, tar, fetch,
 * @kindgi/handler-runtime.runIndexer, @kindgi/crypto.signEd25519,
 * a docker CLI shell-out). Tests never touch this file — they inject
 * fixtures via `runCli({ buildRunners })`.
 */

import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePrivateKeyPem, serializePublicKeyPem, signEd25519 } from '@kindgi/crypto';

import { readSse } from '@kindgi/sdk/client';

import { runJavaIndexer, runPythonIndexer } from '../dev/defaults.js';
import type { IndexedCounts } from '../dev/runners.js';
import { createJavaPackBuilder } from '../dev/java-builder.js';
import { createScalaPackBuilder } from '../dev/scala-builder.js';
import {
  REQUIRE_BANNER,
  collectPackEntries,
  nodeModulesExternalPlugin,
} from './bundle.js';
import { COMPUTED_IMPORT_LOG_OVERRIDE, computedImportsFrom } from './computed-imports.js';
import { loadEsbuild } from '../esbuild-loader.js';
import { readPnpmVersion } from '../package-manager.js';
import { programPath } from '../program-path.js';
import { renderContainerfile } from './containerfile.js';
import { BuildServiceRefusal, retryAfterSeconds } from './hosted.js';
import { installCommands, withoutInstallScripts } from './host-install.js';
import { renderJavaContainerfile } from './java-image.js';
import { loadedInstall } from './loaded-install.js';
import { renderScalaContainerfile } from './scala-image.js';
import { renderPythonContainerfile } from './python-image.js';
import type {
  BuildRunners,
  DockerBuildOptions,
  DockerBuildResult,
  EsbuildBundleOptions,
  EsbuildBundleResult,
  JvmBuildRunners,
  LocalIndexResult,
  PostBuildOptions,
  PostBuildResult,
  PullImageIndexOptions,
  PullImageIndexResult,
  PythonBuildRunners,
  RunLocalIndexerOptions,
  SignOptions,
  SignResult,
  StreamBuildLogsOptions,
  TarPackOptions,
  TarPackResult,
  TerminalPayload,
  WriteContainerfileOptions,
  WriteContextOptions,
} from './runners.js';

// ---------------------------------------------------------------------
// Local indexer — the integrity-gate baseline
// ---------------------------------------------------------------------

/**
 * Index the build the way the image's indexer stage does: the bundled
 * `kindgi-index.mjs`, in its own process, over the same bundles and
 * config, writing `expected-index.json`. Run from the bundles' folder,
 * it loads what the image loads (zod, for one, from the pack's own
 * dependencies), so the two indexes compare like with like.
 */
export async function runLocalIndexerReal(
  opts: RunLocalIndexerOptions,
): Promise<LocalIndexResult> {
  const dist = opts.bundleDir;
  const args = [
    '--enable-source-maps',
    join(dist, 'kindgi-index.mjs'),
    '--pack-dir',
    opts.packDir,
    '--config',
    join(dist, 'kindgi.config.mjs'),
    '--bundle-map',
    join(dist, 'bundle-map.json'),
    '--module-root',
    dist,
    '--artifact-version',
    opts.artifactVersion,
    '--published-at',
    opts.publishedAt,
    '--output',
    opts.outputPath,
  ];
  const run = await spawnOutcome(process.execPath, args, opts.packDir);
  if (run.code !== 0) {
    // `kindgi-index: <code>: <message>`
    const line = run.stderr.trim().split('\n').pop() ?? '';
    const match = /^kindgi-index: ([a-z-]+): (.*)$/s.exec(line);
    return {
      kind: 'err',
      code: match?.[1] ?? 'index-failed',
      message: match?.[2] ?? (run.stderr.trim() || `kindgi-index exited ${run.code}`),
    };
  }
  let report: {
    readonly packId: string;
    readonly packVersion: string;
    readonly counts: IndexedCounts;
    readonly fileErrors: readonly { code: string; message: string; filePath?: string }[];
    readonly warnings?: readonly { code: string; message: string; filePath?: string }[];
  };
  let index: unknown;
  try {
    report = JSON.parse(run.stdout);
    index = JSON.parse(await readFile(opts.outputPath, 'utf8'));
  } catch (cause) {
    return {
      kind: 'err',
      code: 'index-read-failed',
      message: `The indexer finished, but its report or ${opts.outputPath} can't be read: ${(cause as Error).message}`,
    };
  }
  return {
    kind: 'ok',
    packId: report.packId,
    packVersion: report.packVersion,
    counts: report.counts,
    fileErrors: report.fileErrors.map((e) => ({
      code: e.code,
      message: e.message,
      ...(e.filePath !== undefined && { filePath: e.filePath }),
    })),
    warnings: (report.warnings ?? []).map((w) => ({
      code: w.code,
      message: w.message,
      ...(w.filePath !== undefined && { filePath: w.filePath }),
    })),
    index,
  };
}

// ---------------------------------------------------------------------
// esbuild bundle
// ---------------------------------------------------------------------

/**
 * Bundle a build, into `outputDir` (the image's `dist/`), every bundle
 * `.mjs` with a linked sourcemap:
 *   - the pack's primitives and its `kindgi.config.*`: the pack's own
 *     code bundled, its installed dependencies left to the image's
 *     `node_modules` (imported by name);
 *   - the framework's process entries, `kindgi-index.mjs` and
 *     `kindgi-pack-service.mjs`: self-contained, from the CLI's own
 *     `@kindgi/handler-runtime` (the image's install has none: it has
 *     production dependencies only);
 *   - `bundle-map.json`: each primitive's source path → its bundle.
 */
export async function esbuildBundleReal(
  opts: EsbuildBundleOptions,
): Promise<EsbuildBundleResult> {
  const esbuild = await loadEsbuild();
  await rm(opts.outputDir, { recursive: true, force: true });
  await mkdir(opts.outputDir, { recursive: true });
  const common = {
    absWorkingDir: opts.packDir,
    outdir: opts.outputDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: `node${opts.nodeMajor}`,
    sourcemap: 'linked',
    banner: { js: REQUIRE_BANNER },
    metafile: true,
    logLevel: 'silent',
    // Readable stack traces in the image; no minification.
    minify: false,
  } as const;

  const packEntries = await collectPackEntries(opts.packDir, opts.discoveryPatterns);
  const externalPackages = new Set<string>();
  const externalSpecifiers = new Set<string>();
  const externals = nodeModulesExternalPlugin({
    importBy: 'bare',
    onExternal: (name, _importer, specifier) => {
      externalPackages.add(name);
      externalSpecifiers.add(specifier);
    },
  });
  const loaded = opts.dependencies === 'loaded';
  const pack = await esbuild.build({
    ...common,
    entryPoints: [
      ...packEntries.map((e) => ({ in: e.abs, out: e.outRel })),
      { in: opts.configPath, out: 'kindgi.config' },
    ],
    plugins: [externals],
    // Only what the pack loads: esbuild's notes on computed imports, as warnings.
    ...(loaded && { logOverride: COMPUTED_IMPORT_LOG_OVERRIDE }),
  });
  // Resolved from the CLI's own package, whose dependency it is.
  const cliRoot = await cliPackageRoot();
  const framework = await esbuild.build({
    ...common,
    absWorkingDir: cliRoot,
    entryPoints: [
      { in: '@kindgi/handler-runtime/kindgi-index-main', out: 'kindgi-index' },
      { in: '@kindgi/handler-runtime/pack-service-main', out: 'kindgi-pack-service' },
      // Only what the pack loads: the image's closure and load check.
      ...(loaded ? [{ in: '@kindgi/handler-runtime/kindgi-closure-main', out: 'kindgi-closure' }] : []),
    ],
  });
  if (loaded) {
    await writeFile(
      join(opts.outputDir, 'externals.json'),
      `${JSON.stringify({ packages: [...externalPackages].sort(), specifiers: [...externalSpecifiers].sort() }, null, 2)}\n`,
      'utf8',
    );
  }

  const bundleMap: Record<string, string> = {};
  for (const entry of packEntries) bundleMap[entry.sourceRel] = `${entry.outRel}.mjs`;
  await writeFile(
    join(opts.outputDir, 'bundle-map.json'),
    `${JSON.stringify(bundleMap, null, 2)}\n`,
    'utf8',
  );

  // Metafile output keys are relative to each build's `absWorkingDir`.
  const outputs = [
    ...Object.entries(pack.metafile?.outputs ?? {}).map(([p, o]) => [resolve(opts.packDir, p), o] as const),
    ...Object.entries(framework.metafile?.outputs ?? {}).map(([p, o]) => [resolve(cliRoot, p), o] as const),
  ];
  return {
    emitted: outputs.map(([p]) => p).sort(),
    totalBytes: outputs.reduce((sum, [, o]) => sum + o.bytes, 0),
    externals: [...externalPackages].sort(),
    computedImports: loaded ? computedImportsFrom(pack.warnings, opts.packDir) : [],
    bundleMap,
  };
}

/** The `@kindgi/cli` package folder (this file's nearest `package.json`). */
async function cliPackageRoot(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (pkg.name === '@kindgi/cli') return dir;
    } catch {
      // not here
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('kindgi build: cannot find the @kindgi/cli package folder');
    dir = parent;
  }
}

// ---------------------------------------------------------------------
// Containerfile
// ---------------------------------------------------------------------

export async function writeContainerfileReal(opts: WriteContainerfileOptions): Promise<void> {
  const text = renderContainerfile({
    baseImageRef: opts.baseImageRef,
    artifactVersion: opts.artifactVersion,
    publishedAt: opts.publishedAt,
    buildTarget: opts.buildTarget,
    install: opts.install,
    commands: installCommands(opts.install, opts.image.steps),
    image: opts.image,
    hasIncludes: opts.hasIncludes,
    hasBlocks: opts.hasBlocks,
  });
  await mkdir(join(opts.outputPath, '..'), { recursive: true });
  await writeFile(opts.outputPath, text, 'utf8');
}

// ---------------------------------------------------------------------
// Build context + tarball
// ---------------------------------------------------------------------

/**
 * Write the image's build context into `contextDir` (emptied first):
 *   host/          the files the install reads, at their paths under the install root
 *                  (with `'loaded'`, the manifest and lockfile cut down to what the pack loads)
 *   ext/           the files the build extensions read, at their paths under the install root
 *   dist/          the bundles
 *   include/       `bundle.include` files, at their pack-relative paths
 *   blocks/        the pack's data blocks and their templates, at their
 *                  pack-relative paths: the indexer stage's only
 *   Containerfile
 * Nothing else of the app: never its source, never its `.env` or
 * registry credentials.
 */
export async function writeContextReal(opts: WriteContextOptions): Promise<void> {
  await rm(opts.contextDir, { recursive: true, force: true });
  await mkdir(opts.contextDir, { recursive: true });
  const projectManifests = new Set(opts.install.projectManifests);
  const written = opts.install.reduced?.written ?? {};
  for (const rel of opts.install.files) {
    const dest = join(opts.contextDir, 'host', rel);
    await mkdir(dirname(dest), { recursive: true });
    const text = written[rel];
    if (text !== undefined) {
      await writeFile(dest, text, 'utf8');
    } else if (projectManifests.has(rel)) {
      // The app's own install scripts never run in the image.
      const text = await readFile(join(opts.install.root, rel), 'utf8');
      await writeFile(dest, withoutInstallScripts(text), 'utf8');
    } else {
      await cp(join(opts.install.root, rel), dest);
    }
  }
  for (const rel of opts.extensionFiles) {
    const dest = join(opts.contextDir, 'ext', opts.install.packRel, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(opts.packDir, rel), dest);
  }
  await cp(opts.bundleDir, join(opts.contextDir, 'dist'), { recursive: true });
  for (const rel of opts.includes) {
    const dest = join(opts.contextDir, 'include', rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(opts.packDir, rel), dest);
  }
  for (const rel of opts.blockFiles) {
    const dest = join(opts.contextDir, 'blocks', rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(opts.packDir, rel), dest);
  }
  await cp(opts.containerfilePath, join(opts.contextDir, 'Containerfile'));
}

/** Tar a written context (`writeContext`) for the build service. */
export async function tarPackReal(opts: TarPackOptions): Promise<TarPackResult> {
  return deterministicTar(opts.contextDir, opts.outputPath);
}

/**
 * Gzip `contextDir` into `outputPath` with every mtime at the epoch, so the
 * tarball's hash depends only on its content; the scratch context is
 * removed afterwards.
 */
async function deterministicTar(contextDir: string, outputPath: string): Promise<TarPackResult> {
  const tar = await import('tar');
  await tar.create(
    { gzip: true, cwd: contextDir, portable: true, file: outputPath, mtime: new Date(0) },
    ['.'],
  );
  const bytes = await readFile(outputPath);
  await rm(contextDir, { recursive: true, force: true });
  return { path: outputPath, bytes: new Uint8Array(bytes), size: bytes.length };
}

/** A Python pack's build context: the listed pack files plus the Containerfile. */
export async function writePythonContextReal(opts: {
  readonly packDir: string;
  readonly files: readonly string[];
  readonly containerfilePath: string;
  readonly contextDir: string;
}): Promise<void> {
  await rm(opts.contextDir, { recursive: true, force: true });
  await mkdir(opts.contextDir, { recursive: true });
  for (const rel of opts.files) {
    const dest = join(opts.contextDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(opts.packDir, rel), dest);
  }
  await cp(opts.containerfilePath, join(opts.contextDir, 'Containerfile'));
}

/** The Python pack's steps of `kindgi build`. */
export const PYTHON_BUILD_RUNNERS: PythonBuildRunners = {
  runLocalIndexer: (opts) =>
    runPythonIndexer({
      packDir: opts.packDir,
      outputPath: opts.outputPath,
      python: opts.python,
      env: opts.env,
      artifactVersion: opts.artifactVersion,
      publishedAt: opts.publishedAt,
    }),
  async writeContainerfile(opts) {
    await mkdir(join(opts.outputPath, '..'), { recursive: true });
    await writeFile(
      opts.outputPath,
      renderPythonContainerfile({
        baseImageRef: opts.baseImageRef,
        uvImageRef: opts.uvImageRef,
        artifactVersion: opts.artifactVersion,
        publishedAt: opts.publishedAt,
        buildTarget: opts.buildTarget,
        installer: opts.installer,
        systemPackages: opts.systemPackages,
      }),
      'utf8',
    );
  },
  writeContext: writePythonContextReal,
};

/** A JVM pack's steps of `kindgi build` (Java, Scala). */
export const JVM_BUILD_RUNNERS: JvmBuildRunners = {
  async prepare(opts) {
    const builder =
      opts.code.language === 'java'
        ? createJavaPackBuilder({ packDir: opts.packDir, code: opts.code, env: async () => opts.env })
        : createScalaPackBuilder({ packDir: opts.packDir, code: opts.code, env: async () => opts.env });
    try {
      const built = await builder.build();
      return built.kind === 'ok' ? { kind: 'ok' } : { kind: 'err', errors: built.errors };
    } finally {
      // A Scala build's sbt server, when this build started it, stops here.
      await builder.dispose();
    }
  },
  runLocalIndexer: (opts) =>
    runJavaIndexer({
      packDir: opts.packDir,
      outputPath: opts.outputPath,
      code: opts.code,
      env: opts.env,
      artifactVersion: opts.artifactVersion,
      publishedAt: opts.publishedAt,
    }),
  async writeContainerfile(opts) {
    await mkdir(join(opts.outputPath, '..'), { recursive: true });
    const inputs = {
      buildImageRef: opts.buildImageRef,
      runtimeImageRef: opts.runtimeImageRef,
      artifactVersion: opts.artifactVersion,
      publishedAt: opts.publishedAt,
      buildTarget: opts.buildTarget,
      systemPackages: opts.systemPackages,
      declaredEnv: opts.declaredEnv,
    };
    await writeFile(
      opts.outputPath,
      opts.language === 'java' ? renderJavaContainerfile(inputs) : renderScalaContainerfile(inputs),
      'utf8',
    );
  },
  // The pack files and the Containerfile, as for a Python pack.
  writeContext: writePythonContextReal,
};

// ---------------------------------------------------------------------
// POST /v1/build
// ---------------------------------------------------------------------

export async function postBuildReal(opts: PostBuildOptions): Promise<PostBuildResult> {
  const form = new FormData();
  const blob = new Blob([opts.tarballBytes], { type: 'application/gzip' });
  form.append('pack.tgz', blob, 'pack.tgz');
  form.append('buildTarget', opts.buildTarget);
  if (opts.registryPushCredsRef !== undefined) {
    form.append('registryPushCredsRef', opts.registryPushCredsRef);
  }
  if (opts.packId !== undefined) form.append('packId', opts.packId);
  if (opts.projectId !== undefined) form.append('projectId', opts.projectId);
  const url = `${opts.endpoint.replace(/\/+$/, '')}/v1/build`;
  const res = await opts.fetchImpl(url, {
    method: 'POST',
    headers: {
      'X-Content-SHA256': opts.tarballSha256,
      ...(opts.authorization !== undefined && { Authorization: opts.authorization }),
    },
    body: form,
  });
  if (res.status !== 200 && res.status !== 202) {
    const errBody = await res.text().catch(() => '');
    const refusal = buildServiceRefusal(
      res.status,
      retryAfterSeconds(res.headers.get('retry-after')),
      errBody,
    );
    if (refusal !== undefined) throw refusal;
    throw new Error(`POST /v1/build failed with HTTP ${res.status}: ${errBody}`);
  }
  const payload = (await res.json()) as {
    readonly buildJobId: string;
    readonly status: 'queued' | 'running' | 'completed' | 'failed';
    readonly buildLogsUrl: string;
    readonly imageRef?: string;
    readonly imageDigest?: string;
    readonly indexJson?: Readonly<Record<string, unknown>>;
    readonly indexHash?: string;
    readonly error?: { readonly code: string; readonly message: string };
  };
  const terminal: TerminalPayload | undefined =
    payload.status === 'completed' || payload.status === 'failed'
      ? {
          status: payload.status,
          ...(payload.imageRef !== undefined && { imageRef: payload.imageRef }),
          ...(payload.imageDigest !== undefined && { imageDigest: payload.imageDigest }),
          ...(payload.indexJson !== undefined && { indexJson: payload.indexJson }),
          ...(payload.indexHash !== undefined && { indexHash: payload.indexHash }),
          ...(payload.buildLogsUrl !== undefined && { buildLogsUrl: payload.buildLogsUrl }),
          ...(payload.error !== undefined && { error: payload.error }),
        }
      : undefined;
  return {
    buildJobId: payload.buildJobId,
    status: payload.status,
    buildLogsUrl: payload.buildLogsUrl,
    ...(terminal !== undefined && { terminal }),
  };
}

/** A build service's `{ error: { code, message } }` answer, else undefined. */
function buildServiceRefusal(
  status: number,
  retryAfter: number | undefined,
  body: string,
): BuildServiceRefusal | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const error = (
    parsed as { readonly error?: { readonly code?: unknown; readonly message?: unknown } } | null
  )?.error;
  if (typeof error?.code !== 'string' || typeof error.message !== 'string') return undefined;
  return new BuildServiceRefusal(status, error.code, error.message, retryAfter);
}

/** A refused opening of the log stream: its status, body and `Retry-After`. */
interface StreamRefusal {
  readonly status: number;
  readonly body: string;
  readonly retryAfter: number | undefined;
}

// ---------------------------------------------------------------------
// SSE stream of build logs
// ---------------------------------------------------------------------

/** Answers that end the stream for good: the key, the job, or its record is gone. */
const STREAM_FINAL_STATUSES = new Set([401, 403, 404, 410]);
/** Times the stream may be opened again with nothing new before the CLI gives up. */
const STREAM_QUIET_TRIES = 5;
/** The first wait before opening a cut stream again; it doubles, to at most `STREAM_RETRY_MAX_MS`. */
const STREAM_RETRY_FIRST_MS = 1_000;
const STREAM_RETRY_MAX_MS = 30_000;

/**
 * Follows `GET /v1/build/:jobId/stream` to its `terminal` frame, giving
 * each `log` line to `onLog` once. A stream cut before `terminal` (a
 * restarting instance, a proxy's timeout) is opened again: the build
 * service replays the job's log from its first line, and the lines
 * already given are skipped. It waits the answer's `Retry-After`, else
 * a growing pause, and gives up after a few openings that bring nothing
 * new, or at once on 401, 403, 404 or 410.
 */
export async function streamBuildLogsReal(
  opts: StreamBuildLogsOptions,
): Promise<TerminalPayload> {
  const url = `${opts.endpoint.replace(/\/+$/, '')}/v1/build/${opts.buildJobId}/stream`;
  const sleep = opts.sleep ?? sleepUnlessStopped;
  let given = 0;
  let quiet = 0;
  let pauseMs = STREAM_RETRY_FIRST_MS;
  for (;;) {
    // A refusal of this opening, for its message and its Retry-After.
    const opening: { refused?: StreamRefusal } = {};
    const fetchAndKeep: typeof fetch = async (input, init) => {
      const res = await opts.fetchImpl(input, init);
      if (!res.ok) {
        opening.refused = {
          status: res.status,
          body: await res
            .clone()
            .text()
            .catch(() => ''),
          retryAfter: retryAfterSeconds(res.headers.get('retry-after')),
        };
      }
      return res;
    };
    let seen = 0;
    const givenBefore = given;
    let cut: unknown;
    try {
      for await (const event of readSse<Readonly<Record<string, unknown>>>({
        url,
        fetchImpl: fetchAndKeep,
        ...(opts.authorization !== undefined && {
          headers: { Authorization: opts.authorization },
        }),
        ...(opts.signal !== undefined && { signal: opts.signal }),
        // Opened again here, so the lines it replays are counted.
        shouldRetry: () => false,
      })) {
        if (event.event === 'log') {
          const data = event.data as { readonly line?: string };
          if (typeof data.line !== 'string') continue;
          seen += 1;
          if (seen > given) {
            opts.onLog(data.line);
            given = seen;
          }
          continue;
        }
        if (event.event === 'terminal') return terminalOf(event.data);
      }
    } catch (error) {
      cut = error;
    }
    if (opts.signal?.aborted === true) {
      throw new Error(`Stopped following the build's log (buildJobId ${opts.buildJobId}).`);
    }
    const refused = opening.refused;
    if (refused !== undefined && STREAM_FINAL_STATUSES.has(refused.status)) {
      throw (
        buildServiceRefusal(refused.status, refused.retryAfter, refused.body) ??
        new Error(
          `GET /v1/build/${opts.buildJobId}/stream failed with HTTP ${refused.status}: ${refused.body}`,
        )
      );
    }
    quiet = given > givenBefore ? 0 : quiet + 1;
    if (quiet >= STREAM_QUIET_TRIES) {
      const why = cut instanceof Error ? ` (last: ${cut.message})` : '';
      throw new Error(
        `The build's log stream ended ${STREAM_QUIET_TRIES} times in a row without its end or a new line${why}. buildJobId ${opts.buildJobId}: the build may still finish.`,
      );
    }
    const waitMs =
      refused?.retryAfter !== undefined ? Math.max(1, refused.retryAfter) * 1000 : pauseMs;
    pauseMs = given > givenBefore ? STREAM_RETRY_FIRST_MS : Math.min(pauseMs * 2, STREAM_RETRY_MAX_MS);
    await sleep(waitMs, opts.signal);
  }
}

function terminalOf(raw: Readonly<Record<string, unknown>>): TerminalPayload {
  const data = raw as {
    readonly status: 'completed' | 'failed';
    readonly imageRef?: string;
    readonly imageDigest?: string;
    readonly indexJson?: Readonly<Record<string, unknown>>;
    readonly indexHash?: string;
    readonly buildLogsUrl?: string;
    readonly error?: { readonly code: string; readonly message: string };
  };
  return {
    status: data.status,
    ...(data.imageRef !== undefined && { imageRef: data.imageRef }),
    ...(data.imageDigest !== undefined && { imageDigest: data.imageDigest }),
    ...(data.indexJson !== undefined && { indexJson: data.indexJson }),
    ...(data.indexHash !== undefined && { indexHash: data.indexHash }),
    ...(data.buildLogsUrl !== undefined && { buildLogsUrl: data.buildLogsUrl }),
    ...(data.error !== undefined && { error: data.error }),
  };
}

function sleepUnlessStopped(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// ---------------------------------------------------------------------
// docker pull + extract /app/index.json (for the byte-diff path)
// ---------------------------------------------------------------------

/**
 * Mirror of `packages/build-server/src/docker-wrapper.ts:
 * extractFileFromImage`. Uses `docker create/cp/rm` — the same
 * dependency footprint the build server declares, so a machine that
 * can run the build server also has this path available.
 */
export async function pullImageIndexReal(
  opts: PullImageIndexOptions,
): Promise<PullImageIndexResult> {
  await mkdir(opts.workDir, { recursive: true });
  const onLog = opts.onLog ?? ((): void => {});
  const platform = opts.platform !== undefined ? ['--platform', opts.platform] : [];
  if (opts.pull !== false) {
    onLog(`docker pull ${opts.imageRef}`);
    await spawnCapture('docker', ['pull', ...platform, opts.imageRef], opts.signal);
  }
  const containerId = (
    await spawnCapture('docker', ['create', ...platform, opts.imageRef], opts.signal)
  ).trim();
  const localCopy = join(opts.workDir, 'server-index.json');
  try {
    onLog(`docker cp ${containerId}:/app/index.json ${localCopy}`);
    await spawnCapture(
      'docker',
      ['cp', `${containerId}:/app/index.json`, localCopy],
      opts.signal,
    );
    const bytes = await readFile(localCopy);
    return { bytes };
  } finally {
    try {
      await spawnCapture('docker', ['rm', containerId], undefined);
    } catch {
      // ignore — leaked containers are an operator concern, not a build
      // failure.
    }
    try {
      await rm(localCopy);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------
// docker buildx build --load (`kindgi build --local`)
// ---------------------------------------------------------------------

/**
 * Build the image from a written context into the local Docker image
 * store: `docker buildx build --load`, registry config passed as
 * BuildKit secrets (never in a layer). Every output line goes to
 * `onLog`.
 */
export async function dockerBuildReal(opts: DockerBuildOptions): Promise<DockerBuildResult> {
  const metadataFile = join(opts.contextDir, '..', 'buildx-metadata.json');
  const args = [
    'buildx',
    'build',
    opts.push === true ? '--push' : '--load',
    ...(opts.platform !== undefined ? ['--platform', opts.platform] : []),
    // A plain image manifest: its digest is the image's, nothing else's.
    '--provenance=false',
    '--metadata-file',
    metadataFile,
    '--progress',
    'plain',
    '--file',
    join(opts.contextDir, 'Containerfile'),
    '--tag',
    opts.tag,
    '--build-arg',
    'SOURCE_DATE_EPOCH=0',
    '--build-arg',
    `KINDGI_BUILD_TARGET=${opts.buildTarget}`,
    ...opts.secrets.flatMap((s) => ['--secret', `id=${s.id},src=${s.src}`]),
    opts.contextDir,
  ];
  const tail: string[] = [];
  const run = await spawnOutcome('docker', args, opts.contextDir, (line) => {
    tail.push(line);
    if (tail.length > 30) tail.shift();
    opts.onLog?.(line);
  });
  if (run.code !== 0) {
    return { kind: 'err', message: `docker buildx build exited ${run.code}:\n${tail.join('\n')}` };
  }
  if (opts.push === true) {
    // The registry's digest of what was pushed.
    let digest: unknown;
    try {
      digest = (JSON.parse(await readFile(metadataFile, 'utf8')) as Record<string, unknown>)[
        'containerimage.digest'
      ];
    } catch {
      digest = undefined;
    }
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      return { kind: 'err', message: `docker buildx pushed ${opts.tag} but reported no digest` };
    }
    return { kind: 'ok', imageId: digest, digest };
  }
  const inspected = await spawnOutcome('docker', ['image', 'inspect', '--format', '{{.Id}}', opts.tag], opts.contextDir);
  if (inspected.code !== 0) {
    return { kind: 'err', message: `docker image inspect ${opts.tag}: ${inspected.stderr.trim()}` };
  }
  return { kind: 'ok', imageId: inspected.stdout.trim() };
}

/**
 * Run a command to the end, the one `programPath` finds: its exit code
 * and output, each line also to `onLine`.
 */
async function spawnOutcome(
  command: string,
  args: readonly string[],
  cwd: string,
  onLine?: (line: string) => void,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  let file: string;
  try {
    file = await programPath(command);
  } catch (cause) {
    return { code: 127, stdout: '', stderr: (cause as Error).message };
  }
  return new Promise((resolveRun) => {
    const child = spawn(file, args as string[], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const lines = (chunk: Buffer, pending: { text: string }): void => {
      if (onLine === undefined) return;
      pending.text += chunk.toString('utf8');
      const parts = pending.text.split('\n');
      pending.text = parts.pop() ?? '';
      for (const line of parts) onLine(line);
    };
    const out = { text: '' };
    const err = { text: '' };
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
      lines(c, out);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
      lines(c, err);
    });
    child.on('error', (cause) => resolveRun({ code: 127, stdout, stderr: `${stderr}${cause.message}` }));
    child.on('close', (code) => {
      for (const rest of [out.text, err.text]) if (rest !== '') onLine?.(rest);
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Run a command to the end, the one `programPath` finds: its stdout, or why it failed. */
async function spawnCapture(
  command: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const file = await programPath(command);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args as string[], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    const onAbort = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

// ---------------------------------------------------------------------
// Ed25519 sign
// ---------------------------------------------------------------------

export async function signEnvelopeReal(opts: SignOptions): Promise<SignResult> {
  const parsed = parsePrivateKeyPem(opts.privateKeyPem);
  if (parsed.kind === 'err') {
    throw new Error(
      `Signing key rejected: ${parsed.error.code} — ${parsed.error.message}`,
    );
  }
  const sig = signEd25519(parsed.value, opts.message);
  if (sig.kind === 'err') {
    throw new Error(`Ed25519 signing failed: ${sig.error.message}`);
  }
  // Derive the public key from the PEM with Node's crypto: @kindgi/crypto
  // has no `derivePublicKey` helper.
  const priv = createPrivateKey({ key: opts.privateKeyPem, format: 'pem' });
  const pub = createPublicKey(priv);
  const spki = pub.export({ format: 'der', type: 'spki' });
  const raw = new Uint8Array(spki).subarray(-32); // Ed25519 SPKI trailer is the raw pub key.
  const publicKeyPem = serializePublicKeyPem(raw);

  return {
    signatureBase64: Buffer.from(sig.value).toString('base64'),
    publicKeyPem,
  };
}

// ---------------------------------------------------------------------
// Wired seam
// ---------------------------------------------------------------------

export const REAL_BUILD_RUNNERS: BuildRunners = {
  runLocalIndexer: runLocalIndexerReal,
  esbuildBundle: esbuildBundleReal,
  writeContainerfile: writeContainerfileReal,
  writeContext: writeContextReal,
  tarPack: tarPackReal,
  dockerBuild: dockerBuildReal,
  postBuild: postBuildReal,
  streamBuildLogs: streamBuildLogsReal,
  pullImageIndex: pullImageIndexReal,
  signEnvelope: signEnvelopeReal,
  python: PYTHON_BUILD_RUNNERS,
  jvm: JVM_BUILD_RUNNERS,
  hostPnpmVersion: readPnpmVersion,
  loadedInstall,
};

// Re-export utility for callers that want a portable tmp workdir for
// the image-pull path.
export function defaultBuildWorkDir(): string {
  return join(tmpdir(), 'kindgi-cli-build');
}

// Re-export the small primitive tests use to independently compute the
// tarball hash without the tar step.
export function sha256HexOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
