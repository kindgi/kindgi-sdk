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

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  type DiscoveryConfig,
  type PackLanguage,
  findKindgiConfig,
  resolveDiscovery,
} from '@kindgi/handler-runtime';

import { checkAptPackages } from '../build/apt.js';
import { PACK_SERVICE_COMMAND } from '../build/containerfile.js';
import { collectIncludeFiles, readBundleConfig } from '../build/context-files.js';
import { buildEnvelope, canonicaliseSignatureBody, sha256Hex } from '../build/envelope.js';
import {
  type HostInstall,
  type SkippedScript,
  devOnlyImports,
  resolveHostInstall,
} from '../build/host-install.js';
import { readImageConfig } from '../build/image-config.js';
import { checkIntegrity } from '../build/integrity.js';
import { nodeBaseImageFor } from '../build/node-image.js';
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
  TarPackResult,
  TerminalPayload,
} from '../build/runners.js';
import type { CommandContext } from '../context.js';
import { resolvePackPython } from '../dev/pack-code.js';
import type { IndexedCounts } from '../dev/runners.js';
import { renderJson } from '../output.js';
import { loadPackConfig } from '../pack-config.js';
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
}

export interface PackConfig {
  readonly pack?: { readonly id?: string; readonly version?: string };
  readonly environments?: Readonly<Record<string, EnvironmentConfig>>;
  readonly [k: string]: unknown;
}

export const DEFAULT_OUT_DIR = '.kindgi/build';
/** SOURCE_DATE_EPOCH=0 baseline — the build-server also pins epoch=0. */
export const DEFAULT_PUBLISHED_AT = '1970-01-01T00:00:00.000Z';

