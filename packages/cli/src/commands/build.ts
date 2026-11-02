// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi build` — client-side build orchestrator producing a signed
 * `deploy-envelope.json` for `kindgi deploy` to POST.
 *
 * Steps:
 *
 *   1. Resolve config + target env (endpoint, signingKey, tenantId).
 *   2. Local indexer pass → `expected-index.json`.
 *   3. esbuild bundle → `dist/`.
 *   4. Generate multi-stage Containerfile.
 *   5. Tar the bundle → `pack.tgz`.
 *   6. sha256(pack.tgz).
 *   7. POST /v1/build (multipart) → job id + SSE URL.
 *   8. Stream build logs; capture terminal payload.
 *   9. Local integrity gate (hash + optional docker-pull-and-diff).
 *  10. Sign the canonicalised envelope body locally.
 *  11. Write `deploy-envelope.json`.
 *  12. Print summary.
 *
 * Every side effect flows through `ctx.buildRunners` so tests substitute
 * fixtures. `POST /v1/deployments` is NOT called from this command —
 * that's `kindgi deploy`.
 */

import { lstat, mkdir, readFile, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  type DiscoveryConfig,
  type PackLanguage,
  codePatterns,
  findKindgiConfig,
  resolveDiscovery,
  resolvePackEnv,
} from '@kindgi/handler-runtime';

import { hostedApiAddress } from '../api-address.js';
import { checkAptPackages } from '../build/apt.js';
import type { ComputedImport } from '../build/computed-imports.js';
import { PACK_SERVICE_COMMAND } from '../build/containerfile.js';
import { collectIncludeFiles, readBundleConfig } from '../build/context-files.js';
import { buildEnvelope, canonicaliseSignatureBody, sha256Hex } from '../build/envelope.js';
import {
  type HostInstall,
  type SkippedScript,
  devOnlyImports,
  resolveHostInstall,
  whyDevDependencies,
} from '../build/host-install.js';
import {
  BuildServiceRefusal,
  describeBuildRefusal,
  hostedBuildEndpoint,
  hostedUploadTooLarge,
} from '../build/hosted.js';
import { type ResolvedImage, readImageConfig } from '../build/image-config.js';
import { checkIntegrity } from '../build/integrity.js';
import {
  DEFAULT_JAVA_BUILD_IMAGE_REF,
  DEFAULT_JAVA_RUNTIME_IMAGE_REF,
  JAVA_PACK_SERVICE_COMMAND,
  collectJavaContextFiles,
} from '../build/java-image.js';
import { nodeBaseImageFor } from '../build/node-image.js';
import { type PackBlocksCheck, checkPackBlocks, packIndexerName } from '../build/pack-blocks.js';
import { resolvePackRoots } from '../build/pack-root.js';
import {
  DEFAULT_PYTHON_BASE_IMAGE_REF,
  DEFAULT_UV_IMAGE_REF,
  PYTHON_LOCKFILES,
  PYTHON_PACK_SERVICE_COMMAND,
  collectPythonContextFiles,
} from '../build/python-image.js';
import type {
  BuildRunners,
  LocalIndexResult,
  PostBuildResult,
  TarPackResult,
  TerminalPayload,
} from '../build/runners.js';
import {
  DEFAULT_SCALA_BUILD_IMAGE_REF,
  SCALA_PACK_SERVICE_COMMAND,
  collectScalaContextFiles,
} from '../build/scala-image.js';
import type { CommandContext } from '../context.js';
import { resolvePackJava, resolvePackPython, resolvePackScala } from '../dev/pack-code.js';
import type { IndexedCounts } from '../dev/runners.js';
import { renderJson } from '../output.js';
import { loadPackConfig } from '../pack-config.js';
import { isPackageVersion } from '../package-manager.js';
import { type ProgressLines, progressLines } from '../progress-lines.js';
import { isWait, sendWaitingOutRateLimits } from '../rate-limit-wait.js';
import { CLI_VERSION } from '../version-info.js';
import { timeFlagValue } from './helpers.js';
import type { CommandResult, LeafCommand } from './types.js';

/**
 * The `kindgi.config.ts` shape this command consumes. Kept loose —
 * we validate the fields we need + defer the rest to the indexer.
 */
export interface EnvironmentConfig {
  readonly endpoint?: string;
  readonly build?: string;
  readonly registry?: string;
  readonly signingKey?: string;
  readonly signerKeyId?: string;
  readonly tenantId?: string;
  readonly buildTarget?: string;
  /**
   * The project this environment is, by id or slug — what `prod` means in
   * `kindgi environments set prod …`, `kindgi promote`, and the deploy /
   * secrets env resolution. Resolved to a project id the way
   * `kindgi deploy --project` resolves one.
   */
  readonly project?: string;
}

export interface PackConfig {
  readonly pack?: { readonly id?: string; readonly version?: string };
  readonly environments?: Readonly<Record<string, EnvironmentConfig>>;
  readonly [k: string]: unknown;
}

/**
 * The project (id or slug) a pack config names for an environment, or
 * `undefined` when the environment — or its `project` — is unset. One place
 * decides what "the prod project" is, so `kindgi environments set`,
 * `kindgi promote` and the deploy / secrets env resolution agree. The caller
 * resolves the returned id-or-slug to a project id the same way
 * `kindgi deploy --project` does.
 */
export function projectOfEnv(
  config: { readonly environments?: unknown } | undefined,
  name: string,
): string | undefined {
  const environments = config?.environments;
  if (environments === null || typeof environments !== 'object') return undefined;
  const block = (environments as Record<string, unknown>)[name];
  if (block === null || typeof block !== 'object') return undefined;
  const project = (block as { readonly project?: unknown }).project;
  return typeof project === 'string' && project !== '' ? project : undefined;
}

export const DEFAULT_OUT_DIR = '.kindgi/build';

export const buildCommand: LeafCommand = {
  kind: 'leaf',
  name: 'build',
  description:
    'Bundle + build + sign a pack image. Emits deploy-envelope.json for `kindgi deploy`. ' +
    "`--local` builds the image with this machine's Docker instead: no build service, no signing; " +
    'with `--push`, it pushes the image, signs it, and writes the envelope. ' +
    "`--hosted` (or the env block's `build: 'hosted'`) builds on Kindgi hosted's build service, at the API's address under `/cloud`, with your API key; the image goes to your workspace's own repository.",
  hostedRun: { defaultEnv: 'staging', buildServerOption: 'endpoint' },
  usage:
    'kindgi build [--local [--push [<repository>]] [--platform <os/arch>]] [--hosted [--project <id>]] [--target <t>] [--endpoint <url>] [--env <name>] [--out <dir>] ' +
    '[--artifact-version <v>] [--published-at <iso>] [--tenant <id>] [--signing-key <path>] ' +
    '[--registry-push-creds <ref>] [--skip-integrity-gate] [--skip-image-pull] [--skip-sign] [--path <dir>]',
  optionSpec: {
    local: {
      type: 'boolean',
      description:
        "Build with this machine's Docker instead of a build server: no signing and no envelope unless `--push`.",
    },
    push: {
      type: 'string',
      optionalValue: true,
      description:
        "With `--local`: push the image, sign it and write the envelope. Default repository: the env block's `registry` + `/<packId>`.",
    },
    platform: {
      type: 'string',
      description:
        "With `--local`: the image's platform. Default: `linux/amd64` when pushing, else this machine's.",
    },
    project: {
      type: 'string',
      description:
        'With `--hosted`: the project the build is for, by id, kept as a label on the build.',
    },
    target: {
      type: 'string',
      description:
        "The build target, set in the image build and sent to the build server. Default: the env block's `buildTarget`, else the env name.",
    },
    endpoint: {
      type: 'string',
      description:
        "The build server. Default: the env block's `build`. Not used with `--local` or `--hosted`.",
    },
    env: {
      type: 'string',
      description: 'The environment block in `kindgi.config.ts` to build for. Default: `staging`.',
    },
    out: {
      type: 'string',
      description:
        'Where the build output and `deploy-envelope.json` go (default: `.kindgi/build`). It cannot be the pack root or a directory containing it; for a TypeScript pack it must stay under the pack root.',
    },
    'artifact-version': {
      type: 'string',
      description:
        'The artifact version, in the image and its signature. Default: the build time as `YYYYMMDD.HHMMSS` (UTC). For a reproducible build, pass `--artifact-version` and `--published-at`.',
    },
    'published-at': {
      type: 'string',
      description:
        'The publish time (an ISO 8601 time with a zone, or a date: its start, UTC), in the image and its signature. Default: the build time. For a reproducible build, pass `--artifact-version` and `--published-at`.',
    },
    tenant: {
      type: 'string',
      description:
        "The tenant the signature names. Default: the env block's `tenantId`, else `KINDGI_TENANT_ID`, else with `--hosted` your key's own tenant.",
    },
    'signing-key': {
      type: 'string',
      description:
        "The Ed25519 private key (PEM) to sign with. Default: the env block's `signingKey`.",
    },
    'signer-key-id': {
      type: 'string',
      description:
        "The key id the signature names. Default: the env block's `signerKeyId`, else the key file's name.",
    },
    'registry-push-creds': {
      type: 'string',
      description:
        'A reference to the registry push credentials for the build server to use, passed through as is.',
    },
    'skip-integrity-gate': {
      type: 'boolean',
      description:
        "Sign without checking the image's index against the local one. Prints a warning. Build-server builds only.",
    },
    'skip-image-pull': {
      type: 'boolean',
      description:
        "Check the image's index by hash only, without pulling the image. Build-server builds only.",
    },
    'skip-sign': {
      type: 'boolean',
      description:
        'Write an unsigned envelope (for CI that signs elsewhere); `kindgi deploy` refuses it.',
    },
    path: { type: 'string', description: 'The pack root. Default: the current directory.' },
  },
  run: async (ctx): Promise<CommandResult> =>
    runBuild(ctx, progressLines(ctx.progress, ctx.globals.format === 'quiet')),
};

