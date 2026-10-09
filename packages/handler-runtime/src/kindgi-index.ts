// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi-index` — the pack indexer, which writes a pack's `index.json`.
 * `kindgi dev` runs it over the dev bundles; a pack image's indexer
 * stage runs it (process entry `kindgi-index-main`, bundled as
 * `dist/kindgi-index.mjs`) over the image's bundles, and `kindgi build`
 * runs the same bundle locally, so the two indexes compare.
 *
 * The indexer:
 *
 *   1. Loads `kindgi.config.ts` (or `.js` / `.mjs`) at the pack root
 *      to read `pack.id` / `pack.version` + optional `discovery` glob
 *      overrides.
 *   2. Discovers files under the four default folders — `tools/`,
 *      `guardrails/`, `agents/`, `flows/` — using the config's
 *      discovery patterns; or, indexing a build, takes the files a
 *      bundle map lists (`bundleMap`), classified by the same patterns.
 *   3. Dynamically imports each file (from its bundle, given a map).
 *      Reads the `default` export
 *      (accepting either the raw primitive shape or a `Result`-wrapped
 *      envelope from `defineTool` / `defineGuardrail` / etc.).
 *   4. Kind-maps the discovered file by its default folder (primary) or
 *      by structural shape of the default export (fallback for
 *      custom-pattern files).
 *   5. For every Zod-typed schema (`tool.inputZod`, `tool.outputZod`,
 *      `check.configZod`) calls `@kindgi/schema.toJSONSchemaSync` to
 *      derive the JSON Schema wire form. When JSON Schema is authored
 *      directly, it is emitted verbatim.
 *   6. Assembles a `v: 1` `index.json` envelope and writes it
 *      atomically (write-to-tmp, then rename) to the configured output
 *      path.
 *
 * ## Fail loud at every boundary
 *
 * Missing config, missing default export, kind mismatch, Zod conversion
 * failure, filesystem write error — each is a distinct typed
 * `IndexerError` variant with the file path attached. No silent skips.
 *
 * ## Determinism
 *
 * The integrity gate (locally verify the server's build) diffs an indexer output computed on the developer's
 * laptop against the server's output. Byte-identical inputs must
 * produce byte-identical outputs. All list fields are sorted
 * lexicographically by id; JSON serialization uses compact stable
 * output; `publishedAt` is accepted as an explicit `opts.publishedAt`
 * for reproducible builds (the pack build passes it) and defaults to
 * `new Date()` only for local dev (documented in the README).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { type FlowOutputSpec, loadFlow } from '@kindgi/flow';
import { isZodSchema, loadZodConverterSync, toJSONSchemaSync } from '@kindgi/schema';
import type { AnySchema, ZodConverter, ZodLikeSchema } from '@kindgi/schema';
import type { Result } from '@kindgi/types';
import { parse as parseToml } from 'smol-toml';

import { TEST_FILE_REGEX, globStaticPrefix, globToRegex } from './discovery.js';
import { compileSchema } from './handler-runner.js';
import { type PackEnvConfig, type PackEnvDeclaration, resolvePackEnv } from './pack-env.js';

// -----------------------------------------------------------------------
// Public envelope + shape types
// -----------------------------------------------------------------------

/**
 * Envelope version emitted on `index.json`. Bump on breaking change;
 * additive fields on an existing shape don't bump. Consumers (the
 * controller) MUST refuse an envelope version they
 * don't recognize.
 */
export const INDEX_ENVELOPE_VERSION = 1 as const;
export type IndexEnvelopeVersion = typeof INDEX_ENVELOPE_VERSION;

export type PrimitiveKind = 'tool' | 'guardrail' | 'agent' | 'flow';

/** Discovery glob patterns keyed by primitive kind. */
export interface DiscoveryConfig {
  readonly tools?: string;
  readonly guardrails?: string;
  readonly agents?: string;
  readonly flows?: string;
}

/**
 * The language a pack's code (tool handlers, guardrail checks) is written
 * in — which indexer reads it and which pack service runs it. Agents and
 * flows are data in either.
 */
export type PackLanguage = 'node' | 'python';

/**
 * The subset of `kindgi.config.ts` this indexer consumes. Other
 * top-level fields (`environments`, `bundle`, etc.) are read by the
 * deploy pipeline elsewhere and are opaque to the indexer.
 */
export interface KindgiConfig {
  readonly pack: {
    readonly id: string;
    readonly version: string;
    readonly description?: string;
  };
  readonly discovery?: DiscoveryConfig;
  /**
   * The pack's code language. Absent in `kindgi.config.*`: `node`. A
   * `[tool.kindgi]` table in `pyproject.toml` is a Python pack unless it
   * says otherwise.
   */
  readonly language?: PackLanguage;
  /**
   * The process environment the pack's code reads: `required` names must
   * be set for the pack service to be ready; `optional` ones are injected
   * when a deployment has them. Carried in `index.json` (see
   * `pack-env.ts`).
   */
  readonly env?: PackEnvConfig;
  /**
   * The project the pack belongs to under `kindgi dev`, which names its dev
   * database and tenant. Absent: the git repository's name, else the
   * workspace root's, else the pack folder's.
   */
  readonly project?: string;
  /**
   * Model providers `kindgi dev` registers for the project, and keeps in
   * step with this list. Credentials are secrets by name only, resolved in
   * the pack's env files.
   */
  readonly providers?: readonly KindgiProviderDeclaration[];
  readonly [k: string]: unknown;
}

/** One provider in `KindgiConfig.providers`: a preset, or a full registration. */
export type KindgiProviderDeclaration =
  | {
      /** A preset by name (`kindgi providers presets` lists them). */
      readonly preset: string;
      /** Only these of the preset's models. Default: all. */
      readonly models?: readonly string[];
      /** The Google Cloud project, for a preset that needs one (`gemini`). */
      readonly project?: string;
      /** The Azure OpenAI resource (`<name>.openai.azure.com`), for `azure-openai`. */
      readonly resourceName?: string;
      /** The deployment serving each model, `"model=deployment,…"`, for `azure-openai`. */
      readonly deployments?: string;
      /** The AWS region Bedrock runs in (`us-east-2`), for `bedrock`. */
      readonly region?: string;
      /** The secret holding the API key, in place of the preset's own. */
      readonly secret?: string;
      /** Each model's output cap, in place of the preset's (the model's own limit). */
      readonly maxOutputTokens?: number;
    }
  | {
      /**
       * A registration body, as `kindgi providers register --spec` takes it.
       * A credential goes in `secret_ref` by name, never in `adapter_config`.
       */
      readonly spec: Readonly<Record<string, unknown>>;
    };

/** The language of a loaded config's pack code. */
export function packLanguage(config: KindgiConfig): PackLanguage {
  return config.language ?? 'node';
}

/**
 * Default discovery patterns. Extensions
 * `.ts` / `.js` / `.mjs` are all accepted — a pack build may transpile
 * `.ts` to `.js` before the indexer runs inside the Dockerfile's indexer
 * stage, but the indexer accepts either shape so local development (no
 * bundle) and CI-built images (post-bundle) share the same code path.
 */
export const DEFAULT_DISCOVERY: Required<DiscoveryConfig> = {
  tools: 'tools/**/*.{ts,js,mjs}',
  guardrails: 'guardrails/**/*.{ts,js,mjs}',
  agents: 'agents/**/*.{ts,js,mjs}',
  flows: 'flows/**/*.{ts,js,mjs}',
};

/**
 * Default discovery patterns of a Python pack (`python -m kindgi.pack index`
 * reads the same keys from `[tool.kindgi.discovery]`).
 */
export const DEFAULT_PYTHON_DISCOVERY: Required<DiscoveryConfig> = {
  tools: 'tools/**/*.py',
  guardrails: 'guardrails/**/*.py',
  agents: 'agents/**/*.py',
  flows: 'flows/**/*.py',
};

/** A config's discovery patterns with the language's defaults filled in. */
export function resolveDiscovery(
  discovery: DiscoveryConfig | undefined,
  language: PackLanguage = 'node',
): Required<DiscoveryConfig> {
  const defaults = language === 'python' ? DEFAULT_PYTHON_DISCOVERY : DEFAULT_DISCOVERY;
  return { ...defaults, ...(discovery ?? {}) };
}

// -----------------------------------------------------------------------
// Manifest entry shapes emitted in index.json
// -----------------------------------------------------------------------

export interface IndexedTool {
  readonly id: string;
  readonly description?: string;
  readonly version?: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, unknown>>;
  readonly effects?: readonly Readonly<Record<string, unknown>>[];
  readonly needs?: readonly Readonly<Record<string, unknown>>[];
  readonly needsSpec?: Readonly<Record<string, unknown>>;
  readonly sandbox?: string;
  readonly limits?: Readonly<Record<string, unknown>>;
  readonly network?: Readonly<Record<string, unknown>>;
  /**
   * A declarative tool's spec (`defineTool({ spec })`, e.g. `kind:
   * 'http'`). The runtime runs a tool that has one itself — and resolves
   * its `secretRef`s — rather than calling the pack service.
   */
  readonly spec?: Readonly<Record<string, unknown>>;
  /**
   * The tool's declared `mutating`. `false` makes it read-only: it runs
   * in a dry run, and per-tool approval gates don't ask before it by
   * default. Absent means it may change something.
   */
  readonly mutating?: boolean;
  readonly modulePath: string;
}

export interface IndexedGuardrail {
  readonly id: string;
  readonly name?: string;
  readonly kind: string;
  readonly action: Readonly<Record<string, unknown>>;
  readonly severity?: string;
  readonly scope?: Readonly<Record<string, unknown>>;
  readonly checkModulePath: string;
  readonly checkId?: string;
  readonly configSchema?: Readonly<Record<string, unknown>>;
  /** The guardrail's `config`: what its check is configured with. */
  readonly config?: Readonly<Record<string, unknown>>;
  readonly sandbox?: string;
  readonly limits?: Readonly<Record<string, unknown>>;
  readonly network?: Readonly<Record<string, unknown>>;
}

export interface IndexedAgent {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  /** The system prompt, or a prompt block by range. */
  readonly instructions: string | { readonly prompt: string; readonly version: string };
  readonly capabilities: readonly unknown[];
  /**
   * Typed tool references — `{ id, version }` where `version` is a
   * semver range. Structurally compatible with `@kindgi/agents`
   * `ToolRef`.
   */
  readonly tools: readonly { readonly id: string; readonly version: string }[];
  readonly retrieval?: readonly unknown[];
  readonly guardrails?: readonly string[];
  /** Settings blocks by range. */
  readonly settings?: readonly { readonly id: string; readonly version: string }[];
  /** A model-settings block by range. */
  readonly modelSettings?: { readonly id: string; readonly version: string };
  readonly budget?: Readonly<Record<string, unknown>>;
  readonly parameters?: readonly unknown[];
  readonly preferredProvider?: string;
  readonly preferredModel?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly conversationPolicy?: Readonly<Record<string, unknown>>;
  /** The agent's typed output (`{ schema, name?, maxRepairs? }`), JSON Schema already. */
  readonly output?: Readonly<Record<string, unknown>>;
  /** How the agent's turns retry failed tool calls (`{ maxRetries?, retryOn? }`). */
  readonly toolErrors?: Readonly<Record<string, unknown>>;
  /** How the agent uses what it retrieves (`{ instructionTypes? }`). */
  readonly memory?: Readonly<Record<string, unknown>>;
  readonly modulePath: string;
}

/**
 * Envelope version for the flow payload embedded inside `index.json`.
 * Distinct from the top-level `v` envelope so the flow substrate can
 * evolve its own shape independently — matches the `packages/flow`
 * schema-version convention (currently 1.8.0, which added input and
 * output mappings). Additive fields don't bump this.
 */
export const KERNEL_PAYLOAD_VERSION = 1 as const;

export interface IndexedFlow {
  readonly id: string;
  readonly version: string;
  readonly name?: string;
  readonly description?: string;
  readonly nodes: readonly unknown[];
  readonly edges: readonly unknown[];
  readonly maxParallelism?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** The flow's declared output (schema-version 1.8.0+). */
  readonly output?: FlowOutputSpec;
  readonly kernelPayloadVersion: number;
  readonly modulePath: string;
}

export interface Index {
  readonly v: IndexEnvelopeVersion;
  readonly packId: string;
  readonly packVersion: string;
  readonly artifactVersion: string;
  readonly publishedAt: string;
  readonly tools: readonly IndexedTool[];
  readonly guardrails: readonly IndexedGuardrail[];
  readonly agents: readonly IndexedAgent[];
  readonly flows: readonly IndexedFlow[];
  /** The pack's declared process environment (schema-version 1.4.0+); absent when it declares none. */
  readonly env?: PackEnvDeclaration;
}

// -----------------------------------------------------------------------
// Error surface
// -----------------------------------------------------------------------

export type IndexerErrorCode =
  | 'config-not-found'
  | 'config-parse-failed'
  | 'config-invalid'
  | 'discovery-empty'
  | 'file-import-failed'
  | 'no-default-export'
  | 'kind-mismatch'
  | 'ambiguous-kind'
  | 'zod-conversion-failed'
  | 'manifest-validation-failed'
  | 'output-write-failed'
  | 'language-mismatch';

export interface IndexerError {
  readonly code: IndexerErrorCode;
  readonly message: string;
  readonly filePath?: string;
  readonly field?: string;
  readonly cause?: unknown;
}

// -----------------------------------------------------------------------
// Report + options
// -----------------------------------------------------------------------

export interface IndexerReport {
  readonly packId: string;
  readonly packVersion: string;
  readonly artifactVersion: string;
  readonly publishedAt: string;
  readonly counts: {
    readonly tools: number;
    readonly guardrails: number;
    readonly agents: number;
    readonly flows: number;
  };
  readonly outputPath: string;
  /**
   * Per-file errors accumulated during indexing — one bad file no
   * longer aborts the whole pass. Registration continues on healthy
   * primitives; the caller surfaces these to the user (dev watch,
   * build log). Empty on a fully-clean pass.
   */
  readonly fileErrors: readonly IndexerError[];
}

export interface RunIndexerOptions {
  /** Root of the pack repo — the folder containing `kindgi.config.ts`. */
  readonly packDir: string;
  /**
   * Explicit config file path. When omitted, the indexer tries
   * `kindgi.config.ts`, `.mjs`, `.js`, and `.cjs` in that order at
   * the pack root.
   */
  readonly configPath?: string;
  /**
   * Explicit output path. When omitted, defaults to
   * `<packDir>/index.json`.
   */
  readonly outputPath?: string;
  /**
   * Explicit artifact version. When omitted, the indexer computes a
   * `YYYYMMDD.N` shape locally — a pack build supplies an explicit
   * value at Dockerfile invocation time so the image build is
   * reproducible.
   */
  readonly artifactVersion?: string;
  /**
   * Explicit publishedAt timestamp. Determinism gate — a pack build
   * passes this as a build arg (SOURCE_DATE_EPOCH-shaped) so byte-identical
   * source produces byte-identical index.json. Default: `new
   * Date().toISOString()` — noted as non-deterministic in the README.
   */
  readonly publishedAt?: string;
  /**
   * Index a build: each primitive's source path (relative to `packDir`,
   * as the index records it) mapped to its bundle (relative to
   * `moduleRoot`). Given, the map is the file list — the source tree
   * needn't be there, as in a pack image — each key classified by the
   * discovery patterns as `discoverFiles` classifies what it finds; each
   * file is imported from its bundle, and the index records the source
   * path.
   */
  readonly bundleMap?: Readonly<Record<string, string>>;
  /** Where `bundleMap`'s bundle paths are relative to. Default `packDir`. */
  readonly moduleRoot?: string;
  /**
   * Test hook — override the default dynamic `import()`. Used by
   * indexer tests to hand in in-memory module maps without a
   * filesystem round-trip.
   */
  readonly importModule?: (fileUrl: string) => Promise<unknown>;
}

// -----------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------

/**
 * Run the indexer stage. Never throws — every failure is captured as a
 * typed `IndexerError`.
 */
export async function runIndexer(
  opts: RunIndexerOptions,
): Promise<Result<IndexerReport, IndexerError>> {
  const packDir = path.resolve(opts.packDir);
  const importModule = opts.importModule ?? defaultImportModule;

  const configResult = await loadConfig(packDir, opts.configPath, importModule);
  if (configResult.kind === 'err') return configResult;
  const config = configResult.value;
  if (packLanguage(config) !== 'node') {
    return {
      kind: 'err',
      error: {
        code: 'language-mismatch',
        message: `${packDir} is a ${packLanguage(config)} pack; index it with its own indexer (python -m kindgi.pack index)`,
      },
    };
  }
  const env = resolvePackEnv(config.env);
  if (env.kind === 'err') {
    return {
      kind: 'err',
      error: { code: 'config-invalid', field: 'env', message: `kindgi.config: ${env.message}` },
    };
  }

  const discovery = resolveDiscovery(config.discovery);

  const bundleMap = opts.bundleMap;
  const moduleRoot = path.resolve(opts.moduleRoot ?? packDir);
  const discovered =
    bundleMap !== undefined
      ? discoverInBundleMap(bundleMap, discovery)
      : await discoverFiles(packDir, discovery);
  if (discovered.length === 0) {
    return {
      kind: 'err',
      error: {
        code: 'discovery-empty',
        message:
          bundleMap !== undefined
            ? 'The bundle map lists no file the discovery patterns match. Check kindgi.config.ts discovery patterns.'
            : `Indexer discovered zero files under ${packDir}. Check kindgi.config.ts discovery patterns.`,
      },
    };
  }

  const zodConverter = loadZodConverterSync();

  const tools: IndexedTool[] = [];
  const guardrails: IndexedGuardrail[] = [];
  const agents: IndexedAgent[] = [];
  const flows: IndexedFlow[] = [];
  // Per `kind:id`, the versions defined so far and their files. A pack may
  // hold several versions of one primitive side by side (the pack service
  // serves each tool by id and version, as an agent version pins the one it
  // uses), but defines each version once: a second file's would silently
  // replace the first's. So the same version twice is an error, and so is
  // an entry with no version next to any other of its id: nothing would
  // tell them apart. The first (in discovery order) is kept, the second
  // refused, as the Python indexer does.
  const owners = new Map<string, Map<string | undefined, string>>();
  const duplicateOf = (
    kind: string,
    id: string,
    version: string | undefined,
    relPath: string,
  ): IndexerError | undefined => {
    let defined = owners.get(`${kind}:${id}`);
    if (defined === undefined) {
      defined = new Map();
      owners.set(`${kind}:${id}`, defined);
    }
    const owner =
      version === undefined || defined.has(undefined)
        ? defined.values().next().value
        : defined.get(version);
    if (owner !== undefined) {
      const what = `${kind} '${id}'${version !== undefined ? ` version ${version}` : ''}`;
      return {
        code: 'manifest-validation-failed',
        message: `${relPath}: duplicate ${what} (also defined in ${owner})`,
        filePath: relPath,
      };
    }
    defined.set(version, relPath);
    return undefined;
  };
  const fileErrors: IndexerError[] = [];

  for (const { relPath, expectedKind } of discovered) {
    const bundle = bundleMap?.[relPath];
    const absPath =
      bundle !== undefined ? path.resolve(moduleRoot, bundle) : path.join(packDir, relPath);
    const fileUrl = pathToFileURL(absPath).href;

    let module_: unknown;
    try {
      module_ = await importModule(fileUrl);
    } catch (cause) {
      fileErrors.push({
        code: 'file-import-failed',
        message: `Failed to import ${relPath}: ${stringifyError(cause)}`,
        filePath: relPath,
        cause: serializeCause(cause),
      });
      continue;
    }

    const defExport = extractDefaultExport(module_);
    if (defExport === undefined) {
      fileErrors.push({
        code: 'no-default-export',
        message: `File ${relPath} has no default export`,
        filePath: relPath,
      });
      continue;
    }

    const errResult = detectResultError(defExport);
    if (errResult !== undefined) {
      fileErrors.push({
        code: 'manifest-validation-failed',
        message: `File ${relPath} default export is a Result-wrapped error: ${resultErrorMessage(errResult)}`,
        filePath: relPath,
        cause: errResult,
      });
      continue;
    }

    const unwrapped = unwrapResult(defExport);
    const detected = detectKind(unwrapped);
    if (detected === undefined) {
      fileErrors.push({
        code: 'ambiguous-kind',
        message: `File ${relPath} default export does not match any primitive shape (tool / guardrail / agent / flow)`,
        filePath: relPath,
      });
      continue;
    }
    if (expectedKind !== undefined && detected !== expectedKind) {
      fileErrors.push({
        code: 'kind-mismatch',
        message: `File ${relPath} is under the default folder for kind '${expectedKind}' but default-exports a '${detected}'`,
        filePath: relPath,
      });
      continue;
    }

    switch (detected) {
      case 'tool': {
        const built = buildTool(unwrapped, relPath, zodConverter);
        if (built.kind === 'err') {
          fileErrors.push(built.error);
          continue;
        }
        const duplicate = duplicateOf('tool', built.value.id, built.value.version, relPath);
        if (duplicate !== undefined) {
          fileErrors.push(duplicate);
          continue;
        }
        tools.push(built.value);
        break;
      }
      case 'guardrail': {
        const built = buildGuardrail(unwrapped, relPath, zodConverter);
        if (built.kind === 'err') {
          fileErrors.push(built.error);
          continue;
        }
        const duplicate = duplicateOf('guardrail', built.value.id, undefined, relPath);
        if (duplicate !== undefined) {
          fileErrors.push(duplicate);
          continue;
        }
        guardrails.push(built.value);
        break;
      }
      case 'agent': {
        const built = buildAgent(unwrapped, relPath);
        if (built.kind === 'err') {
          fileErrors.push(built.error);
          continue;
        }
        const duplicate = duplicateOf('agent', built.value.id, built.value.version, relPath);
        if (duplicate !== undefined) {
          fileErrors.push(duplicate);
          continue;
        }
        agents.push(built.value);
        break;
      }
      case 'flow': {
        const built = buildGraph(unwrapped, relPath);
        if (built.kind === 'err') {
          fileErrors.push(built.error);
          continue;
        }
        const duplicate = duplicateOf('flow', built.value.id, built.value.version, relPath);
        if (duplicate !== undefined) {
          fileErrors.push(duplicate);
          continue;
        }
        flows.push(built.value);
        break;
      }
    }
  }

  const outputPath =
    opts.outputPath !== undefined
      ? path.resolve(opts.outputPath)
      : path.join(packDir, 'index.json');

  const artifactVersion = opts.artifactVersion ?? (await computeAutoArtifactVersion(outputPath));

  const publishedAt = opts.publishedAt ?? new Date().toISOString();

  const index: Index = {
    v: INDEX_ENVELOPE_VERSION,
    packId: config.pack.id,
    packVersion: config.pack.version,
    artifactVersion,
    publishedAt,
    tools: sortById(tools),
    guardrails: sortById(guardrails),
    agents: sortById(agents),
    flows: sortById(flows),
    ...(env.value !== undefined && { env: env.value }),
  };

  const written = await atomicWriteJson(outputPath, index);
  if (written.kind === 'err') return written;

  return {
    kind: 'ok',
    value: {
      packId: config.pack.id,
      packVersion: config.pack.version,
      artifactVersion,
      publishedAt,
      counts: {
        tools: tools.length,
        guardrails: guardrails.length,
        agents: agents.length,
        flows: flows.length,
      },
      outputPath,
      fileErrors,
    },
  };
}

// -----------------------------------------------------------------------
// CLI entry
// -----------------------------------------------------------------------

/**
 * The `kindgi-index` command (process entry: `kindgi-index-main`) — a
 * pack image's indexer stage runs it over the image's bundles. Args:
 *
 *   --pack-dir <path>          root of the pack (required)
 *   --config <path>            explicit config file (optional)
 *   --output <path>            explicit output path (optional)
 *   --bundle-map <path>        index a build: the bundle map (JSON, optional)
 *   --module-root <path>       where the bundle map's paths resolve (optional)
 *   --artifact-version <str>   pin artifact version (optional)
 *   --published-at <iso>       pin publishedAt (optional; enables reproducible builds)
 *   --strict                   exit 1 when a module fails to load (a pack image's
 *                              build: the image would serve less than the pack has)
 *   --help
 *   --version
 */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  if (parsed.kind === 'version') {
    process.stdout.write('kindgi-index v0.0.0\n');
    return 0;
  }
  if (parsed.kind === 'err') {
    process.stderr.write(`kindgi-index: ${parsed.error}\n`);
    return 2;
  }
  let options = parsed.value.options;
  if (parsed.value.bundleMapPath !== undefined) {
    const bundleMap = await readBundleMap(parsed.value.bundleMapPath);
    if (bundleMap.kind === 'err') {
      process.stderr.write(`kindgi-index: ${bundleMap.message}\n`);
      return 2;
    }
    options = { ...options, bundleMap: bundleMap.value };
  }
  const outcome = await runIndexer(options);
  if (outcome.kind === 'err') {
    process.stderr.write(`kindgi-index: ${outcome.error.code}: ${outcome.error.message}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(outcome.value, null, 2)}\n`);
  if (parsed.value.strict && outcome.value.fileErrors.length > 0) {
    for (const e of outcome.value.fileErrors) {
      process.stderr.write(`kindgi-index: ${e.code}: ${e.message}\n`);
    }
    return 1;
  }
  return 0;
}

export const HELP_TEXT = `kindgi-index — build-time pack manifest indexer

Usage:
  kindgi-index --pack-dir <path> [--config <path>] [--output <path>]
               [--bundle-map <path> [--module-root <path>]]
               [--artifact-version <str>] [--published-at <iso>] [--strict]

Options:
  --pack-dir <path>          Root of the pack (required).
  --config <path>            Explicit kindgi.config.* path.
  --output <path>            Output path for index.json (default: <packDir>/index.json).
  --bundle-map <path>        Index a build: JSON mapping each source path to its bundle.
  --module-root <path>       Where the bundle map's paths resolve (default: --pack-dir).
  --artifact-version <str>   Pin artifact version (default: YYYYMMDD.N auto).
  --published-at <iso>       Pin publishedAt for reproducible builds.
  --strict                   Exit 1 when a module fails to load.
  --help                     Show this help.
  --version                  Print version and exit.`;

type ParsedArgs =
  | {
      readonly kind: 'ok';
      readonly value: {
        readonly options: RunIndexerOptions;
        readonly bundleMapPath?: string;
        readonly strict: boolean;
      };
    }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'err'; readonly error: string };

