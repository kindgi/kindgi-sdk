// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `kindgi deploy` — client-side deploy orchestrator.
 *
 * The one deployment wire call: reads the `deploy-envelope.json`
 * emitted by `kindgi build` — either from an explicit `--from-envelope <path>` OR by
 * auto-detecting `<out>/deploy-envelope.json` from the pack config OR
 * by running `kindgi build` inline as a fallback — then POSTs it to
 * `POST /v1/deployments` and prints the resulting deployment record.
 *
 * Pipeline:
 *
 *   1. Resolve args (env block, endpoint, token, envelope source).
 *   2. Ensure envelope exists — read from disk, or inline-build first.
 *   3. Structurally validate the envelope.
 *   4. Build the wire POST body (strip `tenantId` / `$schema` /
 *      `buildLogsUrl`).
 *   5. Compute `Idempotency-Key: sha256(canonicalBody)` (or `--idempotency-key`).
 *   6. If `--dry-run`: print the curl-equivalent + body + headers to
 *      stderr, exit 0.
 *   7. Otherwise POST via `ctx.fetch`.
 *   8. Handle response (201 / 200 / 4xx / 5xx / transport).
 *   9. Warn on out-of-band secrets sync if `.env.<envName>` exists.
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { LOCAL_ENV_NAME, type PackEnv, packValues, readPackEnv } from '@kindgi/secrets-dotenv';

import type { CommandContext } from '../context.js';
import { isEnvelopeSigned } from '../deploy/envelope-loader.js';
import {
  buildPostBody,
  deriveIdempotencyKey,
  deriveSyncSecretsIdempotencyKey,
} from '../deploy/post.js';
import { renderResponse } from '../deploy/response.js';
import type {
  DeployRunners,
  PostDeploymentBody,
  RunBuildResult,
  SyncSecretsBody,
} from '../deploy/runners.js';
import {
  type PackEnvPlan,
  describePackEnvPlan,
  plainSecretReason,
  planPackEnv,
} from '../env/pack-env-plan.js';
import { renderJson } from '../output.js';
import { loadPackConfig } from '../pack-config.js';
import { runBuild } from './build.js';
import type { EnvironmentConfig, PackConfig } from './build.js';
import type { CommandResult, LeafCommand } from './types.js';

/** Default relative path to look for a pre-built envelope. */
export const DEFAULT_ENVELOPE_RELATIVE_PATH = '.kindgi/build/deploy-envelope.json';

export const deployCommand: LeafCommand = {
  kind: 'leaf',
  name: 'deploy',
  description:
    'Deploy a signed pack image to Kindgi. Reads deploy-envelope.json (or runs `kindgi build` inline) + POSTs to /v1/deployments.',
  usage:
    'kindgi deploy [--env <name>] [--from-envelope <path>] [--endpoint <url>] [--token <bearer>] ' +
    '[--tenant <id>] [--idempotency-key <str>] [--dry-run] [--sync-secrets] [--allow-missing-env] ' +
    '[--target <t>] [--build-endpoint <url>] [--out <dir>] [--artifact-version <v>] [--published-at <iso>] ' +
    '[--signing-key <path>] [--signer-key-id <id>] [--registry-push-creds <ref>] ' +
    '[--skip-integrity-gate] [--skip-image-pull] [--skip-sign] [--path <dir>]',
  optionSpec: {
    env: { type: 'string' },
    'from-envelope': { type: 'string' },
    endpoint: { type: 'string' },
    tenant: { type: 'string' },
    'idempotency-key': { type: 'string' },
    'dry-run': { type: 'boolean' },
    // Opt-in post-deploy secret sync. Default OFF: regulated
    // verticals rotate secrets on a separate cadence.
    'sync-secrets': { type: 'boolean' },
    // Deploy although a name the pack's env.required declares has no
    // value for --env (the pack service won't be ready until it has).
    'allow-missing-env': { type: 'boolean' },
    // Pass-through build flags for inline-build fallback.
    target: { type: 'string' },
    'build-endpoint': { type: 'string' },
    out: { type: 'string' },
    'artifact-version': { type: 'string' },
    'published-at': { type: 'string' },
    'signing-key': { type: 'string' },
    'signer-key-id': { type: 'string' },
    'registry-push-creds': { type: 'string' },
    'skip-integrity-gate': { type: 'boolean' },
    'skip-image-pull': { type: 'boolean' },
    'skip-sign': { type: 'boolean' },
    path: { type: 'string' },
  },
  run: async (ctx): Promise<CommandResult> => runDeploy(ctx),
};

