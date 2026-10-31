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
 *   3. Structurally validate the envelope, and check its blocks against
 *      what runs (`deploy/runs-check.ts`), unless an inline build's local
 *      index was checked before its image was built.
 *   4. Build the wire POST body (strip `tenantId` / `$schema` /
 *      `buildLogsUrl`).
 *   5. Compute `Idempotency-Key: sha256(canonicalBody)` (or `--idempotency-key`).
 *   6. If `--dry-run`: print the curl-equivalent + body + headers to
 *      stderr, exit 0. An unsigned envelope shows the body less the
 *      signature's fields, and no derived key.
 *   7. Otherwise POST via `ctx.fetch`, waiting out the server's rate
 *      limits (`429` with `Retry-After`) for up to 10 minutes in all.
 *   8. Handle response (201 / 200 / 4xx / 5xx / transport).
 *   9. Warn on out-of-band secrets sync if `.env.<envName>` exists.
 */

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { createClient } from '@kindgi/client';
import { type DiscoveryConfig, readPackBlocks, resolveDiscovery } from '@kindgi/handler-runtime';
import { LOCAL_ENV_NAME, type PackEnv, packValues, readPackEnv } from '@kindgi/secrets-dotenv';

import { deployApiAddress, hostedApiAddress } from '../api-address.js';
import { describeFiles } from '../build/pack-blocks.js';
import type { CommandContext } from '../context.js';
import { isEnvelopeSigned } from '../deploy/envelope-loader.js';
import { packBlocksRefusal } from '../deploy/pack-blocks-gate.js';
import { packServiceProblemText, packServiceRetiredText } from '../deploy/pack-service-text.js';
import {
  type UnsignedPostBody,
  buildPostBody,
  deriveIdempotencyKey,
  deriveSyncSecretsIdempotencyKey,
  unsignedPostBody,
} from '../deploy/post.js';
import { type PromotionStop, promotionPath } from '../deploy/promotion-path.js';
import { renderResponse } from '../deploy/response.js';
import type {
  DeployRunners,
  DeploymentEndpointRecord,
  DeploymentRecord,
  PostDeploymentBody,
  PostDeploymentResult,
  RunBuildResult,
  SyncSecretsBody,
} from '../deploy/runners.js';
import {
  type ReplaceFlags,
  type StopWords,
  UNCHECKED_LINES,
  checkRuns,
  passedLines,
  replaceFlagsProblem,
  replaceOf,
  runsCheckInputOf,
  stoppedText,
} from '../deploy/runs-check.js';
import { envProjectRefs } from '../env-projects.js';
import {
  packEnvProblemLines,
  packEnvSecretSetCommand,
  packEnvSetCommand,
} from '../env/pack-env-hint.js';
import {
  type PackEnvPlan,
  describePackEnvPlan,
  packEnvPlanLines,
  packEnvPlanWarnings,
  plainSecretReason,
  planPackEnv,
} from '../env/pack-env-plan.js';
import { renderJson } from '../output.js';
import { loadPackConfig } from '../pack-config.js';
import type { OptionValue } from '../parse.js';
import { type ProgressLines, progressLines } from '../progress-lines.js';
import { PROJECT_ID_RE } from '../project-ref.js';
import { type RateLimitRefusal, isWait, sendWaitingOutRateLimits } from '../rate-limit-wait.js';
import { SLUG } from '../slug.js';
import { type PackEnvironments, environmentsOf, resolveValueTarget } from '../value-target.js';
import { CLI_VERSION } from '../version-info.js';
import { runBuild } from './build.js';
import type { BuildHooks, EnvironmentConfig, PackConfig } from './build.js';
import { listFlag, stringFlag } from './helpers.js';
import type { CommandResult, LeafCommand } from './types.js';

/** Default relative path to look for a pre-built envelope. */
export const DEFAULT_ENVELOPE_RELATIVE_PATH = '.kindgi/build/deploy-envelope.json';

