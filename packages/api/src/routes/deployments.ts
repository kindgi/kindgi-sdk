// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { type Context, Hono } from 'hono';

import {
  type Agent,
  type AgentId,
  type AgentPins,
  type BlockDefinition,
  templateProblem,
  validateBlock,
} from '@kindgi/agents';
import type { AuditEventBinding } from '@kindgi/audit-events';
import { ref, tuplesForCreate } from '@kindgi/authz';
import { runOutsideTenant } from '@kindgi/bounds';
import { parsePublicKeyPem, verifyEd25519 } from '@kindgi/crypto';
import { type Flow, type FlowPins, flowRefs, flowSchemaProblems } from '@kindgi/flow';
import {
  GUARDRAIL_SPEC_KEYS,
  type Guardrail,
  createCheckRegistry,
  validateGuardrailSpec,
} from '@kindgi/guardrails';
import { resolvePackEnv } from '@kindgi/handler-runtime/pack-env';
import type { Logger } from '@kindgi/log';
import type { ProjectBinding } from '@kindgi/platform';
import { SchemaCompileBudgetError, compileInlineSchema } from '@kindgi/schema';
import { toolSecretNames, validateToolManifest } from '@kindgi/tools';
import type {
  Cursor,
  EnvName,
  FlowId,
  GuardrailId,
  ProjectId,
  Semver,
  SigningKeyId,
  TenantId,
  ToolId,
} from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import { type UnpinnableRef, publishDeployedAgent, resolveAgentPins } from '../agent-pins.js';
import type { BlockRegistryBinding } from '../block-binding.js';
import { type BlockPins, type BlockVersionReads, resolveBlockPins } from '../block-pins.js';
import { canonicalJson } from '../canonical-json.js';
import {
  type PlannedBlock,
  planPackBlocks,
  publishPackBlocks,
  withPackVersions,
} from '../deploy-blocks.js';
import { type PlannedTool, keepPublishedTool, planPackTools } from '../deploy-tools.js';
import type { DeployedVersionOutcome } from '../deploy-versions.js';
import {
  type DeployedAgent,
  type DeployedFlow,
  type DeployedVersion,
  type DeploymentBinding,
  type DeploymentPrimitiveCounts,
  type DeploymentRegisterOutcome,
  serializeDeployment,
} from '../deployment-binding.js';
import { canonicalizeEnvelope, normaliseSha256Hex } from '../deployment-envelope.js';
import { type DeploymentValuesDeps, deploymentValues } from '../deployment-values.js';
import type { EnvBinding } from '../env-binding.js';
import { environmentTakesPromotionsResponse, laterEnvironment } from '../environment-entry.js';
import type { EnvironmentOrderBinding } from '../environment-orders-binding.js';
import { type WireErrorBody, retryAfterSeconds, statusFor, toWireError } from '../errors.js';
import type { FlowRegistryBinding } from '../flow-binding.js';
import {
  type FlowPinsLive,
  type FlowPinsSubflows,
  implicitSubflowVersion,
  publishDeployedFlow,
  resolveFlowPins,
  unnamedSubflowIssues,
} from '../flow-pins.js';
import type { GuardrailRegistryBinding } from '../guardrail-binding.js';
import { imageRefWithin, parseImagePrefix, parseImageRef } from '../image-ref.js';
import type { ImageRegistryBinding, ImageRegistryError } from '../image-registry-binding.js';
import type { ItemRights } from '../item-rights.js';
import type { AgentReleaseBindings, LiveVersionBinding } from '../live-version-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import { publishCompilesMiddleware } from '../middleware/publish-compiles.js';
import { packEnvCheck } from '../pack-env.js';
import { type ProviderKeys, refuseSecretNames } from '../provider-keys.js';
import { PROJECT_MISMATCH, PublishRefused, projectMismatchFix } from '../publish-refused.js';
import {
  type ItemReference,
  type ReferenceOutOfScopeError,
  type ReferenceScopeBinding,
  agentReferences,
  flowReferences,
  outOfScopeResponse,
  referencesOutOfScope,
  reservedToolMetadataKeys,
  reservedToolMetadataMessage,
} from '../reference-scope.js';
import { type RegistryReadOnly, refuseReadOnly } from '../registry-read-only.js';
import {
  callerAdministers,
  deploymentSecretScope,
  secretScopesFor,
  toolSecretRefs,
} from '../secret-scope.js';
import { type SecretBinding, secretNameGrammarRefusal } from '../secrets-binding.js';
import { type ServedEnvRule, readReferencesOnce, refuseUnservedValue } from '../served-env.js';
import type { SigningKeyBinding as SigningKeyRegistryBinding } from '../signing-key-binding.js';
import type { ToolRegistryBinding, ToolVersionRow } from '../tool-binding.js';
import type { AppEnv } from '../types.js';
import type { AgentReleaseGateDeps } from './agent-releases.js';
import { capabilityRefusal, deniedBy } from './denied.js';
import {
  carriedFor,
  isPromotionRoute,
  mountDeploymentPromotions,
  readableDeployment,
  readableDeployments,
  valuesDepsFor,
} from './deployment-promotions.js';
import { requireEnvName } from './env.js';
import type { GuardrailWriteHook } from './guardrails.js';
import { clampLimit } from './pagination.js';
import { scopeResourceRef } from './scope-params.js';
import { tenantResourceAccess } from './tenant-access.js';
import { parseTimeInput } from './time-input.js';
import type { ToolWriteHook } from './tools.js';
import { UUID_RE } from './uuid-param.js';

/**
 * Deployments resource routes — the landing surface for signed pack
 * deploys:
 *
 *   - `POST /v1/deployments`                  — signed deployment (atomic).
 *   - `GET  /v1/deployments`                  — cursor-paginated list.
 *   - `GET  /v1/deployments/:deploymentId`    — single record.
 *   - `POST /v1/deployments/:deploymentId/secrets` — deployment-scoped secret sync.
 *
 * ### Atomic transaction (POST)
 *
 * The route runs four verification steps IN ORDER (1–4 below) before any
 * registry write, then does upserts + records deployment (5–6) as a single
 * all-or-nothing unit. Any failure past the first upsert rolls back the successfully-
 * inserted primitives so the tenant's catalog never observes a partial
 * deploy.
 *
 *   1. Body shape (id/version/signature fields present + typed).
 *   2. Signature — canonicalise `{imageDigest, artifactVersion,
 *      indexHash, tenantId, publishedAt}` as sorted-key JSON (UTF-8,
 *      no whitespace); verify with Ed25519 against `signerPublicKey`;
 *      cross-check `(signerKeyId, publicKey)` on the tenant's trust
 *      list via `SigningKeyRegistryBinding.isTrusted`.
 *   3. Image — probe via `ImageRegistryBinding.head`, verify digest in
 *      the image ref matches the descriptor; extract `/app/index.json`,
 *      verify its sha256 matches the signed `indexHash` and its
 *      `artifactVersion` is the signed one.
 *   4. Manifest validation — the image's `/app/index.json` (not a copy
 *      from the request: only the image's bytes are signed). Each
 *      `tools[]`, `guardrails[]`, `agents[]`, `flows[]` runs through its
 *      validator. A tool's `modulePath` and a
 *      guardrail's `checkModulePath` become `codeArtifactRef: { kind:
 *      'oci', imageRef, modulePath, artifactVersion }`, which is how the
 *      runtime knows the code runs in the pack service; a guardrail's
 *      `checkId` becomes its `check`. Agents and flows are declarative:
 *      their `modulePath` is dropped.
 *   5. Upserts — tools + guardrails + agents + flows. Track which were
 *      `ok` (newly registered) vs `already-registered` so rollback only
 *      unwinds our own writes. A tool or data block version the registry
 *      holds is kept only with the pack's definition, checked before the
 *      first write (`deploy-tools.ts`, `deploy-blocks.ts`).
 *   6. Deployment record via `DeploymentBinding.register`. On failure,
 *      rollback all `ok` upserts and return 500.
 *
 * ### Idempotency
 *
 * Two layers:
 *   - `Idempotency-Key` middleware caches the full HTTP response — a
 *     retry with the same key + same body replays the original 201.
 *   - Digest idempotency handled inside `DeploymentBinding.register`:
 *     the same `imageDigest` re-submitted under the same tenant returns
 *     `{ kind: 'already-registered', deployment }` and the route surfaces
 *     it as `200` (NOT `201`), same `deploymentId` + `artifactVersion`.
 *
 * ### Immutable records
 *
 * No PATCH, no DELETE. Each record lists exactly what it shipped
 * (`contents`: ids and versions). Versions are immutable and an image
 * digest deploys once, so the latest deployment is the live one, and a
 * rollback rolls forward: deploy the earlier code again, under new
 * versions. (Re-activating an earlier record instead would need every
 * resolver to resolve only within the active deployment's versions.)
 *
 * The route is register-only + read-only.
 */
/**
 * Where each tenant's images must sit (`imagePrefix`, set by the operator).
 * `required`: a runtime serving many tenants refuses a tenant without one.
 */
export interface DeploymentImagePrefixes {
  of(tenantId: TenantId): Promise<string | undefined>;
  readonly required: boolean;
}

export interface DeploymentsRouterBindings {
  /**
   * Each tenant deploys only images at or under its own repository. It's
   * checked after the digest pin and before the signature or any registry
   * read, so nothing reads another tenant's image. Absent: no check.
   */
  readonly imagePrefixes?: DeploymentImagePrefixes;
  /**
   * The runtime sends each pack check call to the deployment that shipped
   * its id (per-deployment routing), so a check that runs in the pack must
   * carry the pack's id (`<packId>.`): two packs sharing a check id would
   * serve each other's guardrails. Refused, before anything is written, as
   * `deployment-validation-failed`. Absent: the build's warning only.
   */
  readonly requirePrefixedPackChecks?: boolean;
  /**
   * Whether each deployment runs its own pack service (per-deployment
   * routing), so a copy of a pack with its own pack id runs beside it: the
   * fix a `<primitive>-project-mismatch` names. Absent: one pack service
   * serves every deployment, and the fix named is an environment order
   * (with `environmentOrders`), or none.
   */
  readonly perDeploymentPacks?: boolean;
  /**
   * Whether a project is suspended: nothing new deploys into one (the
   * named project, or the Default for a tenant-wide deploy), refused
   * `409 project-suspended` before anything is written. Absent: no check,
   * for a runtime without project suspension.
   */
  readonly projectSuspended?: (tenantId: TenantId, projectId: ProjectId) => Promise<boolean>;
  /** The tenant's model providers' keys: no tool a deployment brings may name one. */
  readonly providerKeys?: ProviderKeys;
  /**
   * What the deployment's project may reference (`reference-scope.ts`):
   * an agent or flow it brings that names an item neither it brings nor
   * its project reaches is refused, before anything is registered.
   */
  readonly referenceScope?: ReferenceScopeBinding;
  /**
   * The tenant's environment orders. A deploy into a later environment of
   * one is refused (`409 environment-takes-promotions`), before anything is
   * registered: a later environment takes builds by promotion only
   * (`environment-entry.ts`). Absent: no project is a later environment.
   */
  readonly environmentOrders?: Pick<EnvironmentOrderBinding, 'orderOf'>;
  readonly deploymentRegistry: DeploymentBinding;
  readonly signingKeyRegistry: SigningKeyRegistryBinding;
  readonly imageRegistry: ImageRegistryBinding;
  readonly toolRegistry?: ToolRegistryBinding;
  readonly guardrailRegistry?: GuardrailRegistryBinding;
  readonly agentRegistry?: AgentRegistryBinding;
  readonly flowRegistry?: FlowRegistryBinding;
  /**
   * The agents' live versions: a deployed flow's agent step that names no
   * version pins the one live for the deploy's project, else the latest.
   */
  readonly liveVersions?: LiveVersionBinding;
  /** Data blocks: an agent's block references are pinned at deploy with its tools. */
  readonly blockRegistry?: BlockRegistryBinding;
  /**
   * REQUIRED at runtime for `POST /v1/deployments/:deploymentId/secrets`.
   * Optional at the type level so app compositions without a secrets
   * binding keep booting — the sync route is always mounted and answers
   * `500` when this is not wired; the register / list / get routes remain
   * functional without it.
   */
  readonly secretsBinding?: SecretBinding;
  /**
   * OPTIONAL at the type level, but REQUIRED at runtime any time
   * `validated.agents.length > 0` OR `validated.flows.length > 0`
   * OR `validated.tools.length > 0` OR `validated.guardrails.length > 0`.
   * The agent / flow / tool / guardrail register loops resolve the
   * tenant's Default project via `projectBinding.getDefault(tenantId)`
   * and thread the resolved id through
   * `AgentRegistryBinding.publish(...)` /
   * `FlowRegistryBinding.publish(...)` /
   * `ToolRegistryBinding.register(...)` /
   * `GuardrailRegistryBinding.register(...)` (content-scoped writes
   * always carry a project; deploys target the Default project).
   * A deployment that carries any of those primitives without this
   * binding wired fails fast at the loop entrypoint with a clear 500
   * message. All four register loops resolve the project the same way.
   */
  readonly projectBinding?: ProjectBinding;
  /** The env this deployment serves: where a pack tool's declared secrets are read (`secret-scope.ts`). */
  readonly envName?: EnvName;
  /**
   * Whether the server gives each deployment's pack service the values of
   * the env its pack declares, from the env store (`pack-env.ts`): a server
   * that runs a pack service per deployment. Otherwise a pack service takes
   * its env from how it's run, and `GET /:deploymentId/pack-env` answers
   * `501 pack-env-not-served`.
   */
  readonly packEnvServed?: boolean;
  /** Where a pack's declared names are looked for, with `secretsBinding` and `projectBinding`. */
  readonly envBinding?: EnvBinding;
  /**
   * On a runtime that refuses other envs: a secret sync under another env
   * answers `409 env-not-served` before any write (`refuseUnservedValue`).
   * Absent: any env.
   */
  readonly servedEnv?: ServedEnvRule;
  /**
   * Called for each tool and guardrail a new deployment registered, as
   * `POST /v1/tools` and `POST /v1/guardrails` call them, so a runtime
   * that caches the catalogs (its tool and guardrail bridges) sees the
   * deployment at once rather than at restart. Advisory: a failing hook
   * doesn't fail the deployment.
   */
  readonly onToolWrite?: ToolWriteHook;
  readonly onGuardrailWrite?: GuardrailWriteHook;
  /**
   * What the values check reads besides the bindings above
   * (`deployment-values.ts`, `valuesDepsFor`): env values, the model
   * providers, where a provider's key is, and the pack service's own env.
   * Each one absent isn't checked.
   */
  readonly values?: Pick<DeploymentValuesDeps, 'env' | 'providers' | 'modelKeyLookup' | 'packEnv'>;
  /** Where a promotion is recorded (`deployment-promoted`). Absent: it isn't. */
  readonly auditEvents?: AuditEventBinding;
  /**
   * The agents' live versions and gated promotions, for a promotion asked
   * to make what it carried live (`{ makeLive: true }`): each carried
   * agent is pinned in the target through the same gate a live route uses
   * (`requestPromotion`). Absent: `makeLive` answers `501`.
   */
  readonly agentReleases?: AgentReleaseBindings;
  /** What the make-live gate reads besides the releases (`requestPromotion`): comparisons, projects, the reference scope. */
  readonly releaseGateDeps?: AgentReleaseGateDeps;
  /**
   * Rights on an agent more than one project serves, for a make-live: an
   * agent in an order is pinned by an admin of the target project, and a
   * pin wider than one project is refused (`liveChangeRefusal`). Absent, or
   * with no authorizer: today's `promote` check.
   */
  readonly itemRights?: ItemRights;
}