interface ResolvedBuildArgs {
  readonly packDir: string;
  /**
   * The directory containing the SURROUNDING repo's `package.json`.
   * Equal to `packDir` for standalone packs (the shape `kindgi init
   * <pack-name>` produces). Different from `packDir` for augment-mode
   * packs — `kindgi.config.ts` under `<repo>/kindgi/`, `package.json`
   * at `<repo>/`. Downstream build stages (bundle, tar, container
   * synthesis) read this to know where to look for lockfiles + the
   * surrounding-repo `package.json`.
   */
  readonly repoRoot: string;
  readonly packMode: 'standalone' | 'augment';
  /** The pack's code language: a Node pack bundles; a Python pack ships its sources. */
  readonly language: PackLanguage;
  readonly outDir: string;
  readonly envName: string;
  readonly endpoint: string;
  /** `--hosted`, or the env block's `build: 'hosted'`: the hosted build service, with the API key. */
  readonly hosted: boolean;
  /** `Bearer <API key>`, for the hosted build service only. */
  readonly authorization: string | undefined;
  /** `--project`, with `--hosted`: a label on the build. */
  readonly projectId: string | undefined;
  readonly buildTarget: string;
  readonly registryPushCredsRef: string | undefined;
  readonly artifactVersion: string;
  readonly publishedAt: string;
  readonly tenantId: string;
  readonly signingKeyPath: string | undefined;
  /** `--signer-key-id`, else the env block's; signing falls back to the key file's name. */
  readonly signerKeyId: string | undefined;
  readonly skipIntegrityGate: boolean;
  readonly skipImagePull: boolean;
  readonly skipSign: boolean;
  /** `--local`: build with this machine's Docker; no build service, no signing. */
  readonly local: boolean;
  /** `--local --push`: the repository the image goes to (`<registry>/<packId>` by default). */
  readonly pushRepository: string | undefined;
  /** The image's platform: `--platform`, else `linux/amd64` when pushing, else this machine's. */
  readonly platform: string | undefined;
  readonly config: PackConfig;
}

/**
 * What a caller of `runBuild` does once the pack is indexed, before an
 * image is built: `kindgi deploy`'s check of its blocks against what runs.
 */
export interface BuildHooks {
  /** Given the local index's path. A result stops the build there, and is its answer. */
  readonly indexed?: (indexPath: string) => Promise<CommandResult | undefined>;
}

/**
 * `kindgi build`. `out` is where its lines go: the command's own, or
 * `kindgi deploy`'s, for its inline build.
 */
export async function runBuild(
  ctx: CommandContext,
  out: ProgressLines,
  hooks: BuildHooks = {},
): Promise<CommandResult> {
  const runners = ctx.buildRunners;
  if (runners === undefined) {
    return {
      kind: 'error',
      stderr:
        'Internal error: kindgi build requires build runners to be wired. ' +
        'Rebuild the CLI (`pnpm --filter @kindgi/cli build`).\n',
      exitCode: 1,
    };
  }
  const parsed = await resolveBuildArgs(ctx);
  if (parsed.kind === 'error') return parsed;
  const args = parsed.args;
  if (args.local) return runLocalBuild(ctx, runners, args, out, hooks);

  const lines = out.line;
  lines('');
  lines(`  Environment: ${args.envName}`);
  lines(`  Build:       ${args.hosted ? `hosted (${args.endpoint})` : args.endpoint}`);
  lines(`  Target:      ${args.buildTarget}`);
  lines(`  Tenant:      ${args.tenantId}`);
  lines(`  Signing key: ${args.signingKeyPath ?? '(--skip-sign)'}`);
  lines(`  Output:      ${args.outDir}`);
  lines('');

  // ---- 1. Local indexer pass ------------------------------------------
  const expectedIndexPath = join(args.outDir, 'expected-index.json');
  await mkdir(args.outDir, { recursive: true });
  const prepared = await prepareTarball(ctx, runners, args, expectedIndexPath, out);
  if (prepared.kind === 'error') return withBanner(prepared, out);
  const stopped = await hooks.indexed?.(expectedIndexPath);
  if (stopped !== undefined) return stopped;
  const { tarball, tarballHash, counts } = prepared;
  lines('');

  // ---- 6. POST /v1/build + SSE stream ---------------------------------
  if (args.hosted) {
    const tooLarge = hostedUploadTooLarge(tarball.bytes.length);
    if (tooLarge !== undefined) return withBanner(failure(tooLarge), out);
  }
  const packId = (args.config.pack as { readonly id?: unknown } | undefined)?.id;
  lines('  Uploading to build service');
  // A `429` with `Retry-After` is waited out and the same build sent
  // again: the service keeps one job per pack and target.
  const sent = await sendWaitingOutRateLimits(
    ctx,
    async (): Promise<{ readonly posted: PostBuildResult } | { readonly thrown: unknown }> => {
      try {
        return {
          posted: await runners.postBuild({
            endpoint: args.endpoint,
            tarballBytes: tarball.bytes,
            tarballSha256: tarballHash,
            buildTarget: args.buildTarget,
            ...(args.registryPushCredsRef !== undefined && {
              registryPushCredsRef: args.registryPushCredsRef,
            }),
            ...(args.authorization !== undefined && { authorization: args.authorization }),
            ...(args.hosted && typeof packId === 'string' && { packId }),
            ...(args.projectId !== undefined && { projectId: args.projectId }),
            fetchImpl: ctx.fetch,
          }),
        };
      } catch (thrown) {
        return { thrown };
      }
    },
    (answer) =>
      'thrown' in answer &&
      answer.thrown instanceof BuildServiceRefusal &&
      answer.thrown.status === 429 &&
      isWait(answer.thrown.retryAfterSeconds)
        ? { retryAfterSeconds: answer.thrown.retryAfterSeconds }
        : undefined,
  );
  if ('thrown' in sent) {
    if (sent.thrown instanceof BuildServiceRefusal) {
      return withBanner(failure(describeBuildRefusal(sent.thrown)), out);
    }
    throw sent.thrown;
  }
  const posted = sent.posted;
  lines(`    ✓ POST /v1/build  →  buildJob: ${posted.buildJobId}`);

  let terminal: TerminalPayload;
  const captured: string[] = [];
  if (posted.terminal !== undefined) {
    // Idempotent replay — server returned the terminal payload inline.
    terminal = posted.terminal;
    lines('    ✓ Existing build (idempotent replay)');
  } else {
    lines('    → Streaming build logs');
    try {
      terminal = await runners.streamBuildLogs({
        endpoint: args.endpoint,
        buildJobId: posted.buildJobId,
        ...(args.authorization !== undefined && { authorization: args.authorization }),
        fetchImpl: ctx.fetch,
        onLog: (line: string): void => {
          captured.push(line);
          // Fold multi-line output into the banner one line at a time,
          // so the build log reads as part of the summary.
          lines(`        ${line}`);
        },
        ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
      });
    } catch (err) {
      if (err instanceof BuildServiceRefusal) {
        return withBanner(failure(describeBuildRefusal(err)), out);
      }
      return withBanner(failure(`${(err as Error).message}\n`), out);
    }
  }

  if (terminal.status === 'failed') {
    return withBanner(
      failure(
        `Build failed: [${terminal.error?.code ?? 'unknown'}] ${terminal.error?.message ?? 'no message'}\n`,
      ),
      out,
    );
  }
  if (
    terminal.imageRef === undefined ||
    terminal.imageDigest === undefined ||
    terminal.indexJson === undefined ||
    terminal.indexHash === undefined
  ) {
    return withBanner(
      failure(
        'Build terminal payload missing required fields (imageRef / imageDigest / indexJson / indexHash).\n',
      ),
      out,
    );
  }
  lines(`    ✓ Build complete (${terminal.imageRef})`);
  for (const line of closureSummary(captured)) lines(line);
  lines('');

  // ---- 7. Local integrity gate ----------------------------------------
  const expectedBytes = new Uint8Array(await readFile(expectedIndexPath));
  const expectedHash = await sha256Hex(expectedBytes);

  let serverBytes: Uint8Array | undefined;
  lines('  Verifying build output');
  if (args.skipIntegrityGate) {
    out.problem('    ⚠ Integrity gate SKIPPED — --skip-integrity-gate. Signature will attest to');
    out.problem('      the server-reported hash without local re-verification. NOT RECOMMENDED.');
  } else {
    if (args.skipImagePull || runners.pullImageIndex === undefined) {
      out.problem('    ⚠ Image pull SKIPPED — hash-only comparison. Byte-diff path unavailable');
      out.problem('      (requires Docker). CI environments where this is expected can safely');
      out.problem('      omit --skip-image-pull warnings.');
    } else {
      try {
        const pulled = await runners.pullImageIndex({
          imageRef: terminal.imageRef,
          workDir: args.outDir,
          onLog: (line) => lines(`        ${line}`),
          ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
        });
        serverBytes = pulled.bytes;
      } catch (err) {
        out.problem(`    ⚠ docker pull failed: ${(err as Error).message}`);
        out.problem('      Falling back to hash-only comparison.');
      }
    }
    const check = checkIntegrity({
      expectedBytes,
      expectedHash,
      serverReportedHash: terminal.indexHash,
      ...(serverBytes !== undefined && { serverBytes }),
    });
    if (!check.ok) {
      return withBanner(
        failure(
          `Integrity gate FAILED — refusing to sign.\n\n${check.reason ?? 'unknown reason'}\n`,
        ),
        out,
      );
    }
    lines(`    ✓ indexHash matches local indexer output (${terminal.indexHash.slice(0, 14)}…)`);
    if (serverBytes !== undefined) {
      lines('    ✓ /app/index.json extracted from image matches byte-for-byte');
    }
  }
  lines('');

  // ---- 8. Sign + 9. emit deploy-envelope.json ------------------------------
  const written = await signAndWriteEnvelope(runners, args, out, {
    imageRef: terminal.imageRef,
    imageDigest: terminal.imageDigest,
    index: terminal.indexJson,
    indexHash: terminal.indexHash,
    ...(terminal.buildLogsUrl !== undefined && { buildLogsUrl: terminal.buildLogsUrl }),
  });
  if (written.kind === 'error') return withBanner(written, out);
  const { envelopePath, signature } = written;

  const summary = {
    envName: args.envName,
    envelopePath,
    buildJobId: posted.buildJobId,
    imageRef: terminal.imageRef,
    imageDigest: terminal.imageDigest,
    artifactVersion: args.artifactVersion,
    publishedAt: args.publishedAt,
    indexHash: terminal.indexHash,
    indexCounts: counts,
    tarballSha256: tarballHash,
    tarballBytes: tarball.size,
    signed: signature !== undefined,
    ...(signature !== undefined && { signerKeyId: signature.keyId }),
    integrityGateSkipped: args.skipIntegrityGate,
    imagePullSkipped: args.skipImagePull || runners.pullImageIndex === undefined,
  };
  const rendered = renderJson(summary, ctx.globals.format);
  return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr: out.kept() } };
}