export const buildCommand: LeafCommand = {
  kind: 'leaf',
  name: 'build',
  description:
    'Bundle + build + sign a pack image. Emits deploy-envelope.json for `kindgi deploy`. ' +
    "`--local` builds the image with this machine's Docker instead: no build service, no signing; " +
    'with `--push`, it pushes the image, signs it, and writes the envelope.',
  usage:
    'kindgi build [--local [--push [<repository>]] [--platform <os/arch>]] [--target <t>] [--endpoint <url>] [--env <name>] [--out <dir>] ' +
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
    target: {
      type: 'string',
      description:
        "The build target, set in the image build and sent to the build server. Default: the env block's `buildTarget`, else the env name.",
    },
    endpoint: {
      type: 'string',
      description: "The build server. Default: the env block's `build`. Not used with `--local`.",
    },
    env: {
      type: 'string',
      description: 'The environment block in `kindgi.config.ts` to build for. Default: `staging`.',
    },
    out: {
      type: 'string',
      description:
        'Where the build output and `deploy-envelope.json` go. Default: `.kindgi/build` under the pack root.',
    },
    'artifact-version': {
      type: 'string',
      description:
        "The artifact version, in the image and its signature. Default: today's date as `YYYYMMDD.1` (UTC).",
    },
    'published-at': {
      type: 'string',
      description:
        'The publish time (ISO 8601), in the image and its signature. Default: the Unix epoch, so builds are reproducible.',
    },
    tenant: {
      type: 'string',
      description:
        "The tenant the signature names. Default: the env block's `tenantId`, else `KINDGI_TENANT_ID`.",
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
  run: async (ctx): Promise<CommandResult> => runBuild(ctx),
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
  readonly buildTarget: string;
  readonly registryPushCredsRef: string | undefined;
  readonly artifactVersion: string;
  readonly publishedAt: string;
  readonly tenantId: string;
  readonly signingKeyPath: string | undefined;
  readonly signerKeyId: string;
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

export async function runBuild(ctx: CommandContext): Promise<CommandResult> {
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
  if (args.local) return runLocalBuild(ctx, runners, args);

  const banner: string[] = [];
  const lines = (s: string): void => {
    banner.push(s);
  };
  lines('');
  lines(`  Environment: ${args.envName}`);
  lines(`  Build:       ${args.endpoint}`);
  lines(`  Target:      ${args.buildTarget}`);
  lines(`  Tenant:      ${args.tenantId}`);
  lines(`  Signing key: ${args.signingKeyPath ?? '(--skip-sign)'}`);
  lines(`  Output:      ${args.outDir}`);
  lines('');

  // ---- 1. Local indexer pass ------------------------------------------
  const expectedIndexPath = join(args.outDir, 'expected-index.json');
  await mkdir(args.outDir, { recursive: true });
  const prepared = await prepareTarball(ctx, runners, args, expectedIndexPath, lines);
  if (prepared.kind === 'error') return prepared;
  const { tarball, tarballHash, counts } = prepared;
  lines('');

  // ---- 6. POST /v1/build + SSE stream ---------------------------------
  lines('  Uploading to build service');
  const posted = await runners.postBuild({
    endpoint: args.endpoint,
    tarballBytes: tarball.bytes,
    tarballSha256: tarballHash,
    buildTarget: args.buildTarget,
    ...(args.registryPushCredsRef !== undefined && {
      registryPushCredsRef: args.registryPushCredsRef,
    }),
    fetchImpl: ctx.fetch,
  });
  lines(`    ✓ POST /v1/build  →  buildJob: ${posted.buildJobId}`);

  let terminal: TerminalPayload;
  if (posted.terminal !== undefined) {
    // Idempotent replay — server returned the terminal payload inline.
    terminal = posted.terminal;
    lines('    ✓ Existing build (idempotent replay)');
  } else {
    lines('    → Streaming build logs');
    const captured: string[] = [];
    terminal = await runners.streamBuildLogs({
      endpoint: args.endpoint,
      buildJobId: posted.buildJobId,
      fetchImpl: ctx.fetch,
      onLog: (line: string): void => {
        captured.push(line);
        // Fold multi-line output into the banner one line at a time,
        // so the build log reads as part of the summary.
        lines(`        ${line}`);
      },
      ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
    });
  }

  if (terminal.status === 'failed') {
    return failure(
      `Build failed: [${terminal.error?.code ?? 'unknown'}] ${terminal.error?.message ?? 'no message'}\n`,
    );
  }
  if (
    terminal.imageRef === undefined ||
    terminal.imageDigest === undefined ||
    terminal.indexJson === undefined ||
    terminal.indexHash === undefined
  ) {
    return failure(
      'Build terminal payload missing required fields (imageRef / imageDigest / indexJson / indexHash).\n',
    );
  }
  lines(`    ✓ Build complete (${terminal.imageRef})`);
  lines('');

  // ---- 7. Local integrity gate ----------------------------------------
  const expectedBytes = new Uint8Array(await readFile(expectedIndexPath));
  const expectedHash = await sha256Hex(expectedBytes);

  let serverBytes: Uint8Array | undefined;
  lines('  Verifying build output');
  if (args.skipIntegrityGate) {
    lines('    ⚠ Integrity gate SKIPPED — --skip-integrity-gate. Signature will attest to');
    lines('      the server-reported hash without local re-verification. NOT RECOMMENDED.');
  } else {
    if (args.skipImagePull || runners.pullImageIndex === undefined) {
      lines('    ⚠ Image pull SKIPPED — hash-only comparison. Byte-diff path unavailable');
      lines('      (requires Docker). CI environments where this is expected can safely');
      lines('      omit --skip-image-pull warnings.');
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
        lines(`    ⚠ docker pull failed: ${(err as Error).message}`);
        lines('      Falling back to hash-only comparison.');
      }
    }
    const check = checkIntegrity({
      expectedBytes,
      expectedHash,
      serverReportedHash: terminal.indexHash,
      ...(serverBytes !== undefined && { serverBytes }),
    });
    if (!check.ok) {
      return failure(
        `Integrity gate FAILED — refusing to sign.\n\n${check.reason ?? 'unknown reason'}\n`,
      );
    }
    lines(`    ✓ indexHash matches local indexer output (${terminal.indexHash.slice(0, 14)}…)`);
    if (serverBytes !== undefined) {
      lines('    ✓ /app/index.json extracted from image matches byte-for-byte');
    }
  }
  lines('');

  // ---- 8. Sign + 9. emit deploy-envelope.json ------------------------------
  const written = await signAndWriteEnvelope(runners, args, lines, {
    imageRef: terminal.imageRef,
    imageDigest: terminal.imageDigest,
    index: terminal.indexJson,
    indexHash: terminal.indexHash,
    ...(terminal.buildLogsUrl !== undefined && { buildLogsUrl: terminal.buildLogsUrl }),
  });
  if (written.kind === 'error') return written;
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
  return {
    kind: 'ok',
    rendered: { stdout: rendered.stdout, stderr: `${banner.join('\n')}\n` },
  };
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
): Promise<CommandResult> {
  if (runners.dockerBuild === undefined || runners.pullImageIndex === undefined) {
    return failure('kindgi build --local needs Docker runners; rebuild the CLI.\n');
  }
  const banner: string[] = [];
  const lines = (s: string): void => {
    banner.push(s);
  };
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
  const context = await preparePackContext(ctx, runners, args, expectedIndexPath, lines);
  if (context.kind === 'error') return withBanner(context, banner);
  const expectedBytes = new Uint8Array(await readFile(expectedIndexPath));
  const packId = (JSON.parse(new TextDecoder().decode(expectedBytes)) as { packId?: unknown })
    .packId;
  const tag = `${pushTo ?? `kindgi-pack/${typeof packId === 'string' ? packId : 'pack'}`}:${args.artifactVersion}`;
  lines('');

  lines(`  Building ${tag}`);
  const built = await runners.dockerBuild({
    contextDir: context.contextDir,
    tag,
    buildTarget: args.buildTarget,
    ...(args.platform !== undefined && { platform: args.platform }),
    ...(pushTo !== undefined && { push: true }),
    secrets: context.secrets.map(({ id, src }) => ({ id, src })),
    onLog: (line) => lines(`        ${line}`),
  });
  if (built.kind === 'err')
    return withBanner(failure(`Image build failed: ${built.message}\n`), banner);
  if (pushTo !== undefined && built.digest === undefined) {
    return withBanner(failure(`The push of ${tag} reported no digest.\n`), banner);
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
      banner,
    );
  }
  lines('    ✓ /app/index.json in the image matches the local index byte for byte');
  lines('');

  if (pushTo !== undefined && built.digest !== undefined) {
    const written = await signAndWriteEnvelope(runners, args, lines, {
      imageRef,
      imageDigest: built.digest,
      index: JSON.parse(new TextDecoder().decode(expectedBytes)) as Record<string, unknown>,
      indexHash: expectedHash,
    });
    if (written.kind === 'error') return withBanner(written, banner);
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
    return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr: `${banner.join('\n')}\n` } };
  }

  lines('  Run it:');
  lines(
    `    docker run --rm -p 8080:8080 -e KINDGI_PACK_SERVICE_TOKEN=<token> --env-file <the pack's env> ${tag}`,
  );
  const service = args.language === 'python' ? PYTHON_PACK_SERVICE_COMMAND : PACK_SERVICE_COMMAND;
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
  return { kind: 'ok', rendered: { stdout: rendered.stdout, stderr: `${banner.join('\n')}\n` } };
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
  lines: (s: string) => void,
  image: BuiltImage,
): Promise<
  | {
      readonly kind: 'ok';
      readonly envelopePath: string;
      readonly signature: Signature | undefined;
    }
  | (CommandResult & { readonly kind: 'error' })