interface ResolvedDeployArgs {
  readonly packDir: string;
  readonly outDir: string;
  readonly envName: string;
  readonly endpoint: string;
  readonly token: string;
  readonly envelopePath: string;
  readonly envelopeSource: 'explicit' | 'auto-detect';
  readonly explicitEnvelope: boolean;
  readonly explicitTenantId: string | undefined;
  readonly idempotencyKeyOverride: string | undefined;
  readonly dryRun: boolean;
  /**
   * Opt-in post-deploy secret sync. When true, and
   * a local `.env.<envName>` file is present, the CLI POSTs its
   * entries to `POST /v1/deployments/:deploymentId/secrets` after a
   * successful register. Default OFF: regulated verticals rotate
   * secrets on a separate cadence — dev + prod both default OFF.
   */
  readonly syncSecrets: boolean;
  readonly envBlock: EnvironmentConfig | undefined;
  /** The pack service's process env in this environment (`env` + `environments.<env>.env`). */
  readonly packEnv: PackEnvPlan;
  readonly allowMissingEnv: boolean;
}

// ---------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------

export async function runDeploy(ctx: CommandContext): Promise<CommandResult> {
  const runners = ctx.deployRunners;
  if (runners === undefined) {
    return failure(
      'Internal error: kindgi deploy requires deploy runners to be wired. ' +
        'Rebuild the CLI (`pnpm --filter @kindgi/cli build`).\n',
    );
  }

  const parsed = await resolveDeployArgs(ctx);
  if (parsed.kind === 'error') return parsed;
  const args = parsed.args;

  const banner: string[] = [];
  const line = (s: string): void => {
    banner.push(s);
  };
  line('');
  line(`  Environment: ${args.envName}`);
  line(`  API:         ${args.endpoint}`);
  line(
    `  Envelope:    ${args.envelopePath}${args.envelopeSource === 'auto-detect' ? '  (auto-detected)' : ''}`,
  );
  line(
    `  Idempotency: ${args.idempotencyKeyOverride !== undefined ? '(caller-supplied)' : '(sha256 of canonical body — derived below)'}`,
  );
  line('');

  // ---- 0. The pack service's env in this environment -------------------
  //
  // Every name the pack declares in env.required needs a value or a
  // Secret Manager reference for this environment; a secret given in
  // the clear is refused. Checked before anything is built or sent.
  const envRefusal = checkPackEnv(args, line);
  if (envRefusal !== undefined) return envRefusal;

  // ---- 1. Ensure envelope on disk -------------------------------------
  const envelopeReady = await ensureEnvelopeExists(ctx, args, runners, line);
  if (envelopeReady.kind === 'error') return envelopeReady;

  // ---- 2. Load + validate envelope ------------------------------------
  const loaded = await runners.loadEnvelope({ path: args.envelopePath });
  if (loaded.kind === 'err') {
    return failure(
      `Failed to load deploy-envelope.json:\n  [${loaded.code}] ${loaded.message}\n\n` +
        `Path: ${loaded.path}\n\n` +
        `Regenerate with \`kindgi build --env=${args.envName}\` or point --from-envelope at a valid file.\n`,
    );
  }
  const envelope = loaded.envelope;

  // ---- 3. Signed-envelope gate ----------------------------------------
  if (!isEnvelopeSigned(envelope)) {
    if (!args.dryRun) {
      return failure(
        'deploy-envelope.json is unsigned. The server will refuse the deployment.\n' +
          'Re-run `kindgi build` without --skip-sign, or pass --dry-run to inspect ' +
          'what would be POSTed.\n',
      );
    }
    line('  ⚠ Envelope is unsigned — --dry-run is proceeding for inspection only.');
    line('');
  }

  // ---- 4. Consistency check: envelope.tenantId vs --tenant override ---
  if (args.explicitTenantId !== undefined && args.explicitTenantId !== envelope.tenantId) {
    return failure(
      `--tenant mismatch: envelope was signed against tenantId="${envelope.tenantId}", but --tenant was passed as "${args.explicitTenantId}". The server re-canonicalises using the token's tenantId + verifies the signature — a mismatch would fail with signature-invalid. Either drop --tenant or re-run \`kindgi build --tenant=${args.explicitTenantId}\`.\n`,
    );
  }

  // ---- 5. Build POST body + Idempotency-Key ---------------------------
  let postBody: PostDeploymentBody;
  try {
    postBody = buildPostBody(envelope);
  } catch (err) {
    return failure(`Internal error building POST body: ${(err as Error).message}\n`);
  }
  const idempotencyKey =
    args.idempotencyKeyOverride !== undefined
      ? args.idempotencyKeyOverride
      : deriveIdempotencyKey(postBody);

  // ---- 6. Secrets sync detection + warning ---------------------------
  //
  // `POST /v1/deployments/:id/secrets` lands after a successful
  // deploy iff `--sync-secrets` is passed. Default OFF (regulated
  // verticals rotate on a separate cadence).
  //
  // Even with the flag OFF we still surface a hint when we detect
  // `.env.<envName>` — otherwise the developer wonders why the sync
  // didn't happen.
  //
  // When flag ON: any key whose name looks secret-shaped (`_KEY`,
  // `_SECRET`, `_TOKEN`, `_PASSWORD`, `_PRIVATE`, `_APIKEY`) fires a
  // LOUD warning pointing at `kindgi secrets set` — plaintext
  // secrets in `.env.<envName>` are an anti-pattern the sync route
  // permits but discourages.
  const secretsFile = await detectSecretsFile(args, envelope.tenantId);
  if (secretsFile !== null && !args.syncSecrets) {
    line(
      `  Note: detected .env.${args.envName} (${secretsFile.entries.length} keys) at ${secretsFile.path}.`,
    );
    line('    --sync-secrets is OFF (default). Pass --sync-secrets to POST them to');
    line(`    /v1/deployments/${'<deploymentId>'}/secrets after the deploy lands.`);
    line('');
  }

  // ---- 7. Dry-run ------------------------------------------------------
  if (args.dryRun) {
    line('  Dry run — would POST the following:');
    line('');
    line(`    curl -X POST ${args.endpoint.replace(/\/+$/, '')}/v1/deployments \\`);
    line('      -H "Authorization: Bearer <redacted>" \\');
    line('      -H "Content-Type: application/json" \\');
    line(`      -H "Idempotency-Key: ${idempotencyKey}" \\`);
    line("      -d @-  <<'JSON'");
    for (const bodyLine of JSON.stringify(postBody, null, 2).split('\n')) {
      line(`    ${bodyLine}`);
    }
    line('    JSON');
    line('');
    line('  --dry-run set. No request sent. Exiting 0.');
    line('');
    const summary = {
      envName: args.envName,
      endpoint: args.endpoint,
      envelopePath: args.envelopePath,
      idempotencyKey,
      dryRun: true,
      wouldPost: postBody,
    };
    const rendered = renderJson(summary, ctx.globals.format);
    return {
      kind: 'ok',
      rendered: { stdout: rendered.stdout, stderr: `${banner.join('\n')}\n` },
    };
  }

  // ---- 8. POST ---------------------------------------------------------
  const result = await runners.postDeployment({
    endpoint: args.endpoint,
    token: args.token,
    body: postBody,
    idempotencyKey,
    fetchImpl: ctx.fetch,
    ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
  });

  // ---- 9. Render response ---------------------------------------------
  const rendered = renderResponse(result, {
    envName: args.envName,
    endpoint: args.endpoint,
    imageRef: envelope.imageRef,
    artifactVersion: envelope.artifactVersion,
    indexHash: envelope.indexHash,
    indexCounts: countIndexPrimitives(envelope.index),
    signerKeyId: envelope.signerKeyId ?? '(unsigned)',
    envelopePath: args.envelopePath,
    idempotencyKey,
  });
  for (const l of rendered.banner) line(l);

  if (rendered.exitCode !== 0) {
    return {
      kind: 'error',
      stderr: `${banner.join('\n')}\n`,
      exitCode: rendered.exitCode,
    };
  }

  // ---- 10. Post-deploy secrets sync ----------------------------------
  //
  // Runs iff `--sync-secrets` is passed AND the deploy landed OK AND
  // `.env.<envName>` has entries. Otherwise no-op (default path).
  //
  // Errors here do NOT change the exit code — the deployment already
  // succeeded. We surface the failure in the banner so the operator can
  // investigate + retry the sync manually via `kindgi secrets sync`
  // (when that CLI command lands in secrets.h).
  const syncSummary: Record<string, unknown> = { performed: false };
  const deployedRecord =
    result.kind === 'created' || result.kind === 'replayed' ? result.record : null;
  if (args.syncSecrets && deployedRecord !== null) {
    const syncOutcome = await runSecretsSync(ctx, args, runners, deployedRecord.deploymentId, line);
    Object.assign(syncSummary, syncOutcome);
  }

  const jsonOut = renderJson(
    { ...rendered.summary, ...(args.syncSecrets && { syncSecrets: syncSummary }) },
    ctx.globals.format,
  );
  return {
    kind: 'ok',
    rendered: { stdout: jsonOut.stdout, stderr: `${banner.join('\n')}\n` },
  };
}