// ---------------------------------------------------------------------
// --local: build with this machine's Docker
// ---------------------------------------------------------------------

/**
 * `kindgi build --local`: the image of a TypeScript or Python pack built
 * with this machine's Docker (`docker buildx build --load`) into its image
 * store, as `kindgi-pack/<packId>:<artifactVersion>`. The same context and
 * integrity gate as a build-service build: the image's `/app/index.json`
 * must equal the local index byte for byte. No build service, no
 * signature, no deploy envelope: push the image yourself, or run it. With
 * `--push`, the image goes to the registry, and is signed into an
 * envelope for `kindgi deploy`.
 */
async function runLocalBuild(
  ctx: CommandContext,
  runners: BuildRunners,
  args: ResolvedBuildArgs,
  out: ProgressLines,
  hooks: BuildHooks,
): Promise<CommandResult> {
  if (runners.dockerBuild === undefined || runners.pullImageIndex === undefined) {
    return failure('kindgi build --local needs Docker runners; rebuild the CLI.\n');
  }
  const lines = out.line;
  const pushTo = args.pushRepository;
  lines('');
  lines(
    pushTo !== undefined
      ? `  Build:       local, pushed to ${pushTo}`
      : '  Build:       local (docker buildx --load)',
  );
  if (args.platform !== undefined) lines(`  Platform:    ${args.platform}`);
  lines(`  Output:      ${args.outDir}`);

  const expectedIndexPath = join(args.outDir, 'expected-index.json');
  await mkdir(args.outDir, { recursive: true });
  const context = await preparePackContext(ctx, runners, args, expectedIndexPath, out);
  if (context.kind === 'error') return withBanner(context, out);
  const stopped = await hooks.indexed?.(expectedIndexPath);
  if (stopped !== undefined) return stopped;
  const expectedBytes = new Uint8Array(await readFile(expectedIndexPath));
  const packId = (JSON.parse(new TextDecoder().decode(expectedBytes)) as { packId?: unknown })
    .packId;
  const tag = `${pushTo ?? `kindgi-pack/${typeof packId === 'string' ? packId : 'pack'}`}:${args.artifactVersion}`;
  lines('');

  lines(`  Building ${tag}`);
  const buildLog: string[] = [];
  const built = await runners.dockerBuild({
    contextDir: context.contextDir,
    tag,
    buildTarget: args.buildTarget,
    ...(args.platform !== undefined && { platform: args.platform }),
    ...(pushTo !== undefined && { push: true }),
    secrets: context.secrets.map(({ id, src }) => ({ id, src })),
    onLog: (line) => {
      buildLog.push(line);
      lines(`        ${line}`);
    },
  });
  if (built.kind === 'err')
    return withBanner(failure(`Image build failed: ${built.message}\n`), out);
  for (const line of closureSummary(buildLog)) lines(line);
  if (pushTo !== undefined && built.digest === undefined) {
    return withBanner(failure(`The push of ${tag} reported no digest.\n`), out);
  }
  // Pushed: the image is the registry's, by digest; loaded: the local tag.
  const imageRef = pushTo !== undefined ? `${pushTo}@${built.digest}` : tag;
  lines(
    pushTo !== undefined
      ? `    ✓ Pushed ${imageRef}`
      : `    ✓ Built ${tag} (${built.imageId.slice(0, 19)}…)`,
  );
  lines('');

  lines('  Verifying build output');
  const pulled = await runners.pullImageIndex({
    imageRef,
    workDir: args.outDir,
    pull: pushTo !== undefined,
    ...(args.platform !== undefined && { platform: args.platform }),
    ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
  });
  const expectedHash = await sha256Hex(expectedBytes);
  const check = checkIntegrity({
    expectedBytes,
    expectedHash,
    serverReportedHash: await sha256Hex(pulled.bytes),
    serverBytes: pulled.bytes,
  });
  if (!check.ok) {
    return withBanner(
      failure(
        `Integrity gate FAILED: the image's index isn't the local one.\n\n${check.reason ?? ''}\n`,
      ),
      out,
    );
  }
  lines('    ✓ /app/index.json in the image matches the local index byte for byte');
  lines('');

  if (pushTo !== undefined && built.digest !== undefined) {
    const written = await signAndWriteEnvelope(runners, args, out, {
      imageRef,
      imageDigest: built.digest,
      index: JSON.parse(new TextDecoder().decode(expectedBytes)) as Record<string, unknown>,
      indexHash: expectedHash,
    });
    if (written.kind === 'error') return withBanner(written, out);
    const rendered = renderJson(
      {
        envName: args.envName,
        envelopePath: written.envelopePath,
        imageRef,
        imageDigest: built.digest,
        platform: args.platform,
        artifactVersion: args.artifactVersion,
        publishedAt: args.publishedAt,
        indexHash: expectedHash,
        indexCounts: context.counts,
        signed: written.signature !== undefined,
        ...(written.signature !== undefined && { signerKeyId: written.signature.keyId }),
        local: true,
      },
      ctx.globals.format,
    );
    return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr: out.kept() } };
  }

  lines('  Run it:');
  lines(
    `    docker run --rm -p 8080:8080 -e KINDGI_PACK_SERVICE_TOKEN=<token> --env-file <the pack's env> ${tag}`,
  );
  const service =
    args.language === 'python'
      ? PYTHON_PACK_SERVICE_COMMAND
      : args.language === 'java'
        ? JAVA_PACK_SERVICE_COMMAND
        : args.language === 'scala'
          ? SCALA_PACK_SERVICE_COMMAND
          : PACK_SERVICE_COMMAND;
  lines(`    (the pack service: ${service.join(' ')})`);
  lines('');

  const rendered = renderJson(
    {
      imageRef: tag,
      imageId: built.imageId,
      artifactVersion: args.artifactVersion,
      publishedAt: args.publishedAt,
      indexHash: expectedHash,
      indexCounts: context.counts,
      local: true,
    },
    ctx.globals.format,
  );
  return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr: out.kept() } };
}

/** The built image, as the envelope names it. */
interface BuiltImage {
  readonly imageRef: string;
  readonly imageDigest: string;
  readonly index: Readonly<Record<string, unknown>>;
  readonly indexHash: string;
  readonly buildLogsUrl?: string;
}

type Signature = {
  readonly signatureBase64: string;
  readonly publicKeyPem: string;
  readonly keyId: string;
};

/**
 * Sign the image (Ed25519 over imageDigest, artifactVersion, indexHash,
 * tenantId, publishedAt) and write `deploy-envelope.json` for
 * `kindgi deploy`: the build service's path and `--local --push` alike.
 */
async function signAndWriteEnvelope(
  runners: BuildRunners,
  args: ResolvedBuildArgs,
  out: ProgressLines,
  image: BuiltImage,
): Promise<
  | {
      readonly kind: 'ok';
      readonly envelopePath: string;
      readonly signature: Signature | undefined;
    }
  | (CommandResult & { readonly kind: 'error' })
> {
  const lines = out.line;
  let signature: Signature | undefined;
  if (args.skipSign) {
    out.problem(
      '  ⚠ Signing SKIPPED — --skip-sign. Emitted envelope is unsigned; deploy will refuse',
    );
    out.problem('    it. Use only for CI that signs elsewhere.');
  } else if (args.signingKeyPath === undefined) {
    return failure(noSigningKey(undefined));
  } else {
    const privateKeyPem = await readFile(args.signingKeyPath, 'utf8');
    const message = canonicaliseSignatureBody({
      imageDigest: image.imageDigest,
      artifactVersion: args.artifactVersion,
      indexHash: image.indexHash,
      tenantId: args.tenantId,
      publishedAt: args.publishedAt,
    });
    const signed = await runners.signEnvelope({ privateKeyPem, message });
    signature = { ...signed, keyId: args.signerKeyId ?? basenameNoExt(args.signingKeyPath) };
    lines('  Signing locally');
    lines(
      '    ✓ Ed25519 signature over (imageDigest, artifactVersion, indexHash, tenantId, publishedAt)',
    );
    lines(`      key: ${signature.keyId}`);
  }

  const envelope = buildEnvelope({
    imageRef: image.imageRef,
    imageDigest: image.imageDigest,
    artifactVersion: args.artifactVersion,
    index: image.index,
    indexHash: image.indexHash,
    tenantId: args.tenantId,
    publishedAt: args.publishedAt,
    ...(image.buildLogsUrl !== undefined && { buildLogsUrl: image.buildLogsUrl }),
    ...(signature !== undefined && { signature }),
  });
  const envelopePath = join(args.outDir, 'deploy-envelope.json');
  await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  lines('');
  lines(`  Deploy envelope written to ${envelopePath}`);
  lines(`  Run \`kindgi deploy --env=${args.envName}\` to POST it.`);
  lines('');
  return { kind: 'ok', envelopePath, signature };
}

