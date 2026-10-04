// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Injectable seams for `kindgi build`. Every side effect flows through
 * this interface so tests can substitute fixtures without invoking real
 * esbuild, real `tar`, real `fetch`, or Docker. Production wiring lives
 * at `packages/cli/src/build/defaults.ts`.
 *
 * `kindgi build` is the CLI-side orchestrator, in nine steps:
 *
 *   1. Local indexer pass (integrity gate baseline)
 *   2. esbuild bundle
 *   3. Generate multi-stage Containerfile
 *   4. Tar the bundle
 *   5. Compute sha256(pack.tgz)
 *   6. POST /v1/build + subscribe to SSE build logs (terminal payload =
 *      { imageRef, imageDigest, indexJson, indexHash, buildLogsUrl })
 *   7. Local integrity gate — hash diff + optional docker pull + diff
 *   8. Sign locally (Ed25519 over canonicalised envelope body)
 *   9. Emit deploy-envelope.json (`kindgi deploy` POSTs this file)
 *
 * The full pipeline is composed by `commands/build.ts` from the seams
 * declared here. Each seam is named per its pipeline step so a test
 * looking at a failing stage can substitute only that field.
 */

import type { IndexResult } from '../dev/runners.js';

/**
 * The manifest slot the local integrity gate uses. Kept structural so
 * tests hand back plain objects without importing
 * `@kindgi/handler-runtime`. Production wiring runs the bundled
 * `kindgi-index.mjs` over the bundles, as the image's indexer stage
 * does, and reads `expected-index.json` back off disk.
 */
export type LocalIndexResult = IndexResult;

export interface RunLocalIndexerOptions {
  readonly packDir: string;
  /** The bundles (`esbuildBundle`'s `outputDir`): the indexer, the config, the bundle map. */
  readonly bundleDir: string;
  readonly outputPath: string;
  readonly artifactVersion: string;
  readonly publishedAt: string;
}

export interface EsbuildBundleOptions {
  readonly packDir: string;
  readonly outputDir: string;
  /**
   * The pack's discovery patterns (defaults filled in) — every file
   * they match is bundled as an entrypoint, the same set the indexer
   * discovers.
   */
  readonly discoveryPatterns: readonly string[];
  /** The pack's `kindgi.config.*`, bundled to `kindgi.config.mjs`. */
  readonly configPath: string;
  /** The Node major the image runs: the bundles' esbuild target. */
  readonly nodeMajor: number;
}

export interface EsbuildBundleResult {
  /** Absolute paths of every emitted file (bundles and sourcemaps). */
  readonly emitted: readonly string[];
  /** Total bundle byte size — surfaced in the summary. */
  readonly totalBytes: number;
  /** The packages the pack's bundles import from `node_modules`, sorted. */
  readonly externals: readonly string[];
  /** Each primitive's source path → its bundle, under `outputDir` (`bundle-map.json`). */
  readonly bundleMap: Readonly<Record<string, string>>;
}

import type { HostInstall, HostSecret } from './host-install.js';
import type { ResolvedImage } from './image-config.js';
import type { PythonInstaller } from './python-image.js';

export interface WriteContainerfileOptions {
  readonly outputPath: string;
  readonly artifactVersion: string;
  readonly publishedAt: string;
  /** The pinned base image (`node-image.ts`). */
  readonly baseImageRef: string;
  /** buildTarget threaded into the ARG for the indexer stage. */
  readonly buildTarget: string;
  readonly install: HostInstall;
  /** What `image` in `kindgi.config` adds. */
  readonly image: ResolvedImage;
  /** Whether the context has `include/` (`bundle.include` files). */
  readonly hasIncludes: boolean;
}

export interface WriteContextOptions {
  readonly contextDir: string;
  readonly packDir: string;
  readonly install: HostInstall;
  readonly bundleDir: string;
  readonly containerfilePath: string;
  /** `bundle.include` files, relative to `packDir`. */
  readonly includes: readonly string[];
  /** The files the image's build extensions read, relative to `packDir`. */
  readonly extensionFiles: readonly string[];
}

export interface TarPackOptions {
  /** A context `writeContext` wrote; removed once tarred. */
  readonly contextDir: string;
  readonly outputPath: string;
}

export interface DockerBuildOptions {
  readonly contextDir: string;
  readonly tag: string;
  readonly buildTarget: string;
  /** The image's platform (`linux/amd64`). Absent: this machine's. */
  readonly platform?: string;
  /** Push `tag` to its registry instead of loading it into the local image store. */
  readonly push?: boolean;
  /** Registry config for the install, as BuildKit secrets. */
  readonly secrets: readonly (Pick<HostSecret, 'id'> & { readonly src: string })[];
  readonly onLog?: (line: string) => void;
}

export type DockerBuildResult =
  | {
      readonly kind: 'ok';
      /** Loaded: the local image id. Pushed: the pushed manifest's digest. */
      readonly imageId: string;
      /** Pushed: the digest the registry has (`sha256:…`). */
      readonly digest?: string;
    }
  | { readonly kind: 'err'; readonly message: string };

export interface TarPackResult {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly size: number;
}

export interface PostBuildOptions {
  readonly endpoint: string;
  readonly tarballBytes: Uint8Array;
  readonly tarballSha256: string;
  readonly buildTarget: string;
  readonly registryPushCredsRef?: string;
  readonly fetchImpl: typeof fetch;
}