const SECRETS_PATH = /\/deployments\/[^/]+\/secrets\/?$/;

export function deploymentsRouter(
  bindings: DeploymentsRouterBindings,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  // Every schema a publish compiles counts against its tenant's budget.
  const publishCompiles = publishCompilesMiddleware();
  // A deploy into a named project needs admin on that project, as creating
  // an agent there does; a tenant-wide deploy, the tenant's. Every read
  // here needs `read` on the tenant, and a read of one deployment `read` on
  // the project it serves as well (`readableDeployment`). (A key limited to
  // another project was already refused, `refuseOtherProjectForKey`.)
  const tenantAccess = tenantResourceAccess(authorizer);
  // What this runtime offers a deploy refused as another project's: the fix
  // its `<primitive>-project-mismatch` names (`projectMismatchFix`).
  const packRuntime = {
    perDeploymentPacks: bindings.perDeploymentPacks === true,
    environmentOrders: bindings.environmentOrders !== undefined,
  };
  r.use('*', async (c, next) => {
    // Without an authorizer, nothing here is checked: deploying is project
    // work, which a runtime without an authorization store leaves to every
    // caller. `tenantResourceAccess` would make every change the tenant
    // admin's, as it does for the tenant's settings.
    if (authorizer === undefined) return next();
    // A promotion checks rights on the projects themselves: read on the
    // deployment's environment, admin on the target.
    if (isPromotionRoute(c.req.method, c.req.path)) return next();
    // A secrets sync asks admin where it writes them, as `/v1/secrets` does.
    if (c.req.method === 'POST' && SECRETS_PATH.test(c.req.path)) return next();
    if (c.req.method !== 'POST' || !/\/deployments\/?$/.test(c.req.path)) {
      return tenantAccess(c, next);
    }
    return authorizer.authorize('admin', async (ctx) => {
      try {
        const body = await ctx.req.json();
        const pid =
          body !== null && typeof body === 'object'
            ? (body as Record<string, unknown>).projectId
            : undefined;
        if (typeof pid === 'string' && pid.length > 0) return ref('project', pid);
      } catch {
        // The handler answers 400 for a body that isn't JSON.
      }
      return ref('tenant', ctx.get('tenantId') as unknown as string);
    })(c, next);
  });

  // ---------- POST /:deploymentId/promotions (and /check) ----------
  mountDeploymentPromotions(r, bindings, authorizer);

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const imageRefPrefixRaw = c.req.query('imageRefPrefix');
    const signerKeyIdRaw = c.req.query('signerKeyId');
    // One environment's deployments (the Default's include those that name
    // no project), and one pack's.
    const projectIdRaw = c.req.query('projectId');
    const packIdRaw = c.req.query('packId');
    // One project's needs `read` on it (one that isn't there is refused to
    // everyone, so it tells no one what exists). Either way the page keeps
    // only the rows whose project the caller reads, whatever the binding
    // returned, so it can come back short, its cursor still the next page's.
    const oneProject = projectIdRaw !== undefined && projectIdRaw.length > 0;
    const refused = oneProject
      ? await deniedBy(authorizer, c, 'read', ref('project', projectIdRaw))
      : undefined;
    if (refused !== undefined) return refused;

    // A throw from list() propagates to the app's central error handler
    // (middleware/error-mapper.ts): a busy database answers this GET with a
    // 503 + Retry-After, anything else a 500 whose body carries no raw error
    // text (the whole error goes to the log).
    const page = await bindings.deploymentRegistry.list({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(imageRefPrefixRaw !== undefined &&
        imageRefPrefixRaw.length > 0 && {
          imageRefPrefix: imageRefPrefixRaw,
        }),
      ...(signerKeyIdRaw !== undefined &&
        signerKeyIdRaw.length > 0 && {
          signerKeyId: signerKeyIdRaw as SigningKeyId,
        }),
      ...(oneProject && { projectId: projectIdRaw as ProjectId }),
      ...(packIdRaw !== undefined && packIdRaw.length > 0 && { packId: packIdRaw }),
    });
    const readable = await readableDeployments(c, bindings, authorizer, page.data);
    return c.json({
      data: readable.map(serializeDeployment),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && {
        nextCursor: page.nextCursor as unknown as string,
      }),
      // The filters it applied, so a client can tell a runtime that ignored them.
      ...(oneProject && { projectId: projectIdRaw }),
      ...(packIdRaw !== undefined && packIdRaw.length > 0 && { packId: packIdRaw }),
    });
  });

  // ---------- GET /:deploymentId ----------
  r.get('/:deploymentId', async (c) => {
    const requestId = c.get('requestId');
    const deploymentId = c.req.param('deploymentId');

    const located = await readableDeployment(c, bindings, authorizer);
    if (located === undefined) {
      c.status(statusFor('deployment-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'deployment-not-found',
            message: `No deployment with id "${deploymentId}" under this tenant`,
            deploymentId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeDeployment(located.deployment));
  });

  // ---------- GET /:deploymentId/pack-env ----------
  // Where each name its pack declares is set, at the deployment's scopes:
  // never a value.
  r.get('/:deploymentId/pack-env', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const deploymentId = c.req.param('deploymentId');
    const env = bindings.envBinding;
    const envName = bindings.envName;
    if (bindings.packEnvServed !== true || env === undefined || envName === undefined) {
      c.status(statusFor('pack-env-not-served') as never);
      return c.json(
        toWireError(
          {
            code: 'pack-env-not-served',
            message:
              "This server doesn't give a deployment's pack service the env its pack declares: its pack services take theirs from how they're run (`kindgi env plan`).",
          },
          requestId,
        ),
      );
    }
    const located = await readableDeployment(c, bindings, authorizer);
    if (located === undefined) {
      c.status(statusFor('deployment-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'deployment-not-found',
            message: `No deployment with id "${deploymentId}" under this tenant`,
            deploymentId,
          },
          requestId,
        ),
      );
    }
    const record = located.deployment;
    const check = await packEnvCheck(
      {
        env,
        ...(bindings.secretsBinding !== undefined && { secrets: bindings.secretsBinding }),
        ...(bindings.projectBinding !== undefined && { projects: bindings.projectBinding }),
      },
      {
        tenantId,
        ...(record.projectId !== undefined && { projectId: record.projectId }),
        envName,
        declaration: record.packEnv ?? { required: [], optional: [] },
        // The orchestrator gives a secret, or records why it can't on the
        // deployment's endpoint: here it's set, with no problem.
        secretOnly: 'set',
      },
    );
    return c.json({
      envName,
      data: check.names,
      ...(check.problem !== undefined && { problem: check.problem }),
    });
  });

  // ---------- GET /:deploymentId/values ----------
  // What the deployment needs set in a project before it serves there,
  // names only (`deployment-values.ts`). It asks what listing secrets in
  // that project asks, `admin` on it, on top of the tenant `read` above and
  // the deployment's own read, as a promotion from it does.
  r.get('/:deploymentId/values', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const deploymentId = c.req.param('deploymentId');
    const named = c.req.query('projectId');
    if (named !== undefined && !UUID_RE.test(named)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`projectId` must be a project id (a UUID)' },
          requestId,
        ),
      );
    }
    const located = await readableDeployment(c, bindings, authorizer);
    if (located === undefined) {
      c.status(statusFor('deployment-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'deployment-not-found',
            message: `No deployment with id "${deploymentId}" under this tenant`,
            deploymentId,
          },
          requestId,
        ),
      );
    }
    const { deployment: record, projectId: own } = located;
    const projectId = (named as ProjectId | undefined) ?? own;
    if (projectId === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message:
              "`projectId` is required: this runtime doesn't record the deployment's project",
          },
          requestId,
        ),
      );
    }
    const refused = await deniedBy(authorizer, c, 'admin', ref('project', projectId));
    if (refused !== undefined) return refused;
    if (named !== undefined && (await bindings.projectBinding?.get(tenantId, projectId)) === null) {
      c.status(statusFor('project-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'project-not-found',
            message: `\`projectId\` "${named}" names no project of this tenant`,
          },
          requestId,
        ),
      );
    }
    // In a project other than its own, the one a promotion would take it
    // to, a tool's secret counts only at a scope the caller administers, as
    // their promotion would record it, so the list says what that
    // promotion's check would. In its own project, every scope counts: the
    // list says where a run there finds each value.
    const administers = projectId === own ? undefined : callerAdministers(c, authorizer, tenantId);
    const { carried } = await carriedFor(bindings, record);
    const data = await deploymentValues(valuesDepsFor(bindings, administers), {
      deployment: record,
      carried,
      projectId,
    });
    return c.json({ data });
  });

  // ---------- POST / (register a signed deployment) ----------
  r.post('/', publishCompiles, async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    const parsed = parseWireBody(body);
    if (parsed.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: parsed.error.message,
            issues: parsed.error.issues as unknown as Record<string, unknown>[],
          },
          requestId,
        ),
      );
    }
    const wire = parsed.value;

    // Extract image digest from imageRef. Must be `<host>/<repo>@sha256:<hex>`.
    const digestFromRef = extractImageDigest(wire.imageRef);
    if (digestFromRef === null) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: 'imageRef must be digest-pinned: "<host>/<repo>@sha256:<64-hex>"',
          },
          requestId,
        ),
      );
    }
    const imageDigest = digestFromRef;

    // ---- The tenant's own repository, before any registry read ----
    const outside = await imagePrefixRefusal(bindings.imagePrefixes, tenantId, wire.imageRef);
    if (outside !== undefined) {
      c.status(statusFor(outside.code) as never);
      return c.json(toWireError(outside, requestId));
    }

    // ---- Signature verification ----
    const publicKeyBytes = parsePublicKeyPem(wire.signerPublicKey);
    if (publicKeyBytes.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: `signerPublicKey PEM invalid: ${publicKeyBytes.error.message}`,
          },
          requestId,
        ),
      );
    }
    const publicKeyBase64 = Buffer.from(publicKeyBytes.value).toString('base64');
    const trusted = await bindings.signingKeyRegistry.isTrusted({
      tenantId,
      keyId: wire.signerKeyId,
      publicKey: publicKeyBase64,
    });
    if (trusted.kind === 'err') {
      // To the central error handler: a 500 with no raw text; the trust-check
      // error is logged via the cause, which keeps its code.
      throw new Error('Trust check failed', { cause: trusted.error });
    }
    if (!trusted.value) {
      c.status(statusFor('signer-not-trusted') as never);
      return c.json(
        toWireError(
          {
            code: 'signer-not-trusted',
            message: `Signer key "${wire.signerKeyId as unknown as string}" is not on this tenant's trust list`,
            signerKeyId: wire.signerKeyId as unknown as string,
          },
          requestId,
        ),
      );
    }

    const canonicalEnvelope = canonicalizeEnvelope({
      imageDigest,
      artifactVersion: wire.artifactVersion,
      indexHash: wire.indexHash,
      tenantId: tenantId as unknown as string,
      publishedAt: wire.publishedAt,
    });
    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(wire.signature, 'base64');
    } catch {
      c.status(statusFor('signature-invalid') as never);
      return c.json(
        toWireError(
          { code: 'signature-invalid', message: 'signature is not valid base64' },
          requestId,
        ),
      );
    }
    const verification = verifyEd25519(
      publicKeyBytes.value,
      canonicalEnvelope,
      new Uint8Array(signatureBytes),
    );
    if (verification.kind === 'err') {
      c.status(statusFor('signature-invalid') as never);
      return c.json(
        toWireError(
          {
            code: 'signature-invalid',
            message: `Signature verification rejected: ${verification.error.message}`,
          },
          requestId,
        ),
      );
    }
    if (!verification.value) {
      c.status(statusFor('signature-invalid') as never);
      return c.json(
        toWireError(
          {
            code: 'signature-invalid',
            message:
              'Ed25519 signature does not match canonical envelope { imageDigest, artifactVersion, indexHash, tenantId, publishedAt }',
          },
          requestId,
        ),
      );
    }

    // ---- Image pullability + index integrity ----
    const head = await bindings.imageRegistry.head({ tenantId, imageRef: wire.imageRef });
    if (head.kind === 'err') {
      return registryRefusal(c, 'Image head probe failed', head.error, wire.imageRef, requestId);
    }
    if (head.value.digest !== imageDigest) {
      c.status(statusFor('image-unverifiable') as never);
      return c.json(
        toWireError(
          {
            code: 'image-unverifiable',
            message: `Registry digest ${head.value.digest} does not match imageRef digest ${imageDigest}`,
            imageRef: wire.imageRef,
          },
          requestId,
        ),
      );
    }

    const indexFile = await bindings.imageRegistry.extractFile({
      tenantId,
      imageRef: wire.imageRef,
      path: '/app/index.json',
    });
    if (indexFile.kind === 'err') {
      return registryRefusal(
        c,
        'Extract /app/index.json failed',
        indexFile.error,
        wire.imageRef,
        requestId,
      );
    }
    const normalisedIndexHash = normaliseSha256Hex(indexFile.value.sha256);
    const normalisedWireIndexHash = normaliseSha256Hex(wire.indexHash);
    if (normalisedIndexHash !== normalisedWireIndexHash) {
      c.status(statusFor('image-unverifiable') as never);
      return c.json(
        toWireError(
          {
            code: 'image-unverifiable',
            message: `Image /app/index.json sha256 (${normalisedIndexHash}) does not match signed indexHash (${normalisedWireIndexHash})`,
            imageRef: wire.imageRef,
          },
          requestId,
        ),
      );
    }

    // What registers is the image's own index, the bytes the signature
    // covers (through indexHash), never a copy from the request.
    const imageIndex = parseImageIndex(indexFile.value.bytes);
    if (imageIndex === undefined) {
      c.status(statusFor('image-unverifiable') as never);
      return c.json(
        toWireError(
          {
            code: 'image-unverifiable',
            message: 'Image /app/index.json is not a JSON object',
            imageRef: wire.imageRef,
          },
          requestId,
        ),
      );
    }
    // The names its pack service reads from its process env, as the build
    // validated them: a signed index that doesn't is refused, never kept.
    const declaredEnv = resolvePackEnv(imageIndex.env);
    if (declaredEnv.kind === 'err') {
      c.status(statusFor('image-unverifiable') as never);
      return c.json(
        toWireError(
          {
            code: 'image-unverifiable',
            message: `Image /app/index.json's env is malformed: ${declaredEnv.message}`,
            imageRef: wire.imageRef,
          },
          requestId,
        ),
      );
    }
    if (imageIndex.artifactVersion !== wire.artifactVersion) {
      c.status(statusFor('image-unverifiable') as never);
      return c.json(
        toWireError(
          {
            code: 'image-unverifiable',
            message: `Image /app/index.json is artifact ${JSON.stringify(imageIndex.artifactVersion)}, not the signed ${wire.artifactVersion}`,
            imageRef: wire.imageRef,
          },
          requestId,
        ),
      );
    }

    // ---- Manifest validation ----
    const validation = validatePrimitives(
      imageIndex,
      { imageRef: wire.imageRef, artifactVersion: wire.artifactVersion },
      c.get('log'),
    );
    if (validation.kind === 'err') {
      c.status(statusFor('deployment-validation-failed') as never);
      return c.json(
        toWireError(
          {
            code: 'deployment-validation-failed',
            message: `Deployment manifest validation failed (${validation.error.details.length} issue${validation.error.details.length === 1 ? '' : 's'})`,
            issues: validation.error.details as unknown as Record<string, unknown>[],
          },
          requestId,
        ),
      );
    }
    const validated = validation.value;

    // A reserved `kindgi.` name or a model provider's key is never a tool's:
    // each tool naming one is an issue.
    const keyIssues: ValidationDetail[] = [];
    if (validated.tools.length > 0) {
      const tenantId = c.get('tenantId') as TenantId;
      for (const [index, tool] of validated.tools.entries()) {
        const refusal = await refuseSecretNames(
          bindings.providerKeys,
          tenantId,
          toolSecretNames(tool),
          'a tool',
        );
        if (refusal !== undefined) {
          keyIssues.push({
            primitive: 'tool',
            index,
            id: tool.id as unknown as string,
            path: `/secrets/${refusal.secret}`,
            message: refusal.message,
          });
        }
      }
    }
    if (keyIssues.length > 0) return validationFailed(c, keyIssues);

    // The pack's data blocks are published into the runtime's block
    // registry: a runtime without one takes none.
    if (validated.blocks.length > 0 && bindings.blockRegistry === undefined) {
      return validationFailed(
        c,
        validated.blocks.map((block, index) => ({
          primitive: 'block' as const,
          index,
          id: block.id,
          path: '',
          message: 'this runtime serves no data blocks',
        })),
      );
    }

    if (bindings.requirePrefixedPackChecks === true) {
      const checkIssues = unprefixedPackChecks(validated.guardrails, imageIndex.packId);
      if (checkIssues.length > 0) return validationFailed(c, checkIssues);
    }

    // A read-only registry (under `kindgi dev`, the pack's files) takes
    // nothing a deployment brings: refuse before any write.
    const readOnly = readOnlyTarget(validated, bindings);
    if (readOnly !== undefined) return refuseReadOnly(c, readOnly);

    // ---- Registry upserts (with rollback tracking) ----
    //
    // Agent-registry, flow-registry, tool-registry, guardrail-registry and
    // block-registry writes are all project-scoped. All five loops write
    // into the deploy's project: the body's `projectId`, else the tenant's
    // Default project via `projectBinding.getDefault(tenantId)`, resolved
    // once per request and threaded into
    // `AgentRegistryBinding.publish(...)` /
    // `FlowRegistryBinding.publish(...)` /
    // `ToolRegistryBinding.register(...)` /
    // `GuardrailRegistryBinding.register(...)` /
    // `BlockRegistryBinding.publish(...)` (`publishPackBlocks`).
    //
    // Fail-fast: if a deployment brings any of those primitives but
    // no `projectBinding` was wired, we surface `500 internal-server-
    // error` with an operator-actionable message BEFORE any registry
    // writes so rollback stays empty.
    const needsProjectBinding =
      validated.agents.length > 0 ||
      validated.flows.length > 0 ||
      validated.tools.length > 0 ||
      validated.guardrails.length > 0 ||
      validated.blocks.length > 0;
    if (needsProjectBinding && bindings.projectBinding === undefined) {
      c.status(statusFor('internal-server-error') as never);
      return c.json(
        toWireError(
          {
            code: 'internal-server-error',
            message:
              'agent/flow/tool/guardrail/block publish requires projectBinding; deployment blocked. Wire projectBinding into DeploymentsRouterBindings at app-creation time.',
          },
          requestId,
        ),
      );
    }
    let targetProjectId: ProjectId | undefined = wire.projectId;
    if (
      targetProjectId === undefined &&
      needsProjectBinding &&
      bindings.projectBinding !== undefined
    ) {
      const defaultProject = await bindings.projectBinding.getDefault(tenantId);
      if (defaultProject === undefined) {
        c.status(statusFor('internal-server-error') as never);
        return c.json(
          toWireError(
            {
              code: 'internal-server-error',
              message:
                'no Default project exists for this tenant; deployment blocked. Every tenant should auto-seed a Default project at creation.',
            },
            requestId,
          ),
        );
      }
      targetProjectId = defaultProject.id;
    }
    if (
      targetProjectId !== undefined &&
      bindings.projectSuspended !== undefined &&
      (await bindings.projectSuspended(tenantId, targetProjectId))
    ) {
      c.status(statusFor('project-suspended') as never);
      return c.json(
        toWireError(
          {
            code: 'project-suspended',
            message:
              "The project is suspended, so nothing deploys into it until it's restored; nothing was deployed",
          },
          requestId,
        ),
      );
    }

    // A later environment of an order takes builds by promotion only: the
    // deploy goes to the order's first environment. The project is the one
    // named, else the Default's (where a deploy naming none lands).
    if (bindings.environmentOrders !== undefined) {
      const entryProjectId =
        targetProjectId ?? (await bindings.projectBinding?.getDefault(tenantId))?.id;
      const later =
        entryProjectId === undefined
          ? undefined
          : await laterEnvironment(bindings.environmentOrders, tenantId, entryProjectId);
      if (later !== undefined) {
        return environmentTakesPromotionsResponse(
          c,
          requestId,
          authorizer,
          { kind: 'deploy' },
          later,
        );
      }
    }

    // What its agents and flows name, besides what it brings itself, must be
    // its project's to reach (`reference-scope.ts`), before any write.
    if (targetProjectId !== undefined) {
      const brought = new Set([
        ...validated.tools.map((t) => `tool:${t.id as unknown as string}`),
        ...validated.agents.map((a) => `agent:${a.id as unknown as string}`),
        ...validated.flows.map((f) => `flow:${f.id as unknown as string}`),
        ...validated.guardrails.map((g) => `guardrail:${g.id as unknown as string}`),
        // Published into this project, or refused as another project's.
        ...validated.blocks.map((b) => `block:${b.id}`),
      ]);
      const named = [
        ...validated.agents.flatMap((agent, i) =>
          agentReferences(agent).map((ref) => ({ ...ref, path: `/agents/${i}${ref.path}` })),
        ),
        ...validated.flows.flatMap((flow, i) =>
          flowReferences(flow).map((ref) => ({ ...ref, path: `/flows/${i}${ref.path}` })),
        ),
      ].filter((ref) => !brought.has(`${ref.kind}:${ref.id}`));
      const outOfScope = await referencesOutOfScope(
        bindings.referenceScope,
        tenantId,
        targetProjectId,
        named,
      );
      if (outOfScope !== undefined) return outOfScopeResponse(c, requestId, outOfScope);
    }

    // Every schema a deploy compiles is compiled before its first write,
    // so a compile its tenant's budget refuses leaves nothing stored. The
    // pack's data blocks are checked against the registry here (a settings
    // version's values against the schema it keeps), and the agents'
    // blocks pin here (checking model settings compiles one), over the
    // registry's versions and the pack's new ones (`deploy-blocks.ts`).
    let packBlocks: readonly PlannedBlock[] = [];
    let blockReads: BlockVersionReads | undefined = bindings.blockRegistry;
    if (
      validated.blocks.length > 0 &&
      bindings.blockRegistry !== undefined &&
      targetProjectId !== undefined
    ) {
      const plan = await planPackBlocks(bindings.blockRegistry, tenantId, validated.blocks);
      if (plan.kind === 'invalid') {
        return validationFailed(
          c,
          plan.issues.map((issue) => ({ primitive: 'block' as const, ...issue })),
        );
      }
      if (plan.kind === 'refused') {
        return publishRefusedResponse(c, requestId, plan.refusal, packRuntime);
      }
      packBlocks = plan.planned;
      blockReads = withPackVersions(bindings.blockRegistry, targetProjectId, packBlocks);
    }
    // The pack's tools are checked against the registry here too: a
    // version it holds in this project is kept only with the pack's
    // definition, and refused with another (`deploy-tools.ts`).
    let packTools: readonly PlannedTool[] = [];
    if (bindings.toolRegistry !== undefined && targetProjectId !== undefined) {
      const plan = await planPackTools(
        bindings.toolRegistry,
        tenantId,
        targetProjectId,
        validated.tools,
      );
      if (plan.kind === 'refused') {
        return publishRefusedResponse(c, requestId, plan.refusal, packRuntime);
      }
      packTools = plan.planned;
    }
    const blockPinsOf =
      bindings.agentRegistry !== undefined &&
      bindings.toolRegistry !== undefined &&
      targetProjectId !== undefined
        ? await pinBlocks(
            blockReads,
            tenantId,
            validated.agents,
            new Map(packBlocks.map(({ block }) => [block.id, block.version])),
          )
        : undefined;
    // The pack's blocks are written first, and a failed deploy's rollback
    // leaves their new versions unregistered, which refuses the pack's next
    // deploy until they're reinstated. So with the pack's blocks, a block
    // range the agents can't pin is refused here, before anything is
    // written; a tool range is named at the write, as before.
    if (packBlocks.length > 0 && blockPinsOf !== undefined) {
      const unpinnable = blockPinsOf.flatMap((pins, i) =>
        atAgent(i, validated.agents[i] as Agent, pins.issues),
      );
      if (unpinnable.length > 0) return unpinnableResponse(c, requestId, unpinnable);
    }

    const rolled: RollbackAction[] = [];
    // The version each agent is registered under: its definition's, or
    // the one a deploy registered in its place (`publishDeployedAgent`).
    const deployedAgents: DeployedAgent[] = [];
    const deployedFlows: DeployedFlow[] = [];
    try {
      // Past the first write, a compile is a registry's own compile of a
      // schema compiled above, which the tenant's budget was charged for:
      // it runs outside the counting, so the budget can't refuse a deploy
      // half-written.
      await runOutsideTenant(async () => {
        // The pack's blocks first: what follows pins them.
        if (bindings.blockRegistry !== undefined && targetProjectId !== undefined) {
          await publishPackBlocks({
            blocks: bindings.blockRegistry,
            tenantId,
            projectId: targetProjectId,
            planned: packBlocks,
            rolled,
          });
        }
        if (bindings.toolRegistry !== undefined && targetProjectId !== undefined) {
          for (const { tool, state } of packTools) {
            const projectIdForTool = targetProjectId;
            // Where each secret it names is read: decided now, as the deployer
            // may read them, and kept with this version (`secret-scope.ts`).
            // One set nowhere yet is read where this deployment's sync writes.
            const secretScopes = await secretScopesFor(
              c,
              {
                secrets: bindings.secretsBinding,
                projects: bindings.projectBinding,
                authorizer,
              },
              { kind: 'project', tenantId, projectId: projectIdForTool },
              toolSecretRefs(tool, bindings.envName),
              deploymentSecretScope(tenantId, wire.projectId),
            );
            const outcome = await bindings.toolRegistry.publish({
              tenantId,
              projectId: projectIdForTool,
              tool,
              ...(secretScopes !== undefined && { secretScopes }),
              enqueueTuples: (toolId) =>
                tuplesForCreate({
                  kind: 'tool',
                  id: toolId as ToolId,
                  tenantId,
                  projectId: projectIdForTool,
                }),
            });
            if (outcome.kind === 'ok') {
              const toolId = outcome.toolId;
              const version = outcome.version;
              rolled.push({
                primitive: 'tool',
                id: `${toolId}@${version}`,
                undo: 'unregister',
                run: async () => {
                  await bindings.toolRegistry?.unregister({ tenantId, toolId, version });
                },
              });
            } else if (outcome.kind === 'already-registered') {
              // Compared before the first write where the plan could.
              if (state === 'new' || state === 'publish-decides') {
                await keepPublishedTool(bindings.toolRegistry, tenantId, tool);
              }
              await reinstateRetiredTool(bindings.toolRegistry, tenantId, tool, rolled);
              await refreshToolCode(bindings.toolRegistry, tenantId, tool, rolled);
            } else {
              throw new PublishRefused('tool', `${tool.id}@${tool.version}`, outcome);
            }
          }
        }
        if (bindings.guardrailRegistry !== undefined && targetProjectId !== undefined) {
          for (const guardrail of validated.guardrails) {
            const projectIdForGuardrail = targetProjectId;
            const outcome = await bindings.guardrailRegistry.register({
              tenantId,
              projectId: projectIdForGuardrail,
              guardrail,
              enqueueTuples: (guardrailId) =>
                tuplesForCreate({
                  kind: 'guardrail',
                  id: guardrailId as GuardrailId,
                  tenantId,
                  projectId: projectIdForGuardrail,
                }),
            });
            if (outcome.kind === 'ok') {
              const guardrailId = outcome.guardrailId;
              rolled.push({
                primitive: 'guardrail',
                id: guardrailId,
                undo: 'unregister',
                run: async () => {
                  await bindings.guardrailRegistry?.unregister({ tenantId, guardrailId });
                },
              });
            } else if (outcome.kind === 'already-registered') {
              const kept = await keepRegisteredGuardrail(
                bindings.guardrailRegistry,
                bindings.environmentOrders,
                tenantId,
                projectIdForGuardrail,
                guardrail,
              );
              // Unregistered since the registry answered: registered afresh.
              if (kept.kind === 'registered') {
                const guardrailId = guardrail.id;
                rolled.push({
                  primitive: 'guardrail',
                  id: guardrailId,
                  undo: 'unregister',
                  run: async () => {
                    await bindings.guardrailRegistry?.unregister({ tenantId, guardrailId });
                  },
                });
              } else {
                await refreshGuardrailFields(
                  bindings.guardrailRegistry,
                  tenantId,
                  guardrail,
                  kept.existing,
                  rolled,
                );
              }
            } else {
              throw new PublishRefused('guardrail', guardrail.id, outcome);
            }
          }
        }
        if (bindings.agentRegistry !== undefined && targetProjectId !== undefined) {
          deployedAgents.push(
            ...(await registerAgents({
              agents: bindings.agentRegistry,
              tools: bindings.toolRegistry,
              blockPins: blockPinsOf,
              tenantId,
              projectId: targetProjectId,
              defined: validated.agents,
              referenceScope: bindings.referenceScope,
              rolled,
            })),
          );
        } else {
          deployedAgents.push(...validated.agents.map(deployedPrimitive));
        }
        if (bindings.flowRegistry !== undefined && targetProjectId !== undefined) {
          deployedFlows.push(
            ...(await registerFlows({
              flows: bindings.flowRegistry,
              tools: bindings.toolRegistry,
              agents: bindings.agentRegistry,
              ...(bindings.liveVersions !== undefined && { live: bindings.liveVersions }),
              tenantId,
              projectId: targetProjectId,
              defined: validated.flows,
              referenceScope: bindings.referenceScope,
              rolled,
            })),
          );
        } else {
          deployedFlows.push(...validated.flows.map(deployedPrimitive));
        }
      });
    } catch (cause) {
      await rollback(rolled, c.get('log'));
      // A compile the tenant's budget refused is a limit, which the app's
      // error handler answers. None runs past the first write here.
      if (cause instanceof SchemaCompileBudgetError) throw cause;
      // A primitive refused with a typed outcome is the caller's to fix:
      // that outcome's own status and code. Anything else propagates to the
      // central error handler (a 500 for this write).
      if (cause instanceof PublishRefused) {
        return publishRefusedResponse(c, requestId, cause, packRuntime);
      }
      if (cause instanceof UnpinnableDeploy) return unpinnableResponse(c, requestId, cause.issues);
      // An unregistered agent or flow version naming what its project doesn't
      // reach: refused as the pack's own references are, before any write.
      if (cause instanceof RetiredVersionOutOfScope) {
        return outOfScopeResponse(c, requestId, cause.refusal);
      }
      // Not a mapped outcome: to the central error handler (a 500 for this
      // write — the rollback above already ran; the whole error is logged).
      throw cause;
    }

    // ---- Deployment record ----
    const primitives: DeploymentPrimitiveCounts = {
      tools: validated.tools.length,
      guardrails: validated.guardrails.length,
      agents: validated.agents.length,
      flows: validated.flows.length,
    };

    let outcome: DeploymentRegisterOutcome;
    try {
      outcome = await bindings.deploymentRegistry.register({
        tenantId,
        imageRef: wire.imageRef,
        imageDigest,
        artifactVersion: wire.artifactVersion,
        indexHash: normalisedWireIndexHash,
        signerKeyId: wire.signerKeyId,
        signerPublicKey: publicKeyBase64,
        signature: wire.signature,
        publishedAt: wire.publishedAt,
        primitives,
        ...(wire.projectId !== undefined && { projectId: wire.projectId }),
        ...(typeof imageIndex.packId === 'string' && { packId: imageIndex.packId }),
        ...(declaredEnv.value !== undefined && { packEnv: declaredEnv.value }),
        packChecks: [
          ...new Set(
            validated.guardrails
              // Its check runs in the image: a module, and not a built-in it merely names.
              .filter((g) => g.codeArtifactRef !== undefined && g.checkBuiltIn !== true)
              .map((g) => g.check as unknown as string),
          ),
        ],
        contents: {
          tools: validated.tools.map((t) => ({
            id: t.id as unknown as string,
            version: t.version,
          })),
          guardrails: validated.guardrails.map((g) => ({ id: g.id as unknown as string })),
          agents: deployedAgents,
          flows: deployedFlows,
        },
      });
    } catch (cause) {
      await rollback(rolled, c.get('log'));
      // To the central error handler: a 500 with no raw text; the error is logged.
      throw cause;
    }

    if (outcome.kind === 'error') {
      await rollback(rolled, c.get('log'));
      // To the central error handler: a 500 with no raw text; the outcome's
      // code and message go to the log.
      throw new Error(`Deployment record failed (${outcome.code}): ${outcome.message}`);
    }
    if (outcome.kind === 'already-registered') {
      // Digest-based idempotency: same digest already recorded. Roll back
      // any freshly-inserted primitives (the primitive itself is fine —
      // the previous deploy landed it — but re-inserting is idempotent
      // at the primitive layer too, so `ok` outcomes only happen when
      // the primitive was DIFFERENT this run, which is an inconsistent
      // wire body).
      await rollback(rolled, c.get('log'));
      c.status(200);
      return c.json(serializeDeployment(outcome.deployment));
    }

    await notifyWrites(tenantId, validated, bindings);
    c.status(201);
    return c.json(serializeDeployment(outcome.deployment));
  });

  // ---------- POST /:deploymentId/secrets ----------
  //
  // Deployment-scoped bulk secret sync.
  //
  // Body shape:
  //   {
  //     envName: EnvName;
  //     secrets: Array<{ name, ref } | { name, value }>;
  //   }
  //
  // - `{ name, ref }` entries → validated via `SecretBinding.get`. No
  //   bytes cross the wire. Missing → 404 `secret-not-found` (matches
  //   the framework-wide `secret-not-found` → 404 mapping in
  //   `errors.ts`). The `ref` value is echoed
  //   verbatim in the response (opaque reference the deployment
  //   runtime resolves at dispatch).
  // - `{ name, value }` entries → written via `SecretBinding.set` with
  //   `writeMode: 'add-version'` + `tags.deployment = deploymentId`. The
  //   response returns the just-minted reference (framework-generated
  //   `secret:` scheme so the developer can round-trip).
  //
  // Scope is derived from the target deployment record, NOT accepted from
  // the wire (CRITICAL): the project the deploy named (`projectId`), else
  // the tenant (`deploymentSecretScope`).
  //
  // Capability: `secrets:write` (fail-closed). Rights: the deployment's
  // read (one the caller doesn't read is a `404`), then `admin` on the
  // scope it writes, as `/v1/secrets` asks for a write there.
  // Idempotency-Key: honoured by the middleware layer.
  r.post('/:deploymentId/secrets', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const deploymentId = c.req.param('deploymentId');

    if (bindings.secretsBinding === undefined) {
      c.status(statusFor('internal-server-error') as never);
      return c.json(
        toWireError(
          {
            code: 'internal-server-error',
            message:
              'secretsBinding is not wired; POST /v1/deployments/:deploymentId/secrets is unavailable. ' +
              'Wire secretsBinding into DeploymentsRouterBindings.',
          },
          requestId,
        ),
      );
    }

    const missing = capabilityRefusal(c, authorizer, 'secrets:write', 'for deployment secret sync');
    if (missing !== undefined) return missing;

    // Resolve the target deployment first — its `(tenantId, projectId?)`
    // is what determines the write scope.
    const located = await readableDeployment(c, bindings, authorizer);
    if (located === undefined) {
      c.status(statusFor('deployment-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'deployment-not-found',
            message: `No deployment with id "${deploymentId}" under this tenant`,
            deploymentId,
          },
          requestId,
        ),
      );
    }
    const deployment = located.deployment;
    const scope = deploymentSecretScope(deployment.tenantId, deployment.projectId);
    const refused = await deniedBy(authorizer, c, 'admin', scopeResourceRef(scope, tenantId));
    if (refused !== undefined) return refused;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: 'Request body must be a JSON object' },
          requestId,
        ),
      );
    }
    const b = body as Record<string, unknown>;

    const envNameResult = requireEnvName(typeof b.envName === 'string' ? b.envName : undefined);
    if (envNameResult.kind === 'err') {
      c.status(statusFor(envNameResult.code) as never);
      return c.json(
        toWireError({ code: envNameResult.code, message: envNameResult.message }, requestId),
      );
    }
    const envName = envNameResult.envName;

    if (!Array.isArray(b.secrets)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: '`secrets` must be an array of `{ name, ref }` or `{ name, value }` entries',
          },
          requestId,
        ),
      );
    }
    // Empty array is legal (a no-op sync). Every real entry must be an
    // object with a non-empty `name` and exactly one of `ref` / `value`.
    const parsed: ParsedSyncEntry[] = [];
    for (let i = 0; i < b.secrets.length; i++) {
      const raw = b.secrets[i];
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: `secrets[${i}] must be an object`,
            },
            requestId,
          ),
        );
      }
      const e = raw as Record<string, unknown>;
      if (typeof e.name !== 'string' || e.name.length === 0) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: `secrets[${i}].name is required and must be a non-empty string`,
            },
            requestId,
          ),
        );
      }
      const hasRef = typeof e.ref === 'string';
      const hasValue = typeof e.value === 'string';
      if (hasRef === hasValue) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            {
              code: 'bad-input',
              message: `secrets[${i}] must set exactly one of \`ref\` or \`value\``,
            },
            requestId,
          ),
        );
      }
      if (hasRef) {
        parsed.push({ kind: 'ref', name: e.name, ref: e.ref as string });
      } else {
        parsed.push({ kind: 'value', name: e.name, value: e.value as string });
      }
    }

    // Every entry is checked against the env this runtime serves before any
    // write, so a refusal leaves nothing half-written.
    const servedEnv =
      bindings.servedEnv !== undefined ? readReferencesOnce(bindings.servedEnv) : undefined;
    for (const entry of parsed) {
      const unserved = await refuseUnservedValue(servedEnv, {
        tenantId,
        scope,
        envName,
        name: entry.name,
        kind: 'secret',
      });
      if (unserved !== undefined) {
        c.status(statusFor(unserved.code) as never);
        return c.json(toWireError(unserved, requestId));
      }
    }

    // A new inline secret's name is held to the shared grammar before any
    // write, so a refusal leaves nothing half-written. A name that passes
    // needs no store read; a name that fails is refused unless it's already
    // stored (an `add-version` to a name written before this release).
    for (const entry of parsed) {
      if (entry.kind !== 'value') continue;
      const nameRefusal = secretNameGrammarRefusal(entry.name);
      if (nameRefusal === undefined) continue;
      const existing = await bindings.secretsBinding.get({ scope, envName, name: entry.name });
      if (existing !== null) continue;
      c.status(statusFor(nameRefusal.code) as never);
      return c.json(
        toWireError(
          {
            code: nameRefusal.code,
            message: `secrets[${entry.name}]: ${nameRefusal.message}`,
            name: entry.name,
          },
          requestId,
        ),
      );
    }

    let resolvedCount = 0;
    let addedCount = 0;
    const references: Array<{ name: string; ref: string; version: number }> = [];
    for (const entry of parsed) {
      if (entry.kind === 'ref') {
        const rec = await bindings.secretsBinding.get({ scope, envName, name: entry.name });
        if (rec === null || rec.revokedAt !== undefined) {
          c.status(statusFor('secret-not-found') as never);
          return c.json(
            toWireError(
              {
                code: 'secret-not-found',
                message: `secrets[${entry.name}]: no secret at (${scope.kind}, ${envName as unknown as string}, ${entry.name}) — write with { name, value } first or fix the ref.`,
                name: entry.name,
              },
              requestId,
            ),
          );
        }
        resolvedCount += 1;
        references.push({ name: entry.name, ref: entry.ref, version: rec.currentVersion });
      } else {
        const outcome = await bindings.secretsBinding.set({
          scope,
          envName,
          name: entry.name,
          value: entry.value,
          writeMode: 'add-version',
          tags: { deployment: deploymentId },
          // Only fires on create-new; here we're adding a version → no-op.
          enqueueTuples: () => [],
        });
        if (outcome.kind !== 'ok') {
          // add-version should never trigger `already-exists`; treat any
          // non-ok as a hard failure (binding-side conflict, encryption
          // failure, etc.). Fail the whole request (atomic model).
          const code =
            outcome.kind === 'version-conflict'
              ? 'secret-write-conflict'
              : outcome.kind === 'already-exists'
                ? 'secret-write-conflict'
                : outcome.code;
          const message =
            outcome.kind === 'version-conflict'
              ? `secrets[${entry.name}]: version conflict (stored=${outcome.currentVersion}); retry.`
              : outcome.kind === 'already-exists'
                ? `secrets[${entry.name}]: already-exists surface on add-version (adapter bug); investigate.`
                : `secrets[${entry.name}]: ${outcome.message}`;
          c.status(statusFor(code) as never);
          return c.json(toWireError({ code, message }, requestId));
        }
        addedCount += 1;
        // Reference format: `secret:<envName>/<name>#<version>`. Opaque
        // to the wire — the deployment runtime resolves via SecretBinding
        // at dispatch time.
        const ref = `secret:${envName as unknown as string}/${entry.name}#${outcome.versionId}`;
        references.push({ name: entry.name, ref, version: outcome.versionId });
      }
    }

    return c.json({
      resolved: resolvedCount,
      added: addedCount,
      references,
    });
  });

  return r;
}