function parseArgs(argv: readonly string[]): ParsedArgs {
  let packDir: string | undefined;
  let configPath: string | undefined;
  let outputPath: string | undefined;
  let artifactVersion: string | undefined;
  let publishedAt: string | undefined;
  let bundleMapPath: string | undefined;
  let moduleRoot: string | undefined;
  let strict = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--version' || arg === '-v') return { kind: 'version' };

    const takeValue = (): string | { readonly err: string } => {
      const value = argv[i + 1];
      if (value === undefined) return { err: `${arg} requires a value` };
      return value;
    };

    if (arg === '--strict') {
      strict = true;
      i += 1;
      continue;
    }
    if (arg === '--pack-dir') {
      const value = takeValue();
      if (typeof value !== 'string') return { kind: 'err', error: value.err };
      packDir = value;
      i += 2;
      continue;
    }
    if (arg === '--config') {
      const value = takeValue();
      if (typeof value !== 'string') return { kind: 'err', error: value.err };
      configPath = value;
      i += 2;
      continue;
    }
    if (arg === '--output') {
      const value = takeValue();
      if (typeof value !== 'string') return { kind: 'err', error: value.err };
      outputPath = value;
      i += 2;
      continue;
    }
    if (arg === '--artifact-version') {
      const value = takeValue();
      if (typeof value !== 'string') return { kind: 'err', error: value.err };
      artifactVersion = value;
      i += 2;
      continue;
    }
    if (arg === '--published-at') {
      const value = takeValue();
      if (typeof value !== 'string') return { kind: 'err', error: value.err };
      publishedAt = value;
      i += 2;
      continue;
    }
    if (arg === '--bundle-map') {
      const value = takeValue();
      if (typeof value !== 'string') return { kind: 'err', error: value.err };
      bundleMapPath = value;
      i += 2;
      continue;
    }
    if (arg === '--module-root') {
      const value = takeValue();
      if (typeof value !== 'string') return { kind: 'err', error: value.err };
      moduleRoot = value;
      i += 2;
      continue;
    }
    return { kind: 'err', error: `Unknown argument: ${arg}` };
  }
  if (packDir === undefined) {
    return { kind: 'err', error: '--pack-dir is required' };
  }
  if (moduleRoot !== undefined && bundleMapPath === undefined) {
    return { kind: 'err', error: '--module-root goes with --bundle-map' };
  }
  const options: RunIndexerOptions = {
    packDir,
    ...(configPath !== undefined && { configPath }),
    ...(outputPath !== undefined && { outputPath }),
    ...(artifactVersion !== undefined && { artifactVersion }),
    ...(publishedAt !== undefined && { publishedAt }),
    ...(moduleRoot !== undefined && { moduleRoot }),
  };
  return {
    kind: 'ok',
    value: { options, strict, ...(bundleMapPath !== undefined && { bundleMapPath }) },
  };
}