// ---------------------------------------------------------------------
// Post-deploy secrets sync
// ---------------------------------------------------------------------

/**
 * Read `.env.<envName>` + POST entries to
 * `/v1/deployments/:deploymentId/secrets`. Only invoked when the user
 * opted in via `--sync-secrets`. Warns loudly when secret-shaped keys
 * are present (they should live in `kindgi secrets set` instead).
 */
async function runSecretsSync(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  runners: DeployRunners,
  deploymentId: string,
  line: (s: string) => void,
): Promise<Record<string, unknown>> {
  const file = await detectSecretsFile(args, '');
  if (file === null || file.entries.length === 0) {
    line('  --sync-secrets set, but no `.env.<envName>` entries to sync. Skipping.');
    line('');
    return { performed: false, reason: 'no-entries' };
  }

  // Warn loudly if any key looks secret-shaped — `.env.<envName>` was
  // designed for env vars, not secrets (regulated verticals should use
  // `kindgi secrets set`). We still sync — but the warning must be
  // impossible to miss.
  const shaped = file.entries.filter((e) => plainSecretReason(e.name, e.value) !== undefined);
  if (shaped.length > 0) {
    line(
      `  ! secret-shaped keys detected in .env.${args.envName}: ${shaped.map((e) => e.name).join(', ')}`,
    );
    line('    Keep secrets out of .env files: store them with `kindgi secrets`.');
    line(`    Consider: kindgi secrets set --env=${args.envName} <name> <value>`);
    line('');
  }

  const syncBody: SyncSecretsBody = {
    envName: args.envName,
    secrets: file.entries.map((e) => ({ name: e.name, value: e.value })),
  };
  const idempotencyKey = deriveSyncSecretsIdempotencyKey(deploymentId, syncBody);

  if (runners.syncSecrets === undefined) {
    line('  ! --sync-secrets set but no syncSecrets runner wired. Skipping.');
    line('    (Production wiring in packages/cli/src/deploy/defaults.ts).');
    line('');
    return { performed: false, reason: 'runner-not-wired' };
  }

  line(`  Syncing ${file.entries.length} secret${file.entries.length === 1 ? '' : 's'} to`);
  line(`    POST /v1/deployments/${deploymentId}/secrets`);
  const result = await runners.syncSecrets({
    endpoint: args.endpoint,
    token: args.token,
    deploymentId,
    body: syncBody,
    idempotencyKey,
    fetchImpl: ctx.fetch,
    ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
  });

  if (result.kind === 'ok') {
    line(`    ✓ 200 OK  →  resolved=${result.response.resolved} added=${result.response.added}`);
    line('');
    return {
      performed: true,
      resolved: result.response.resolved,
      added: result.response.added,
      references: result.response.references,
    };
  }
  if (result.kind === 'wire-error') {
    line(`    ✗ ${result.status} ${result.error.code}: ${result.error.message}`);
    line('      The deployment landed OK; only the secret sync failed. Retry with');
    line('      `kindgi deploy --sync-secrets` (idempotent).');
    line('');
    return { performed: false, error: { code: result.error.code, message: result.error.message } };
  }
  line(`    ✗ transport error: ${result.message}`);
  line('');
  return { performed: false, error: { code: 'transport-error', message: result.message } };
}