/** A failure that still shows what the build did up to it (the lines kept, when not streamed). */
function withBanner(
  result: CommandResult & { readonly kind: 'error' },
  out: ProgressLines,
): CommandResult & { readonly kind: 'error' } {
  return { ...result, stderr: `${out.kept()}${result.stderr}` };
}

// ---------------------------------------------------------------------
// Argument resolution
// ---------------------------------------------------------------------

type ArgsOutcome =
  | { readonly kind: 'ok'; readonly args: ResolvedBuildArgs }
  | (CommandResult & { readonly kind: 'error' });

type PreparedContext =
  | {
      readonly kind: 'ok';
      readonly tarball: TarPackResult;
      readonly tarballHash: string;
      readonly counts: IndexedCounts;
    }
  | (CommandResult & { readonly kind: 'error' });

/** A file the image's install reads as a BuildKit secret; never in the image. */
interface BuildSecret {
  readonly id: string;
  /** Where it's read from. */
  readonly src: string;
  /** The file, as messages name it. */
  readonly file: string;
}

/**
 * A pack's image, ready to build or to tar for the build service: its
 * context (`<out>/context`), the local index's counts, the install's build
 * secrets.
 */
type PackContext =
  | {
      readonly kind: 'ok';
      readonly contextDir: string;
      readonly counts: IndexedCounts;
      readonly secrets: readonly BuildSecret[];
    }
  | (CommandResult & { readonly kind: 'error' });

/** The pack's image context, by the pack's language. */
function preparePackContext(
  ctx: CommandContext,
  runners: BuildRunners,
  args: ResolvedBuildArgs,
  expectedIndexPath: string,
  out: ProgressLines,
): Promise<PackContext> {
  if (args.language === 'java' || args.language === 'scala')
    return prepareJvmContext(ctx, runners, args, args.language, expectedIndexPath, out);
  return args.language === 'python'
    ? preparePythonContext(ctx, runners, args, expectedIndexPath, out)
    : prepareNodeContext(runners, args, expectedIndexPath, out);
}

/**
 * A pnpm install with no `packageManager` gets the host's pnpm version:
 * the image then installs with the pnpm that wrote the lockfile, not the
 * newest one corepack would take. When the host's can't be read, the
 * build is refused rather than left to float.
 */
async function withHostPnpm(
  runners: BuildRunners,
  install: HostInstall,
): Promise<
  | { readonly kind: 'ok'; readonly install: HostInstall }
  | { readonly kind: 'err'; readonly message: string }
> {
  if (install.manager !== 'pnpm' || install.managerSpec !== undefined)
    return { kind: 'ok', install };
  const fix = `Add "packageManager": "pnpm@<version>" to ${join(install.root, 'package.json')}, with the pnpm version that writes pnpm-lock.yaml, and run kindgi build again.`;
  let version: string;
  try {
    version = await runners.hostPnpmVersion(install.root);
  } catch (err) {
    return {
      kind: 'err',
      message: `package.json has no packageManager, and kindgi build couldn't read the pnpm version here (pnpm --version in ${install.root}: ${(err as Error).message}). The image installs with the pnpm that wrote the lockfile, never the newest. ${fix}`,
    };
  }
  if (!isPackageVersion(version)) {
    return {
      kind: 'err',
      message: `package.json has no packageManager, and pnpm --version in ${install.root} printed "${version}", not a version. ${fix}`,
    };
  }
  return { kind: 'ok', install: { ...install, hostPnpm: version } };
}

/**
 * A Node pack: how the image installs the app (`host-install.ts`), its
 * base image, the bundles, the local index over them, the Containerfile,
 * and the build context (`<out>/context`).
 */
async function prepareNodeContext(
  runners: BuildRunners,
  args: ResolvedBuildArgs,
  expectedIndexPath: string,
  out: ProgressLines,
): Promise<PackContext> {
  const lines = out.line;
  const hostInstall = await resolveHostInstall(args.packDir);
  if (hostInstall.kind === 'err') return failure(`${hostInstall.message}\n`);
  const pinned = await withHostPnpm(runners, hostInstall.install);
  if (pinned.kind === 'err') return failure(`${pinned.message}\n`);
  const install = pinned.install;
  const base = nodeBaseImageFor(install.enginesNode);
  if (base.kind === 'err') return failure(`${base.message}\n`);
  const configFile = await findKindgiConfig(args.packDir);
  if (configFile === undefined || configFile.format === 'pyproject') {
    return failure(`No kindgi.config.* at ${args.packDir}.\n`);
  }
  const includes = readBundleConfig(args.config);
  if (includes.kind === 'invalid') return failure(`${includes.message}\n`);
  const includeFiles = await collectIncludeFiles(args.packDir, includes.bundle.include);
  if (includeFiles.kind === 'error') return failure(`${includeFiles.message}\n`);
  const imageConfig = readImageConfig(args.config);
  if (imageConfig.kind === 'invalid') return failure(`${imageConfig.message}\n`);
  const image = imageConfig.image;
  for (const file of image.contextFiles) {
    if (!(await isFile(join(args.packDir, file)))) {
      return failure(`image: ${file} (an extension's file) doesn't exist in ${args.packDir}.\n`);
    }
  }

  lines(
    `  Install:     ${install.managerSpec ?? (install.hostPnpm !== undefined ? `pnpm@${install.hostPnpm} (the host's; no packageManager)` : install.manager)} from ${install.files.find((f) => /lock|shrinkwrap/.test(f)) ?? 'the lockfile'}${install.packRel === '' ? '' : ` (pack at ${install.packRel}/)`}`,
  );
  lines(`  Node:        ${base.image.version} (${base.image.ref.split('@')[0]})`);
  if (image.extensions.length > 0 || image.systemPackages.length > 0) {
    lines(
      `  Image:       ${[
        ...image.extensions.map((e) => `${e} extension`),
        ...(image.systemPackages.length > 0 ? [`apt: ${image.systemPackages.join(' ')}`] : []),
      ].join('; ')}`,
    );
  }

  // ---- 1. esbuild bundle -----------------------------------------------
  lines('  Bundling (esbuild — local)');
  const bundleDir = join(args.outDir, 'dist');
  const bundle = await runners.esbuildBundle({
    packDir: args.packDir,
    outputDir: bundleDir,
    // The config's discovery patterns (defaults filled in) — the same
    // files the indexer discovers.
    discoveryPatterns: discoveryPatternsOf(args.config),
    configPath: configFile.path,
    nodeMajor: base.image.major,
    dependencies: image.dependencies,
  });
  lines(
    `    ✓ ${Object.keys(bundle.bundleMap).length} pack modules, the config, and the framework entrypoints (kindgi-index + the pack service)`,
  );
  lines(`    ✓ ${bundle.emitted.length} files emitted (${humanBytes(bundle.totalBytes)})`);
  lines(renderExternalsSummary(bundle.externals));
  const devOnly = devOnlyImports(bundle.externals, install.packDependencies);
  if (devOnly.length > 0) {
    const manifest = install.packRel === '' ? 'package.json' : `${install.packRel}/package.json`;
    const one = devOnly.length === 1;
    return failure(
      `The pack imports ${devOnly.join(', ')}, which ${manifest} lists only in devDependencies. The image keeps production dependencies only, so ${one ? 'it' : 'they'} wouldn't load there: move ${one ? 'it' : 'them'} to dependencies.\n`,
    );
  }
  const dependencies = dependenciesStep(image, bundle.computedImports, args.packDir);
  if (dependencies.kind === 'refuse') return failure(dependencies.message);
  lines(dependencies.mode);
  warn(out, dependencies.warnings);
  // Only what the pack loads: the install cut down to it, or the full one trimmed after, and why.
  let imageInstall = install;
  let trimmedBecause: string | undefined;
  if (image.dependencies === 'loaded') {
    const loaded = await runners.loadedInstall({
      install,
      packDir: args.packDir,
      externals: bundle.externals,
      image,
    });
    if (loaded.kind === 'err') return failure(`${loaded.message}\n`);
    if (loaded.kind === 'fallback') trimmedBecause = loaded.reason;
    else imageInstall = loaded.install;
  }

  // ---- 2. Local indexer over the bundles ----------------------------------
  const localIndex = await runners.runLocalIndexer({
    packDir: args.packDir,
    bundleDir,
    outputPath: expectedIndexPath,
    artifactVersion: args.artifactVersion,
    publishedAt: args.publishedAt,
  });
  if (localIndex.kind === 'err') {
    return failure(
      `Local indexer failed: [${localIndex.code}] ${localIndex.message}${localIndex.filePath !== undefined ? ` (at ${localIndex.filePath})` : ''}\n`,
    );
  }
  if (localIndex.fileErrors.length > 0) {
    return failure(
      `Local indexer reported file errors — fix them before building:\n${localIndex.fileErrors
        .map((e) => `  [${e.code}] ${e.message}`)
        .join('\n')}\n`,
    );
  }
  const blocks = await checkBuildBlocks(args, localIndex.counts, expectedIndexPath);
  if (blocks.kind === 'err') return failure(`${blocks.message}\n`);
  lines(
    `    ✓ ${localIndex.counts.tools} tools, ${localIndex.counts.guardrails} guardrails, ` +
      `${localIndex.counts.agents} agents, ${localIndex.counts.flows} flows${blocksCounted(localIndex.counts)} indexed`,
  );
  printIndexWarnings(localIndex, out.problem);

  // ---- 3. Containerfile + context --------------------------------------
  const containerfilePath = join(args.outDir, 'Containerfile');
  await runners.writeContainerfile({
    outputPath: containerfilePath,
    artifactVersion: args.artifactVersion,
    publishedAt: args.publishedAt,
    baseImageRef: base.image.ref,
    buildTarget: args.buildTarget,
    install: imageInstall,
    image,
    hasIncludes: includeFiles.files.length > 0,
    hasBlocks: blocks.files.length > 0,
  });
  const contextDir = join(args.outDir, 'context');
  await runners.writeContext({
    contextDir,
    packDir: args.packDir,
    install: imageInstall,
    bundleDir,
    containerfilePath,
    includes: includeFiles.files,
    extensionFiles: image.contextFiles,
    blockFiles: blocks.files,
  });
  lines(
    `    ✓ Context: ${imageInstall.files.length} install file(s), the bundles${includeFiles.files.length > 0 ? `, ${includeFiles.files.length} bundle.include file(s)` : ''}${blocks.files.length > 0 ? `, ${blocks.files.length} block file(s) for the indexer` : ''}; no pack source`,
  );
  if (install.secrets.length > 0) {
    lines(
      `    ✓ ${install.secrets.map((s) => s.file).join(', ')}: read by the install as a build secret, never in the image`,
    );
  }
  lines(installLine(imageInstall, image.steps, trimmedBecause));
  for (const line of skippedScriptLines(install.skippedScripts)) lines(line);
  warn(out, patchPackageWarnings(install.skippedScripts));
  const secrets = install.secrets.map((secret) => ({
    id: secret.id,
    src: join(install.root, secret.file),
    file: secret.file,
  }));
  return { kind: 'ok', contextDir, counts: localIndex.counts, secrets };
}

/**
 * The image's install: production dependencies only, or dev ones too, and
 * why. With `image.dependencies: 'loaded'`: only what the pack loads, or the
 * full install trimmed after, and why (`trimmedBecause`).
 */
export function installLine(
  install: Pick<HostInstall, 'manager' | 'yarnBerry' | 'reduced'>,
  steps: ResolvedImage['steps'],
  trimmedBecause?: string,
): string {
  const why = whyDevDependencies(install, steps);
  const what =
    why === undefined
      ? 'production dependencies only'
      : `dev dependencies too, ${why}; pruned to production after`;
  if (install.reduced !== undefined) {
    const { kept, total, leftOut } = install.reduced;
    const line = `    ✓ Install: only what the pack loads, ${kept} of the lockfile's ${total} packages; ${what}`;
    return leftOut.length === 0
      ? line
      : `${line}\n      Left out ${leftOut.length} of the pack's own dependencies its tools don't import: ${leftOut.join(', ')}`;
  }
  return trimmedBecause === undefined
    ? `    ✓ Install: ${what}`
    : `    ✓ Install: ${what}, then trimmed to what the pack loads\n      It downloads the app's whole install first, since ${trimmedBecause}.`;
}

/** What the image leaves out of the app's own install scripts. */
export function skippedScriptLines(skipped: readonly SkippedScript[]): string[] {
  if (skipped.length === 0) return [];
  return [
    `    ✓ The app's own install scripts don't run in the image: ${skipped.map((s) => `${scriptWhere(s)} (\`${s.command}\`)`).join(', ')}`,
  ];
}

/**
 * What to do when a skipped script is something the image needs:
 * `patch-package` (pnpm's own patches are applied by the install). A
 * warning each, after `skippedScriptLines`.
 */
export function patchPackageWarnings(skipped: readonly SkippedScript[]): string[] {
  return skipped
    .filter((s) => /\bpatch-package\b/.test(s.command))
    .map(
      (s) =>
        `    ⚠ ${scriptWhere(s)} runs patch-package, so its patches aren't applied in the image. Apply them with a build step: defineBuildExtension({ name: 'patch-package', contextFiles: [<each file in patches/>], postInstall: [{ bin: 'patch-package' }] }) in image.extensions (@kindgi/sdk/build). With pnpm, pnpm patch applies them in the install itself.`,
    );
}