export const deployCommand: LeafCommand = {
  kind: 'leaf',
  name: 'deploy',
  description:
    'Deploy a signed pack image to Kindgi. Reads deploy-envelope.json (or runs `kindgi build` inline) + POSTs to /v1/deployments. ' +
    "`--hosted` (or the env block's `build: 'hosted'`) deploys to Kindgi hosted: an inline build runs on the hosted build service (as `kindgi build --hosted`), and after the deploy it waits, up to 5 minutes, for the deployment's pack service to be ready. " +
    "A deploy into the Default project with a pack tool whose id is an MCP endpoint's tool's is refused (`tool-kind-mismatch`), and nothing is deployed. " +
    "Before an image is built, the pack's blocks are checked against what runs: a deploy that would put back an older version of a block than runs now in a project of one of its agents stops, and exits 1 with nothing deployed, unless `--replace` names the block, with `--reason`.",
  hostedRun: { defaultEnv: 'staging' },
  usage:
    'kindgi deploy [--env <name>] [--from-envelope <path>] [--endpoint <url>] [--token <bearer>] ' +
    '[--tenant <id>] [--project <id|slug>] [--hosted] [--idempotency-key <str>] [--dry-run] [--sync-secrets] [--allow-missing-env] ' +
    '[--replace <block>]... [--reason <text>] ' +
    '[--target <t>] [--build-endpoint <url>] [--out <dir>] [--artifact-version <v>] [--published-at <iso>] ' +
    '[--signing-key <path>] [--signer-key-id <id>] [--registry-push-creds <ref>] ' +
    '[--skip-integrity-gate] [--skip-image-pull] [--skip-sign] [--path <dir>]',
  optionSpec: {
    env: {
      type: 'string',
      description:
        'The environment: its block in `kindgi.config.ts` and its `.env.<name>` file. Default: `staging`.',
    },
    'from-envelope': {
      type: 'string',
      description:
        'The envelope to deploy. Default: `deploy-envelope.json` in `--out`; when there is none, `kindgi build` runs first.',
    },
    endpoint: {
      type: 'string',
      description:
        "The API to deploy to. Default: the env block's `endpoint`, else the CLI's API URL (`--url`, `KINDGI_API_URL`, config files).",
    },
    tenant: {
      type: 'string',
      description:
        'Refuse unless the envelope was signed for this tenant (checked before sending). Also passed to an inline build.',
    },
    project: {
      type: 'string',
      description:
        "The project to deploy into, one per client: its id, or its slug. A slug two orgs share is refused: pass the id. Default: a tenant-wide deploy, into the tenant's Default project.",
    },
    'idempotency-key': {
      type: 'string',
      description:
        'The `Idempotency-Key` header. Default: a hash of the request body, so the same image deployed again returns the same deployment.',
    },
    'dry-run': {
      type: 'boolean',
      description:
        "Print the equivalent `curl` request instead of sending it. A missing envelope is still built first, and the pack's blocks are still checked against what runs: a stop exits 1.",
    },
    replace: {
      type: 'string',
      multiple: true,
      description:
        'A block the deploy puts back on purpose, although a newer version of it runs now (repeatable). Needs --reason. The deployment records each, with the reason and who deployed.',
    },
    reason: {
      type: 'string',
      description: 'Why --replace puts the blocks back: 1 to 500 characters.',
    },
    // Opt-in post-deploy secret sync. Default OFF: regulated
    // verticals rotate secrets on a separate cadence.
    'sync-secrets': {
      type: 'boolean',
      description:
        "After the deploy lands, also send the values in `.env.<env>` to the deployment's secrets. Off by default. A hosted deploy needs --env with it.",
    },
    // Deploy although a name the pack's env.required declares has no
    // value for --env (the pack service won't be ready until it has).
    'allow-missing-env': {
      type: 'boolean',
      description:
        "Deploy, with a warning, even when a name in the pack's `env.required` has no value for `--env`.",
    },
    // Pass-through build flags for inline-build fallback.
    target: {
      type: 'string',
      description:
        "For an inline build: the build target. Default: the env block's `buildTarget`, else the env name.",
    },
    'build-endpoint': {
      type: 'string',
      description:
        "For an inline build: the build server (`kindgi build --endpoint`). Default: the env block's `build`.",
    },
    out: {
      type: 'string',
      description:
        'Where the envelope is looked for, and an inline build writes (default: `.kindgi/build`). An inline build applies the same --out rules as `kindgi build`: not the pack root or a directory containing it, and under it for a TypeScript pack.',
    },
    'artifact-version': {
      type: 'string',
      description:
        'For an inline build: the artifact version. Default: the build time as `YYYYMMDD.HHMMSS` (UTC). For a reproducible build, pass `--artifact-version` and `--published-at`.',
    },
    'published-at': {
      type: 'string',
      description:
        'For an inline build: the publish time (an ISO 8601 time with a zone, or a date: its start, UTC). Default: the build time. For a reproducible build, pass `--artifact-version` and `--published-at`.',
    },
    'signing-key': {
      type: 'string',
      description:
        "For an inline build: the Ed25519 private key (PEM) to sign with. Default: the env block's `signingKey`.",
    },
    'signer-key-id': {
      type: 'string',
      description:
        "For an inline build: the key id the signature names. Default: the env block's `signerKeyId`, else the key file's name.",
    },
    'registry-push-creds': {
      type: 'string',
      description:
        'For an inline build: a reference to the registry push credentials for the build server to use.',
    },
    'skip-integrity-gate': {
      type: 'boolean',
      description:
        "For an inline build: sign without checking the image's index against the local one.",
    },
    'skip-image-pull': {
      type: 'boolean',
      description:
        "For an inline build: check the image's index by hash only, without pulling the image.",
    },
    'skip-sign': {
      type: 'boolean',
      description:
        'For an inline build: write an unsigned envelope, which the deploy then refuses unless `--dry-run`.',
    },
    path: { type: 'string', description: 'The pack root. Default: the current directory.' },
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
  /** `--project`: an id or a slug, resolved before the POST. */
  readonly projectRef: string | undefined;
  /** `--hosted`, or the env block's `build: 'hosted'`: build there, then wait for the pack service. */
  readonly hosted: boolean;
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
  /**
   * The pack's environments, each with the project it names, if any: for the
   * value target, and to name the environments a refusal into a later one
   * points at.
   */
  readonly environments: PackEnvironments;
  /** The pack service's process env in this environment (`env` + `environments.<env>.env`). */
  readonly packEnv: PackEnvPlan;
  readonly allowMissingEnv: boolean;
  /** The pack's blocks discovery pattern (`discovery.blocks`, the same default in every language). */
  readonly blocksPattern: string;
  /** `--replace` and `--reason`: the blocks put back on purpose, and why. */
  readonly replace: ReplaceFlags;
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

  // Deploy's lines, its inline build's among them: each to stderr as it
  // comes when the CLI streams them, else kept for the result. A failure's
  // error comes after them either way. `--quiet` keeps errors and warnings
  // only, as `kindgi dev` does: a refusal, a secret sync that failed, and
  // its warnings.
  const out = progressLines(ctx.progress, ctx.globals.format === 'quiet');
  const result = await deployWith(ctx, runners, args, out);
  if (result.kind === 'error') return { ...result, stderr: `${out.kept()}${result.stderr}` };
  return { ...result, rendered: { ...result.rendered, stderr: out.kept() } };
}

async function deployWith(
  ctx: CommandContext,
  runners: DeployRunners,
  args: ResolvedDeployArgs,
  out: ProgressLines,
): Promise<CommandResult> {
  const { line } = out;
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
  const envRefusal = checkPackEnv(args, out);
  if (envRefusal !== undefined) return envRefusal;

  // On a runtime that keeps its values under one env, a pack environment
  // with a `project` is that project, and its secret sync goes there, under
  // the env the runtime serves. Any other env's sync is refused here,
  // before a build or an upload, as the runtime would refuse the sync after
  // the deployment.
  let syncEnvName = args.envName;
  let environmentProject: string | undefined;
  const named = args.environments[args.envName] !== undefined;
  if ((args.syncSecrets || named) && runners.servedEnv !== undefined) {
    const target = resolveValueTarget({
      flag: args.envName,
      served: await runners.servedEnv({
        endpoint: args.endpoint,
        token: args.token,
        fetchImpl: ctx.fetch,
        ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
      }),
      write: args.syncSecrets,
      what: `the secrets in .env.${args.envName}`,
      mayOmit: false,
      environments: args.environments,
    });
    if (target.kind === 'refused') return failure(target.stderr);
    if (target.kind === 'ok' && target.environment !== undefined) {
      environmentProject = target.environment.projectRef;
      syncEnvName = target.envName;
      line(`  Project:     ${environmentProject}  (environments.${args.envName}.project)`);
      if (args.syncSecrets) line(`  Secrets:     under ${syncEnvName}, the env the runtime serves`);
      line('');
    }
  }

  // ---- 1. The project to deploy into (--project) ---------------------
  //
  // Resolved first: a project that isn't there fails before a build, and
  // a hosted build carries the project's id as its label.
  const project = await resolveDeployProject(args, environmentProject, runners, ctx);
  if (project.kind === 'error') return failure(project.message);
  const hostedEnvRefusal = refuseHostedConfigEnv(args, project.id);
  if (hostedEnvRefusal !== undefined) return hostedEnvRefusal;

  // A pack with blocks deploys only to a runtime that publishes them
  // (`deploy/pack-blocks-gate.ts`): read before a build or an upload, from
  // the pack's block files when the envelope is still to be built, and
  // from the envelope's index (step 3) otherwise. Not on --dry-run, which
  // sends nothing.
  let blocksChecked = false;
  const refuseBlocks = async (brought: string): Promise<string | undefined> => {
    if (args.dryRun || blocksChecked) return undefined;
    blocksChecked = true;
    return packBlocksRefusal({
      endpoint: args.endpoint,
      fetchImpl: ctx.fetch,
      ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
      brought,
      release: CLI_VERSION,
    });
  };
  if (!args.explicitEnvelope && !(await pathExists(args.envelopePath))) {
    const read = await readPackBlocks(args.packDir, args.blocksPattern);
    const found = new Set([...read.files, ...read.errors.map((e) => e.filePath)]).size;
    const refused =
      found > 0 ? await refuseBlocks(describeFiles(args.blocksPattern, found)) : undefined;
    if (refused !== undefined) return failure(refused);
  }

  // The pack's blocks against what runs, asked once, before an image is
  // built: from the local index an inline build writes, else from the
  // envelope's (step 3). A stop exits 1 with nothing deployed, under
  // --dry-run too (`deploy/runs-check.ts`).
  const runsCheck = runsCheckOnce(ctx, args, project.id, out);

  // ---- 2. Ensure envelope on disk -------------------------------------
  const envelopeReady = await ensureEnvelopeExists(
    ctx,
    args,
    runners,
    out,
    project.id,
    runsCheck.hooks,
  );
  if (envelopeReady.kind === 'error') return envelopeReady;

  // ---- 3. Load + validate envelope ------------------------------------
  const loaded = await runners.loadEnvelope({ path: args.envelopePath });
  if (loaded.kind === 'err') {
    return failure(
      `Failed to load deploy-envelope.json:\n  [${loaded.code}] ${loaded.message}\n\n` +
        `Path: ${loaded.path}\n\n` +
        `Regenerate with \`kindgi build --env=${args.envName}\` or point --from-envelope at a valid file.\n`,
    );
  }
  const envelope = loaded.envelope;
  const indexBlocks = Array.isArray(envelope.index.blocks) ? envelope.index.blocks.length : 0;
  if (indexBlocks > 0) {
    const refused = await refuseBlocks(
      `${indexBlocks} ${indexBlocks === 1 ? 'block' : 'blocks'} in its index`,
    );
    if (refused !== undefined) return failure(refused);
  }
  const stopped = await runsCheck.unlessChecked(envelope.index);
  if (stopped !== undefined) return stopped;

  // ---- 4. Signed-envelope gate ----------------------------------------
  if (!isEnvelopeSigned(envelope)) {
    if (!args.dryRun) return failure(UNSIGNED_REFUSAL);
    out.problem('  ⚠ Envelope is unsigned — --dry-run is proceeding for inspection only.');
    out.problem('');
  }

  // ---- 5. Consistency check: envelope.tenantId vs --tenant override ---
  if (args.explicitTenantId !== undefined && args.explicitTenantId !== envelope.tenantId) {
    return failure(
      `--tenant mismatch: envelope was signed against tenantId="${envelope.tenantId}", but --tenant was passed as "${args.explicitTenantId}". The server re-canonicalises using the token's tenantId + verifies the signature — a mismatch would fail with signature-invalid. Either drop --tenant or re-run \`kindgi build --tenant=${args.explicitTenantId}\`.\n`,
    );
  }

  // ---- 6. Build POST body + Idempotency-Key ---------------------------
  //
  // An unsigned envelope comes this far only under --dry-run (step 4). It
  // has no POST body: the dry run shows the body less the signature's
  // fields, and no derived Idempotency-Key, which hashes the signed body.
  // Where the pack lives in git, inside a work tree (`deploy/source.ts`).
  const source = await runners.readSource?.(args.packDir);
  const replace = replaceOf(args.replace);
  const bodyFields = {
    ...(project.id !== undefined && { projectId: project.id }),
    ...(source !== undefined && { source }),
    ...(replace !== undefined && { replace }),
  };
  const postBody: PostDeploymentBody | undefined = isEnvelopeSigned(envelope)
    ? { ...buildPostBody(envelope), ...bodyFields }
    : undefined;
  const idempotencyKey =
    args.idempotencyKeyOverride ??
    (postBody !== undefined ? deriveIdempotencyKey(postBody) : undefined);

  // ---- 7. Secrets sync detection + warning ---------------------------
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

  // ---- 8. Dry-run ------------------------------------------------------
  if (args.dryRun) {
    const shown = postBody ?? { ...unsignedPostBody(envelope), ...bodyFields };
    return dryRunResult(ctx, args, line, shown, idempotencyKey);
  }
  // Step 4 refused an unsigned envelope without --dry-run; this tells the types.
  if (postBody === undefined || idempotencyKey === undefined) return failure(UNSIGNED_REFUSAL);

  // ---- 9. POST ---------------------------------------------------------
  //
  // A `429 rate-limit-exceeded` with `Retry-After` is waited out and the
  // same request sent again, with the same Idempotency-Key: the server
  // keeps no answer to a refused request under its key.
  const result = await sendWaitingOutRateLimits(
    ctx,
    () =>
      runners.postDeployment({
        endpoint: args.endpoint,
        token: args.token,
        body: postBody,
        idempotencyKey,
        fetchImpl: ctx.fetch,
        ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
      }),
    deployRefusal,
  );

  // ---- 10. Render response ---------------------------------------------
  const promotionPath = await promotionPathOf(args, runners, ctx, result);
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
    promotionPath,
  });
  // A refused deployment's banner is its error: said under `--quiet` too.
  if (rendered.exitCode !== 0) {
    return {
      kind: 'error',
      stderr: rendered.banner.map((l) => `${l}\n`).join(''),
      exitCode: rendered.exitCode,
    };
  }
  for (const l of rendered.banner) line(l);

  // ---- 11. Post-deploy secrets sync ----------------------------------
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
    const syncOutcome = await runSecretsSync(
      ctx,
      args,
      syncEnvName,
      runners,
      deployedRecord.deploymentId,
      out,
    );
    Object.assign(syncSummary, syncOutcome);
  }

  // ---- 12. Hosted: wait for the deployment's pack service --------------
  //
  // After the secrets sync, so the service starts with them. The
  // deployment is in place whatever the wait finds.
  let packService: DeploymentEndpointRecord | undefined;
  if (args.hosted && deployedRecord !== null && deployedRecord.endpoint !== undefined) {
    const waited = await waitForPackService(ctx, args, runners, deployedRecord, line, project.id);
    if (waited.kind === 'error') {
      return { kind: 'error', stderr: waited.message, exitCode: 1 };
    }
    packService = waited.endpoint;
  }

  // ---- 13. Hosted: the builds the project keeps -------------------------
  //
  // Each kept build has its own pack service, and a version stays callable
  // by its number until someone unregisters it, so say how many there are
  // and how to let old ones go. Only when the runtime counts them.
  const kept =
    packService !== undefined ? await sayKeptBuilds(ctx, args, runners, line, project.id) : {};

  const jsonOut = renderJson(
    {
      ...rendered.summary,
      ...(args.syncSecrets && { syncSecrets: syncSummary }),
      ...(packService !== undefined && { packService }),
      ...(kept.keptBuilds !== undefined && { keptBuilds: kept.keptBuilds }),
      ...(kept.error !== undefined && { keptBuildsError: kept.error }),
    },
    ctx.globals.format,
  );
  return {
    kind: 'ok',
    rendered: { stdout: jsonOut.stdout, stderr: '' },
  };
}