type ParsedSyncEntry =
  | { readonly kind: 'ref'; readonly name: string; readonly ref: string }
  | { readonly kind: 'value'; readonly name: string; readonly value: string };

// ------------------------------------------------------------
// Wire body validation
// ------------------------------------------------------------

interface WireBody {
  readonly imageRef: string;
  readonly artifactVersion: string;
  readonly indexHash: string;
  readonly signerKeyId: SigningKeyId;
  readonly signerPublicKey: string;
  readonly signature: string;
  readonly publishedAt: string;
  /** The project to deploy into; absent: the tenant's Default project. */
  readonly projectId?: ProjectId;
}

interface Issue {
  readonly path: string;
  readonly message: string;
}

type ParseResult =
  | { readonly kind: 'ok'; readonly value: WireBody }
  | {
      readonly kind: 'err';
      readonly error: { readonly message: string; readonly issues: readonly Issue[] };
    };

const ARTIFACT_VERSION_RE = /^\d{8}\.\d+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const SHA256_PREFIX_RE = /^sha256:[0-9a-f]{64}$/i;

function parseWireBody(body: unknown): ParseResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      kind: 'err',
      error: {
        message: 'Request body must be a JSON object',
        issues: [{ path: '', message: 'must be an object' }],
      },
    };
  }
  const b = body as Record<string, unknown>;
  const issues: Issue[] = [];
  const requireString = (field: string): string | undefined => {
    const raw = b[field];
    if (typeof raw !== 'string' || raw.length === 0) {
      issues.push({ path: field, message: `${field} must be a non-empty string` });
      return undefined;
    }
    return raw;
  };
  const imageRef = requireString('imageRef');
  const artifactVersion = requireString('artifactVersion');
  const indexHash = requireString('indexHash');
  const signerKeyId = requireString('signerKeyId');
  const signerPublicKey = requireString('signerPublicKey');
  const signature = requireString('signature');
  const publishedAt = requireString('publishedAt');

  if (artifactVersion !== undefined && !ARTIFACT_VERSION_RE.test(artifactVersion)) {
    issues.push({
      path: 'artifactVersion',
      message: 'artifactVersion must match YYYYMMDD.N',
    });
  }
  if (
    indexHash !== undefined &&
    !SHA256_PREFIX_RE.test(indexHash) &&
    !SHA256_HEX_RE.test(indexHash)
  ) {
    issues.push({
      path: 'indexHash',
      message: 'indexHash must be sha256:<64-hex> (or bare 64-hex)',
    });
  }
  if (publishedAt !== undefined && parseTimeInput(publishedAt) === null) {
    issues.push({ path: 'publishedAt', message: 'publishedAt must be ISO-8601' });
  }
  // Checked again by the project-ref middleware, which also answers 404 for
  // a project of no tenant's; here only its shape, for a router mounted alone.
  const projectId = b.projectId;
  if (projectId !== undefined && (typeof projectId !== 'string' || !UUID_RE.test(projectId))) {
    issues.push({ path: 'projectId', message: 'projectId must be a project id (a UUID)' });
  }

  if (issues.length > 0) {
    return {
      kind: 'err',
      error: { message: issues[0]?.message ?? 'body validation failed', issues },
    };
  }

  return {
    kind: 'ok',
    value: {
      imageRef: imageRef as string,
      artifactVersion: artifactVersion as string,
      indexHash: indexHash as string,
      signerKeyId: signerKeyId as unknown as SigningKeyId,
      signerPublicKey: signerPublicKey as string,
      signature: signature as string,
      publishedAt: publishedAt as string,
      ...(typeof projectId === 'string' && { projectId: projectId as unknown as ProjectId }),
    },
  };
}