export interface PostBuildResult {
  readonly buildJobId: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed';
  readonly buildLogsUrl: string;
  /**
   * When the build server replays an idempotent hit (200 with existing
   * completed job), the terminal payload is returned inline — the caller
   * can skip the SSE stream.
   */
  readonly terminal?: TerminalPayload;
}

export interface TerminalPayload {
  readonly status: 'completed' | 'failed';
  readonly imageRef?: string;
  readonly imageDigest?: string;
  readonly indexJson?: Readonly<Record<string, unknown>>;
  readonly indexHash?: string;
  readonly buildLogsUrl?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface StreamBuildLogsOptions {
  readonly endpoint: string;
  readonly buildJobId: string;
  readonly fetchImpl: typeof fetch;
  readonly onLog: (line: string) => void;
  readonly signal?: AbortSignal;
}

export interface PullImageIndexOptions {
  readonly imageRef: string;
  readonly workDir: string;
  /** `false`: the image is in the local store already (`--local`). Default: pull it. */
  readonly pull?: boolean;
  /** The image's platform, when it isn't this machine's (an amd64 image on Apple silicon). */
  readonly platform?: string;
  readonly onLog?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export interface PullImageIndexResult {
  /** Raw bytes of `/app/index.json` extracted from the image. */
  readonly bytes: Uint8Array;
}

export interface SignOptions {
  /** PEM-encoded PKCS8 Ed25519 private key. */
  readonly privateKeyPem: string;
  /** Bytes to sign — the canonicalised signature body. */
  readonly message: Uint8Array;
}

export interface SignResult {
  /** Base64-encoded 64-byte signature. */
  readonly signatureBase64: string;
  /** PEM-encoded public key derived from the private key. */
  readonly publicKeyPem: string;
}

/**
 * The steps that differ for a Python pack (`[tool.kindgi]` in
 * `pyproject.toml`): no bundle — its own indexer with the pack's
 * interpreter, its own Containerfile, the pack root as the context. The
 * context is tarred (`tarPack`) or built (`dockerBuild`) as a Node pack's.
 */
export interface PythonBuildRunners {
  readonly runLocalIndexer: (
    opts: Omit<RunLocalIndexerOptions, 'bundleDir'> & {
      readonly python: readonly [string, ...string[]];
      readonly env: Readonly<Record<string, string>>;
    },
  ) => Promise<LocalIndexResult>;
  readonly writeContainerfile: (
    opts: Omit<WriteContainerfileOptions, 'baseImageRef' | 'install' | 'image' | 'hasIncludes'> & {
      readonly baseImageRef: string;
      readonly uvImageRef: string;
      readonly installer: PythonInstaller;
      /** Debian packages for the image, checked (`checkAptPackages`). */
      readonly systemPackages: readonly string[];
    },
  ) => Promise<void>;
  /** Writes the build context: `files` (pack-relative) and the Containerfile. */
  readonly writeContext: (opts: {
    readonly packDir: string;
    readonly files: readonly string[];
    readonly containerfilePath: string;
    readonly contextDir: string;
  }) => Promise<void>;
}

/**
 * Injected seams the `build` command consumes. Every side effect must
 * pass through one of these — no `import('esbuild')` / `import('tar')`
 * inside `commands/build.ts` and no direct docker or filesystem writes
 * outside these methods. Tests substitute per-field to exercise every
 * pipeline branch without ever booting real esbuild / real tar / real
 * docker / real network.
 */
export interface BuildRunners {
  /** Runs the CLI's own indexer against the pack + writes to `outputPath`. */
  readonly runLocalIndexer: (opts: RunLocalIndexerOptions) => Promise<LocalIndexResult>;
  /** Bundles the pack source + framework entrypoints into `outputDir`. */
  readonly esbuildBundle: (opts: EsbuildBundleOptions) => Promise<EsbuildBundleResult>;
  /** Emits the multi-stage Containerfile at `outputPath`. */
  readonly writeContainerfile: (opts: WriteContainerfileOptions) => Promise<void>;
  /** Writes the image's build context: the install's files, the bundles, the includes, the Containerfile. */
  readonly writeContext: (opts: WriteContextOptions) => Promise<void>;
  /** Tars a written context into a single gzipped archive. */
  readonly tarPack: (opts: TarPackOptions) => Promise<TarPackResult>;
  /** `--local`: builds the image into the local Docker image store. */
  readonly dockerBuild?: (opts: DockerBuildOptions) => Promise<DockerBuildResult>;
  /** POSTs the tarball to `POST /v1/build`. */
  readonly postBuild: (opts: PostBuildOptions) => Promise<PostBuildResult>;
  /**
   * Subscribes to `GET /v1/build/:jobId/stream`. Forwards each `log`
   * event to `onLog`. Resolves with the terminal payload the server
   * emits before closing the stream.
   */
  readonly streamBuildLogs: (opts: StreamBuildLogsOptions) => Promise<TerminalPayload>;
  /**
   * Optional docker-pull-and-extract path. When absent OR when the
   * command runs with `--skip-image-pull`, the integrity gate uses only
   * the hash-comparison path.
   */
  readonly pullImageIndex?: (opts: PullImageIndexOptions) => Promise<PullImageIndexResult>;
  /**
   * Ed25519 signature over the canonicalised envelope body. Returns the
   * base64-encoded signature + the derived public key in PEM.
   */
  readonly signEnvelope: (opts: SignOptions) => Promise<SignResult>;
  /** A Python pack's steps; absent → `kindgi build` refuses a Python pack. */
  readonly python?: PythonBuildRunners;
}