/**
 * A bundle map file: a JSON object of source path → bundle path, both
 * strings (`kindgi build` writes `dist/bundle-map.json`).
 */
export async function readBundleMap(
  file: string,
): Promise<
  | { readonly kind: 'ok'; readonly value: Readonly<Record<string, string>> }
  | { readonly kind: 'err'; readonly message: string }
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (cause) {
    return { kind: 'err', message: `Cannot read the bundle map ${file}: ${stringifyError(cause)}` };
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((v) => typeof v === 'string' && v !== '')
  ) {
    return {
      kind: 'err',
      message: `The bundle map ${file} must be a JSON object of source path → bundle path.`,
    };
  }
  return { kind: 'ok', value: parsed as Record<string, string> };
}

// -----------------------------------------------------------------------
// Config loading
// -----------------------------------------------------------------------

/** Config file names looked up at a pack root, in order. */
export const KINDGI_CONFIG_FILENAMES: readonly string[] = [
  'kindgi.config.ts',
  // `.mts` is always ESM — the config name for a CommonJS app, where a
  // `.ts` config would be reparsed with a Node warning.
  'kindgi.config.mts',
  'kindgi.config.mjs',
  'kindgi.config.js',
  'kindgi.config.cjs',
];

export interface LoadKindgiConfigOptions {
  /** Explicit config path (absolute or cwd-relative); skips the lookup. */
  readonly configPath?: string;
  /** Test hook — replaces the cache-busted dynamic `import()`. */
  readonly importModule?: (fileUrl: string) => Promise<unknown>;
}

