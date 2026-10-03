// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Injectable seams for `kindgi dev`. The command consumes only these
 * interfaces so tests can hand in a mock runtime / indexer / watcher
 * without touching Docker, Postgres, the filesystem, or `fs.watch`'s
 * cross-platform caveats. Production callers wire the real ones from
 * `packages/cli/src/dev/defaults.ts`: the Kindgi runtime as a container,
 * `runIndexer` (`@kindgi/handler-runtime`), and an `fs.watch` bridge.
 */

import type {
  PackServiceSupervisor,
  PackServiceSupervisorEvent,
} from '@kindgi/handler-runtime/pack-service';

import type { PackCode } from './pack-code.js';

/** The running Kindgi runtime `kindgi dev` talks to. */
export interface RunningApiServer {
  readonly baseUrl: string;
  readonly port: number;
  readonly tenantId: string;
  /** The user the dev token resolves to. */
  readonly userId: string;
  /**
   * Default project id for the boot tenant. Required for POST-body
   * primitive-registration routes. `kindgi dev`
   * threads this into `registerFromIndex` so scaffolded packs land
   * under the tenant's Default project.
   */
  readonly defaultProjectId: string;
  readonly token: string;
  readonly banner: string;
  /**
   * True when the api-server has the console SPA mounted at
   * `${baseUrl}/console/`. Depends on the bundled console-assets
   * directory being present next to the CLI dist — the shipped CLI
   * ships them; a broken install may not. Absent = console URL
   * should not be advertised.
   */
  readonly consoleMounted?: boolean;
  shutdown(): Promise<void>;
}

export interface StartApiServerOptions {
  /** The host port the API is reached on (`127.0.0.1` only). */
  readonly port: number;
  /** Postgres, as this machine reaches it. */
  readonly databaseUrl: string;
  readonly tenantId: string;
  readonly token: string;
  /** The user the dev token resolves to — the previous boot's, so reviewer registrations carry over. */
  readonly userId: string;
  /** The pack directory: the runtime reads its index and its `.env` files there. */
  readonly packDir: string;
  /** `dev.envFiles` from `kindgi.config.ts`; default `.env`, `.env.local`. */
  readonly localEnvFiles?: readonly string[];
  /**
   * The CLI's environment: values for `${VAR}` references the env files
   * don't define, and `HOME` (Google credentials).
   */
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  /** The local pack service's front, which the runtime calls the pack's code through. */
  readonly packService: { readonly url: string; readonly token: string };
  /** `KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH`: the developer's key file, if set. Otherwise the runtime makes one. */
  readonly publicRunTokenKeyPath?: string;
  /** `KINDGI_CORS_ORIGINS`: the browser app's origins, allowed on the run progress routes. */
  readonly corsOrigins?: readonly string[];
  /** The runtime image (`--runtime-image`). */
  readonly runtimeImage: string;
  /**
   * `--runtime-url`: a runtime the developer runs themselves (from
   * source). No container: `kindgi dev` writes `runtime.env` for it and
   * waits until it serves with this session's dev token.
   */
  readonly runtimeUrl?: string;
  /** Lines the runtime writes. */
  readonly onLog?: (line: string) => void;
  /** Progress while preparing (an image pull). */
  readonly onProgress?: (line: string) => void;
}

/**
 * One bundle of the pack's code: each primitive's source path (as the
 * index records it) mapped to its bundle, both relative to the pack
 * root — or the build errors, located `file:line:column`.
 */
export type PackBuild =
  | { readonly kind: 'ok'; readonly bundleMap: Readonly<Record<string, string>> }
  | { readonly kind: 'err'; readonly errors: readonly string[] };

/**
 * Makes the pack's code ready for the pack service: esbuild bundles for a
 * Node pack, the sources themselves for a Python one.
 */