/**
 * A refused deployment to wait out: `429 rate-limit-exceeded` with a
 * `Retry-After`. Not a replayed one (a runtime before 0.1.3 replays
 * refusals): sent again, it would answer the same.
 */
function deployRefusal(result: PostDeploymentResult): RateLimitRefusal | undefined {
  if (
    result.kind !== 'wire-error' ||
    result.status !== 429 ||
    result.error.code !== 'rate-limit-exceeded' ||
    result.idempotentReplay === true ||
    !isWait(result.retryAfterSeconds)
  ) {
    return undefined;
  }
  return {
    retryAfterSeconds: result.retryAfterSeconds,
    ...(result.error.limit !== undefined && { limit: result.error.limit }),
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
  /** The env the values go under: `--env`, or the one a runtime that keeps its values under one serves. */
  envName: string,
  runners: DeployRunners,
  deploymentId: string,
  out: ProgressLines,
): Promise<Record<string, unknown>> {
  const { line, problem } = out;
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
    problem(
      `  ! secret-shaped keys detected in .env.${args.envName}: ${shaped.map((e) => e.name).join(', ')}`,
    );
    problem('    Keep secrets out of .env files: store them with `kindgi secrets`.');
    problem(`    Consider: kindgi secrets set --env=${args.envName} <name> <value>`);
    problem('');
  }

  const syncBody: SyncSecretsBody = {
    envName,
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
    // Errors: said under `--quiet` too, though the exit code stays 0.
    problem(`    ✗ ${result.status} ${result.error.code}: ${result.error.message}`);
    syncFailedHint(problem);
    return { performed: false, error: { code: result.error.code, message: result.error.message } };
  }
  problem(`    ✗ transport error: ${result.message}`);
  syncFailedHint(problem);
  return { performed: false, error: { code: 'transport-error', message: result.message } };
}