/**
 * Load and minimally validate a pack's `kindgi.config.*` — the one
 * loader behind the indexer and any tooling that reads pack config.
 * Never throws:
 * `config-not-found` when no config file exists, `config-parse-failed`
 * (with the underlying cause) when it exists but cannot be imported or
 * lacks `pack.id` / `pack.version`. Imports are cache-busted by mtime so
 * a long-running process sees edits.
 */
export async function loadKindgiConfig(
  packDir: string,
  options: LoadKindgiConfigOptions = {},
): Promise<Result<KindgiConfig, IndexerError>> {
  return loadConfig(
    path.resolve(packDir),
    options.configPath,
    options.importModule ?? defaultImportModule,
  );
}

/** `pyproject.toml` — a Python pack keeps its config in the `[tool.kindgi]` table. */
export const PYPROJECT_FILENAME = 'pyproject.toml';

export interface KindgiConfigFile {
  readonly path: string;
  /** `module`: a `kindgi.config.*`; `pyproject`: the `[tool.kindgi]` table of a `pyproject.toml`. */
  readonly format: 'module' | 'pyproject';
}

/**
 * Where a pack's config lives: the first `kindgi.config.*` at `packDir`
 * (`KINDGI_CONFIG_FILENAMES` order), else a `pyproject.toml` with a
 * `[tool.kindgi]` table. `undefined` when neither — a `pyproject.toml`
 * without the table is a Python project, not a pack.
 */