function scriptWhere(s: SkippedScript): string {
  return s.manifest === 'package.json' ? s.name : `${s.manifest} ${s.name}`;
}

/** A pack's context, tarred for the build service. */
async function prepareTarball(
  ctx: CommandContext,
  runners: BuildRunners,
  args: ResolvedBuildArgs,
  expectedIndexPath: string,
  out: ProgressLines,
): Promise<PreparedContext> {
  const context = await preparePackContext(ctx, runners, args, expectedIndexPath, out);
  if (context.kind === 'error') return context;
  if (context.secrets.length > 0) {
    out.problem(
      `    ⚠ The build service gets no build secrets: an install that needs ${context.secrets.map((s) => s.file).join(', ')} (a private registry) fails there. \`kindgi build --local\` passes them.`,
    );
  }
  const tarballPath = join(args.outDir, 'pack.tgz');
  const tarball = await runners.tarPack({
    contextDir: context.contextDir,
    outputPath: tarballPath,
  });
  const tarballHash = await sha256Hex(tarball.bytes);
  out.line(
    `    ✓ Emitted ${tarballPath} (${humanBytes(tarball.size)}, ${tarballHash.slice(0, 14)}…)`,
  );
  return { kind: 'ok', tarball, tarballHash, counts: context.counts };
}

/**
 * A Python pack: the local index with the pack's interpreter, the Python
 * Containerfile (`build/python-image.ts`), the pack root as the context
 * (`<out>/context`).
 */
async function preparePythonContext(
  ctx: CommandContext,
  runners: BuildRunners,
  args: ResolvedBuildArgs,
  expectedIndexPath: string,
  out: ProgressLines,
): Promise<PackContext> {
  const lines = out.line;
  const python = runners.python;
  if (python === undefined)
    return failure('This CLI cannot build Python packs (no Python build runners).\n');
  const interpreter = await resolvePackPython(args.packDir, args.config);
  if (interpreter.kind === 'err') return failure(`kindgi build: ${interpreter.message}\n`);
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR'] as const) {
    const value = ctx.env[name];
    if (value !== undefined) env[name] = value;
  }
  const localIndex = await python.runLocalIndexer({
    packDir: args.packDir,
    outputPath: expectedIndexPath,
    artifactVersion: args.artifactVersion,
    publishedAt: args.publishedAt,
    python: interpreter.value,
    env,
  });
  if (localIndex.kind === 'err') {
    return failure(
      `Local indexer failed: [${localIndex.code}] ${localIndex.message}${localIndex.filePath !== undefined ? ` (at ${localIndex.filePath})` : ''}\n`,
    );
  }
  if (localIndex.fileErrors.length > 0) {
    return failure(
      `Local indexer reported file errors — fix them before building:\n${localIndex.fileErrors
        .map((e) => `  [${e.code}] ${e.message}`)
        .join('\n')}\n`,
    );
  }
  const blocks = await checkBuildBlocks(args, localIndex.counts, expectedIndexPath);
  if (blocks.kind === 'err') return failure(`${blocks.message}\n`);
  lines(`  Indexing (Python — ${interpreter.value.join(' ')})`);
  lines(
    `    ✓ ${localIndex.counts.tools} tools, ${localIndex.counts.guardrails} guardrails, ` +
      `${localIndex.counts.agents} agents, ${localIndex.counts.flows} flows${blocksCounted(localIndex.counts)} discovered`,
  );
  printIndexWarnings(localIndex, out.problem);

  const packFiles = await collectPythonContextFiles(args.packDir);
  if (packFiles.kind === 'error') return failure(`${packFiles.message}\n`);
  const image = args.config.image;
  const system = checkAptPackages(
    image !== null && typeof image === 'object'
      ? (image as Record<string, unknown>)['system-packages']
      : undefined,
    '[tool.kindgi.image] system-packages',
  );
  if (system.kind === 'err') return failure(`kindgi build: ${system.message}\n`);
  const trimming = pythonTrimmingRefusal(image);
  if (trimming !== undefined) return failure(`kindgi build: ${trimming}\n`);
  const containerfilePath = join(args.outDir, 'Containerfile');
  await python.writeContainerfile({
    outputPath: containerfilePath,
    artifactVersion: args.artifactVersion,
    publishedAt: args.publishedAt,
    baseImageRef: DEFAULT_PYTHON_BASE_IMAGE_REF,
    uvImageRef: DEFAULT_UV_IMAGE_REF,
    buildTarget: args.buildTarget,
    installer: packFiles.installer,
    systemPackages: system.packages,
  });
  const contextDir = join(args.outDir, 'context');
  await python.writeContext({
    packDir: args.packDir,
    files: packFiles.files,
    containerfilePath,
    contextDir,
  });
  lines(
    `    ✓ ${packFiles.files.length} pack file(s) in the image (the pack root, minus caches, virtualenvs and secrets); dependencies from ${PYTHON_LOCKFILES[packFiles.installer]}${system.packages.length > 0 ? `; Debian packages: ${system.packages.join(', ')}` : ''}`,
  );
  return { kind: 'ok', contextDir, counts: localIndex.counts, secrets: [] };
}

/**
 * A JVM pack (Java, Scala): Maven or sbt compiles it with the pack's JDK
 * and the local index runs on its classes, then its Containerfile
 * (`build/java-image.ts`, `build/scala-image.ts`), the pack root as the
 * context (`<out>/context`).
 */