/** `400 deployment-validation-failed`, naming each issue. */
/**
 * A primitive the deploy refused to publish (`PublishRefused`), with that
 * outcome's own status and code. A project mismatch logs the project the
 * primitive belongs to, which the answer never names, and names the fix
 * this runtime has (`projectMismatchFix`).
 */
function publishRefusedResponse(
  c: Context<AppEnv>,
  requestId: string,
  cause: PublishRefused,
  runtime: Parameters<typeof projectMismatchFix>[0],
) {
  if (cause.projectId !== undefined) {
    c.get('log').info(`${cause.message}: deploy refused`, {
      primitive: cause.primitive,
      id: cause.id,
      ownerProjectId: cause.projectId as unknown as string,
    });
  }
  c.status(statusFor(cause.code) as never);
  return c.json(
    toWireError(
      {
        code: cause.code,
        message: `${cause.message}${fixOf(cause, runtime)}; nothing was deployed`,
        primitive: cause.primitive,
        id: cause.id,
        ...(cause.endpointId !== undefined && { endpointId: cause.endpointId }),
        ...(cause.fields !== undefined && { fields: cause.fields }),
      },
      requestId,
    ),
  );
}

/** A project mismatch's fix, as ` (<fix>)`, when this runtime has one; else nothing. */
function fixOf(cause: PublishRefused, runtime: Parameters<typeof projectMismatchFix>[0]): string {
  if (!cause.code.endsWith('-project-mismatch')) return '';
  const fix = projectMismatchFix(runtime);
  return fix === undefined ? '' : ` (${fix})`;
}