/**
 * The deploy preflight for the pack service's env (R4): the plan's lines
 * when the pack declares any, and the refusal when a required name has no
 * value (unless `--allow-missing-env`) or a secret is given in the clear.
 */
function checkPackEnv(
  args: ResolvedDeployArgs,
  line: (s: string) => void,
): CommandResult | undefined {
  const plan = args.packEnv;
  if (plan.entries.length === 0 && plan.problems.length === 0 && plan.warnings.length === 0) {
    return undefined;
  }
  for (const l of describePackEnvPlan(plan)) line(l);
  line('');
  if (plan.problems.length > 0) {
    return failure(
      `kindgi deploy: the pack service's env for ${args.envName} gives a secret in the clear or is malformed (above). Fix environments.${args.envName}.env in kindgi.config and deploy again.\n`,
    );
  }
  if (plan.missing.length > 0 && !args.allowMissingEnv) {
    return failure(
      `kindgi deploy: ${plan.missing.join(', ')} ${plan.missing.length === 1 ? 'is' : 'are'} required by the pack and ${plan.missing.length === 1 ? 'has' : 'have'} no value in environments.${args.envName}.env, so the pack service wouldn't be ready. Add ${plan.missing.length === 1 ? 'it' : 'them'}, or deploy anyway with --allow-missing-env.\n`,
    );
  }
  if (plan.missing.length > 0) {
    line(`  ⚠ --allow-missing-env: deploying without ${plan.missing.join(', ')}`);
    line('');
  }
  return undefined;
}