async function prepareJvmContext(
  ctx: CommandContext,
  runners: BuildRunners,
  args: ResolvedBuildArgs,
  language: 'java' | 'scala',
  expectedIndexPath: string,
  out: ProgressLines,
): Promise<PackContext> {
  const lines = out.line;
  const java = runners.jvm;
  const name = language === 'java' ? 'Java' : 'Scala';
  if (java === undefined)
    return failure(`This CLI cannot build ${name} packs (no JVM build runners).\n`);
  // The JDK and Maven or sbt as `kindgi dev` finds them; the build's own files under the output folder.
  const resolved =
    language === 'java'
      ? await resolvePackJava(args.packDir, args.config, ctx.env)
      : await resolvePackScala(args.packDir, args.config, ctx.env);
  if (resolved.kind === 'err') return failure(`kindgi build: ${resolved.message}\n`);
  const code = { ...resolved.value, workDir: join(args.outDir, language) };
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR'] as const) {
    const value = ctx.env[name];
    if (value !== undefined) env[name] = value;
  }
  const prepared = await java.prepare({ packDir: args.packDir, code, env });
  if (prepared.kind === 'err') {
    return failure(
      `The pack didn't compile — fix it before building:\n${prepared.errors.map((e) => `  ${e}`).join('\n')}\n`,
    );
  }
  const localIndex = await java.runLocalIndexer({
    packDir: args.packDir,
    outputPath: expectedIndexPath,
    artifactVersion: args.artifactVersion,
    publishedAt: args.publishedAt,
    code,
    env,
  });
  if (localIndex.kind === 'err') {
    return failure(
      `Local indexer failed: [${localIndex.code}] ${localIndex.message}${localIndex.filePath !== undefined ? ` (at ${localIndex.filePath})` : ''}\n`,
    );
  }
  if (localIndex.fileErrors.length > 0) {
    return failure(
      `Local indexer reported file errors — fix them before building:\n${localIndex.fileErrors
        .map((e) => `  [${e.code}] ${e.message}`)
        .join('\n')}\n`,
    );
  }
  // The launcher keeps these names in the image, and drops the rest.
  const declared = resolvePackEnv(
    (JSON.parse(await readFile(expectedIndexPath, 'utf8')) as { readonly env?: unknown }).env,
  );
  if (declared.kind === 'err')
    return failure(`kindgi build: the index's env: ${declared.message}\n`);
  const declaredEnv = [
    ...(declared.value?.required ?? []),
    ...(declared.value?.optional ?? []),
  ].sort();
  const blocks = await checkBuildBlocks(args, localIndex.counts, expectedIndexPath);
  if (blocks.kind === 'err') return failure(`${blocks.message}\n`);
  const tool = code.language === 'java' ? code.maven : code.sbt;
  lines(`  Indexing (${name} — ${code.javaHome ?? code.java}; ${tool.join(' ')})`);
  lines(
    `    ✓ ${localIndex.counts.tools} tools, ${localIndex.counts.guardrails} guardrails, ` +
      `${localIndex.counts.agents} agents, ${localIndex.counts.flows} flows${blocksCounted(localIndex.counts)} discovered`,
  );
  printIndexWarnings(localIndex, out.problem);

  const packFiles =
    language === 'java'
      ? await collectJavaContextFiles(args.packDir)
      : await collectScalaContextFiles(args.packDir);
  if (packFiles.kind === 'error') return failure(`${packFiles.message}\n`);
  const image = args.config.image;
  const system = checkAptPackages(
    image !== null && typeof image === 'object'
      ? (image as Record<string, unknown>).systemPackages
      : undefined,
    'image.systemPackages in kindgi.config.json',
  );
  if (system.kind === 'err') return failure(`kindgi build: ${system.message}\n`);
  const containerfilePath = join(args.outDir, 'Containerfile');
  await java.writeContainerfile({
    language,
    outputPath: containerfilePath,
    artifactVersion: args.artifactVersion,
    publishedAt: args.publishedAt,
    buildTarget: args.buildTarget,
    buildImageRef:
      language === 'java' ? DEFAULT_JAVA_BUILD_IMAGE_REF : DEFAULT_SCALA_BUILD_IMAGE_REF,
    runtimeImageRef: DEFAULT_JAVA_RUNTIME_IMAGE_REF,
    systemPackages: system.packages,
    declaredEnv,
  });
  const contextDir = join(args.outDir, 'context');
  await java.writeContext({
    packDir: args.packDir,
    files: packFiles.files,
    containerfilePath,
    contextDir,
  });
  lines(
    `    ✓ ${packFiles.files.length} pack file(s) in the image (the pack root, minus build output, IDE files and secrets); classes and dependencies from ${language === 'java' ? 'pom.xml' : 'build.sbt'}${system.packages.length > 0 ? `; Debian packages: ${system.packages.join(', ')}` : ''}`,
  );
  return { kind: 'ok', contextDir, counts: localIndex.counts, secrets: [] };
}

// Resolve a path to its real location, following symlinks, even when the
// path (or a leaf of it) does not exist yet: realpath the deepest existing
// ancestor, then re-append the missing tail. A final dangling symlink (the
// link exists, its target does not) is followed via readlink, so an in-pack
// symlink that points outside the pack is caught here, not mistaken for a
// plain in-pack path (nor surfaced later as an opaque ENOENT). Used so an
// in-pack symlink can't point the build output outside the pack root.
async function realpathUnderExisting(target: string, depth = 0): Promise<string> {
  const abs = resolve(target);
  try {
    return await realpath(abs);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') return abs;
  }
  // `abs` is a dangling symlink, or it (or an ancestor) does not exist yet. A
  // dangling symlink still has a target to follow; cap the chain so a cyclic
  // one can't loop forever.
  if (depth < 40) {
    try {
      if ((await lstat(abs)).isSymbolicLink()) {
        return await realpathUnderExisting(resolve(dirname(abs), await readlink(abs)), depth + 1);
      }
    } catch {
      // Not a symlink, or unreadable — fall through to the ancestor walk.
    }
  }
  return realpathDeepestAncestor(abs);
}