export async function findKindgiConfig(packDir: string): Promise<KindgiConfigFile | undefined> {
  for (const name of KINDGI_CONFIG_FILENAMES) {
    const candidate = path.join(packDir, name);
    if (await exists(candidate)) return { path: candidate, format: 'module' };
  }
  const pyproject = path.join(packDir, PYPROJECT_FILENAME);
  let text: string;
  try {
    text = await fs.readFile(pyproject, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const tool = (parseToml(text) as Record<string, unknown>).tool;
    return isObject(tool) && 'kindgi' in tool
      ? { path: pyproject, format: 'pyproject' }
      : undefined;
  } catch {
    // Unparsable: a pack only if it clearly meant to be one (the loader reports the error).
    return /^\s*\[tool\.kindgi[\].]/m.test(text)
      ? { path: pyproject, format: 'pyproject' }
      : undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(
  packDir: string,
  explicitPath: string | undefined,
  importModule: (fileUrl: string) => Promise<unknown>,
): Promise<Result<KindgiConfig, IndexerError>> {
  let file: KindgiConfigFile | undefined;
  if (explicitPath !== undefined) {
    const resolved = path.resolve(explicitPath);
    if (await exists(resolved)) {
      const format = path.basename(resolved) === PYPROJECT_FILENAME ? 'pyproject' : 'module';
      file = { path: resolved, format };
    }
  } else {
    file = await findKindgiConfig(packDir);
  }
  if (file === undefined) {
    return {
      kind: 'err',
      error: {
        code: 'config-not-found',
        message: `No kindgi.config.{ts,mts,mjs,js,cjs}, or pyproject.toml with a [tool.kindgi] table, found at pack root ${packDir}`,
      },
    };
  }
  const read =
    file.format === 'pyproject'
      ? await readPyprojectTable(file.path)
      : await importConfigModule(file.path, importModule);
  if (read.kind === 'err') return read;
  const checked = checkConfig(read.value, file.path);
  if (checked.kind === 'err') return checked;
  const record = checked.value;
  return {
    kind: 'ok',
    value:
      file.format === 'pyproject' && record.language === undefined
        ? { ...record, language: 'python' }
        : record,
  };
}

function parseFailed(
  filePath: string,
  message: string,
  cause?: unknown,
): Result<never, IndexerError> {
  return {
    kind: 'err',
    error: {
      code: 'config-parse-failed',
      message,
      filePath,
      ...(cause !== undefined && { cause: serializeCause(cause) }),
    },
  };
}

async function importConfigModule(
  filePath: string,
  importModule: (fileUrl: string) => Promise<unknown>,
): Promise<Result<Record<string, unknown>, IndexerError>> {
  let module_: unknown;
  try {
    module_ = await importModule(pathToFileURL(filePath).href);
  } catch (cause) {
    return parseFailed(filePath, `Failed to import ${filePath}: ${stringifyError(cause)}`, cause);
  }
  const defExport = extractDefaultExport(module_);
  if (defExport === undefined || typeof defExport !== 'object' || defExport === null) {
    return parseFailed(
      filePath,
      `Config file ${filePath} has no default export (or it is not an object)`,
    );
  }
  return { kind: 'ok', value: defExport as Record<string, unknown> };
}

async function readPyprojectTable(
  filePath: string,
): Promise<Result<Record<string, unknown>, IndexerError>> {
  let document: Record<string, unknown>;
  try {
    document = parseToml(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
  } catch (cause) {
    return parseFailed(filePath, `Failed to read ${filePath}: ${stringifyError(cause)}`, cause);
  }
  const tool = document.tool;
  const table = isObject(tool) ? tool.kindgi : undefined;
  if (!isObject(table)) {
    return {
      kind: 'err',
      error: {
        code: 'config-not-found',
        message: `${filePath} has no [tool.kindgi] table`,
        filePath,
      },
    };
  }
  return { kind: 'ok', value: table as Record<string, unknown> };
}

/** The checks every config passes, whatever file it came from. */
function checkConfig(
  record: Record<string, unknown>,
  filePath: string,
): Result<KindgiConfig, IndexerError> {
  const pack = record.pack;
  if (typeof pack !== 'object' || pack === null) {
    return parseFailed(
      filePath,
      `Config file ${filePath}: 'pack' field is missing or not an object`,
    );
  }
  const packRec = pack as Record<string, unknown>;
  if (typeof packRec.id !== 'string' || packRec.id.length === 0) {
    return parseFailed(
      filePath,
      `Config file ${filePath}: 'pack.id' is missing or not a non-empty string`,
    );
  }
  if (typeof packRec.version !== 'string' || packRec.version.length === 0) {
    return parseFailed(
      filePath,
      `Config file ${filePath}: 'pack.version' is missing or not a non-empty string`,
    );
  }
  if (record.language !== undefined && record.language !== 'node' && record.language !== 'python') {
    return parseFailed(filePath, `Config file ${filePath}: 'language' must be "node" or "python"`);
  }
  return { kind: 'ok', value: record as KindgiConfig };
}

// -----------------------------------------------------------------------
// Discovery
// -----------------------------------------------------------------------

interface DiscoveredFile {
  readonly relPath: string;
  /**
   * `undefined` when the matching pattern was custom (not the default
   * `<folder>/**\/*.{ts,js,mjs}` shape). Structural detection resolves
   * the kind from the default export's shape.
   */
  readonly expectedKind: PrimitiveKind | undefined;
}

const DEFAULT_FOLDERS: Record<PrimitiveKind, string> = {
  tool: 'tools',
  guardrail: 'guardrails',
  agent: 'agents',
  flow: 'flows',
};

async function discoverFiles(
  packDir: string,
  discovery: Required<DiscoveryConfig>,
): Promise<readonly DiscoveredFile[]> {
  const seen = new Map<string, PrimitiveKind | undefined>();
  for (const { kind, pattern } of kindPatterns(discovery)) {
    for (const rel of await globMatch(packDir, pattern)) classifyDiscovered(seen, rel, kind);
  }
  return sortedDiscovered(seen);
}

/** A bundle map's source paths, classified as `discoverFiles` classifies what it finds. */
function discoverInBundleMap(
  bundleMap: Readonly<Record<string, string>>,
  discovery: Required<DiscoveryConfig>,
): readonly DiscoveredFile[] {
  const sources = Object.keys(bundleMap).sort();
  const seen = new Map<string, PrimitiveKind | undefined>();
  for (const { kind, pattern } of kindPatterns(discovery)) {
    const regex = globToRegex(pattern);
    for (const rel of sources) if (regex.test(rel)) classifyDiscovered(seen, rel, kind);
  }
  return sortedDiscovered(seen);
}

function kindPatterns(
  discovery: Required<DiscoveryConfig>,
): readonly { readonly kind: PrimitiveKind; readonly pattern: string }[] {
  return [
    { kind: 'tool', pattern: discovery.tools },
    { kind: 'guardrail', pattern: discovery.guardrails },
    { kind: 'agent', pattern: discovery.agents },
    { kind: 'flow', pattern: discovery.flows },
  ];
}

/** Record `rel`, matched by `kind`'s pattern, unless it's a test file or already seen. */
function classifyDiscovered(
  seen: Map<string, PrimitiveKind | undefined>,
  rel: string,
  kind: PrimitiveKind,
): void {
  // Skip test / spec files — they live next to the primitive
  // (`tools/echo/index.ts` + `tools/echo/index.test.ts`)
  // and would break the indexer if imported as a primitive
  // module. Matches conventional test-file suffixes across
  // vitest / jest / node:test.
  if (TEST_FILE_REGEX.test(rel)) return;
  if (seen.has(rel)) return;
  const firstSegment = rel.split('/')[0];
  const inDefaultFolder = firstSegment === DEFAULT_FOLDERS[kind];
  seen.set(rel, inDefaultFolder ? kind : undefined);
}

function sortedDiscovered(
  seen: ReadonlyMap<string, PrimitiveKind | undefined>,
): readonly DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  for (const [relPath, expectedKind] of seen) out.push({ relPath, expectedKind });
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

/**
 * Minimal glob matcher supporting `**` (any depth), `*` (single-segment
 * wildcard), and `{a,b,c}` alternation. Sufficient for the default
 * discovery patterns and typical custom overrides. Negations and
 * extglob patterns are not supported.
 */
async function globMatch(root: string, pattern: string): Promise<readonly string[]> {
  const regex = globToRegex(pattern);
  const matches: string[] = [];
  // Walk only the pattern's static prefix — a pack embedded in a large
  // app (`kindgi/tools/**`) must not crawl the whole host repo.
  await walk(root, globStaticPrefix(pattern), matches, regex);
  return matches;
}

async function walk(root: string, rel: string, matches: string[], regex: RegExp): Promise<void> {
  const abs = rel === '' ? root : path.join(root, rel);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(root, childRel, matches, regex);
    } else if (entry.isFile()) {
      if (regex.test(childRel)) matches.push(childRel);
    }
  }
}

// -----------------------------------------------------------------------
// Module import + default export extraction
// -----------------------------------------------------------------------

/**
 * Cache-busted dynamic import. Node's module cache is keyed by URL, so
 * a plain `import(fileUrl)` inside a long-running process (a dev watch
 * loop) returns the *originally loaded* module even after the author
 * edits the file on disk — the indexer would then re-emit stale
 * manifests every watch tick.
 *
 * Fix: append `?v=<mtimeMs>` to the URL. Node treats each distinct URL
 * as a distinct module entry, so an edited file (with a newer mtime)
 * triggers a fresh load; an unchanged file keeps the same URL and hits
 * the cache — no wasted work, no memory churn.
 *
 * Best-effort: if `fs.stat` fails (e.g. an unusual URL scheme or a
 * race), fall back to the plain `import()` so the indexer still
 * completes — logged behavior remains the same, just without cache
 * invalidation.
 */
async function defaultImportModule(fileUrl: string): Promise<unknown> {
  try {
    const abs = fileURLToPath(fileUrl);
    const { mtimeMs } = await fs.stat(abs);
    return await import(`${fileUrl}?v=${mtimeMs}`);
  } catch {
    return await import(fileUrl);
  }
}

function extractDefaultExport(module_: unknown): unknown | undefined {
  if (module_ === null || typeof module_ !== 'object') return undefined;
  const record = module_ as Record<string, unknown>;
  return record.default;
}

// -----------------------------------------------------------------------
// Result-wrapper handling
// -----------------------------------------------------------------------

function detectResultError(value: unknown): unknown | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === 'err' && 'error' in record) return record.error;
  return undefined;
}