function validationFailed(c: Context<AppEnv>, issues: readonly ValidationDetail[]) {
  c.status(statusFor('deployment-validation-failed') as never);
  return c.json(
    toWireError(
      {
        code: 'deployment-validation-failed',
        message: `Deployment manifest validation failed (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
        issues: issues as unknown as Record<string, unknown>[],
      },
      c.get('requestId'),
    ),
  );
}

/**
 * Each guardrail whose check runs in the pack (a module, not a built-in it
 * merely names) and whose check id doesn't start with the pack's id: the
 * issue the indexer warns about, refused where checks are routed by id.
 */
function unprefixedPackChecks(
  guardrails: readonly Guardrail[],
  packId: unknown,
): ValidationDetail[] {
  const issues: ValidationDetail[] = [];
  for (const [index, guardrail] of guardrails.entries()) {
    if (guardrail.codeArtifactRef === undefined || guardrail.checkBuiltIn === true) continue;
    const check = guardrail.check as unknown as string;
    if (typeof packId === 'string' && check.startsWith(`${packId}.`)) continue;
    issues.push({
      primitive: 'guardrail',
      index,
      id: guardrail.id as unknown as string,
      path: '/check',
      message:
        typeof packId === 'string'
          ? `check "${check}" doesn't start with this pack's id ("${packId}."). Name it "${packId}.checks.<name>": this runtime sends each check call to the deployment that shipped its id, so two packs' checks must never share one.`
          : `check "${check}" runs in the pack, but the image's index names no pack id. Build it again with a current CLI, which writes one.`,
    });
  }
  return issues;
}

/** The image's `/app/index.json` as an object, or `undefined` when it isn't one. */
function parseImageIndex(bytes: Uint8Array): Readonly<Record<string, unknown>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * Why the tenant may not deploy this image, or `undefined`: outside its
 * repository (`409 image-not-allowed`, naming only its own prefix), or, where
 * a prefix is required, none set (`409 image-prefix-unset`). A stored prefix
 * that doesn't parse refuses as unset: it fails closed.
 */
async function imagePrefixRefusal(
  prefixes: DeploymentImagePrefixes | undefined,
  tenantId: TenantId,
  imageRef: string,
): Promise<
  ({ readonly code: string; readonly message: string } & Record<string, unknown>) | undefined
> {
  if (prefixes === undefined) return undefined;
  const raw = await prefixes.of(tenantId);
  const prefix = raw === undefined ? undefined : parseImagePrefix(raw);
  if (prefix === undefined || prefix.kind === 'err') {
    if (raw === undefined && !prefixes.required) return undefined;
    return {
      code: 'image-prefix-unset',
      message:
        "This tenant has no image repository set, so it can't register a deployment yet: its operator sets one.",
    };
  }
  const ref = parseImageRef(imageRef);
  if (ref.kind === 'err') {
    return { code: 'bad-input', message: `imageRef is refused: ${ref.error.reason}` };
  }
  if (imageRefWithin(ref.value, prefix.value)) return undefined;
  return {
    code: 'image-not-allowed',
    message: `This tenant deploys only images at or under ${raw}.`,
    imagePrefix: raw,
  };
}

function extractImageDigest(imageRef: string): string | null {
  const at = imageRef.lastIndexOf('@');
  if (at < 0) return null;
  const digest = imageRef.slice(at + 1);
  if (!SHA256_PREFIX_RE.test(digest)) return null;
  return digest.toLowerCase();
}

// ------------------------------------------------------------
// Primitive validation
// ------------------------------------------------------------

interface ValidationDetail {
  readonly primitive: 'tool' | 'guardrail' | 'agent' | 'flow' | 'block';
  readonly index: number;
  readonly id?: string;
  readonly path: string;
  readonly message: string;
}

interface ValidatedPrimitives {
  readonly tools: readonly import('@kindgi/tools').ToolManifest[];
  readonly guardrails: readonly Guardrail[];
  readonly agents: readonly import('@kindgi/agents').Agent[];
  readonly flows: readonly import('@kindgi/flow').Flow[];
  /** The pack's data blocks (`blocks/`), each a valid block. */
  readonly blocks: readonly BlockDefinition[];
}

type ValidateResult =
  | { readonly kind: 'ok'; readonly value: ValidatedPrimitives }
  | { readonly kind: 'err'; readonly error: { readonly details: readonly ValidationDetail[] } };

/** The image a deployment's code lives in, for each primitive's `codeArtifactRef`. */
interface DeployedImage {
  readonly imageRef: string;
  readonly artifactVersion: string;
}

/**
 * A deploy keeps a guardrail id that's already live only when it's the
 * deploy's own: in the project the deploy registers into, with the same
 * definition (`sameGuardrailDefinition`, what its author declares). An id live in another project
 * is refused (`guardrail-project-mismatch`, its project never named): the
 * pack's agents would otherwise run that project's guardrail. One in this
 * project with another definition is refused too
 * (`guardrail-already-registered`): a deploy never changes a guardrail,
 * and keeping the old one would run what the pack no longer says.
 *
 * `get` answers a guardrail without its project, so whether the id is in
 * this project comes from the project's list. When the row is gone by the
 * time it's looked at (unregistered meanwhile), the guardrail is
 * registered again: `registered`, for the deploy to roll back. A kept one
 * comes back with the row as it is (`existing`).
 */
async function keepRegisteredGuardrail(
  registry: GuardrailRegistryBinding,
  orders: Pick<EnvironmentOrderBinding, 'orderOf'> | undefined,
  tenantId: TenantId,
  projectId: ProjectId,
  guardrail: Guardrail,
): Promise<
  { readonly kind: 'kept'; readonly existing: Guardrail } | { readonly kind: 'registered' }
> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await registry.get({ tenantId, guardrailId: guardrail.id });
    if (existing !== null) {
      if (!(await guardrailInOrder(registry, orders, tenantId, projectId, guardrail.id))) {
        throw new PublishRefused('guardrail', guardrail.id, {
          code: 'guardrail-project-mismatch',
          reason: PROJECT_MISMATCH,
        });
      }
      if (!sameGuardrailDefinition(existing, guardrail)) {
        throw new PublishRefused('guardrail', guardrail.id, {
          code: 'guardrail-already-registered',
          reason: `it is already registered with a different definition; unregister it (\`kindgi guardrails unregister ${guardrail.id}\`) and deploy again`,
        });
      }
      return { kind: 'kept', existing };
    }
    const again = await registry.register({
      tenantId,
      projectId,
      guardrail,
      enqueueTuples: (guardrailId) =>
        tuplesForCreate({
          kind: 'guardrail',
          id: guardrailId as GuardrailId,
          tenantId,
          projectId,
        }),
    });
    if (again.kind === 'ok') return { kind: 'registered' };
    if (again.kind !== 'already-registered') {
      throw new PublishRefused('guardrail', guardrail.id, again);
    }
  }
  throw new Error(`guardrail ${guardrail.id}: registered and unregistered while deploying`);
}

/**
 * A tool version a deploy finds already published gets this deploy's code
 * pointer (a new image of the same pack), when its registry can take it
 * (`refreshCodeArtifactRef`); rolling the deploy back puts the old one
 * back, unless another deploy has refreshed it since (compare-and-set on
 * this deploy's pointer). Without it, the version keeps its first
 * pointer, as before.
 */
async function refreshToolCode(
  registry: ToolRegistryBinding,
  tenantId: TenantId,
  tool: import('@kindgi/tools').ToolManifest,
  rolled: RollbackAction[],
): Promise<void> {
  const refresh = registry.refreshCodeArtifactRef?.bind(registry);
  if (refresh === undefined || tool.codeArtifactRef === undefined) return;
  const version = tool.version as unknown as Semver;
  const stored = await registry.getVersion({ tenantId, toolId: tool.id, version });
  if (stored === null) return;
  const was = stored.codeArtifactRef ?? null;
  if (canonicalJson(was) === canonicalJson(tool.codeArtifactRef)) return;
  const now = tool.codeArtifactRef;
  const done = await refresh({ tenantId, toolId: tool.id, version, codeArtifactRef: now });
  if (!done.refreshed) return;
  // Only while it still points where this deploy put it.
  rolled.push({
    primitive: 'tool',
    id: `${tool.id}@${tool.version}`,
    undo: 'put back the code pointer of',
    run: async () => {
      await refresh({ tenantId, toolId: tool.id, version, codeArtifactRef: was, expected: now });
    },
  });
}