> {
  let signature: Signature | undefined;
  if (args.skipSign) {
    lines('  ⚠ Signing SKIPPED — --skip-sign. Emitted envelope is unsigned; deploy will refuse');
    lines('    it. Use only for CI that signs elsewhere.');
  } else if (args.signingKeyPath === undefined) {
    return failure(
      'Signing key not configured. Set environments.<env>.signingKey in kindgi.config.ts, ' +
        'pass --signing-key <path>, or use --skip-sign to emit an unsigned envelope.\n',
    );
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
    signature = { ...signed, keyId: args.signerKeyId };
    lines('  Signing locally');
    lines(
      '    ✓ Ed25519 signature over (imageDigest, artifactVersion, indexHash, tenantId, publishedAt)',
    );
    lines(`      key: ${args.signerKeyId}`);
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

/** A failure that still shows what the build did up to it. */
function withBanner(
  result: CommandResult & { readonly kind: 'error' },
  banner: readonly string[],
): CommandResult & { readonly kind: 'error' } {
  return { ...result, stderr: `${banner.join('\n')}\n${result.stderr}` };
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
  lines: (s: string) => void,
): Promise<PackContext> {
  return args.language === 'python'
    ? preparePythonContext(ctx, runners, args, expectedIndexPath, lines)
    : prepareNodeContext(runners, args, expectedIndexPath, lines);
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
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
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
  lines: (s: string) => void,
): Promise<PackContext> {
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
  lines(
    `    ✓ ${localIndex.counts.tools} tools, ${localIndex.counts.guardrails} guardrails, ` +
      `${localIndex.counts.agents} agents, ${localIndex.counts.flows} flows indexed`,
  );

  // ---- 3. Containerfile + context --------------------------------------
  const containerfilePath = join(args.outDir, 'Containerfile');
  await runners.writeContainerfile({
    outputPath: containerfilePath,
    artifactVersion: args.artifactVersion,
    publishedAt: args.publishedAt,
    baseImageRef: base.image.ref,
    buildTarget: args.buildTarget,
    install,
    image,
    hasIncludes: includeFiles.files.length > 0,
  });
  const contextDir = join(args.outDir, 'context');
  await runners.writeContext({
    contextDir,
    packDir: args.packDir,
    install,
    bundleDir,
    containerfilePath,
    includes: includeFiles.files,
    extensionFiles: image.contextFiles,
  });
  lines(
    `    ✓ Context: ${install.files.length} install file(s), the bundles${includeFiles.files.length > 0 ? `, ${includeFiles.files.length} bundle.include file(s)` : ''}; no pack source`,
  );
  if (install.secrets.length > 0) {
    lines(
      `    ✓ ${install.secrets.map((s) => s.file).join(', ')}: read by the install as a build secret, never in the image`,
    );
  }
  for (const line of skippedScriptLines(install.skippedScripts)) lines(line);
  const secrets = install.secrets.map((secret) => ({
    id: secret.id,
    src: join(install.root, secret.file),
    file: secret.file,
  }));
  return { kind: 'ok', contextDir, counts: localIndex.counts, secrets };
}

/**
 * What the image leaves out of the app's own install scripts, and what
 * to do when one of them is something the image needs: `patch-package`
 * (pnpm's own patches are applied by the install).
 */
export function skippedScriptLines(skipped: readonly SkippedScript[]): string[] {
  if (skipped.length === 0) return [];
  const where = (s: SkippedScript): string =>
    s.manifest === 'package.json' ? s.name : `${s.manifest} ${s.name}`;
  const lines = [
    `    ✓ The app's own install scripts don't run in the image: ${skipped.map((s) => `${where(s)} (\`${s.command}\`)`).join(', ')}`,
  ];
  for (const s of skipped.filter((s) => /\bpatch-package\b/.test(s.command))) {
    lines.push(
      `    ⚠ ${where(s)} runs patch-package, so its patches aren't applied in the image. Apply them with a build step: defineBuildExtension({ name: 'patch-package', contextFiles: [<each file in patches/>], postInstall: [{ bin: 'patch-package' }] }) in image.extensions (@kindgi/sdk/build). With pnpm, pnpm patch applies them in the install itself.`,
    );
  }
  return lines;
}