/** After a secret sync that failed: the deployment is in place; how to sync again. */
function syncFailedHint(problem: (s: string) => void): void {
  problem('      The deployment landed OK; only the secret sync failed. Retry with');
  problem('      `kindgi deploy --sync-secrets` (idempotent).');
  problem('');
}

/**
 * The deploy preflight for the pack service's env (R4): the plan's lines
 * when the pack declares any, and the refusal when a required name has no
 * value (unless `--allow-missing-env`) or a secret is given in the clear.
 */
function checkPackEnv(args: ResolvedDeployArgs, out: ProgressLines): CommandResult | undefined {
  // A hosted pack service gets the values set in the workspace, not these:
  // `refuseHostedConfigEnv`, once the project is known.
  if (args.hosted) return undefined;
  const plan = args.packEnv;
  if (plan.entries.length === 0 && plan.problems.length === 0 && plan.warnings.length === 0) {
    return undefined;
  }
  const refusal = packEnvRefusal(args, plan);
  if (refusal !== undefined) {
    // A refusal's reason is the plan: said under `--quiet` too.
    for (const l of describePackEnvPlan(plan)) out.problem(l);
    out.problem('');
    return failure(refusal);
  }
  // A plan that deploys: under `--quiet`, its warnings alone.
  for (const l of packEnvPlanLines(plan)) out.line(l);
  for (const l of packEnvPlanWarnings(plan)) out.problem(l);
  (plan.warnings.length > 0 ? out.problem : out.line)('');
  if (plan.missing.length > 0) {
    out.problem(`  ⚠ --allow-missing-env: deploying without ${plan.missing.join(', ')}`);
    out.problem('');
  }
  return undefined;
}

/** Why the pack service's env refuses the deploy (`checkPackEnv`), when it does. */
function packEnvRefusal(args: ResolvedDeployArgs, plan: PackEnvPlan): string | undefined {
  if (plan.problems.length > 0) {
    return `kindgi deploy: the pack service's env for ${args.envName} gives a secret in the clear or is malformed (above). Fix environments.${args.envName}.env in kindgi.config and deploy again.\n`;
  }
  if (plan.missing.length > 0 && !args.allowMissingEnv) {
    return `kindgi deploy: ${plan.missing.join(', ')} ${plan.missing.length === 1 ? 'is' : 'are'} required by the pack and ${plan.missing.length === 1 ? 'has' : 'have'} no value in environments.${args.envName}.env, so the pack service wouldn't be ready. Add ${plan.missing.length === 1 ? 'it' : 'them'}, or deploy anyway with --allow-missing-env.\n`;
  }
  return undefined;
}

/**
 * A hosted deploy: Kindgi Cloud gives the pack service the env values set
 * in the workspace (`kindgi env set`, a secret with `kindgi secrets set`),
 * at the deployment's project, then its org, then the tenant.
 * `environments.<env>.env` in kindgi.config isn't read there, so a config
 * that gives any is refused before anything is built or sent, naming each
 * name and how to set it.
 */