// Walk up to the deepest existing ancestor, realpath it (following symlinks
// in the ancestors), then re-append the missing tail lexically.
async function realpathDeepestAncestor(abs: string): Promise<string> {
  let existing = dirname(abs);
  const missing: string[] = [basename(abs)];
  for (;;) {
    try {
      return resolve(await realpath(existing), ...missing);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') return abs;
      const parent = dirname(existing);
      if (parent === existing) return abs;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

async function resolveBuildArgs(ctx: CommandContext): Promise<ArgsOutcome> {
  // --path — pack root; auto-detects repo root separately so augment-
  // mode packs (kindgi.config.ts under <repo>/kindgi/, package.json at
  // <repo>/) build correctly. See src/build/pack-root.ts for the
  // algorithm.
  const pathFlag = typeof ctx.options.path === 'string' ? ctx.options.path : undefined;
  const rootsResult = await resolvePackRoots({
    cwd: ctx.cwd,
    ...(pathFlag !== undefined && pathFlag !== '' && { pathFlag }),
  });
  if (rootsResult.kind === 'err') {
    return { kind: 'error', stderr: `${rootsResult.message}\n`, exitCode: 1 };
  }
  const { packDir, repoRoot, mode: packMode, language } = rootsResult.roots;
  const local = ctx.options.local === true;
  const push = typeof ctx.options.push === 'string' ? ctx.options.push : undefined;
  if (push !== undefined && !local) {
    return {
      kind: 'error',
      stderr: '--push goes with --local: `kindgi build --local --push [<repository>]`.\n',
      exitCode: 1,
    };
  }

  // Load kindgi.config.ts. Node 22's `--experimental-strip-types` is
  // enabled by the shebang in production; tests inject a
  // `configLoader` seam.
  const configResult = await loadBuildConfig(ctx, packDir);
  if (configResult.kind === 'error') return configResult;
  const config = configResult.config;

  // --env — resolves an env block; default 'staging'.
  const envFlag = ctx.options.env;
  const envName = typeof envFlag === 'string' && envFlag !== '' ? envFlag : 'staging';
  const envBlock =
    config.environments?.[envName] !== undefined
      ? ((config.environments as Record<string, EnvironmentConfig>)[envName] as EnvironmentConfig)
      : undefined;

  // --target — falls back to the env name.
  const targetFlag = ctx.options.target;
  const buildTarget =
    typeof targetFlag === 'string' && targetFlag !== ''
      ? targetFlag
      : (envBlock?.buildTarget ?? envName);

  // --hosted, or the env block's `build: 'hosted'` without --endpoint
  // (main.ts, `hostedRun`): the hosted build service at the API's
  // address, which takes the API key.
  const endpointFlag = ctx.options.endpoint;
  const explicitEndpoint =
    typeof endpointFlag === 'string' && endpointFlag !== '' ? endpointFlag : undefined;
  const hosted = ctx.hosted;
  const projectFlag = ctx.options.project;
  const projectId = typeof projectFlag === 'string' && projectFlag !== '' ? projectFlag : undefined;
  const credsFlag = ctx.options['registry-push-creds'];
  const registryPushCredsRef =
    typeof credsFlag === 'string' && credsFlag !== '' ? credsFlag : undefined;
  if (projectId !== undefined && !hosted) {
    return failure('--project goes with --hosted: `kindgi build --hosted --project <id>`.\n');
  }
  let hostedService:
    | { readonly endpoint: string; readonly apiUrl: string; readonly token: string }
    | undefined;
  if (hosted) {
    const clash = local
      ? "--local builds with this machine's Docker"
      : explicitEndpoint !== undefined
        ? '--endpoint names another build server'
        : registryPushCredsRef !== undefined
          ? "--registry-push-creds is for a build server's push; the hosted build service pushes to your workspace's own repository"
          : undefined;
    if (clash !== undefined) {
      return failure(`--hosted builds on the hosted build service, and ${clash}: leave one out.\n`);
    }
    // The API: the CLI's own address (`--url`, KINDGI_API_URL or the
    // stored one, never a local runtime's .kindgirc.json), the one the
    // key is for. The env block's `endpoint` may only repeat it
    // (api-address.ts).
    const address = hostedApiAddress('kindgi build --hosted', ctx.config, [
      { url: envBlock?.endpoint, where: `environments.${envName}.endpoint` },
    ]);
    if (address.kind === 'refused') return failure(`${address.message}\n`);
    const apiUrl = address.url;
    const token = address.config.token;
    if (token === undefined || token === '') {
      return failure(
        'kindgi build --hosted sends your API key to the build service, and none is set. ' +
          'Run `kindgi auth login`, export KINDGI_API_TOKEN, or pass --token <key>.\n',
      );
    }
    hostedService = { endpoint: hostedBuildEndpoint(apiUrl), apiUrl, token };
  }

  // --endpoint — flag > env block > error.
  const endpoint = hostedService?.endpoint ?? explicitEndpoint ?? envBlock?.build ?? '';
  if (endpoint === '' && !local) {
    return {
      kind: 'error',
      stderr: `kindgi build could not resolve a build-server endpoint. Set environments.${envName}.build in kindgi.config.ts or pass --endpoint <url>.\n`,
      exitCode: 1,
    };
  }

  // --out — output dir.
  const outFlag = ctx.options.out;
  const outDirRaw = typeof outFlag === 'string' && outFlag !== '' ? outFlag : DEFAULT_OUT_DIR;
  const outDir = isAbsolute(outDirRaw) ? outDirRaw : resolve(packDir, outDirRaw);

  // The build writes its output — `dist/`, the Containerfile, `context/`
  // (and `<language>/` for a JVM pack) — under --out. Rules constrain it,
  // all following symlinks (realpath) so an in-pack symlink can't slip past.
  // Mirrors the local-dependency refusal in build/host-install.ts.
  const realPackDir = await realpathUnderExisting(packDir);
  const realOutDir = await realpathUnderExisting(outDir);
  // 1. In any language, --out must not BE the pack root: the build would
  //    write its dist/, Containerfile and context/ over the pack's own files.
  if (realOutDir === realPackDir) {
    return failure(
      `--out ${outDirRaw} is the pack root ${realPackDir}: the build writes dist/, the Containerfile and context/ there, over the pack's own files. Use a subdirectory (default: ${DEFAULT_OUT_DIR}).\n`,
    );
  }
  // 1b. Nor may --out CONTAIN the pack root (an ancestor directory): the
  //     build would write dist/, the Containerfile and context/ beside the
  //     pack, over a sibling of the same name — or, when the pack is itself
  //     named like one of them, over the pack. Same hazard as (1), any
  //     language. (A TypeScript pack with such an --out is also outside-root,
  //     caught by (2); this gives every language the clearer reason.)
  const packRel = relative(realOutDir, realPackDir);
  if (packRel !== '..' && !packRel.startsWith(`..${sep}`) && !isAbsolute(packRel)) {
    return failure(
      `--out ${outDirRaw} resolves to ${realOutDir}, which contains the pack root ${realPackDir}: the build writes dist/, the Containerfile and context/ there, beside the pack — over a sibling of the same name, or the pack itself. Use a path inside the pack (default: ${DEFAULT_OUT_DIR}).\n`,
    );
  }
  // 2. A TypeScript pack's --out must stay UNDER the pack root. Its local
  //    indexer runs `node <out>/dist/kindgi-index.mjs`, whose bundle keeps
  //    the pack's dependencies (zod, @kindgi/*) as bare externals that Node
  //    resolves by walking up from <out>/dist into the pack's node_modules —
  //    only reachable under the pack root. A Python or JVM pack's indexer
  //    takes the pack dir and an explicit output path and never walks up from
  //    <out>, so its output may sit anywhere; only this walk-up is bound to
  //    the pack root.
  // 'node' is the one pack language whose indexer walks up from <out>/dist;
  // naming it positively stays correct if another language is added later.
  const isTypeScriptPack = language === 'node';
  if (isTypeScriptPack) {
    const outRel = relative(realPackDir, realOutDir);
    if (outRel === '..' || outRel.startsWith(`..${sep}`) || isAbsolute(outRel)) {
      return failure(
        `--out ${outDirRaw} resolves to ${realOutDir}, outside the pack root ${realPackDir}: a TypeScript pack's build indexes from <out>/dist and resolves the pack's dependencies by walking up into its node_modules, which only works under the pack root. Use a path inside the pack (default: ${DEFAULT_OUT_DIR}).\n`,
      );
    }
  }

  // --artifact-version and --published-at: pinned, else the build time.
  const defaults = buildTimeDefaults(new Date());
  const avFlag = ctx.options['artifact-version'];
  const artifactVersion =
    typeof avFlag === 'string' && avFlag !== '' ? avFlag : defaults.artifactVersion;
  // A given --published-at goes into the signed image as the API's
  // `date-time` (a date reads as that day's start in UTC), or deploying it
  // would be refused.
  const paFlag = ctx.options['published-at'];
  let publishedAt = defaults.publishedAt;
  if (typeof paFlag === 'string' && paFlag !== '') {
    try {
      publishedAt = timeFlagValue(paFlag, 'published-at');
    } catch (err) {
      return { kind: 'error', stderr: `${(err as Error).message}\n`, exitCode: 2 };
    }
  }

  // --tenant — flag > env block > KINDGI_TENANT_ID env var > (hosted) the
  // key's own tenant > error.
  const tenantFlag = ctx.options.tenant;
  let tenantId =
    typeof tenantFlag === 'string' && tenantFlag !== ''
      ? tenantFlag
      : (envBlock?.tenantId ??
        (typeof ctx.env.KINDGI_TENANT_ID === 'string'
          ? (ctx.env.KINDGI_TENANT_ID as string)
          : undefined));
  if ((tenantId === undefined || tenantId === '') && hostedService !== undefined) {
    try {
      tenantId = (await ctx.clientFor(hostedService.apiUrl, hostedService.token).identity.whoami())
        .tenantId as unknown as string;
    } catch (err) {
      return failure(
        `kindgi build --hosted couldn't read your key's tenant from ${hostedService.apiUrl}: ${(err as Error).message}\n`,
      );
    }
  }
  if ((tenantId === undefined || tenantId === '') && (!local || push !== undefined)) {
    return {
      kind: 'error',
      stderr: `kindgi build could not resolve a tenantId. Set environments.${envName}.tenantId in kindgi.config.ts, pass --tenant <id>, or export KINDGI_TENANT_ID.\n`,
      exitCode: 1,
    };
  }

  // --skip-integrity-gate / --skip-image-pull / --skip-sign. A hosted
  // image stays in the workspace's repository, which this machine can't
  // pull: it's checked by its index's hash.
  const skipIntegrityGate = ctx.options['skip-integrity-gate'] === true;
  const skipImagePull = ctx.options['skip-image-pull'] === true || hosted;
  const skipSign = ctx.options['skip-sign'] === true;

  // --signing-key — flag > env block; error only if we're actually
  // signing (skipSign flips this off).
  const signKeyFlag = ctx.options['signing-key'];
  const signingKeyRaw =
    typeof signKeyFlag === 'string' && signKeyFlag !== '' ? signKeyFlag : envBlock?.signingKey;
  const signingKeyPath =
    typeof signingKeyRaw === 'string' && signingKeyRaw !== ''
      ? expandHome(signingKeyRaw, ctx.home)
      : undefined;

  // --signer-key-id — flag > env block; signing falls back to the key
  // file's name. With no key there's no signature to name a key.
  const keyIdFlag = ctx.options['signer-key-id'];
  const signerKeyId =
    typeof keyIdFlag === 'string' && keyIdFlag !== '' ? keyIdFlag : envBlock?.signerKeyId;

  // --push — the repository: the flag's, else the env block's registry
  // plus the pack id.
  const packId = (config.pack as { readonly id?: unknown } | undefined)?.id;
  const pushRepository =
    push === undefined
      ? undefined
      : push !== ''
        ? push
        : envBlock?.registry !== undefined && typeof packId === 'string'
          ? `${envBlock.registry.replace(/\/+$/, '')}/${packId}`
          : undefined;
  if (push !== undefined && pushRepository === undefined) {
    return {
      kind: 'error',
      stderr: `kindgi build --push needs a repository: set environments.${envName}.registry in kindgi.config.ts, or pass --push=<repository>.\n`,
      exitCode: 1,
    };
  }
  const platformFlag = ctx.options.platform;
  const platform =
    typeof platformFlag === 'string' && platformFlag !== ''
      ? platformFlag
      : push !== undefined
        ? 'linux/amd64'
        : undefined;

  // A build that signs (the build server's, or --local --push) needs its
  // key before anything is built or sent; the other settings are checked
  // first.
  if (!skipSign && (!local || push !== undefined)) {
    const keyRefusal = await signingKeyRefusal(
      signingKeyPath,
      typeof signKeyFlag === 'string' && signKeyFlag !== ''
        ? '--signing-key'
        : `environments.${envName}.signingKey`,
      // The block the key goes in, when one is picked (with no --env and
      // no `staging` block, the hint doesn't send you to make one).
      envBlock !== undefined || (typeof envFlag === 'string' && envFlag !== '')
        ? envName
        : undefined,
    );
    if (keyRefusal !== undefined) return failure(keyRefusal);
  }

  return {
    kind: 'ok',
    args: {
      packDir,
      repoRoot,
      packMode,
      language,
      outDir,
      envName,
      endpoint,
      hosted,
      authorization: hostedService !== undefined ? `Bearer ${hostedService.token}` : undefined,
      projectId,
      buildTarget,
      registryPushCredsRef,
      artifactVersion,
      publishedAt,
      tenantId: tenantId ?? '',
      signingKeyPath,
      signerKeyId,
      skipIntegrityGate,
      skipImagePull,
      skipSign,
      local,
      pushRepository,
      platform,
      config,
    },
  };
}

/**
 * Why a build can't sign, before it starts: no key set, or a key file
 * that isn't there or isn't a file. `undefined` when the key is there to
 * read. `envName` is the env block the key goes in, when one is picked.
 */
async function signingKeyRefusal(
  keyPath: string | undefined,
  from: string,
  envName: string | undefined,
): Promise<string | undefined> {
  if (keyPath === undefined) return noSigningKey(envName);
  try {
    if ((await stat(keyPath)).isFile()) return undefined;
    return `The signing key ${keyPath} (${from}) isn't a file. Name the key's .pem file, as \`kindgi key create <id>\` writes it: ~/.kindgi/keys/<id>.pem.\n`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return `The signing key ${keyPath} (${from}) isn't there. ${MAKE_A_KEY} Then ${nameTheKey(envName)}.\n`;
  }
}

/** How a signing key comes to be, and to be trusted. */
const MAKE_A_KEY =
  "Make a key with `kindgi key create <id>`, and add it to the runtime's trust list with `kindgi key trust <id>` (once).";

function noSigningKey(envName: string | undefined): string {
  return `No signing key is set. ${MAKE_A_KEY} Then ${nameTheKey(envName)}. (--skip-sign emits an unsigned envelope, which kindgi deploy refuses.)\n`;
}

/** Where a build finds its key: the picked env block's `signingKey`, or --signing-key. */
function nameTheKey(envName: string | undefined): string {
  return envName !== undefined
    ? `set environments.${envName}.signingKey to ~/.kindgi/keys/<id>.pem in kindgi.config.ts, or pass --signing-key ~/.kindgi/keys/<id>.pem`
    : 'pass --signing-key ~/.kindgi/keys/<id>.pem, or set signingKey in an env block of kindgi.config.ts and pick that block with --env=<name> (with no --env, the block is `staging`)';
}

async function loadBuildConfig(
  ctx: CommandContext,
  packDir: string,
): Promise<
  | { readonly kind: 'ok'; readonly config: PackConfig }
  | (CommandResult & { readonly kind: 'error' })
> {
  const outcome = await loadPackConfig(ctx, packDir);
  if (outcome.kind === 'ok') return { kind: 'ok', config: outcome.config as PackConfig };
  return {
    kind: 'error',
    stderr:
      outcome.kind === 'missing'
        ? `kindgi build could not load kindgi.config.ts at ${packDir}. Run \`kindgi init <pack-name>\` to scaffold a pack, or pass --path=<dir>.\n`
        : `Failed to load kindgi.config.ts at ${packDir}: ${outcome.message}\n`,
    exitCode: 1,
  };
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function failure(stderr: string): CommandResult & { readonly kind: 'error' } {
  return { kind: 'error', stderr, exitCode: 1 };
}

/**
 * The packages the bundles load from the app's `node_modules`, for the
 * summary. Empty list → empty string (caller emits no extra line).
 */
function renderExternalsSummary(externals: readonly string[]): string {
  if (externals.length === 0) return '';
  const suffix = externals.length === 1 ? '' : 's';
  return `    ✓ ${externals.length} package${suffix} from the app's node_modules: ${externals.join(', ')}`;
}

/**
 * Read `config.discovery` and extract folder prefixes for the
 * esbuild bundler to walk. Handles both shapes:
 *
 *   discovery: { tools: 'tools/**\/*.ts', ... }     →  ['tools', ...]
 *   discovery: { tools: 'kindgi/tools/**
 * The config's code discovery patterns with defaults filled in — the
 * files the indexer loads, and so the bundler's entries. Not the blocks
 * pattern: blocks are data, read from the pack's files.
 */
export function discoveryPatternsOf(config: PackConfig): readonly string[] {
  return codePatterns(discoveryOf(config));
}

/** The config's discovery with the defaults for the pack's language filled in. */
function discoveryOf(config: PackConfig, language?: PackLanguage): Required<DiscoveryConfig> {
  const discovery = (config as { readonly discovery?: unknown }).discovery;
  return resolveDiscovery(
    typeof discovery === 'object' && discovery !== null
      ? (discovery as DiscoveryConfig)
      : undefined,
    language,
  );
}

/** The pack's blocks after its local index (`checkPackBlocks`), in every language. */
function checkBuildBlocks(
  args: ResolvedBuildArgs,
  counts: IndexedCounts,
  indexPath: string,
): Promise<PackBlocksCheck> {
  return checkPackBlocks({
    packDir: args.packDir,
    pattern: discoveryOf(args.config, args.language).blocks,
    indexPath,
    blocksCounted: counts.blocks !== undefined,
    indexer: packIndexerName(args.language),
    release: CLI_VERSION,
  });
}

/** `, 2 blocks` for the indexed line, when the pack has any. */
function blocksCounted(counts: IndexedCounts): string {
  return counts.blocks !== undefined && counts.blocks > 0 ? `, ${counts.blocks} blocks` : '';
}

/**
 * An unpinned build's artifact version and publish time, from one clock
 * reading: `YYYYMMDD.HHMMSS` and the ISO time, both UTC. Builds a second or
 * more apart get different versions, so a second build the same day gets
 * its own image tag; the versions sort in build order.
 */
export function buildTimeDefaults(now: Date): {
  readonly artifactVersion: string;
  readonly publishedAt: string;
} {
  const two = (n: number): string => String(n).padStart(2, '0');
  const day = `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}`;
  const time = `${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`;
  return { artifactVersion: `${day}.${time}`, publishedAt: now.toISOString() };
}

function expandHome(path: string, home: string | undefined): string {
  if (!path.startsWith('~')) return path;
  const h = home ?? process.env.HOME ?? '';
  return `${h}${path.slice(1)}`;
}

function basenameNoExt(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const base = idx === -1 ? path : path.slice(idx + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? base : base.slice(0, dot);
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Type export for the loader hook — the CommandContext extension in
// context.ts declares it; re-exporting here so tests can name it
// alongside `runBuild`.
export type BuildConfigLoader = (packDir: string) => Promise<PackConfig>;
export type { BuildRunners, LocalIndexResult };

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Each of `warnings`, a line each: said under `--quiet` too. */
function warn(out: ProgressLines, warnings: readonly string[]): void {
  for (const w of warnings) out.problem(w);
}

/** The indexer's warnings, a line each: what the pack should change, though it builds as it is. */
function printIndexWarnings(
  result: { readonly warnings?: readonly { readonly message: string }[] },
  problem: (s: string) => void,
): void {
  for (const w of result.warnings ?? []) problem(`    ⚠ ${w.message}`);
}

/** The image's dependencies, as the build says them (`image.dependencies`). */
function renderDependenciesMode(image: ResolvedImage): string {
  if (image.dependencies === 'all') {
    return "    ✓ Dependencies: all of the app's production dependencies (image.dependencies: 'loaded' keeps only what the pack loads)";
  }
  const kept = [...image.keep, ...image.keepIfInstalled];
  return `    ✓ Dependencies: only what the pack loads (image.dependencies: 'loaded')${kept.length > 0 ? `, and ${kept.join(', ')}` : ''}`;
}

/** The image's dependencies, said, and with `'loaded'` the computed-import check's warnings. */
function dependenciesStep(
  image: ResolvedImage,
  computed: readonly ComputedImport[] | undefined,
  packDir: string,
):
  | { readonly kind: 'refuse'; readonly message: string }
  | { readonly kind: 'ok'; readonly mode: string; readonly warnings: readonly string[] } {
  const mode = renderDependenciesMode(image);
  if (image.dependencies === 'all') return { kind: 'ok', mode, warnings: [] };
  const check = computedImportsCheck(computed ?? [], image.keep, packDir);
  return check.kind === 'refuse' ? check : { kind: 'ok', mode, warnings: check.lines };
}

/**
 * With `'loaded'`: a computed `require(x)` / `import(x)` in the pack's
 * own code loads a package the closure can't see. With no `image.keep`,
 * the build refuses, naming each call; with one, it names them as a
 * reminder that `keep` must cover what they load.
 */
export function computedImportsCheck(
  computed: readonly ComputedImport[],
  keep: readonly string[],
  packDir: string,
):
  | { readonly kind: 'refuse'; readonly message: string }
  | { readonly kind: 'ok'; readonly lines: readonly string[] } {
  if (computed.length === 0) return { kind: 'ok', lines: [] };
  const sites = computed.map((c) => `  ${relative(packDir, c.file)}:${c.line}  ${c.text}`);
  if (keep.length === 0) {
    return {
      kind: 'refuse',
      message: `The pack's code loads a module by a computed name, and the image keeps only the packages the pack imports by name (image.dependencies: 'loaded'):\n${sites.join('\n')}\nName the packages these load in image.keep, or set image.dependencies: 'all'.\n`,
    };
  }
  return {
    kind: 'ok',
    lines: [
      `    ⚠ Loaded by a computed name; image.keep (${keep.join(', ')}) must cover what these load:`,
      ...sites.map((s) => `    ${s}`),
    ],
  };
}

/**
 * A Python pack's `[tool.kindgi.image]` can't ask for an image that keeps
 * only what the pack loads yet: refused, never silently ignored.
 */
export function pythonTrimmingRefusal(image: unknown): string | undefined {
  if (image === null || typeof image !== 'object') return undefined;
  const table = image as Record<string, unknown>;
  const dependencies = table.dependencies;
  if (dependencies !== undefined && dependencies !== 'all' && dependencies !== 'loaded') {
    return `[tool.kindgi.image] dependencies is "loaded" or "all". Got ${JSON.stringify(dependencies)}.`;
  }
  if (dependencies === 'loaded' || table.keep !== undefined) {
    return `[tool.kindgi.image] ${dependencies === 'loaded' ? 'dependencies = "loaded"' : 'keep'} isn't available for Python packs yet: a Python pack's image keeps every dependency in its lockfile. Remove it, or set dependencies = "all".`;
  }
  return undefined;
}

/**
 * The closure's own lines in a build log (`kindgi-closure: …`), as the
 * summary prints them: what it kept of what's installed, and which of
 * the pack's own dependencies it dropped.
 */
export function closureSummary(logLines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of logLines) {
    const match = /kindgi-closure: ((?:kept|dropped) .*)$/.exec(line);
    if (match?.[1] !== undefined) out.push(`    ✓ Dependencies: ${match[1]}`);
  }
  return out;
}