// ---------------------------------------------------------------------
// Envelope existence — either read from disk or inline-build
// ---------------------------------------------------------------------

async function ensureEnvelopeExists(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  runners: DeployRunners,
  line: (s: string) => void,
): Promise<{ readonly kind: 'ok' } | (CommandResult & { readonly kind: 'error' })> {
  const exists = await pathExists(args.envelopePath);
  if (exists) return { kind: 'ok' };

  if (args.explicitEnvelope) {
    return failure(
      `deploy-envelope.json not found at ${args.envelopePath} (--from-envelope). Verify the path or drop --from-envelope to auto-build.\n`,
    );
  }

  // Auto-detect path is missing → run build inline.
  line(`  Envelope missing — running \`kindgi build --env=${args.envName}\` inline...`);
  line('');
  if (runners.runBuild !== undefined) {
    const buildArgv = buildInlineArgv(ctx, args);
    const outcome: RunBuildResult = await runners.runBuild({
      buildArgv,
      packDir: args.packDir,
    });
    if (outcome.kind === 'err') {
      return failure(
        `Inline \`kindgi build\` failed (exit ${outcome.exitCode}):\n\n${outcome.stderr}`,
      );
    }
    if (outcome.banner.length > 0) {
      line(outcome.banner);
      line('');
    }
    // After the build the envelope should exist. If the build wrote it
    // to a different location than we auto-detected, honour the build's
    // reported path.
    const producedExists = await pathExists(outcome.envelopePath);
    if (!producedExists) {
      return failure(
        `\`kindgi build\` completed but no deploy-envelope.json was written at ${outcome.envelopePath}. Aborting.\n`,
      );
    }
    // Rebind path to the build's actual output. Mutating a readonly
    // typed field is not allowed — the caller pattern is to inspect
    // .envelopePath below.
    (args as { -readonly [K in keyof ResolvedDeployArgs]: ResolvedDeployArgs[K] }).envelopePath =
      outcome.envelopePath;
    return { kind: 'ok' };
  }

  // No inline runner available — invoke the same-package `runBuild`
  // directly. This is the production path when
  // `deployRunners.runBuild` is omitted (see `deploy/defaults.ts`).
  const built = await runInlineBuild(ctx, args);
  if (built.kind === 'error') return built;
  if (built.banner.length > 0) {
    line(built.banner);
    line('');
  }
  return { kind: 'ok' };
}