export interface PackBuilder {
  /** Build once; picks up added or removed primitive files. */
  build(): Promise<PackBuild>;
  /** Rebuild whenever a file any bundle read changes, reporting every build. */
  watch(onBuild: (build: PackBuild) => void): Promise<void>;
  /** Pick up added or removed primitive files; resolves `true` when the entries changed. */
  syncEntries(): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface IndexerRunOptions {
  /** Import each primitive's bundle instead of its source (source path → bundle path). */
  readonly bundleMap?: Readonly<Record<string, string>>;
  /** Run the indexer in a child process with this environment. */
  readonly env?: () => Promise<Readonly<Record<string, string>>>;
  /** Which indexer: the TypeScript one (default) or the pack's Python. */
  readonly code?: PackCode;
}

/** The local pack service `kindgi dev` runs the pack's code in. */
export interface DevPackServiceOptions {
  readonly packDir: string;
  /** Which pack service runs the code: the Node one, or the pack's Python. */
  readonly code: PackCode;
  /** The pack service's whole environment, read at every start. */
  readonly env: () => Promise<Readonly<Record<string, string>>>;
  /** Lines the pack's code writes. */
  readonly onLog: (line: string, stream: 'stdout' | 'stderr') => void;
  readonly onEvent: (event: PackServiceSupervisorEvent) => void;
  /**
   * The front's port and token: the previous session's, so a runtime
   * started with them (`--runtime-url`) keeps reaching it. Default: any
   * free port, a new token.
   */
  readonly port?: number;
  readonly token?: string;
}

/**
 * The local pack service: the public supervisor, children behind a
 * stable front. The runtime calls the front by URL and token.
 */
export type DevPackService = PackServiceSupervisor;

/**
 * Shape of `IndexerReport.counts` — kept structural so tests can hand
 * back plain objects without importing `@kindgi/handler-runtime`.
 */
export interface IndexedCounts {
  readonly tools: number;
  readonly guardrails: number;
  readonly agents: number;
  readonly flows: number;
}

/**
 * The subset of `IndexerReport` `kindgi dev` needs at the callsite.
 * The full runtime report (published-at, artifact version, etc.) is
 * present in the manifest but the CLI only surfaces counts + the read
 * `index.json` bytes.
 */
export interface IndexOutcome {
  readonly kind: 'ok';
  readonly packId: string;
  readonly packVersion: string;
  readonly counts: IndexedCounts;
  /**
   * Per-file errors accumulated during indexing. One bad file no
   * longer aborts the whole pass — registration proceeds on healthy
   * primitives and the errors surface here for `kindgi dev` to
   * print. Empty on a fully-clean pass.
   */
  readonly fileErrors: readonly {
    readonly code: string;
    readonly message: string;
    readonly filePath?: string;
  }[];
  /**
   * The parsed `index.json` payload — passed straight to the
   * registration bridge. Kept as `unknown` because the CLI does not
   * re-validate the shape (`runIndexer` is the authority).
   */
  readonly index: unknown;
}

export interface IndexFailure {
  readonly kind: 'err';
  readonly code: string;
  readonly message: string;
  readonly filePath?: string;
}

export type IndexResult = IndexOutcome | IndexFailure;

/**
 * Watcher handle. `close()` is idempotent — the command may call it
 * from the graceful-shutdown path after the abort-signal has fired.
 */
export interface WatchHandle {
  close(): Promise<void>;
}

/**
 * Handle returned by `startServices` when auto-start succeeded.
 * `databaseUrl` is the connection string the runtime should use;
 * `services` names what runs, for the banner.
 *
 * The services aren't stopped when `kindgi dev` exits: every `kindgi dev`
 * on the machine shares the one `kindgi-dev` compose project, so another
 * session's runtime may be using them. The next boot picks them up;
 * `kindgi dev --reset` removes them and their data.
 */
export interface StartedServicesHandle {
  readonly databaseUrl: string;
  readonly services: readonly string[];
}

/**
 * Outcome of `startServices`. `kind: 'ok'` = docker-compose available
 * AND all containers healthy. `kind: 'unavailable'` = docker-compose
 * not detected (or docker not installed); caller falls back to the
 * missing-KINDGI_DATABASE_URL error. `kind: 'error'` = docker-compose was
 * available but the boot failed (image pull, port collision, health
 * timeout) — caller surfaces the reason.
 */
export type StartServicesResult =
  | { readonly kind: 'ok'; readonly handle: StartedServicesHandle }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Injected fixture-friendly runners. Every field has a real
 * implementation in `dev/defaults.ts`; tests replace individual fields
 * to bypass Postgres, real file watchers, or the real indexer.
 */
export interface DevRunners {
  /** Boot the api-server. Resolves once the HTTP listener is bound. */
  readonly startApiServer: (opts: StartApiServerOptions) => Promise<RunningApiServer>;
  /**
   * Run the indexer against a pack root + return the parsed
   * `index.json`, written to `outputPath` (default: the dev index).
   * Failures are captured — this function never throws.
   */
  readonly runIndexer: (
    packDir: string,
    outputPath?: string,
    options?: IndexerRunOptions,
  ) => Promise<IndexResult>;
  /** The builder for the pack's code (esbuild for Node, the sources for Python). */
  readonly createPackBuilder: (opts: {
    readonly packDir: string;
    readonly patterns: readonly string[];
    readonly code: PackCode;
    /** The pack's environment (a Python build runs the pack's interpreter with it). */
    readonly env: () => Promise<Readonly<Record<string, string>>>;
  }) => PackBuilder;
  /** The local pack service (not yet started). */
  readonly createPackService: (opts: DevPackServiceOptions) => DevPackService;
  /**
   * Check a Python pack's interpreter can run pack code (`import kindgi`),
   * with the pack's environment: a one-line description, or why not.
   */
  readonly checkPackPython: (
    python: readonly [string, ...string[]],
    env: Readonly<Record<string, string>>,
    packDir?: string,
  ) => Promise<
    | { readonly kind: 'ok'; readonly value: string }
    | { readonly kind: 'err'; readonly message: string }
  >;
  /** Make a staged index the one the api-server reads. */
  readonly publishIndex: (stagedPath: string, indexPath: string) => Promise<void>;
  /**
   * Start watching the pack's discovery patterns (default: the
   * indexer's `DEFAULT_DISCOVERY`). The callback fires (debounced) when
   * a file a pattern matches changes, or one of `files` (absolute
   * paths — the env files). Returns a handle with an idempotent
   * `close()`.
   */
  readonly watchPack: (
    packDir: string,
    onChange: () => void,
    opts?: {
      readonly debounceMs?: number;
      readonly patterns?: readonly string[];
      readonly files?: readonly string[];
    },
  ) => Promise<WatchHandle>;
  /**
   * Auto-start the bundled `docker-compose.dev.yml` (Postgres) with
   * `docker compose`, in the `kindgi-dev` project. Called only when the user did NOT
   * provide `--database-url` / `KINDGI_DATABASE_URL`. Returns an outcome
   * enum: `ok` (fall through with the container's URL), `unavailable`
   * (docker-compose not detected — caller falls back to the manual
   * error), or `error` (docker was available but boot failed).
   *
   * Optional so tests can leave it unset (falls through to the
   * current "manual KINDGI_DATABASE_URL required" error).
   */
  /**
   * `recreate`: let compose recreate the shared Postgres when its
   * definition changed (`--recreate-services`). Default: an existing
   * container is reused as it is — another `kindgi dev` may be using it.
   */
  readonly startServices?: (options: {
    readonly recreate: boolean;
  }) => Promise<StartServicesResult>;
}