function unwrapResult(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.kind === 'ok' && 'value' in record) return record.value;
  return value;
}

function resultErrorMessage(err: unknown): string {
  if (err === null || typeof err !== 'object') return String(err);
  const rec = err as Record<string, unknown>;
  if (typeof rec.message === 'string') return rec.message;
  return JSON.stringify(err);
}

// -----------------------------------------------------------------------
// Structural kind detection
// -----------------------------------------------------------------------

function detectKind(value: unknown): PrimitiveKind | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.handler === 'function' && ('input' in rec || 'inputZod' in rec)) {
    return 'tool';
  }
  const isGuardrailAction =
    typeof rec.action === 'object' &&
    rec.action !== null &&
    'on-violation' in (rec.action as Record<string, unknown>);
  if (isGuardrailAction && 'kind' in rec) return 'guardrail';
  if (
    (typeof rec.instructions === 'string' || isPromptRef(rec.instructions)) &&
    Array.isArray(rec.tools)
  ) {
    return 'agent';
  }
  if (Array.isArray(rec.nodes) && Array.isArray(rec.edges)) return 'flow';
  return undefined;
}

// -----------------------------------------------------------------------
// Manifest builders
// -----------------------------------------------------------------------

function buildTool(
  raw: unknown,
  relPath: string,
  converter: ZodConverter | undefined,
): Result<IndexedTool, IndexerError> {
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string') {
    return manifestErr(relPath, `'id' is missing or not a string`);
  }

  const inputWire = resolveSchema(rec, 'input', 'inputZod', relPath, converter);
  if (inputWire.kind === 'err') return inputWire;
  const outputWire = resolveSchema(rec, 'output', 'outputZod', relPath, converter);
  if (outputWire.kind === 'err') return outputWire;

  const tool: IndexedTool = {
    id: rec.id,
    ...(typeof rec.description === 'string' && { description: rec.description }),
    ...(typeof rec.version === 'string' && { version: rec.version }),
    input: inputWire.value,
    output: outputWire.value,
    ...(Array.isArray(rec.effects) && {
      effects: rec.effects as readonly Readonly<Record<string, unknown>>[],
    }),
    ...(Array.isArray(rec.needs) && {
      needs: rec.needs as readonly Readonly<Record<string, unknown>>[],
    }),
    ...(isObject(rec.needsSpec) && {
      needsSpec: rec.needsSpec as Readonly<Record<string, unknown>>,
    }),
    ...(typeof rec.sandbox === 'string' && { sandbox: rec.sandbox }),
    ...(isObject(rec.limits) && {
      limits: rec.limits as Readonly<Record<string, unknown>>,
    }),
    ...(isObject(rec.network) && {
      network: rec.network as Readonly<Record<string, unknown>>,
    }),
    ...(isObject(rec.spec) && { spec: rec.spec as Readonly<Record<string, unknown>> }),
    ...(typeof rec.mutating === 'boolean' && { mutating: rec.mutating }),
    modulePath: normalizeModulePath(relPath),
  };
  return { kind: 'ok', value: tool };
}