/**
 * Run `kindgi build` in-process, threading through the same
 * `CommandContext` (buildRunners, buildConfigLoader, env, cwd, etc.)
 * but with an argument set derived from the deploy invocation. We
 * clone the context with `options` replaced so the build command sees
 * only build-relevant flags.
 */
async function runInlineBuild(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
): Promise<
  | { readonly kind: 'ok'; readonly banner: string }
  | { readonly kind: 'error'; readonly stderr: string; readonly exitCode: number }
> {
  const buildOptions = buildInlineOptions(ctx, args);
  const buildCtx: CommandContext = { ...ctx, options: buildOptions };
  const result = await runBuild(buildCtx);
  if (result.kind === 'error') {
    return {
      kind: 'error',
      stderr: `Inline \`kindgi build\` failed (exit ${result.exitCode}):\n\n${result.stderr}`,
      exitCode: 1,
    };
  }
  // Build success — envelope should now exist at args.envelopePath.
  const exists = await pathExists(args.envelopePath);
  if (!exists) {
    return {
      kind: 'error',
      stderr: `\`kindgi build\` completed but no deploy-envelope.json was written at ${args.envelopePath}. Aborting.\n`,
      exitCode: 1,
    };
  }
  return {
    kind: 'ok',
    banner: result.rendered.stderr.trim(),
  };
}

function buildInlineOptions(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
): Record<string, string | boolean | undefined> {
  const opts: Record<string, string | boolean | undefined> = {};
  opts.env = args.envName;
  opts.path = args.packDir;
  opts.out = args.outDir;
  const pass = (key: string, alias?: string): void => {
    const val = ctx.options[alias ?? key];
    if (val !== undefined) opts[key] = val;
  };
  pass('target');
  // The deploy command has its OWN --endpoint (for the api-server). The
  // build server URL is either `env.build` in kindgi.config.ts OR
  // deploy's `--build-endpoint` alias. Thread the alias into build's
  // `--endpoint`.
  const buildEndpoint = ctx.options['build-endpoint'];
  if (buildEndpoint !== undefined) opts.endpoint = buildEndpoint;
  pass('artifact-version');
  pass('published-at');
  if (args.explicitTenantId !== undefined) opts.tenant = args.explicitTenantId;
  pass('signing-key');
  pass('signer-key-id');
  pass('registry-push-creds');
  pass('skip-integrity-gate');
  pass('skip-image-pull');
  pass('skip-sign');
  return opts;
}