/**
 * A tool version a deploy finds already published but unregistered is
 * reinstated. Version numbers are single-use (`publish`), so the registry
 * won't take it again, and without it the agents and flows that use the
 * tool find no published version: a deploy that failed after its tool
 * publish unregistered it rolling back, and the same image was refused
 * from then on, until its pack was rebuilt under a new version. Rolling
 * this deploy back unregisters it again.
 *
 * Only a version its registry lists as unregistered (`unregisteredAt`) is
 * reinstated, under the rule reinstating it by hand holds
 * (`POST /v1/tools/{toolId}/versions/{version}/reinstate`): the stored
 * version is what comes back. It's the pack's tool, as the deploy keeps a
 * version only with the pack's definition (`deploy-tools.ts`), so one
 * naming a model provider's key never gets here: the pack's own check
 * refused it before any write. One of another kind than the tool's
 * active versions stays unregistered, refused as publishing it is
 * (`tool-kind-mismatch`).
 */
async function reinstateRetiredTool(
  registry: ToolRegistryBinding,
  tenantId: TenantId,
  tool: import('@kindgi/tools').ToolManifest,
  rolled: RollbackAction[],
): Promise<void> {
  const toolId = tool.id;
  const version = tool.version as unknown as Semver;
  const retired = await unregisteredVersion(registry, tenantId, toolId, version);
  if (retired === undefined) return;
  const outcome = await registry.reinstateVersion({ tenantId, toolId, version });
  if (outcome.kind === 'not-found') {
    throw new Error(
      `tool ${toolId as unknown as string}@${tool.version}: its registry lists the version as unregistered, then answered not-found reinstating it`,
    );
  }
  if (outcome.kind === 'kind-mismatch') {
    throw new PublishRefused('tool', `${tool.id}@${tool.version}`, outcome);
  }
  // Reinstated since the registry listed it: nothing of this deploy's to undo.
  if (!outcome.wasTombstoned) return;
  rolled.push({
    primitive: 'tool',
    id: `${toolId}@${version}`,
    undo: 'unregister',
    run: async () => {
      await registry.unregister({ tenantId, toolId, version });
    },
  });
}