function buildGuardrail(
  raw: unknown,
  relPath: string,
  converter: ZodConverter | undefined,
): Result<IndexedGuardrail, IndexerError> {
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string') {
    return manifestErr(relPath, `'id' is missing or not a string`);
  }
  if (typeof rec.kind !== 'string') {
    return manifestErr(relPath, `'kind' is missing or not a string`);
  }
  if (!isObject(rec.action)) {
    return manifestErr(relPath, `'action' is missing or not an object`);
  }

  // configSchema resolution: look in three places, in priority order:
  //   1. guardrail.configZod  (top-level, DefinedCheck-style)
  //   2. guardrail.check.configZod (nested inside the check object)
  //   3. guardrail.configSchema / guardrail.check.configSchema (already JSON Schema)
  const check = isObject(rec.check) ? (rec.check as Record<string, unknown>) : undefined;
  const zodConfig =
    (isZodSchema(rec.configZod) ? (rec.configZod as ZodLikeSchema) : undefined) ??
    (check && isZodSchema(check.configZod) ? (check.configZod as ZodLikeSchema) : undefined);
  let configSchema: Readonly<Record<string, unknown>> | undefined;
  if (zodConfig !== undefined) {
    const converted = toJSONSchemaSync(zodConfig, converter, 'input');
    if (converted.kind === 'err') {
      return {
        kind: 'err',
        error: {
          code: 'zod-conversion-failed',
          message: `Guardrail ${rec.id} configSchema Zod conversion failed: ${converted.error.message}`,
          filePath: relPath,
          field: 'configSchema',
          cause: converted.error.cause,
        },
      };
    }
    configSchema = converted.value;
  } else if (isObject(rec.configSchema)) {
    configSchema = rec.configSchema as Readonly<Record<string, unknown>>;
  } else if (check !== undefined && isObject(check.configSchema)) {
    configSchema = check.configSchema as Readonly<Record<string, unknown>>;
  } else if (check !== undefined && isObject(check.configJsonSchema)) {
    // `defineCheck` (guardrails pkg) already stores the converted JSON
    // Schema on `configJsonSchema` — accept that shape without a second
    // conversion pass.
    configSchema = check.configJsonSchema as Readonly<Record<string, unknown>>;
  }

  const configCheck = checkGuardrailConfig(rec.id, rec.config, configSchema, relPath);
  if (configCheck.kind === 'err') return configCheck;

  const checkId: string | undefined =
    typeof rec.check === 'string'
      ? rec.check
      : check !== undefined && typeof check.id === 'string'
        ? check.id
        : undefined;

  const guardrail: IndexedGuardrail = {
    id: rec.id,
    ...(typeof rec.name === 'string' && { name: rec.name }),
    kind: rec.kind,
    action: rec.action as Readonly<Record<string, unknown>>,
    ...(typeof rec.severity === 'string' && { severity: rec.severity }),
    ...(isObject(rec.scope) && {
      scope: rec.scope as Readonly<Record<string, unknown>>,
    }),
    checkModulePath: normalizeModulePath(relPath),
    ...(checkId !== undefined && { checkId }),
    ...(configSchema !== undefined && { configSchema }),
    ...(isObject(rec.config) && { config: rec.config as Readonly<Record<string, unknown>> }),
    ...(typeof rec.sandbox === 'string' && { sandbox: rec.sandbox }),
    ...(isObject(rec.limits) && {
      limits: rec.limits as Readonly<Record<string, unknown>>,
    }),
    ...(isObject(rec.network) && {
      network: rec.network as Readonly<Record<string, unknown>>,
    }),
  };
  return { kind: 'ok', value: guardrail };
}

function buildAgent(raw: unknown, relPath: string): Result<IndexedAgent, IndexerError> {
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string') {
    return manifestErr(relPath, `'id' is missing or not a string`);
  }
  if (typeof rec.version !== 'string') {
    return manifestErr(relPath, `'version' is missing or not a string`);
  }
  if (typeof rec.name !== 'string') {
    return manifestErr(relPath, `'name' is missing or not a string`);
  }
  if (typeof rec.instructions !== 'string' && !isPromptRef(rec.instructions)) {
    return manifestErr(
      relPath,
      `'instructions' is missing, or neither a string nor a prompt block { prompt, version }`,
    );
  }
  if (!Array.isArray(rec.capabilities)) {
    return manifestErr(relPath, `'capabilities' is missing or not an array`);
  }
  if (!Array.isArray(rec.tools)) {
    return manifestErr(relPath, `'tools' is missing or not an array`);
  }
  const agent: IndexedAgent = {
    id: rec.id,
    version: rec.version,
    name: rec.name,
    instructions: rec.instructions as IndexedAgent['instructions'],
    capabilities: rec.capabilities as readonly unknown[],
    tools: rec.tools as readonly { readonly id: string; readonly version: string }[],
    ...optionalAgentFields(rec),
    modulePath: normalizeModulePath(relPath),
  };
  return { kind: 'ok', value: agent };
}

/** A prompt block reference: `{ prompt, version }`. */
function isPromptRef(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof (value as { prompt?: unknown }).prompt === 'string' &&
    typeof (value as { version?: unknown }).version === 'string'
  );
}

/** The agent's optional fields, carried when present with the right shape. */
function optionalAgentFields(rec: Record<string, unknown>): Partial<IndexedAgent> {
  const out: Record<string, unknown> = {};
  for (const key of ['retrieval', 'guardrails', 'parameters', 'tags', 'settings'] as const) {
    if (Array.isArray(rec[key])) out[key] = rec[key];
  }
  for (const key of [
    'budget',
    'conversationPolicy',
    'output',
    'toolErrors',
    'modelSettings',
    'memory',
  ] as const) {
    if (isObject(rec[key])) out[key] = rec[key];
  }
  for (const key of ['preferredProvider', 'preferredModel', 'description'] as const) {
    if (typeof rec[key] === 'string') out[key] = rec[key];
  }
  return out as Partial<IndexedAgent>;
}