/**
 * Same as `buildInlineOptions` but flattened into a `--flag=value`
 * argv-style array. Used when a test-supplied `DeployRunners.runBuild`
 * wants to see the exact CLI form the command would have invoked.
 */
function buildInlineArgv(ctx: CommandContext, args: ResolvedDeployArgs): readonly string[] {
  const opts = buildInlineOptions(ctx, args);
  const out: string[] = ['build'];
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined) continue;
    if (typeof v === 'boolean') {
      if (v) out.push(`--${k}`);
    } else {
      out.push(`--${k}=${v}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Argument resolution
// ---------------------------------------------------------------------

type ArgsOutcome =
  | { readonly kind: 'ok'; readonly args: ResolvedDeployArgs }
  | (CommandResult & { readonly kind: 'error' });

async function resolveDeployArgs(ctx: CommandContext): Promise<ArgsOutcome> {
  // --path — pack root, default cwd.
  const pathFlag = ctx.options.path;
  const rawPath = typeof pathFlag === 'string' && pathFlag !== '' ? pathFlag : ctx.cwd;
  const packDir = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

  // Load kindgi.config.ts — same seam kindgi build uses.
  const config = await loadDeployConfig(ctx, packDir);
  if (config.kind === 'error') return config;
  const cfg = config.config;

  // --env — default staging (matches build's default).
  const envFlag = ctx.options.env;
  const envName = typeof envFlag === 'string' && envFlag !== '' ? envFlag : 'staging';
  const envBlock =
    cfg.environments?.[envName] !== undefined
      ? ((cfg.environments as Record<string, EnvironmentConfig>)[envName] as EnvironmentConfig)
      : undefined;

  // --out — resolves the output dir the build command uses.
  const outFlag = ctx.options.out;
  const outDirRaw = typeof outFlag === 'string' && outFlag !== '' ? outFlag : '.kindgi/build';
  const outDir = isAbsolute(outDirRaw) ? outDirRaw : resolve(packDir, outDirRaw);

  // --endpoint — env.endpoint > --endpoint flag > config apiUrl > KINDGI_API_URL > error.
  const endpointFlag = ctx.options.endpoint;
  const endpoint =
    typeof endpointFlag === 'string' && endpointFlag !== ''
      ? endpointFlag
      : (envBlock?.endpoint ??
        ctx.config.apiUrl ??
        (typeof ctx.env.KINDGI_API_URL === 'string'
          ? (ctx.env.KINDGI_API_URL as string)
          : undefined));
  if (endpoint === undefined || endpoint === '') {
    return {
      kind: 'error',
      stderr: `kindgi deploy could not resolve an API endpoint. Set environments.${envName}.endpoint in kindgi.config.ts, pass --endpoint <url>, or export KINDGI_API_URL.\n`,
      exitCode: 1,
    };
  }

  // --token — bearer token; standard config precedence.
  const token = ctx.config.token;
  if (token === undefined || token === '') {
    return {
      kind: 'error',
      stderr:
        'kindgi deploy could not resolve an API token. ' +
        'Pass --token <bearer>, export KINDGI_API_TOKEN, or run `kindgi auth login`.\n',
      exitCode: 1,
    };
  }

  // --tenant — used only as a consistency check against the envelope.
  const tenantFlag = ctx.options.tenant;
  const explicitTenantId =
    typeof tenantFlag === 'string' && tenantFlag !== '' ? tenantFlag : undefined;

  // --from-envelope — explicit path OR auto-detect.
  const fromFlag = ctx.options['from-envelope'];
  const explicitEnvelope = typeof fromFlag === 'string' && fromFlag !== '';
  const envelopePath = explicitEnvelope
    ? isAbsolute(fromFlag as string)
      ? (fromFlag as string)
      : resolve(ctx.cwd, fromFlag as string)
    : join(outDir, 'deploy-envelope.json');

  const idempotencyKeyFlag = ctx.options['idempotency-key'];
  const idempotencyKeyOverride =
    typeof idempotencyKeyFlag === 'string' && idempotencyKeyFlag !== ''
      ? idempotencyKeyFlag
      : undefined;

  const dryRun = ctx.options['dry-run'] === true;
  // Opt-in flag. Default OFF (see `syncSecrets` above).
  const syncSecrets = ctx.options['sync-secrets'] === true;

  // The pack service's env in this environment: the declaration in
  // `env` against `environments.<envName>.env` (checked in runDeploy).
  const packEnv = planPackEnv(cfg as Readonly<Record<string, unknown>>, envName);
  if (packEnv.kind === 'err') {
    return { kind: 'error', stderr: `kindgi deploy: ${packEnv.message}\n`, exitCode: 1 };
  }

  return {
    kind: 'ok',
    args: {
      packDir,
      outDir,
      envName,
      endpoint,
      token,
      envelopePath,
      envelopeSource: explicitEnvelope ? 'explicit' : 'auto-detect',
      explicitEnvelope,
      explicitTenantId,
      idempotencyKeyOverride,
      dryRun,
      syncSecrets,
      envBlock,
      packEnv: packEnv.plan,
      allowMissingEnv: ctx.options['allow-missing-env'] === true,
    },
  };
}

async function loadDeployConfig(
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
        ? `kindgi deploy could not load kindgi.config.ts at ${packDir}. Run \`kindgi init <pack-name>\` to scaffold a pack, or pass --path=<dir>.\n`
        : `Failed to load kindgi.config.ts at ${packDir}: ${outcome.message}\n`,
    exitCode: 1,
  };
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function failure(stderr: string): CommandResult {
  return { kind: 'error', stderr, exitCode: 1 };
}

function countIndexPrimitives(index: Readonly<Record<string, unknown>>): {
  tools: number;
  guardrails: number;
  agents: number;
  flows: number;
} {
  const asArrLen = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  return {
    tools: asArrLen(index.tools),
    guardrails: asArrLen(index.guardrails),
    agents: asArrLen(index.agents),
    flows: asArrLen(index.flows),
  };
}

// ---------------------------------------------------------------------
// Secrets sync — file detection + parsing
// ---------------------------------------------------------------------

interface DetectedEnvEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * Detect an out-of-band secrets file (`.env.<envName>`) next to the
 * pack config + parse its `KEY=value` entries. Comments + blank lines
 * are skipped. When the `--sync-secrets` flag is off, the
 * detector still fires so the CLI can hint at the opt-in path. When
 * the flag is on, the returned `entries` become the sync-request body.
 *
 * Parser is intentionally minimal (same subset as
 * `packages/cli/src/env/parser.ts` — but re-inlined here to avoid
 * pulling the whole `kindgi env` command flow into `deploy`).
 */
async function detectSecretsFile(
  args: ResolvedDeployArgs,
  _tenantId: string,
): Promise<{ readonly path: string; readonly entries: readonly DetectedEnvEntry[] } | null> {
  // `local` is the project's own env files — in an existing app, the
  // app's whole `.env`. `kindgi dev` reads them directly; they are never
  // pushed anywhere.
  if (args.envName === LOCAL_ENV_NAME) return null;
  let env: PackEnv;
  try {
    env = await readPackEnv({ packDir: args.packDir, envName: args.envName });
  } catch {
    // If we can't read it, don't warn — a real file with a real
    // problem will surface elsewhere.
    return null;
  }
  if (env.present.length === 0) return null;
  // Same reader as `kindgi dev` / `kindgi env`: dotenv grammar, `${VAR}`
  // expanded (no shell fallback — local machine values must not leak
  // into a deployed environment), `KINDGI_*` runtime names excluded.
  const entries = Object.entries(packValues(env.values))
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => ({ name, value }));
  return { path: env.files.write, entries };
}