function refuseHostedConfigEnv(
  args: ResolvedDeployArgs,
  projectId: string | undefined,
): CommandResult | undefined {
  const plan = args.packEnv;
  if (!args.hosted || (plan.given.length === 0 && plan.problems.length === 0)) return undefined;
  const block = `environments.${args.envName}.env`;
  const names = plan.given.length === 0 ? '' : ` (${plan.given.join(', ')})`;
  const target = { envName: args.envName, ...(projectId !== undefined && { projectId }) };
  const command = packEnvSetCommand({ ...target, hasProjectMapping: false });
  const secrets = plan.entries.some((e) => e.source?.kind === 'secret')
    ? ` (a secret with \`${packEnvSecretSetCommand(target)}\`)`
    : '';
  return failure(
    `kindgi deploy: on Kindgi Cloud the pack service gets the env values set in your workspace, not ${block} in kindgi.config${names}. Set each with \`${command}\`${secrets}, then remove ${block} from kindgi.config and deploy again.\n`,
  );
}

// ---------------------------------------------------------------------
// Envelope existence — either read from disk or inline-build
// ---------------------------------------------------------------------

async function ensureEnvelopeExists(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  runners: DeployRunners,
  out: ProgressLines,
  projectId: string | undefined,
  hooks: BuildHooks,
): Promise<{ readonly kind: 'ok' } | (CommandResult & { readonly kind: 'error' })> {
  const { line } = out;
  const exists = await pathExists(args.envelopePath);
  if (exists) return { kind: 'ok' };

  if (args.explicitEnvelope) {
    return failure(
      `deploy-envelope.json not found at ${args.envelopePath} (--from-envelope). Verify the path or drop --from-envelope to auto-build.\n`,
    );
  }

  // Auto-detect path is missing → run build inline.
  line(`  Envelope missing — running \`kindgi build --env=${args.envName}\` inline...`);
  if (runners.runBuild !== undefined) {
    line('');
    const buildArgv = buildInlineArgv(ctx, args, projectId);
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
  const built = await runInlineBuild(ctx, args, projectId, out, hooks);
  if (built.kind === 'error') return built;
  return { kind: 'ok' };
}

/**
 * Run `kindgi build` in-process, threading through the same
 * `CommandContext` (buildRunners, buildConfigLoader, env, cwd, etc.)
 * but with an argument set derived from the deploy invocation. We
 * clone the context with `options` replaced so the build command sees
 * only build-relevant flags. Its lines go out with deploy's (`out`), in
 * order.
 */
async function runInlineBuild(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  projectId: string | undefined,
  out: ProgressLines,
  hooks: BuildHooks,
): Promise<
  | { readonly kind: 'ok' }
  | { readonly kind: 'error'; readonly stderr: string; readonly exitCode: number }
> {
  const buildOptions = buildInlineOptions(ctx, args, projectId);
  // A hosted build runs at the API this deploy goes to: the build resolves
  // the same address, with the same key, from the same config.
  const buildCtx: CommandContext = { ...ctx, options: buildOptions };
  // Through deploy's own `out`, `--quiet` and all. None are kept here:
  // deploy's `out` streams or keeps them.
  // A stop of the check against what runs, after the build's local index
  // and before its image, is deploy's own answer.
  const checked: { stop?: CommandResult | undefined } = {};
  const result = await runBuild(
    buildCtx,
    { ...out, kept: () => '' },
    {
      indexed: async (indexPath) => {
        checked.stop = await hooks.indexed?.(indexPath);
        return checked.stop;
      },
    },
  );
  if (checked.stop?.kind === 'error') return checked.stop;
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
  return { kind: 'ok' };
}

function buildInlineOptions(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  projectId: string | undefined,
): Record<string, OptionValue> {
  const opts: Record<string, OptionValue> = {};
  opts.env = args.envName;
  opts.path = args.packDir;
  opts.out = args.outDir;
  if (args.hosted) {
    opts.hosted = true;
    if (projectId !== undefined) opts.project = projectId;
  }
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
function buildInlineArgv(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  projectId: string | undefined,
): readonly string[] {
  const opts = buildInlineOptions(ctx, args, projectId);
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
// Hosted: the deployment's pack service
// ---------------------------------------------------------------------

/** How long `--hosted` waits for the pack service. */
const PACK_SERVICE_WAIT_MS = 5 * 60 * 1000;
/** How often it reads the deployment again meanwhile. */
const PACK_SERVICE_POLL_MS = 2_000;
/** Reads in a row that may fail before it stops waiting. */
const PACK_SERVICE_READ_TRIES = 3;

/**
 * Waits for the deployment's own pack service to be `ready`, reading the
 * deployment again every 2 s and saying each new state once. A `cleared`
 * one that's `waiting` (a suspension that took it down was lifted) is
 * waited for like a pending one. Fails when it's `cleared` otherwise (saying
 * why, when the server says), after 5 minutes, after a few failed reads in
 * a row, or on Ctrl+C. The deployment is in place whatever it finds.
 */
async function waitForPackService(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  runners: DeployRunners,
  record: DeploymentRecord,
  line: (s: string) => void,
  projectId: string | undefined,
): Promise<
  | { readonly kind: 'ok'; readonly endpoint: DeploymentEndpointRecord }
  | { readonly kind: 'error'; readonly message: string }
> {
  const read = runners.getDeployment;
  if (read === undefined) {
    return {
      kind: 'error',
      message: 'Internal error: kindgi deploy --hosted needs the getDeployment runner wired.\n',
    };
  }
  const sleep = runners.sleep ?? sleepUnlessStopped;
  const now = runners.now ?? Date.now;
  const id = record.deploymentId;
  const started = now();
  let endpoint = record.endpoint as DeploymentEndpointRecord;
  let said = '';
  let saidEnv = '';
  let failedReads = 0;
  // What stands in the way of its env, said once, and again when it changes.
  const sayPackEnv = async (): Promise<void> => {
    const lines = await packEnvLines(ctx, args, runners, id, projectId);
    const text = lines.join('\n');
    if (text !== '' && text !== saidEnv) for (const l of lines) line(`      ${l}`);
    saidEnv = text;
  };
  line('  Waiting for the pack service');
  for (;;) {
    const settled = settledPackService(endpoint, id);
    if (settled !== undefined) {
      if (settled.kind === 'ok') line('    ✓ ready\n');
      return settled;
    }
    const state = waitingState(endpoint);
    if (state !== said) {
      line(`    … ${state}`);
      // At once, before the platform records it as the problem; and again then.
      if (said === '' || endpoint.problem?.code.startsWith('pack-env-') === true) {
        await sayPackEnv();
      }
    }
    said = state;
    if (now() - started >= PACK_SERVICE_WAIT_MS) {
      return stoppedWaiting(`The pack service isn't ready after 5 minutes: ${state}`, id);
    }
    await sleep(PACK_SERVICE_POLL_MS, ctx.stopSignal);
    if (ctx.stopSignal?.aborted === true) {
      return stoppedWaiting(`Stopped waiting for the pack service: ${state}`, id);
    }
    const got = await readPackService(read, ctx, args, id);
    if (got.kind === 'ok') {
      failedReads = 0;
      endpoint = got.endpoint ?? endpoint;
      continue;
    }
    failedReads += 1;
    if (failedReads >= PACK_SERVICE_READ_TRIES) {
      return stoppedWaiting(
        `Couldn't read the deployment while waiting for its pack service: ${got.message}`,
        id,
      );
    }
  }
}

/**
 * Where the deployment's pack declares names that stand in the way, said
 * as what to do: nothing when none does, or when the server doesn't give
 * pack services their env (or is older). A read that fails is said, with
 * why, so no lines never stand for a read that didn't happen. A read the
 * stop cut short says nothing: the wait says it stopped.
 */
async function packEnvLines(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  runners: DeployRunners,
  deploymentId: string,
  projectId: string | undefined,
): Promise<string[]> {
  if (runners.getPackEnv === undefined) return [];
  const got = await runners.getPackEnv({
    endpoint: args.endpoint,
    token: args.token,
    deploymentId,
    fetchImpl: ctx.fetch,
    ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
  });
  if (got.kind === 'not-served' || ctx.stopSignal?.aborted === true) return [];
  if (got.kind === 'error') return [`Couldn't read where each value is set: ${got.message}`];
  return packEnvProblemLines(got.packEnv.data, {
    envName: got.packEnv.envName,
    ...(projectId !== undefined && { projectId }),
    hasProjectMapping: false,
  });
}

/** The deployment's pack service now, read again. */
async function readPackService(
  read: NonNullable<DeployRunners['getDeployment']>,
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  deploymentId: string,
): Promise<
  | { readonly kind: 'ok'; readonly endpoint: DeploymentEndpointRecord | undefined }
  | { readonly kind: 'error'; readonly message: string }
> {
  const got = await read({
    endpoint: args.endpoint,
    token: args.token,
    deploymentId,
    fetchImpl: ctx.fetch,
    ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
  });
  return got.kind === 'ok' ? { kind: 'ok', endpoint: got.record.endpoint } : got;
}

/**
 * How many builds keep a pack service where the deploy went, said with how
 * to let old ones go: in the project it named, or the tenant's when it
 * named none (the deploy answer doesn't name the Default it went into). A
 * read that fails is said, with why, and given back as `error`, so the
 * JSON tells it from a runtime that doesn't count them; one the stop cut
 * short says nothing.
 */
async function sayKeptBuilds(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  runners: DeployRunners,
  line: (s: string) => void,
  projectId: string | undefined,
): Promise<{ readonly keptBuilds?: number; readonly error?: string }> {
  const count = runners.countKeptBuilds;
  if (count === undefined) return {};
  const got = await count({
    endpoint: args.endpoint,
    token: args.token,
    ...(projectId !== undefined && { projectId }),
    fetchImpl: ctx.fetch,
    ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
  });
  if (ctx.stopSignal?.aborted === true) return {};
  if (got.kind === 'error') {
    line(`  Couldn't count the builds kept: ${got.message}`);
    line('');
    return { error: got.message };
  }
  if (got.keptBuilds === undefined) return {};
  for (const l of keptBuildsLines(got.keptBuilds, projectId !== undefined)) line(l);
  return { keptBuilds: got.keptBuilds };
}

export function keptBuildsLines(keptBuilds: number, inProject: boolean): string[] {
  return [
    `  Builds kept in this ${inProject ? 'project' : 'workspace'}: ${keptBuilds}`,
    '    Each keeps its pack service while something it serves is registered, pinned or',
    '    running, or until a newer build ships it. To let old ones go, unregister what',
    '    nothing calls:',
    '      kindgi tools|agents|flows unregister <id> <version>',
    '      kindgi guardrails unregister <guardrail-id>',
    '    `kindgi deployments get <deployment-id>` says what keeps each one.',
    '',
  ];
}

/** The wait stopped, with the deployment in place: why, and how to wait again. */
function stoppedWaiting(why: string, deploymentId: string) {
  return {
    kind: 'error' as const,
    message: `${why}. deploymentId ${deploymentId}. Run the same \`kindgi deploy --hosted\` again to keep waiting: it sends the same deployment, and the server answers with this one.\n`,
  };
}

/**
 * A pack service that's done with: `ready`, or `cleared` and not `waiting`
 * (a failure, with the server's reason when it gives one: an older server
 * gives none); else undefined.
 */
function settledPackService(
  endpoint: DeploymentEndpointRecord,
  id: string,
):
  | { readonly kind: 'ok'; readonly endpoint: DeploymentEndpointRecord }
  | { readonly kind: 'error'; readonly message: string }
  | undefined {
  if (endpoint.status === 'ready') return { kind: 'ok', endpoint };
  if (endpoint.status !== 'cleared' || endpoint.waiting === true) return undefined;
  if (endpoint.retired === undefined) {
    return {
      kind: 'error',
      message: `The deployment's pack service was taken down (cleared). deploymentId ${id}.\n`,
    };
  }
  const why = packServiceRetiredText(endpoint.retired);
  return {
    kind: 'error',
    message: `The deployment's pack service was taken down (cleared, ${endpoint.retired}): ${why}. deploymentId ${id}.\n`,
  };
}

/**
 * A pack service being waited for, as the wait says it: `pending`, or
 * `cleared, waiting for its pack service again`, and why when there's a
 * problem.
 */
function waitingState(endpoint: DeploymentEndpointRecord): string {
  const state =
    endpoint.status === 'cleared' ? 'cleared, waiting for its pack service again' : 'pending';
  if (endpoint.problem === undefined) return state;
  const why = packServiceProblemText(endpoint.problem.code);
  return `${state} (${endpoint.problem.code}): ${why}`;
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
// The project a deploy goes into
// ---------------------------------------------------------------------

type ProjectOutcome =
  | { readonly kind: 'ok'; readonly id?: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The project to deploy into: `--project`, else the pack environment's
 * `project` when the runtime keeps its values under one env (`fromEnvironment`).
 * A `--project` that isn't that environment's project is refused.
 */
async function resolveDeployProject(
  args: ResolvedDeployArgs,
  fromEnvironment: string | undefined,
  runners: DeployRunners,
  ctx: CommandContext,
): Promise<ProjectOutcome> {
  const flag = await resolveProject(args.projectRef, '--project', args, runners, ctx);
  if (flag.kind === 'error' || fromEnvironment === undefined) return flag;
  const where = `environments.${args.envName}.project`;
  const environment = await resolveProject(fromEnvironment, where, args, runners, ctx);
  if (environment.kind === 'error' || args.projectRef === undefined) return environment;
  if (flag.id === environment.id) return environment;
  return {
    kind: 'error',
    message: `--project ${args.projectRef} isn't the ${args.envName} environment's project, ${fromEnvironment} (${where}). Leave --project out, or deploy with the --env whose project it is.\n`,
  };
}

/**
 * `--project`: an id goes as it is (the server answers 404 for one of no
 * project of the tenant); a slug is looked up, and refused when it names
 * no project, or several (a slug is unique within an org, so two orgs may
 * share one). Absent: tenant-wide.
 */
async function resolveProject(
  ref: string | undefined,
  where: string,
  args: ResolvedDeployArgs,
  runners: DeployRunners,
  ctx: CommandContext,
): Promise<ProjectOutcome> {
  if (ref === undefined) return { kind: 'ok' };
  if (PROJECT_ID_RE.test(ref)) return { kind: 'ok', id: ref };
  if (runners.findProjects === undefined) {
    return {
      kind: 'error',
      message: `${where} ${ref}: this build can't look a slug up. Pass the project's id.\n`,
    };
  }
  const found = await runners.findProjects({
    endpoint: args.endpoint,
    token: args.token,
    slug: ref,
    fetchImpl: ctx.fetch,
    ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
  });
  if (found.kind === 'error') {
    return {
      kind: 'error',
      message: `${where} ${ref}: couldn't list the tenant's projects: ${found.message}\n`,
    };
  }
  const [only, ...more] = found.projects;
  if (only === undefined) {
    return {
      kind: 'error',
      message: `${where} ${ref}: no project of this tenant has that slug. \`kindgi projects list\` shows them; \`kindgi projects create --name=<name> --slug=${SLUG.test(ref) ? ref : '<slug>'}\` makes one.\n`,
    };
  }
  if (more.length > 0) {
    const ids = found.projects.map(
      (p) => `${p.id} (${p.name}${p.orgId === undefined ? '' : `, org ${p.orgId}`})`,
    );
    return {
      kind: 'error',
      message: `${where} ${ref}: ${found.projects.length} projects of this tenant have that slug, in different orgs: ${ids.join(', ')}. Pass the id.\n`,
    };
  }
  return { kind: 'ok', id: only.id };
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
  const envGiven = typeof envFlag === 'string' && envFlag !== '';
  const envName = envGiven ? envFlag : 'staging';
  const envBlock =
    cfg.environments?.[envName] !== undefined
      ? ((cfg.environments as Record<string, EnvironmentConfig>)[envName] as EnvironmentConfig)
      : undefined;

  // --out — resolves the output dir the build command uses.
  const outFlag = ctx.options.out;
  const outDirRaw = typeof outFlag === 'string' && outFlag !== '' ? outFlag : '.kindgi/build';
  const outDir = isAbsolute(outDirRaw) ? outDirRaw : resolve(packDir, outDirRaw);

  // --hosted, or the env block's `build: 'hosted'` (main.ts, `hostedRun`).
  const hosted = ctx.hosted;
  if (ctx.globals.hosted && ctx.options['build-endpoint'] !== undefined) {
    return {
      kind: 'error',
      stderr:
        '--hosted builds on the hosted build service, and --build-endpoint names another build server: leave one out.\n',
      exitCode: 1,
    };
  }
  // A hosted runtime reads a deployment's secrets in the env it serves.
  // Without --env the sync would send `.env.staging` under `staging`,
  // which it may never read: the env is named, not defaulted.
  if (hosted && ctx.options['sync-secrets'] === true && !envGiven) {
    return {
      kind: 'error',
      stderr:
        "--sync-secrets on a hosted deploy needs --env. A hosted runtime reads a deployment's secrets in the env it serves; without --env, the values in .env.staging would go up under staging. Pass --env=<the env it serves>.\n",
      exitCode: 1,
    };
  }

  // The API (api-address.ts): --endpoint > the env block's `endpoint` >
  // the CLI's own address (`--url`, KINDGI_API_URL or the stored one).
  // A stored key goes only to the address stored with it; a hosted
  // deploy goes to the CLI's own address alone, and doesn't read a
  // folder's .kindgirc.json that points at a local runtime.
  const endpointFlag = ctx.options.endpoint;
  const named = [
    { url: typeof endpointFlag === 'string' ? endpointFlag : undefined, where: '--endpoint' },
    { url: envBlock?.endpoint, where: `environments.${envName}.endpoint` },
  ];
  const address = hosted
    ? hostedApiAddress('kindgi deploy --hosted', ctx.config, named)
    : deployApiAddress(ctx.config, named);
  if (address === undefined) {
    return {
      kind: 'error',
      stderr: `kindgi deploy could not resolve an API endpoint. Set environments.${envName}.endpoint in kindgi.config.ts, pass --endpoint <url>, or export KINDGI_API_URL.\n`,
      exitCode: 1,
    };
  }
  if (address.kind === 'refused') {
    return { kind: 'error', stderr: `${address.message}\n`, exitCode: 1 };
  }
  const endpoint = address.url;

  // --token — bearer token; standard config precedence (for --hosted,
  // without a local runtime's .kindgirc.json).
  const token = address.config.token;
  if (token === undefined || token === '') {
    return {
      kind: 'error',
      stderr:
        'kindgi deploy could not resolve an API token. ' +
        'Pass --token <bearer>, export KINDGI_API_TOKEN, or run `kindgi auth login`.\n',
      exitCode: 1,
    };
  }
  // No --endpoint or env `endpoint`: the key goes to the CLI's own address.
  if (named.every((n) => n.url === undefined || n.url === '')) ctx.noteOwnAddressKey();

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

  const projectFlag = ctx.options.project;
  const projectRef =
    typeof projectFlag === 'string' && projectFlag !== '' ? projectFlag : undefined;

  const idempotencyKeyFlag = ctx.options['idempotency-key'];
  const idempotencyKeyOverride =
    typeof idempotencyKeyFlag === 'string' && idempotencyKeyFlag !== ''
      ? idempotencyKeyFlag
      : undefined;

  const dryRun = ctx.options['dry-run'] === true;
  const replace: ReplaceFlags = {
    blocks: listFlag(ctx, 'replace'),
    reason: stringFlag(ctx, 'reason'),
  };
  const replaceProblem = replaceFlagsProblem(replace);
  if (replaceProblem !== undefined) {
    return { kind: 'error', stderr: `kindgi deploy: ${replaceProblem}\n`, exitCode: 1 };
  }
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
      projectRef,
      hosted,
      idempotencyKeyOverride,
      dryRun,
      syncSecrets,
      envBlock,
      environments: environmentsOf(cfg),
      packEnv: packEnv.plan,
      allowMissingEnv: ctx.options['allow-missing-env'] === true,
      blocksPattern: resolveDiscovery(cfg.discovery as DiscoveryConfig | undefined).blocks,
      replace,
    },
  };
}

/**
 * A deploy refused into a later environment of its order
 * (`409 environment-takes-promotions`): each environment from the order's
 * first to that one, named from the pack config, for the hint. `undefined`
 * for any other answer, and when the refusal doesn't name the first (the
 * caller can't read it) or the reads fail: the hint then says the rule
 * without names.
 */
async function promotionPathOf(
  args: ResolvedDeployArgs,
  runners: DeployRunners,
  ctx: CommandContext,
  result: PostDeploymentResult,
): Promise<readonly PromotionStop[] | undefined> {
  if (result.kind !== 'wire-error' || result.error.code !== 'environment-takes-promotions') {
    return undefined;
  }
  const { position, firstProjectId } = result.error;
  if (position === undefined || firstProjectId === undefined) return undefined;
  if (runners.listProjects === undefined || runners.listEnvironmentOrders === undefined) {
    return undefined;
  }
  const opts = {
    endpoint: args.endpoint,
    token: args.token,
    fetchImpl: ctx.fetch,
    ...(ctx.stopSignal !== undefined && { signal: ctx.stopSignal }),
  };
  const [projects, orders] = await Promise.all([
    runners.listProjects(opts),
    runners.listEnvironmentOrders(opts),
  ]);
  if (projects.kind === 'error' || orders.kind === 'error') return undefined;
  return promotionPath({
    firstProjectId,
    position,
    orders: orders.orders,
    projects: projects.projects,
    environments: envProjectRefs(args.environments),
  });
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

/**
 * `--dry-run`'s answer: the curl-equivalent and body as progress, the
 * summary on stdout. An unsigned envelope's body lacks the signature's
 * fields, and has no derived Idempotency-Key, which hashes the signed body.
 */
function dryRunResult(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  line: ProgressLines['line'],
  body: PostDeploymentBody | UnsignedPostBody,
  idempotencyKey: string | undefined,
): CommandResult {
  const missing =
    idempotencyKey === undefined
      ? 'signerKeyId, signerPublicKey and signature a signed build adds, and the Idempotency-Key, which hashes that body'
      : 'signerKeyId, signerPublicKey and signature a signed build adds';
  line(
    'signature' in body
      ? '  Dry run — would POST the following:'
      : `  Dry run — would POST the following, plus the ${missing}:`,
  );
  line('');
  line(`    curl -X POST ${args.endpoint.replace(/\/+$/, '')}/v1/deployments \\`);
  line('      -H "Authorization: Bearer <redacted>" \\');
  line('      -H "Content-Type: application/json" \\');
  if (idempotencyKey !== undefined) line(`      -H "Idempotency-Key: ${idempotencyKey}" \\`);
  line("      -d @-  <<'JSON'");
  for (const bodyLine of JSON.stringify(body, null, 2).split('\n')) {
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
    ...(idempotencyKey !== undefined && { idempotencyKey }),
    dryRun: true,
    wouldPost: body,
  };
  const rendered = renderJson(summary, ctx.globals.format);
  return {
    kind: 'ok',
    rendered: { stdout: rendered.stdout, stderr: '' },
  };
}

function failure(stderr: string): CommandResult {
  return { kind: 'error', stderr, exitCode: 1 };
}

/**
 * The check against what runs, asked once: by an inline build once it has
 * its local index (`hooks`), else from the envelope's (`unlessChecked`).
 */
function runsCheckOnce(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  projectId: string | undefined,
  out: ProgressLines,
): {
  readonly hooks: BuildHooks;
  readonly unlessChecked: (index: unknown) => Promise<CommandResult | undefined>;
} {
  let checked = false;
  const check = (index: unknown): Promise<CommandResult | undefined> => {
    checked = true;
    return runsCheckAnswer(ctx, args, projectId, index, out);
  };
  return {
    hooks: {
      indexed: async (indexPath) => {
        let index: unknown;
        try {
          index = JSON.parse(await readFile(indexPath, 'utf8'));
        } catch {
          // Checked from the envelope's index after the build instead.
          return undefined;
        }
        return check(index);
      },
    },
    unlessChecked: async (index) => (checked ? undefined : check(index)),
  };
}

/**
 * The pack's blocks against what runs, from its index: each block put back
 * on purpose and each `--replace` not needed as progress, or the stop's
 * table as the error, exit 1. A pack with no blocks and no `--replace`
 * isn't asked about.
 */
async function runsCheckAnswer(
  ctx: CommandContext,
  args: ResolvedDeployArgs,
  projectId: string | undefined,
  index: unknown,
  out: ProgressLines,
): Promise<CommandResult | undefined> {
  const input = runsCheckInputOf(index);
  if (input.blocks.length === 0 && args.replace.blocks.length === 0) return undefined;
  // Through `ctx.fetch`, as every other request a deploy sends.
  const client = createClient({
    apiUrl: args.endpoint,
    auth: { kind: 'apiToken', token: args.token },
    fetch: ctx.fetch,
  });
  out.line(`  Checking ${input.packId ?? 'the pack'} against what runs…`);
  const check = await checkRuns(client, input, {
    ...(projectId !== undefined && { projectId }),
    replace: args.replace,
  });
  switch (check.kind) {
    case 'passed':
      for (const l of passedLines(check)) out.line(l);
      out.line('');
      return undefined;
    case 'unchecked':
      out.line(UNCHECKED_LINES[check.why]);
      out.line('');
      return undefined;
    case 'failed':
      return failure(
        `Couldn't check the pack's blocks against what runs (POST /v1/deployments/check): ${check.message}\n`,
      );
    case 'stopped':
      return failure(await stoppedText(client, check.stops, deployStopWords(args.envName)));
  }
}

function deployStopWords(envName: string): StopWords {
  return {
    what: 'deploy',
    ours: 'your files',
    nothingDone: 'Nothing was deployed.',
    keep: 'run `kindgi blocks pull`, then deploy again',
    command: `kindgi deploy --env=${envName}`,
  };
}

const UNSIGNED_REFUSAL =
  'deploy-envelope.json is unsigned. The server will refuse the deployment.\n' +
  'Re-run `kindgi build` without --skip-sign, or pass --dry-run to inspect ' +
  'what would be POSTed.\n';

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