/** A pack's context, tarred for the build service. */
async function prepareTarball(
  ctx: CommandContext,
  runners: BuildRunners,
  args: ResolvedBuildArgs,
  expectedIndexPath: string,
  lines: (s: string) => void,
): Promise<PreparedContext> {
  const context = await preparePackContext(ctx, runners, args, expectedIndexPath, lines);
  if (context.kind === 'error') return context;
  if (context.secrets.length > 0) {
    lines(
      `    ⚠ The build service gets no build secrets: an install that needs ${context.secrets.map((s) => s.file).join(', ')} (a private registry) fails there. \`kindgi build --local\` passes them.`,
    );
  }
  const tarballPath = join(args.outDir, 'pack.tgz');
  const tarball = await runners.tarPack({
    contextDir: context.contextDir,
    outputPath: tarballPath,
  });
  const tarballHash = await sha256Hex(tarball.bytes);
  lines(`    ✓ Emitted ${tarballPath} (${humanBytes(tarball.size)}, ${tarballHash.slice(0, 14)}…)`);
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
  lines: (s: string) => void,
): Promise<PackContext> {
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
  lines(`  Indexing (Python — ${interpreter.value.join(' ')})`);
  lines(
    `    ✓ ${localIndex.counts.tools} tools, ${localIndex.counts.guardrails} guardrails, ` +
      `${localIndex.counts.agents} agents, ${localIndex.counts.flows} flows discovered`,
  );

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

  // --endpoint — flag > env block > error.
  const endpointFlag = ctx.options.endpoint;
  const endpoint =
    typeof endpointFlag === 'string' && endpointFlag !== ''
      ? endpointFlag
      : (envBlock?.build ?? '');
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

  // --artifact-version — pinned or auto YYYYMMDD.1.
  const avFlag = ctx.options['artifact-version'];
  const artifactVersion =
    typeof avFlag === 'string' && avFlag !== '' ? avFlag : defaultArtifactVersion();

  // --published-at — SOURCE_DATE_EPOCH=0 baseline unless overridden.
  const paFlag = ctx.options['published-at'];
  const publishedAt = typeof paFlag === 'string' && paFlag !== '' ? paFlag : DEFAULT_PUBLISHED_AT;

  // --tenant — flag > env block > KINDGI_TENANT_ID env var > error.
  const tenantFlag = ctx.options.tenant;
  const tenantId =
    typeof tenantFlag === 'string' && tenantFlag !== ''
      ? tenantFlag
      : (envBlock?.tenantId ??
        (typeof ctx.env.KINDGI_TENANT_ID === 'string'
          ? (ctx.env.KINDGI_TENANT_ID as string)
          : undefined));
  if ((tenantId === undefined || tenantId === '') && (!local || push !== undefined)) {
    return {
      kind: 'error',
      stderr: `kindgi build could not resolve a tenantId. Set environments.${envName}.tenantId in kindgi.config.ts, pass --tenant <id>, or export KINDGI_TENANT_ID.\n`,
      exitCode: 1,
    };
  }

  // --skip-integrity-gate / --skip-image-pull / --skip-sign
  const skipIntegrityGate = ctx.options['skip-integrity-gate'] === true;
  const skipImagePull = ctx.options['skip-image-pull'] === true;
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

  // --signer-key-id — derive from key filename basename if not
  // explicitly configured.
  const keyIdFlag = ctx.options['signer-key-id'];
  const signerKeyId =
    typeof keyIdFlag === 'string' && keyIdFlag !== ''
      ? keyIdFlag
      : (envBlock?.signerKeyId ??
        (signingKeyPath !== undefined ? basenameNoExt(signingKeyPath) : `${envName}-signer`));

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

  // --registry-push-creds — opaque reference, empty means undefined.
  const credsFlag = ctx.options['registry-push-creds'];
  const registryPushCredsRef =
    typeof credsFlag === 'string' && credsFlag !== '' ? credsFlag : undefined;

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
 *   discovery: { tools: 'kindgi/tools/** The config's discovery patterns with defaults filled in — what the indexer uses. */
export function discoveryPatternsOf(config: PackConfig): readonly string[] {
  const discovery = (config as { readonly discovery?: unknown }).discovery;
  return Object.values(
    resolveDiscovery(
      typeof discovery === 'object' && discovery !== null
        ? (discovery as DiscoveryConfig)
        : undefined,
    ),
  );
}

function defaultArtifactVersion(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}.1`;
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