/** `toolId@version` as its registry lists it, when it's unregistered. */
async function unregisteredVersion(
  registry: ToolRegistryBinding,
  tenantId: TenantId,
  toolId: ToolId,
  version: Semver,
): Promise<ToolVersionRow | undefined> {
  let cursor: Cursor | undefined;
  do {
    const page = await registry.listVersions({
      tenantId,
      toolId,
      includeTombstoned: true,
      limit: 100,
      ...(cursor !== undefined && { cursor }),
    });
    const row = page.data.find((v) => v.version === version);
    if (row !== undefined) return row.unregisteredAt !== undefined ? row : undefined;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return undefined;
}

/**
 * An agent or flow version a deploy finds already published but
 * unregistered is reinstated, where the deploy registers its agents and
 * flows unpinned (without a tool registry), as `reinstateRetiredTool`
 * reinstates a tool's: version numbers are single-use, so without it the
 * deploy lands with that agent or flow still unregistered. Pinned, a
 * deploy registers the next free version instead (`deployVersion`).
 * Answers whether this deploy reinstated it, so that rolling the deploy
 * back unregisters it again.
 *
 * Only a version its registry reads as unregistered (`unregisteredAt`) is
 * reinstated, under the rule reinstating it by hand holds
 * (`POST /v1/agents/{agentId}/versions/{version}/reinstate`, and flows'):
 * the stored version is what comes back, and its references are asked as
 * at publish, so one naming what its project doesn't reach stays
 * unregistered (`RetiredVersionOutOfScope`).
 */
async function reinstateRetiredVersion<
  Stored extends { readonly unregisteredAt?: string; readonly projectId?: ProjectId },
>(input: {
  readonly primitive: 'agent' | 'flow';
  readonly id: string;
  readonly version: string;
  /** Where the pack names it (`/agents/0`), for the refusal's issues. */
  readonly path: string;
  readonly tenantId: TenantId;
  readonly referenceScope: ReferenceScopeBinding | undefined;
  readonly read: () => Promise<Stored | null>;
  readonly referencesOf: (stored: Stored) => readonly (ItemReference & { readonly path: string })[];
  readonly reinstate: () => Promise<
    { readonly kind: 'ok'; readonly wasTombstoned: boolean } | { readonly kind: 'not-found' }
  >;
}): Promise<boolean> {
  const { primitive, version } = input;
  const retired = await input.read();
  if (retired?.unregisteredAt === undefined) return false;
  if (retired.projectId !== undefined) {
    const outOfScope = await referencesOutOfScope(
      input.referenceScope,
      input.tenantId,
      retired.projectId,
      input.referencesOf(retired),
    );
    if (outOfScope !== undefined) {
      throw new RetiredVersionOutOfScope({
        ...outOfScope,
        issues: outOfScope.issues.map((issue) => ({
          ...issue,
          path: input.path,
          message: `version ${version} of this ${primitive} is unregistered and can't be reinstated: ${issue.message}. Publish the ${primitive} under a new version`,
        })),
      });
    }
  }
  const outcome = await input.reinstate();
  if (outcome.kind === 'not-found') {
    throw new Error(
      `${primitive} ${input.id}@${version}: its registry reads the version as unregistered, then answered not-found reinstating it`,
    );
  }
  // Reinstated since the registry read it: nothing of this deploy's to undo.
  return outcome.wasTombstoned;
}

/**
 * A guardrail a deploy keeps gets what this deploy derived for it: its
 * code pointer and its check's config schema, when its registry can take
 * them (`refreshDeployedFields`); rolling the deploy back restores the old
 * ones, unless another deploy has refreshed them since (compare-and-set on
 * what this deploy wrote). Without it, the guardrail keeps what its first
 * deploy derived.
 */
async function refreshGuardrailFields(
  registry: GuardrailRegistryBinding,
  tenantId: TenantId,
  guardrail: Guardrail,
  existing: Guardrail,
  rolled: RollbackAction[],
): Promise<void> {
  const refresh = registry.refreshDeployedFields?.bind(registry);
  if (refresh === undefined) return;
  const now = {
    codeArtifactRef: guardrail.codeArtifactRef ?? null,
    configSchema: guardrail.configSchema ?? null,
  };
  const was = {
    codeArtifactRef: existing.codeArtifactRef ?? null,
    configSchema: existing.configSchema ?? null,
  };
  if (canonicalJson(now) === canonicalJson(was)) return;
  const done = await refresh({ tenantId, guardrailId: guardrail.id, ...now });
  if (!done.refreshed) return;
  // Only while it still holds what this deploy gave it.
  rolled.push({
    primitive: 'guardrail',
    id: guardrail.id,
    undo: 'put back the code pointer and config schema of',
    run: async () => {
      await refresh({ tenantId, guardrailId: guardrail.id, ...was, expected: now });
    },
  });
}

/**
 * Whether the live guardrail `id` is in `projectId`, or in another project
 * of its environment order: an order's projects keep one guardrail, as
 * they keep one agent (a deploy never changes a guardrail, so what each
 * environment runs is the same definition).
 */
async function guardrailInOrder(
  registry: GuardrailRegistryBinding,
  orders: Pick<EnvironmentOrderBinding, 'orderOf'> | undefined,
  tenantId: TenantId,
  projectId: ProjectId,
  id: GuardrailId,
): Promise<boolean> {
  const projects = (await orders?.orderOf({ tenantId, projectId }))?.projects ?? [projectId];
  for (const project of projects) {
    if (await guardrailInProject(registry, tenantId, project, id)) return true;
  }
  return false;
}

/** Whether the live guardrail `id` is in `projectId`, by that project's list. */
async function guardrailInProject(
  registry: GuardrailRegistryBinding,
  tenantId: TenantId,
  projectId: ProjectId,
  id: GuardrailId,
): Promise<boolean> {
  let cursor: Cursor | undefined;
  do {
    const page = await registry.list({
      tenantId,
      limit: 100,
      nameFilter: id,
      scope: { kind: 'project', tenantId, projectId },
      ...(cursor !== undefined && { cursor }),
    });
    if (page.data.some((g) => g.id === id)) return true;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return false;
}

/**
 * The fields of a guardrail its author declares, which a deploy compares.
 * Never compared: what a deploy or a release derives. That includes
 * `configSchema`, which the deploy route dropped before 0.1.5, so a row a
 * 0.1.4 deploy stored has none; the image and artifact version a code
 * pointer names, which every new image changes; and any field a later
 * release adds. So an unchanged pack redeploys across releases.
 */
const DECLARED_GUARDRAIL_FIELDS = [
  'name',
  'description',
  'kind',
  'check',
  'config',
  'action',
  'severity',
  'scope',
  'budget',
  'judgeCapabilities',
  'sandbox',
  'limits',
  'network',
  'needsSpec',
] as const;

/**
 * The same guardrail definition: equal in what its author declares
 * (`DECLARED_GUARDRAIL_FIELDS`, and of where its code lives only the
 * module path), as JSON with keys in any order (a registry may store it as
 * JSONB) and an absent field the same as an `undefined` one.
 */
export function sameGuardrailDefinition(a: Guardrail, b: Guardrail): boolean {
  return canonicalJson(definitionOf(a)) === canonicalJson(definitionOf(b));
}

function definitionOf(guardrail: Guardrail): Record<string, unknown> {
  const declared: Record<string, unknown> = {};
  for (const field of DECLARED_GUARDRAIL_FIELDS) {
    declared[field] = (guardrail as unknown as Record<string, unknown>)[field];
  }
  declared.modulePath = guardrail.codeArtifactRef?.modulePath;
  return declared;
}

/** The pointer to a tool's or guardrail's module inside the deployed image. */
function ociCodeArtifactRef(image: DeployedImage, modulePath: unknown) {
  return typeof modulePath === 'string' && modulePath.length > 0
    ? {
        codeArtifactRef: {
          kind: 'oci' as const,
          imageRef: image.imageRef,
          modulePath,
          artifactVersion: image.artifactVersion,
        },
      }
    : {};
}

/**
 * Validate the index's primitives as the registries store them. Tools
 * and guardrails keep where their code is (`codeArtifactRef`, an `oci`
 * pointer into the deployed image) in place of the index's module path;
 * a guardrail's `checkId` becomes its `check`, as `kindgi dev`'s disk
 * registry maps it.
 */
/** The built-in checks, for the config of a guardrail naming one. */
const builtInChecks = createCheckRegistry();

function validatePrimitives(
  index: Readonly<Record<string, unknown>>,
  image: DeployedImage,
  log?: { debug(message: string): void },
): ValidateResult {
  const details: ValidationDetail[] = [];

  const tools = readArray(index.tools);
  const guardrails = readArray(index.guardrails);
  const agents = readArray(index.agents);
  const flows = readArray(index.flows);
  const blocks = readArray(index.blocks);

  const validatedTools: import('@kindgi/tools').ToolManifest[] = [];
  tools.forEach((raw, i) => {
    if (raw === null || typeof raw !== 'object') {
      details.push({ primitive: 'tool', index: i, path: '', message: 'must be an object' });
      return;
    }
    const { modulePath, ...manifest } = raw as Record<string, unknown>;
    const r = validateToolManifest({ ...manifest, ...ociCodeArtifactRef(image, modulePath) });
    if (r.kind === 'err') {
      const err = r.error as {
        message: string;
        issues?: readonly { path: string; message: string }[];
      };
      const rawId = (raw as { id?: unknown }).id;
      const idBase: Partial<ValidationDetail> = typeof rawId === 'string' ? { id: rawId } : {};
      if (err.issues && err.issues.length > 0) {
        for (const issue of err.issues) {
          details.push({
            primitive: 'tool',
            index: i,
            ...idBase,
            path: issue.path,
            message: issue.message,
          });
        }
      } else {
        details.push({ primitive: 'tool', index: i, ...idBase, path: '', message: err.message });
      }
      return;
    }
    const reserved = reservedToolMetadataKeys(r.value.metadata);
    if (reserved.length > 0) {
      for (const key of reserved) {
        details.push({
          primitive: 'tool',
          index: i,
          id: r.value.id as unknown as string,
          path: `/metadata/${key}`,
          message: reservedToolMetadataMessage(key),
        });
      }
      return;
    }
    validatedTools.push(r.value);
  });

  const validatedGuardrails: Guardrail[] = [];
  guardrails.forEach((raw, i) => {
    if (raw === null || typeof raw !== 'object') {
      details.push({ primitive: 'guardrail', index: i, path: '', message: 'must be an object' });
      return;
    }
    // The rest is the guardrail as registered, its `configSchema` included:
    // the runtime checks a guardrail naming this check against it. A field
    // the guardrail spec doesn't have (an index from a newer CLI) is dropped,
    // never refused, so a newer CLI never breaks a deployment.
    const { checkModulePath, checkId, ...indexed } = raw as Record<string, unknown>;
    const dropped = Object.keys(indexed).filter((k) => !GUARDRAIL_SPEC_KEYS.includes(k));
    const rest = Object.fromEntries(
      Object.entries(indexed).filter(([k]) => GUARDRAIL_SPEC_KEYS.includes(k)),
    );
    if (dropped.length > 0) {
      log?.debug(
        `deployment: guardrail ${String(indexed.id)}: ignored index field(s) this runtime doesn't know: ${dropped.join(', ')}`,
      );
    }
    const r = validateGuardrailSpec({
      ...rest,
      check: checkId ?? rest.check ?? rest.id,
      ...ociCodeArtifactRef(image, checkModulePath),
    });
    if (r.kind === 'err') {
      const err = r.error as {
        message: string;
        issues?: readonly { path: string; message: string }[];
      };
      const rawId = (raw as { id?: unknown }).id;
      const idBase: Partial<ValidationDetail> = typeof rawId === 'string' ? { id: rawId } : {};
      if (err.issues && err.issues.length > 0) {
        for (const issue of err.issues) {
          details.push({
            primitive: 'guardrail',
            index: i,
            ...idBase,
            path: issue.path,
            message: issue.message,
          });
        }
      } else {
        details.push({
          primitive: 'guardrail',
          index: i,
          ...idBase,
          path: '',
          message: err.message,
        });
      }
      return;
    }
    // A guardrail naming a built-in check: its config against the built-in's.
    const builtIn = builtInChecks.get(r.value.check);
    const configProblems = builtIn?.configProblems?.(r.value.config) ?? [];
    if (configProblems.length > 0) {
      for (const problem of configProblems) {
        details.push({
          primitive: 'guardrail',
          index: i,
          id: r.value.id as unknown as string,
          path: problem.path,
          message: problem.message,
        });
      }
      return;
    }
    validatedGuardrails.push(r.value);
  });

  const validatedAgents: import('@kindgi/agents').Agent[] = [];
  agents.forEach((raw, i) => {
    if (raw === null || typeof raw !== 'object') {
      details.push({ primitive: 'agent', index: i, path: '', message: 'must be an object' });
      return;
    }
    const { modulePath: _mp, ...spec } = raw as Record<string, unknown>;
    const shapeIssues = validateAgentIndexShape(spec);
    if (shapeIssues.length > 0) {
      const rawId = (spec as { id?: unknown }).id;
      const idBase: Partial<ValidationDetail> = typeof rawId === 'string' ? { id: rawId } : {};
      for (const issue of shapeIssues) {
        details.push({ primitive: 'agent', index: i, ...idBase, ...issue });
      }
      return;
    }
    validatedAgents.push(spec as unknown as import('@kindgi/agents').Agent);
  });

  const validatedGraphs: import('@kindgi/flow').Flow[] = [];
  flows.forEach((raw, i) => {
    if (raw === null || typeof raw !== 'object') {
      details.push({ primitive: 'flow', index: i, path: '', message: 'must be an object' });
      return;
    }
    const { modulePath: _mp, kernelPayloadVersion: _kpv, ...spec } = raw as Record<string, unknown>;
    const shapeIssues = validateFlowIndexShape(spec);
    if (shapeIssues.length > 0) {
      const rawId = (spec as { id?: unknown }).id;
      const idBase: Partial<ValidationDetail> = typeof rawId === 'string' ? { id: rawId } : {};
      for (const issue of shapeIssues) {
        details.push({ primitive: 'flow', index: i, ...idBase, ...issue });
      }
      return;
    }
    validatedGraphs.push(spec as unknown as import('@kindgi/flow').Flow);
  });

  const validatedBlocks: BlockDefinition[] = [];
  blocks.forEach((raw, i) => {
    if (raw === null || typeof raw !== 'object') {
      details.push({ primitive: 'block', index: i, path: '', message: 'must be an object' });
      return;
    }
    // Its file in the pack (`modulePath`) is where the pack keeps it, not part of the block.
    const { modulePath: _mp, ...definition } = raw as Record<string, unknown>;
    const r = validateBlock(definition);
    if (r.kind === 'err') {
      const idBase: Partial<ValidationDetail> =
        typeof definition.id === 'string' ? { id: definition.id } : {};
      const issues =
        r.error.issues.length > 0 ? r.error.issues : [{ path: '', message: r.error.message }];
      for (const issue of issues) {
        details.push({
          primitive: 'block',
          index: i,
          ...idBase,
          path: issue.path,
          message: issue.message,
        });
      }
      return;
    }
    validatedBlocks.push(r.value);
  });

  if (details.length > 0) {
    return { kind: 'err', error: { details } };
  }
  return {
    kind: 'ok',
    value: {
      tools: validatedTools,
      guardrails: validatedGuardrails,
      agents: validatedAgents,
      flows: validatedGraphs,
      blocks: validatedBlocks,
    },
  };
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Minimal shape check on an `IndexedAgent` after `modulePath` is
 * stripped, plus what would fail every turn: the instructions' template
 * and the output schema, checked as `defineAgent` checks them. Deeper
 * validation (RetrievalIntent shape, budget arithmetic, conversation
 * policy tri-state) is left to the runtime at dispatch — the deploy
 * route only validates that the wire is well-shaped enough to persist.
 * The alternative is running `defineAgent`, but that requires promoting
 * `capabilities`/`tools` to their branded shapes; the pattern across the
 * API package is to keep transport shape checks lightweight and leave
 * semantic checks to the runtime.
 */
function validateAgentIndexShape(
  spec: Record<string, unknown>,
): readonly { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (typeof spec.id !== 'string' || (spec.id as string).length === 0) {
    out.push({ path: '/id', message: 'agent.id must be a non-empty string' });
  }
  if (typeof spec.version !== 'string' || !SEMVER_RE.test(spec.version as string)) {
    out.push({ path: '/version', message: 'agent.version must be semver' });
  }
  if (typeof spec.name !== 'string' || (spec.name as string).length === 0) {
    out.push({ path: '/name', message: 'agent.name must be a non-empty string' });
  }
  const instructions = spec.instructions as { prompt?: unknown; version?: unknown } | string;
  const promptRef =
    typeof instructions === 'object' &&
    instructions !== null &&
    typeof instructions.prompt === 'string' &&
    typeof instructions.version === 'string';
  if (!promptRef && (typeof instructions !== 'string' || instructions.length === 0)) {
    out.push({
      path: '/instructions',
      message:
        'agent.instructions must be a non-empty string, or a prompt block { prompt, version }',
    });
  } else if (typeof instructions === 'string') {
    // The check `defineAgent` and a prompt block's publish run too.
    const problem = templateProblem(instructions);
    if (problem !== undefined) out.push({ path: '/instructions', message: problem });
  }
  if (!Array.isArray(spec.capabilities)) {
    out.push({ path: '/capabilities', message: 'agent.capabilities must be an array' });
  }
  if (!Array.isArray(spec.tools)) {
    out.push({ path: '/tools', message: 'agent.tools must be an array of tool ids' });
  }
  out.push(...agentOutputProblems(spec.output));
  if (spec.parallelToolCalls !== undefined && typeof spec.parallelToolCalls !== 'boolean') {
    out.push({
      path: '/parallelToolCalls',
      message: 'agent.parallelToolCalls must be true or false',
    });
  }
  return out;
}

/** An agent's `output`, when it has one: an object whose schema compiles. */
function agentOutputProblems(raw: unknown): readonly { path: string; message: string }[] {
  if (raw === undefined) return [];
  const output = raw as { schema?: unknown } | null;
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return [
      { path: '/output', message: 'agent.output must be an object { schema, name?, maxRepairs? }' },
    ];
  }
  // The compile `defineAgent` runs, and each structured turn after it:
  // one that doesn't compile would fail every turn.
  const compiled = compileInlineSchema(output.schema);
  if (compiled.kind === 'ok') return [];
  const why = compiled.error.message.replace(/^Inline schema failed to compile: /, '');
  return [{ path: '/output/schema', message: `doesn't compile: ${why}` }];
}

/**
 * Minimal shape check on an `IndexedFlow` after `modulePath` and
 * `kernelPayloadVersion` are stripped, and every inline schema a run
 * compiles (`flowSchemaProblems`): one that doesn't compile would fail
 * every run. The rest of `loadFlow` isn't run: it refuses fields it
 * doesn't know, and an index from a newer CLI may carry some.
 */
function validateFlowIndexShape(
  spec: Record<string, unknown>,
): readonly { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  if (typeof spec.id !== 'string' || (spec.id as string).length === 0) {
    out.push({ path: '/id', message: 'flow.id must be a non-empty string' });
  }
  if (typeof spec.version !== 'string' || !SEMVER_RE.test(spec.version as string)) {
    out.push({ path: '/version', message: 'flow.version must be semver' });
  }
  if (!Array.isArray(spec.nodes)) {
    out.push({ path: '/nodes', message: 'flow.nodes must be an array' });
  }
  if (!Array.isArray(spec.edges)) {
    out.push({ path: '/edges', message: 'flow.edges must be an array' });
  }
  out.push(...flowSchemaProblems(spec));
  return out;
}

// ------------------------------------------------------------
// Rollback / serialisation
// ------------------------------------------------------------

/**
 * A write a deploy made, and how to undo it should the deploy fail
 * (`rollback`), named for the warn when the undo fails.
 */
export interface RollbackAction {
  readonly primitive: 'tool' | 'guardrail' | 'agent' | 'flow' | 'block';
  /** `id@version`, or a guardrail's id. */
  readonly id: string;
  /** What `run` does to it, as the warn says it: `unregister`, `put back the code pointer of`. */
  readonly undo: string;
  readonly run: () => Promise<void>;
}

/** The refusal of a deploy whose agents or flows use versions nothing published takes. */
function unpinnableResponse(
  c: Context<AppEnv>,
  requestId: string,
  issues: readonly UnpinnableRef[],
) {
  c.status(statusFor('invalid-agent') as never);
  return c.json(
    toWireError(
      {
        code: 'validation-failed',
        message: `The deployment's agents or flows use tool, agent, block or sub-flow versions that can't be pinned (${issues.length} issue${issues.length === 1 ? '' : 's'}); nothing was deployed`,
        issues: issues as unknown as Record<string, unknown>[],
      },
      requestId,
    ),
  );
}

/** A deploy whose agents or flows use a tool or agent with no published version in range. */
class UnpinnableDeploy extends Error {
  constructor(readonly issues: readonly UnpinnableRef[]) {
    super('the deployment uses tools, agents or sub-flows that can not be pinned');
  }
}

/** An agent or flow version a deploy found unregistered and may not reinstate (`reinstateRetiredVersion`). */
class RetiredVersionOutOfScope extends Error {
  constructor(readonly refusal: ReferenceOutOfScopeError) {
    super(refusal.message);
  }
}

/** A deployed agent or flow registered under its definition's version. */
function deployedPrimitive(definition: { readonly id: string; readonly version: string }): {
  id: string;
  version: string;
} {
  return { id: definition.id, version: definition.version };
}

/** A deployed agent or flow, under the version the deploy rule registered it as. */
function deployedVersion(
  definition: { readonly id: string; readonly version: string },
  outcome: DeployedVersionOutcome,
): DeployedVersion {
  return outcome.kind === 'reused' || outcome.kind === 'renumbered'
    ? {
        id: definition.id,
        version: outcome.version,
        authoredVersion: definition.version,
        reason: outcome.reason,
        newVersion: outcome.kind === 'renumbered',
        ...(outcome.pinChanges !== undefined && { pinChanges: outcome.pinChanges }),
      }
    : deployedPrimitive(definition);
}

/**
 * Register a deployment's agents, each under the version it's registered
 * as (`DeployedAgent`), pushing a rollback for each version it writes.
 *
 * With a tool registry, every agent is pinned first (the pack's tools
 * are registered by now, and its data blocks were pinned before the
 * deploy wrote anything): one whose range matches no published version
 * throws `UnpinnableDeploy` before any agent is written, and the deploy
 * rolls back. Each is then registered by `publishDeployedAgent`, which
 * never keeps a version's old pins. Without one, agents register
 * unpinned, as before pins existed.
 */
async function registerAgents(input: {
  readonly agents: AgentRegistryBinding;
  readonly tools: ToolRegistryBinding | undefined;
  /** Each agent's data-block pins (`pinBlocks`); undefined without a tool registry. */
  readonly blockPins: readonly BlockPins[] | undefined;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly defined: readonly Agent[];
  /** What a reinstated version's references are asked of (`reinstateRetiredVersion`). */
  readonly referenceScope: ReferenceScopeBinding | undefined;
  readonly rolled: RollbackAction[];
}): Promise<DeployedAgent[]> {
  const { agents, tools, blockPins, tenantId, projectId, rolled } = input;
  // Signed deploys have no per-request principal — pass parent-only
  // tuples (no owner grant). Tenant admins keep access via
  // `admin from parent` cascade.
  const enqueueTuples = (agentId: string) =>
    tuplesForCreate({ kind: 'agent', id: agentId as AgentId, tenantId, projectId });
  const written = (agentId: AgentId, version: Semver) =>
    rolled.push({
      primitive: 'agent',
      id: `${agentId}@${version}`,
      undo: 'unregister',
      run: async () => {
        await agents.unregister({ tenantId, agentId, version });
      },
    });

  if (tools === undefined || blockPins === undefined) {
    for (const [index, agent] of input.defined.entries()) {
      const outcome = await agents.publish({ tenantId, projectId, agent, enqueueTuples });
      if (outcome.kind === 'ok') written(outcome.agentId, outcome.version);
      else if (outcome.kind === 'already-registered') {
        const agentId = agent.id;
        const version = agent.version;
        const reinstated = await reinstateRetiredVersion({
          primitive: 'agent',
          id: agentId as unknown as string,
          version: version as unknown as string,
          path: `/agents/${index}`,
          tenantId,
          referenceScope: input.referenceScope,
          read: () => agents.getVersion({ tenantId, agentId, version }),
          referencesOf: agentReferences,
          reinstate: () => agents.reinstateVersion({ tenantId, agentId, version }),
        });
        if (reinstated) written(agentId, version);
      } else {
        throw new PublishRefused('agent', `${agent.id}@${agent.version}`, outcome);
      }
    }
    return input.defined.map(deployedPrimitive);
  }

  const pinsOf = await pinAgents(tools, blockPins, tenantId, input.defined);
  const deployed: DeployedAgent[] = [];
  for (const [i, agent] of input.defined.entries()) {
    const pins = pinsOf[i] as AgentPins;
    const outcome = await publishDeployedAgent({
      agents,
      tenantId,
      projectId,
      agent,
      pins,
      enqueueTuples,
    });
    if (outcome.kind === 'registered' || outcome.kind === 'renumbered') {
      written(agent.id, outcome.version as unknown as Semver);
    }
    deployed.push(deployedVersion(agent, outcome));
  }
  return deployed;
}

/**
 * Register a deployment's flows, each under the version it's registered
 * as, pushing a rollback for each version it writes. Runs after the
 * agents, so a flow's agent pins see the versions this deploy
 * registered: a tool change cascades through an agent into a flow
 * within the one deploy, each derived once. An agent step that names no
 * version pins what a run in the project gets: the agent's live version
 * there, with `live`, else the latest (this deploy's, when it registered
 * one).
 *
 * A sub-flow step that names no version pins the newest version of its
 * flow the project reaches. A flow the deploy brings registers before
 * the flows that run it that way, so their pins see the version this
 * deploy registered, and a change cascades through a sub-flow into its
 * parent as it does through an agent. Flows of the deploy that run each
 * other that way have no such order, and are refused.
 *
 * With the tool and agent registries, every flow is pinned first, all
 * but its sub-flows from this deploy; one with something it can't pin
 * throws `UnpinnableDeploy` before any flow is written, and the deploy
 * rolls back. Without them, flows register unpinned, as before pins
 * existed, and a flow with a sub-flow step that names no version throws
 * `UnpinnableDeploy` first (`unnamedSubflowIssues`): nothing would fix its
 * child's version.
 */
async function registerFlows(input: {
  readonly flows: FlowRegistryBinding;
  readonly tools: ToolRegistryBinding | undefined;
  readonly agents: AgentRegistryBinding | undefined;
  readonly live?: LiveVersionBinding;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly defined: readonly Flow[];
  /** What a reinstated version's references are asked of (`reinstateRetiredVersion`). */
  readonly referenceScope: ReferenceScopeBinding | undefined;
  readonly rolled: RollbackAction[];
}): Promise<DeployedFlow[]> {
  const { flows, tools, agents, live, referenceScope, tenantId, projectId, rolled } = input;
  const enqueueTuples = (flowId: string) =>
    tuplesForCreate({ kind: 'flow', id: flowId as FlowId, tenantId, projectId });
  const written = (flowId: FlowId, version: string) =>
    rolled.push({
      primitive: 'flow',
      id: `${flowId}@${version}`,
      undo: 'unregister',
      run: async () => {
        await flows.unregister({ tenantId, flowId, version: version as never });
      },
    });

  if (tools === undefined || agents === undefined) {
    const unnamed = input.defined.flatMap((flow, i) =>
      unnamedSubflowIssues(flow).map((issue) => ({
        path: `/flows/${i}${issue.path}`,
        message: `flow "${flow.id as unknown as string}": ${issue.message}`,
      })),
    );
    if (unnamed.length > 0) throw new UnpinnableDeploy(unnamed);
    for (const [index, flow] of input.defined.entries()) {
      const outcome = await flows.publish({ tenantId, projectId, flow, enqueueTuples });
      if (outcome.kind === 'ok') written(outcome.flowId, outcome.version as unknown as string);
      else if (outcome.kind === 'already-registered') {
        const flowId = flow.id;
        const version = flow.version;
        const reinstated = await reinstateRetiredVersion({
          primitive: 'flow',
          id: flowId as unknown as string,
          version,
          path: `/flows/${index}`,
          tenantId,
          referenceScope: input.referenceScope,
          read: () => flows.getVersion({ tenantId, flowId, version }),
          referencesOf: flowReferences,
          reinstate: () => flows.reinstateVersion({ tenantId, flowId, version }),
        });
        if (reinstated) written(flowId, version);
      } else {
        throw new PublishRefused('flow', `${flow.id}@${flow.version}`, outcome);
      }
    }
    return input.defined.map(deployedPrimitive);
  }

  const order = childrenFirst(input.defined);
  if (order.kind === 'cycle') throw new UnpinnableDeploy([order.issue]);
  const subflows: FlowPinsSubflows = {
    flows,
    ...(referenceScope !== undefined && { referenceScope }),
    projectId,
    deferred: new Set(input.defined.map((flow) => flow.id as unknown as string)),
  };
  const pinsOf = await pinFlows(
    tools,
    agents,
    tenantId,
    input.defined,
    live !== undefined ? { binding: live, projectId } : undefined,
    subflows,
  );
  const deployed: DeployedFlow[] = [];
  for (const i of order.indices) {
    const flow = input.defined[i] as Flow;
    const pins = await withDeployedSubflows(subflows, tenantId, i, flow, pinsOf[i] as FlowPins);
    const outcome = await publishDeployedFlow({
      flows,
      tenantId,
      projectId,
      flow,
      pins,
      enqueueTuples,
    });
    if (outcome.kind === 'registered' || outcome.kind === 'renumbered') {
      written(flow.id, outcome.version);
    }
    deployed[i] = deployedVersion(flow, outcome);
  }
  return deployed;
}

/**
 * The order to register a deploy's flows in: a flow after every flow of
 * the deploy it runs as a sub-flow at no named version (a named version
 * needs no order, and a flow running itself is `resolveFlowPins`'s to
 * refuse). Otherwise the deploy's own order. A cycle among them is
 * refused, naming it.
 */
function childrenFirst(
  defined: readonly Flow[],
):
  | { readonly kind: 'ok'; readonly indices: readonly number[] }
  | { readonly kind: 'cycle'; readonly issue: UnpinnableRef } {
  const at = new Map(defined.map((flow, i) => [flow.id as unknown as string, i]));
  const children = defined.map((flow) =>
    flowRefs(flow).flows.flatMap((id) => {
      const child = at.get(id);
      return child === undefined || id === (flow.id as unknown as string) ? [] : [child];
    }),
  );
  const indices: number[] = [];
  const state = new Map<number, 'visiting' | 'done'>();
  const visit = (i: number, path: readonly number[]): readonly number[] | undefined => {
    if (state.get(i) === 'done') return undefined;
    if (state.get(i) === 'visiting') return [...path.slice(path.indexOf(i)), i];
    state.set(i, 'visiting');
    for (const child of children[i] ?? []) {
      const cycle = visit(child, [...path, i]);
      if (cycle !== undefined) return cycle;
    }
    state.set(i, 'done');
    indices.push(i);
    return undefined;
  };
  for (const i of defined.keys()) {
    const cycle = visit(i, []);
    if (cycle === undefined) continue;
    const names = cycle.map((k) => `"${defined[k]?.id as unknown as string}"`).join(' → ');
    return {
      kind: 'cycle',
      issue: {
        path: `/flows/${cycle[0]}`,
        message: `flows ${names} run each other as sub-flows with no version, so neither can be pinned first; name the version in one of them`,
      },
    };
  }
  return { kind: 'ok', indices };
}

/**
 * Flow `i`'s pins with its sub-flows from this deploy pinned, now that
 * the deploy has registered them (`childrenFirst`): the newest version of
 * each the project reaches, as at any publish. One the deploy registered
 * is reached, so this throws `UnpinnableDeploy` only when the registry
 * says otherwise.
 */
async function withDeployedSubflows(
  subflows: FlowPinsSubflows,
  tenantId: TenantId,
  i: number,
  flow: Flow,
  pins: FlowPins,
): Promise<FlowPins> {
  const own = flowRefs(flow).flows.filter(
    (id) => subflows.deferred?.has(id) === true && id !== (flow.id as unknown as string),
  );
  if (own.length === 0) return pins;
  const pinned: Record<string, string> = { ...(pins.flows ?? {}) };
  for (const id of own) {
    const version = await implicitSubflowVersion(subflows, tenantId, id);
    if (version === undefined) {
      throw new UnpinnableDeploy([
        {
          path: `/flows/${i}/nodes`,
          message: `flow "${flow.id as unknown as string}": flow "${id}" has no published version this project runs; publish it first`,
        },
      ]);
    }
    pinned[id] = version;
  }
  return { ...pins, flows: pinned };
}

/** Each flow's pins, in order, all but its sub-flows from this deploy; throws `UnpinnableDeploy` naming everything it can't pin. */
async function pinFlows(
  tools: ToolRegistryBinding,
  agents: AgentRegistryBinding,
  tenantId: TenantId,
  defined: readonly Flow[],
  live: FlowPinsLive | undefined,
  subflows: FlowPinsSubflows,
): Promise<FlowPins[]> {
  const pins: FlowPins[] = [];
  const unpinnable: UnpinnableRef[] = [];
  for (const [i, flow] of defined.entries()) {
    const resolved = await resolveFlowPins(tools, agents, tenantId, flow, live, subflows);
    if (resolved.kind === 'ok') {
      pins.push(resolved.pins);
      continue;
    }
    for (const issue of resolved.issues) {
      unpinnable.push({
        path: `/flows/${i}${issue.path}`,
        message: `flow "${flow.id as unknown as string}": ${issue.message}`,
      });
    }
  }
  if (unpinnable.length > 0) throw new UnpinnableDeploy(unpinnable);
  return pins;
}

/**
 * Each agent's data-block pins, in order (`resolveBlockPins`), a block
 * the pack brings at the pack's version; `pinAgents` reports their issues.
 */
async function pinBlocks(
  blocks: BlockVersionReads | undefined,
  tenantId: TenantId,
  defined: readonly Agent[],
  pack: ReadonlyMap<string, string>,
): Promise<BlockPins[]> {
  const pins: BlockPins[] = [];
  for (const agent of defined) pins.push(await resolveBlockPins(blocks, tenantId, agent, pack));
  return pins;
}

/** Each agent's pins, in order; throws `UnpinnableDeploy` naming every range that matches nothing. */
async function pinAgents(
  tools: ToolRegistryBinding,
  blockPins: readonly BlockPins[],
  tenantId: TenantId,
  defined: readonly Agent[],
): Promise<AgentPins[]> {
  const pins: AgentPins[] = [];
  const unpinnable: UnpinnableRef[] = [];
  for (const [i, agent] of defined.entries()) {
    const resolved = await resolveAgentPins(
      tools,
      tenantId,
      agent,
      undefined,
      blockPins[i] as BlockPins,
    );
    if (resolved.kind === 'ok') {
      pins.push(resolved.pins);
      continue;
    }
    unpinnable.push(...atAgent(i, agent, resolved.issues));
  }
  if (unpinnable.length > 0) throw new UnpinnableDeploy(unpinnable);
  return pins;
}

/** An agent's pin issues at its place in the deployment, naming it. */
function atAgent(i: number, agent: Agent, issues: readonly UnpinnableRef[]): UnpinnableRef[] {
  return issues.map((issue) => ({
    path: `/agents/${i}${issue.path}`,
    message: `agent "${agent.id as unknown as string}": ${issue.message}`,
  }));
}

/**
 * Undo a deploy's writes, last first, so registrations are undone in the
 * mirror sequence of their creation. An undo that fails doesn't stop the
 * rest: it's warned, naming what it couldn't undo, which stays as the
 * deploy left it for an operator to reconcile.
 */
async function rollback(actions: readonly RollbackAction[], log: Logger): Promise<void> {
  for (let i = actions.length - 1; i >= 0; i--) {
    const action = actions[i];
    if (action === undefined) continue;
    try {
      await action.run();
    } catch (cause) {
      log.warn(
        `deploy rollback: couldn't ${action.undo} ${action.primitive} "${action.id}", so it stays as this deploy left it`,
        { primitive: action.primitive, id: action.id, err: cause },
      );
    }
  }
}

/** Tell the catalog caches about what a new deployment registered (advisory). */
async function notifyWrites(
  tenantId: TenantId,
  validated: ValidatedPrimitives,
  bindings: DeploymentsRouterBindings,
): Promise<void> {
  for (const tool of validated.tools) {
    try {
      await bindings.onToolWrite?.({
        tenantId,
        toolId: tool.id as ToolId,
        version: tool.version,
        kind: 'publish',
      });
    } catch {
      // Advisory, as on `POST /v1/tools`.
    }
  }
  for (const guardrail of validated.guardrails) {
    try {
      await bindings.onGuardrailWrite?.({
        tenantId,
        guardrailId: guardrail.id as GuardrailId,
        kind: 'register',
      });
    } catch {
      // Advisory, as on `POST /v1/guardrails`.
    }
  }
}

/** The tenant's hour, when its binding gives no wait: the most the hour can take. */
const UNPACK_HOUR_MS = 60 * 60 * 1000;

/**
 * A registry read that failed, as `400 image-unverifiable`: `details.cause`
 * is the binding's code, and `details.limit` the bound that refused the
 * image, when one did. Built here, not by `toWireError`, which keeps a
 * domain error's `cause` off the wire. The tenant's hour
 * (`tenant-unpack-hour`) passes, so it's answered as the rate limit it is:
 * `429 rate-limit-exceeded` with `details.limit` and `Retry-After`, which
 * clients wait out.
 */
function registryRefusal(
  c: Context<AppEnv>,
  step: string,
  error: ImageRegistryError,
  imageRef: string,
  requestId: string,
): Response {
  const message = `${step}: ${error.message}`;
  if (error.code === 'image-limit-exceeded' && error.limit === 'tenant-unpack-hour') {
    const wait = error.retryAfterMs;
    const waitMs = wait !== undefined && Number.isFinite(wait) ? wait : UNPACK_HOUR_MS;
    c.header('Retry-After', String(retryAfterSeconds(waitMs)));
    c.status(statusFor('rate-limit-exceeded') as never);
    return c.json(
      toWireError({ code: 'rate-limit-exceeded', message, limit: error.limit }, requestId),
    );
  }
  const body: WireErrorBody = {
    error: {
      code: 'image-unverifiable',
      message,
      details: {
        imageRef,
        cause: error.code,
        ...(error.code === 'image-limit-exceeded' && { limit: error.limit }),
      },
      requestId,
    },
  };
  c.status(statusFor('image-unverifiable') as never);
  return c.json(body);
}

// Formats a sha256 digest in the canonical `sha256:<hex>` shape. Not used
// by the router or elsewhere in this package; exported from this module
// only.
export function sha256HexPrefixed(bytes: Uint8Array): string {
  const hex = createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hex}`;
}

/** The first read-only registry a deployment would publish into, if any. */
function readOnlyTarget(
  validated: {
    readonly blocks: readonly unknown[];
    readonly tools: readonly unknown[];
    readonly agents: readonly unknown[];
    readonly flows: readonly unknown[];
    readonly guardrails: readonly unknown[];
  },
  bindings: DeploymentsRouterBindings,
): RegistryReadOnly | undefined {
  const targets = [
    [validated.blocks, bindings.blockRegistry?.readOnly],
    [validated.tools, bindings.toolRegistry?.readOnly],
    [validated.agents, bindings.agentRegistry?.readOnly],
    [validated.flows, bindings.flowRegistry?.readOnly],
    [validated.guardrails, bindings.guardrailRegistry?.readOnly],
  ] as const;
  return targets.find(([brought, readOnly]) => brought.length > 0 && readOnly !== undefined)?.[1];
}