/**
 * Validate a discovered flow with the same loader the API uses, so a
 * broken flow fails indexing with the loader's message instead of
 * failing later at publish or run time, and carry every field it has.
 */
function buildGraph(raw: unknown, relPath: string): Result<IndexedFlow, IndexerError> {
  const loaded = loadFlow(raw);
  if (loaded.kind === 'err') return manifestErr(relPath, loaded.error.message);
  const f = loaded.value;
  const flow: IndexedFlow = {
    id: f.id as unknown as string,
    version: f.version,
    ...(f.name !== undefined && { name: f.name }),
    ...(f.description !== undefined && { description: f.description }),
    nodes: f.nodes,
    edges: f.edges,
    ...(f.maxParallelism !== undefined && { maxParallelism: f.maxParallelism }),
    ...(f.metadata !== undefined && { metadata: f.metadata }),
    ...(f.output !== undefined && { output: f.output }),
    kernelPayloadVersion: KERNEL_PAYLOAD_VERSION,
    modulePath: normalizeModulePath(relPath),
  };
  return { kind: 'ok', value: flow };
}

/**
 * A guardrail's `config` against its `configSchema`, when the pack is
 * indexed: a config that doesn't fit stops `kindgi build` / `kindgi dev`
 * here, naming where, as Python's guardrails refuse it at definition,
 * rather than failing every evaluation. No config is checked as `{}`: the
 * check gets its defaults, so required fields without one must be set.
 */
function checkGuardrailConfig(
  id: string,
  config: unknown,
  configSchema: Readonly<Record<string, unknown>> | undefined,
  relPath: string,
): Result<void, IndexerError> {
  const fail = (message: string): Result<never, IndexerError> => ({
    kind: 'err',
    error: {
      code: 'manifest-validation-failed',
      message: `${relPath}: guardrail ${id}'s config ${message}`,
      filePath: relPath,
      field: 'config',
    },
  });
  if (config !== undefined && !isObject(config)) return fail('must be an object');
  if (configSchema === undefined) return { kind: 'ok', value: undefined };
  let validate: ReturnType<typeof compileSchema>;
  try {
    // The output side: checks without filling in defaults (the index
    // keeps the config as declared; the check resolves it).
    validate = compileSchema(configSchema, 'output');
  } catch (cause) {
    return fail(
      `can't be checked: its configSchema doesn't compile: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (validate(config ?? {})) return { kind: 'ok', value: undefined };
  const first = validate.errors?.[0];
  const at =
    first?.instancePath === undefined || first.instancePath === ''
      ? ''
      : ` at ${first.instancePath}`;
  return fail(`doesn't fit its configSchema${at}: ${first?.message ?? 'invalid'}`);
}

function manifestErr(relPath: string, msg: string): Result<never, IndexerError> {
  return {
    kind: 'err',
    error: {
      code: 'manifest-validation-failed',
      message: `${relPath}: ${msg}`,
      filePath: relPath,
    },
  };
}

// -----------------------------------------------------------------------
// Schema resolution — Zod → JSON Schema pass
// -----------------------------------------------------------------------

function resolveSchema(
  rec: Record<string, unknown>,
  wireField: 'input' | 'output',
  zodField: string,
  relPath: string,
  converter: ZodConverter | undefined,
): Result<Readonly<Record<string, unknown>>, IndexerError> {
  // A tool's `input` is what a caller sends; its `output`, what it returns.
  const side = wireField;
  const zodValue = rec[zodField];
  if (zodValue !== undefined && isZodSchema(zodValue)) {
    const converted = toJSONSchemaSync(zodValue as AnySchema, converter, side);
    if (converted.kind === 'err') {
      return {
        kind: 'err',
        error: {
          code: 'zod-conversion-failed',
          message: `${relPath}: Zod conversion for '${zodField}' failed: ${converted.error.message}`,
          filePath: relPath,
          field: zodField,
          cause: converted.error.cause,
        },
      };
    }
    return { kind: 'ok', value: converted.value };
  }
  const wireValue = rec[wireField];
  // `wireValue` may itself be a Zod schema (author-time authored with Zod
  // but not yet run through defineTool). Convert lazily in that case.
  if (isZodSchema(wireValue)) {
    const converted = toJSONSchemaSync(wireValue as AnySchema, converter, side);
    if (converted.kind === 'err') {
      return {
        kind: 'err',
        error: {
          code: 'zod-conversion-failed',
          message: `${relPath}: Zod conversion for '${wireField}' failed: ${converted.error.message}`,
          filePath: relPath,
          field: wireField,
          cause: converted.error.cause,
        },
      };
    }
    return { kind: 'ok', value: converted.value };
  }
  if (!isObject(wireValue)) {
    return {
      kind: 'err',
      error: {
        code: 'manifest-validation-failed',
        message: `${relPath}: '${wireField}' is missing or not an object`,
        filePath: relPath,
        field: wireField,
      },
    };
  }
  return { kind: 'ok', value: wireValue as Readonly<Record<string, unknown>> };
}

// -----------------------------------------------------------------------
// Output serialization — atomic write + auto artifact version
// -----------------------------------------------------------------------

async function atomicWriteJson(
  outputPath: string,
  index: Index,
): Promise<Result<undefined, IndexerError>> {
  const tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `${stableStringify(index)}\n`;
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(tmpPath, serialized, 'utf8');
    await fs.rename(tmpPath, outputPath);
  } catch (cause) {
    // Best-effort tmp cleanup — swallow errors here (the original write
    // error is what the caller needs).
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore
    }
    return {
      kind: 'err',
      error: {
        code: 'output-write-failed',
        message: `Failed to write ${outputPath}: ${stringifyError(cause)}`,
        filePath: outputPath,
        cause: serializeCause(cause),
      },
    };
  }
  return { kind: 'ok', value: undefined };
}

/**
 * Stable JSON serializer — keys sorted at every level. Guarantees
 * byte-identical output for byte-identical semantic input, which is the
 * property the local integrity gate depends on.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec).sort()) {
    out[key] = canonicalize(rec[key]);
  }
  return out;
}

async function computeAutoArtifactVersion(outputPath: string): Promise<string> {
  const today = new Date();
  const yyyymmdd =
    today.getUTCFullYear().toString().padStart(4, '0') +
    (today.getUTCMonth() + 1).toString().padStart(2, '0') +
    today.getUTCDate().toString().padStart(2, '0');

  let n = 1;
  try {
    const existing = await fs.readFile(outputPath, 'utf8');
    const parsed = JSON.parse(existing) as { artifactVersion?: unknown };
    if (typeof parsed.artifactVersion === 'string') {
      const match = /^(\d{8})\.(\d+)$/.exec(parsed.artifactVersion);
      const dayPart = match?.[1];
      const nPart = match?.[2];
      if (dayPart === yyyymmdd && nPart !== undefined) {
        const parsedN = Number.parseInt(nPart, 10);
        if (Number.isFinite(parsedN)) n = parsedN + 1;
      }
    }
  } catch {
    // No prior index.json — start at .1
  }
  return `${yyyymmdd}.${n}`;
}

// -----------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------

function isObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sortById<T extends { readonly id: string }>(items: readonly T[]): readonly T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function serializeCause(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (err === undefined) return null;
  if (
    err === null ||
    typeof err === 'string' ||
    typeof err === 'number' ||
    typeof err === 'boolean'
  ) {
    return err;
  }
  try {
    JSON.stringify(err);
    return err;
  } catch {
    return String(err);
  }
}

function normalizeModulePath(relPath: string): string {
  // Forward slashes only, no leading './'
  let normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}
