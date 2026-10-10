// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { Hono } from 'hono';

import type { Agent, AgentId, AgentPins } from '@kindgi/agents';
import { tuplesForCreate } from '@kindgi/authz';
import { parsePublicKeyPem, verifyEd25519 } from '@kindgi/crypto';
import type { Flow, FlowPins } from '@kindgi/flow';
import {
  GUARDRAIL_SPEC_KEYS,
  type Guardrail,
  createCheckRegistry,
  validateGuardrailSpec,
} from '@kindgi/guardrails';
import type { ProjectBinding, Scope } from '@kindgi/platform';
import { validateToolManifest } from '@kindgi/tools';
import type {
  Cursor,
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
import type { DeployedVersionOutcome } from '../deploy-versions.js';
import type {
  DeployedAgent,
  DeployedFlow,
  DeployedVersion,
  Deployment,
  DeploymentBinding,
  DeploymentPrimitiveCounts,
  DeploymentRegisterOutcome,
} from '../deployment-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { FlowRegistryBinding } from '../flow-binding.js';
import { type FlowPinsLive, publishDeployedFlow, resolveFlowPins } from '../flow-pins.js';
import type { GuardrailRegistryBinding } from '../guardrail-binding.js';
import type { ImageRegistryBinding } from '../image-registry-binding.js';
import type { LiveVersionBinding } from '../live-version-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import { PublishRefused } from '../publish-refused.js';
import { type RegistryReadOnly, refuseReadOnly } from '../registry-read-only.js';
import type { SecretBinding } from '../secrets-binding.js';
import type { SigningKeyBinding as SigningKeyRegistryBinding } from '../signing-key-binding.js';
import type { ToolRegistryBinding } from '../tool-binding.js';
import type { AppEnv } from '../types.js';
import { capabilityRefusal } from './denied.js';
import { requireEnvName } from './env.js';
import type { GuardrailWriteHook } from './guardrails.js';
import { clampLimit } from './pagination.js';
import { tenantResourceAccess } from './tenant-access.js';
import { parseTimeInput } from './time-input.js';
import type { ToolWriteHook } from './tools.js';

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
 *      unwinds our own writes.
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
export interface DeploymentsRouterBindings {
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
  /**
   * Called for each tool and guardrail a new deployment registered, as
   * `POST /v1/tools` and `POST /v1/guardrails` call them, so a runtime
   * that caches the catalogs (its tool and guardrail bridges) sees the
   * deployment at once rather than at restart. Advisory: a failing hook
   * doesn't fail the deployment.
   */
  readonly onToolWrite?: ToolWriteHook;
  readonly onGuardrailWrite?: GuardrailWriteHook;
}

export function deploymentsRouter(
  bindings: DeploymentsRouterBindings,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', tenantResourceAccess(authorizer));

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const imageRefPrefixRaw = c.req.query('imageRefPrefix');
    const signerKeyIdRaw = c.req.query('signerKeyId');

    try {
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
      });
      return c.json({
        data: page.data.map(serializeDeployment),
        hasMore: page.nextCursor !== undefined,
        ...(page.nextCursor !== undefined && {
          nextCursor: page.nextCursor as unknown as string,
        }),
      });
    } catch (cause) {
      c.status(statusFor('internal-server-error') as never);
      return c.json(
        toWireError(
          {
            code: 'internal-server-error',
            message: `Deployment list failed: ${errMessage(cause)}`,
          },
          requestId,
        ),
      );
    }
  });

  // ---------- GET /:deploymentId ----------
  r.get('/:deploymentId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const deploymentId = c.req.param('deploymentId');

    const record = await bindings.deploymentRegistry.get({ tenantId, deploymentId });
    if (record === null) {
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
    return c.json(serializeDeployment(record));
  });

  // ---------- POST / (register a signed deployment) ----------
  r.post('/', async (c) => {
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
      c.status(statusFor('internal-server-error') as never);
      return c.json(
        toWireError(
          {
            code: 'internal-server-error',
            message: `Trust check failed: ${trusted.error.message}`,
          },
          requestId,
        ),
      );
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
      c.status(statusFor('image-unverifiable') as never);
      return c.json(
        toWireError(
          {
            code: 'image-unverifiable',
            message: `Image head probe failed: ${head.error.message}`,
            imageRef: wire.imageRef,
            cause: head.error.code,
          },
          requestId,
        ),
      );
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
      c.status(statusFor('image-unverifiable') as never);
      return c.json(
        toWireError(
          {
            code: 'image-unverifiable',
            message: `Extract /app/index.json failed: ${indexFile.error.message}`,
            imageRef: wire.imageRef,
            cause: indexFile.error.code,
          },
          requestId,
        ),
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

    // A read-only registry (under `kindgi dev`, the pack's files) takes
    // nothing a deployment brings: refuse before any write.
    const readOnly = readOnlyTarget(validated, bindings);
    if (readOnly !== undefined) return refuseReadOnly(c, readOnly);

    // ---- Registry upserts (with rollback tracking) ----
    //
    // Agent-registry, flow-registry, tool-registry, and
    // guardrail-registry writes are all project-scoped. All four loops resolve
    // the tenant's Default project via `projectBinding.getDefault(
    // tenantId)` once per request and thread the resolved id into
    // `AgentRegistryBinding.publish(...)` /
    // `FlowRegistryBinding.publish(...)` /
    // `ToolRegistryBinding.register(...)` /
    // `GuardrailRegistryBinding.register(...)`.
    //
    // Fail-fast: if a deployment brings any of those primitives but
    // no `projectBinding` was wired, we surface `500 internal-server-
    // error` with an operator-actionable message BEFORE any registry
    // writes so rollback stays empty.
    const needsProjectBinding =
      validated.agents.length > 0 ||
      validated.flows.length > 0 ||
      validated.tools.length > 0 ||
      validated.guardrails.length > 0;
    if (needsProjectBinding && bindings.projectBinding === undefined) {
      c.status(statusFor('internal-server-error') as never);
      return c.json(
        toWireError(
          {
            code: 'internal-server-error',
            message:
              'agent/flow/tool/guardrail publish requires projectBinding; deployment blocked. Wire projectBinding into DeploymentsRouterBindings at app-creation time.',
          },
          requestId,
        ),
      );
    }
    let defaultProjectId: import('@kindgi/types').ProjectId | undefined;
    if (needsProjectBinding && bindings.projectBinding !== undefined) {
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
      defaultProjectId = defaultProject.id;
    }

    const rolled: RollbackAction[] = [];
    // The version each agent is registered under: its definition's, or
    // the one a deploy registered in its place (`publishDeployedAgent`).
    const deployedAgents: DeployedAgent[] = [];
    const deployedFlows: DeployedFlow[] = [];
    try {
      if (bindings.toolRegistry !== undefined && defaultProjectId !== undefined) {
        for (const tool of validated.tools) {
          const projectIdForTool = defaultProjectId;
          const outcome = await bindings.toolRegistry.publish({
            tenantId,
            projectId: projectIdForTool,
            tool,
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
            rolled.push(async () => {
              await bindings.toolRegistry?.unregister({ tenantId, toolId, version });
            });
          } else if (outcome.kind !== 'already-registered') {
            throw new PublishRefused('tool', `${tool.id}@${tool.version}`, outcome);
          }
        }
      }
      if (bindings.guardrailRegistry !== undefined && defaultProjectId !== undefined) {
        for (const guardrail of validated.guardrails) {
          const projectIdForGuardrail = defaultProjectId;
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
            rolled.push(async () => {
              await bindings.guardrailRegistry?.unregister({ tenantId, guardrailId });
            });
          } else if (outcome.kind === 'already-registered') {
            const kept = await keepRegisteredGuardrail(
              bindings.guardrailRegistry,
              tenantId,
              projectIdForGuardrail,
              guardrail,
            );
            // Unregistered since the registry answered: registered afresh.
            if (kept === 'registered') {
              const guardrailId = guardrail.id;
              rolled.push(async () => {
                await bindings.guardrailRegistry?.unregister({ tenantId, guardrailId });
              });
            }
          } else {
            throw new PublishRefused('guardrail', guardrail.id, outcome);
          }
        }
      }
      if (bindings.agentRegistry !== undefined && defaultProjectId !== undefined) {
        deployedAgents.push(
          ...(await registerAgents({
            agents: bindings.agentRegistry,
            tools: bindings.toolRegistry,
            blocks: bindings.blockRegistry,
            tenantId,
            projectId: defaultProjectId,
            defined: validated.agents,
            rolled,
          })),
        );
      } else {
        deployedAgents.push(...validated.agents.map(deployedPrimitive));
      }
      if (bindings.flowRegistry !== undefined && defaultProjectId !== undefined) {
        deployedFlows.push(
          ...(await registerFlows({
            flows: bindings.flowRegistry,
            tools: bindings.toolRegistry,
            agents: bindings.agentRegistry,
            ...(bindings.liveVersions !== undefined && { live: bindings.liveVersions }),
            tenantId,
            projectId: defaultProjectId,
            defined: validated.flows,
            rolled,
          })),
        );
      } else {
        deployedFlows.push(...validated.flows.map(deployedPrimitive));
      }
    } catch (cause) {
      await rollback(rolled);
      // A primitive refused with a typed outcome is the caller's to fix:
      // that outcome's own status and code. Anything thrown is a 500.
      if (cause instanceof PublishRefused) {
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
              message: `${cause.message}; nothing was deployed`,
              primitive: cause.primitive,
              id: cause.id,
            },
            requestId,
          ),
        );
      }
      if (cause instanceof UnpinnableDeploy) {
        c.status(statusFor('invalid-agent') as never);
        return c.json(
          toWireError(
            {
              code: 'validation-failed',
              message: `The deployment's agents or flows use tool or agent versions that aren't published (${cause.issues.length} issue${cause.issues.length === 1 ? '' : 's'}); nothing was deployed`,
              issues: cause.issues as unknown as Record<string, unknown>[],
            },
            requestId,
          ),
        );
      }
      c.status(statusFor('internal-server-error') as never);
      return c.json(
        toWireError(
          {
            code: 'internal-server-error',
            message: `Registry upsert failed: ${errMessage(cause)}`,
          },
          requestId,
        ),
      );
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
      await rollback(rolled);
      c.status(statusFor('internal-server-error') as never);
      return c.json(
        toWireError(
          {
            code: 'internal-server-error',
            message: `Deployment record failed: ${errMessage(cause)}`,
          },
          requestId,
        ),
      );
    }

    if (outcome.kind === 'error') {
      await rollback(rolled);
      c.status(statusFor('internal-server-error') as never);
      return c.json(
        toWireError(
          {
            code: 'internal-server-error',
            message: `Deployment record failed: ${outcome.message}`,
            cause: outcome.code,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'already-registered') {
      // Digest-based idempotency: same digest already recorded. Roll back
      // any freshly-inserted primitives (the primitive itself is fine —
      // the previous deploy landed it — but re-inserting is idempotent
      // at the primitive layer too, so `ok` outcomes only happen when
      // the primitive was DIFFERENT this run, which is an inconsistent
      // wire body).
      await rollback(rolled);
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
  // the wire (CRITICAL). The `Deployment` shape carries no `projectId`, so
  // the scope is `{ kind: 'tenant', tenantId }`; `deriveScopeFromDeployment`
  // switches to a project scope if a record does carry one.
  //
  // Capability: `secrets:write` (fail-closed).
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
    const deployment = await bindings.deploymentRegistry.get({ tenantId, deploymentId });
    if (deployment === null) {
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
    const scope = deriveScopeFromDeployment(deployment);

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

// ------------------------------------------------------------
// Scope derivation for deployment secret sync
// ------------------------------------------------------------

/**
 * Derive the write scope for a deployment secret-sync request from
 * the deployment record itself. Never accepts a caller-supplied scope
 * override on the wire (CRITICAL — scope MUST be inferred
 * server-side to prevent tenant/project confusion attacks).
 *
 * The `Deployment` type carries no `projectId`, so this normally returns
 * `{ kind: 'tenant', tenantId }`. If a binding's record does carry a
 * non-empty `projectId`, the helper returns a project scope instead. The
 * field is read dynamically because the type does not declare it.
 */
function deriveScopeFromDeployment(d: Deployment): Scope {
  const maybeProjectId = (d as Deployment & { readonly projectId?: unknown }).projectId;
  if (typeof maybeProjectId === 'string' && maybeProjectId.length > 0) {
    return {
      kind: 'project',
      tenantId: d.tenantId,
      projectId: maybeProjectId as unknown as ProjectId,
    } as Scope;
  }
  return { kind: 'tenant', tenantId: d.tenantId } as Scope;
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
    },
  };
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

function extractImageDigest(imageRef: string): string | null {
  const at = imageRef.lastIndexOf('@');
  if (at < 0) return null;
  const digest = imageRef.slice(at + 1);
  if (!SHA256_PREFIX_RE.test(digest)) return null;
  return digest.toLowerCase();
}

function normaliseSha256Hex(raw: string): string {
  const lower = raw.toLowerCase();
  return lower.startsWith('sha256:') ? lower : `sha256:${lower}`;
}

// ------------------------------------------------------------
// Canonical envelope
// ------------------------------------------------------------

interface EnvelopeFields {
  readonly imageDigest: string;
  readonly artifactVersion: string;
  readonly indexHash: string;
  readonly tenantId: string;
  readonly publishedAt: string;
}

/**
 * Canonical form of the signed envelope: JSON object with sorted keys,
 * no whitespace, UTF-8. Deterministic by construction — the same field
 * values always produce byte-identical output.
 */
function canonicalizeEnvelope(fields: EnvelopeFields): Uint8Array {
  const ordered: Record<string, string> = {
    artifactVersion: fields.artifactVersion,
    imageDigest: normaliseSha256Hex(fields.imageDigest),
    indexHash: normaliseSha256Hex(fields.indexHash),
    publishedAt: fields.publishedAt,
    tenantId: fields.tenantId,
  };
  const json = JSON.stringify(ordered);
  return new TextEncoder().encode(json);
}

// ------------------------------------------------------------
// Primitive validation
// ------------------------------------------------------------

interface ValidationDetail {
  readonly primitive: 'tool' | 'guardrail' | 'agent' | 'flow';
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
 * registered again: `'registered'`, for the deploy to roll back.
 */
async function keepRegisteredGuardrail(
  registry: GuardrailRegistryBinding,
  tenantId: TenantId,
  projectId: ProjectId,
  guardrail: Guardrail,
): Promise<'kept' | 'registered'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await registry.get({ tenantId, guardrailId: guardrail.id });
    if (existing !== null) {
      if (!(await guardrailInProject(registry, tenantId, projectId, guardrail.id))) {
        throw new PublishRefused('guardrail', guardrail.id, {
          code: 'guardrail-project-mismatch',
          reason: 'it belongs to another project',
        });
      }
      if (!sameGuardrailDefinition(existing, guardrail)) {
        throw new PublishRefused('guardrail', guardrail.id, {
          code: 'guardrail-already-registered',
          reason: `it is already registered with a different definition; unregister it (\`kindgi guardrails unregister ${guardrail.id}\`) and deploy again`,
        });
      }
      return 'kept';
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
    if (again.kind === 'ok') return 'registered';
    if (again.kind !== 'already-registered') {
      throw new PublishRefused('guardrail', guardrail.id, again);
    }
  }
  throw new Error(`guardrail ${guardrail.id}: registered and unregistered while deploying`);
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

/** JSON with every object's keys sorted, and absent and `undefined` alike. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(JSON.parse(JSON.stringify(value) ?? 'null'), (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
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
    },
  };
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Minimal shape check on an `IndexedAgent` after `modulePath` is
 * stripped. Deeper validation (RetrievalIntent shape, budget arithmetic,
 * conversation policy tri-state) is left to the runtime at dispatch —
 * the deploy route only validates that the wire is well-shaped enough to
 * persist. The alternative is running `defineAgent`, but that requires
 * promoting `capabilities`/`tools` to their branded shapes; the pattern
 * across the API package is to keep transport shape checks lightweight
 * and leave semantic checks to the runtime.
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
  }
  if (!Array.isArray(spec.capabilities)) {
    out.push({ path: '/capabilities', message: 'agent.capabilities must be an array' });
  }
  if (!Array.isArray(spec.tools)) {
    out.push({ path: '/tools', message: 'agent.tools must be an array of tool ids' });
  }
  return out;
}

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
  return out;
}

// ------------------------------------------------------------
// Rollback / serialisation
// ------------------------------------------------------------

type RollbackAction = () => Promise<void>;

/** A deploy whose agents or flows use a tool or agent with no published version in range. */
class UnpinnableDeploy extends Error {
  constructor(readonly issues: readonly UnpinnableRef[]) {
    super('the deployment uses tools or agents that are not published');
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
 * are registered by now): one whose range matches no published version
 * throws `UnpinnableDeploy` before any agent is written, and the deploy
 * rolls back. Each is then registered by `publishDeployedAgent`, which
 * never keeps a version's old pins. Without one, agents register
 * unpinned, as before pins existed.
 */
async function registerAgents(input: {
  readonly agents: AgentRegistryBinding;
  readonly tools: ToolRegistryBinding | undefined;
  readonly blocks: BlockRegistryBinding | undefined;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly defined: readonly Agent[];
  readonly rolled: RollbackAction[];
}): Promise<DeployedAgent[]> {
  const { agents, tools, blocks, tenantId, projectId, rolled } = input;
  // Signed deploys have no per-request principal — pass parent-only
  // tuples (no owner grant). Tenant admins keep access via
  // `admin from parent` cascade.
  const enqueueTuples = (agentId: string) =>
    tuplesForCreate({ kind: 'agent', id: agentId as AgentId, tenantId, projectId });
  const written = (agentId: AgentId, version: Semver) =>
    rolled.push(async () => {
      await agents.unregister({ tenantId, agentId, version });
    });

  if (tools === undefined) {
    for (const agent of input.defined) {
      const outcome = await agents.publish({ tenantId, projectId, agent, enqueueTuples });
      if (outcome.kind === 'ok') written(outcome.agentId, outcome.version);
      else if (outcome.kind !== 'already-registered') {
        throw new PublishRefused('agent', `${agent.id}@${agent.version}`, outcome);
      }
    }
    return input.defined.map(deployedPrimitive);
  }

  const pinsOf = await pinAgents(tools, blocks, tenantId, input.defined);
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
 * With the tool and agent registries, every flow is pinned first; one
 * that runs a tool or agent with no published version throws
 * `UnpinnableDeploy` before any flow is written, and the deploy rolls
 * back. Without them, flows register unpinned, as before pins existed.
 */
async function registerFlows(input: {
  readonly flows: FlowRegistryBinding;
  readonly tools: ToolRegistryBinding | undefined;
  readonly agents: AgentRegistryBinding | undefined;
  readonly live?: LiveVersionBinding;
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly defined: readonly Flow[];
  readonly rolled: RollbackAction[];
}): Promise<DeployedFlow[]> {
  const { flows, tools, agents, live, tenantId, projectId, rolled } = input;
  const enqueueTuples = (flowId: string) =>
    tuplesForCreate({ kind: 'flow', id: flowId as FlowId, tenantId, projectId });
  const written = (flowId: FlowId, version: string) =>
    rolled.push(async () => {
      await flows.unregister({ tenantId, flowId, version: version as never });
    });

  if (tools === undefined || agents === undefined) {
    for (const flow of input.defined) {
      const outcome = await flows.publish({ tenantId, projectId, flow, enqueueTuples });
      if (outcome.kind === 'ok') written(outcome.flowId, outcome.version as unknown as string);
      else if (outcome.kind !== 'already-registered') {
        throw new PublishRefused('flow', `${flow.id}@${flow.version}`, outcome);
      }
    }
    return input.defined.map(deployedPrimitive);
  }

  const pinsOf = await pinFlows(
    tools,
    agents,
    tenantId,
    input.defined,
    live !== undefined ? { binding: live, projectId } : undefined,
  );
  const deployed: DeployedFlow[] = [];
  for (const [i, flow] of input.defined.entries()) {
    const outcome = await publishDeployedFlow({
      flows,
      tenantId,
      projectId,
      flow,
      pins: pinsOf[i] as FlowPins,
      enqueueTuples,
    });
    if (outcome.kind === 'registered' || outcome.kind === 'renumbered') {
      written(flow.id, outcome.version);
    }
    deployed.push(deployedVersion(flow, outcome));
  }
  return deployed;
}

/** Each flow's pins, in order; throws `UnpinnableDeploy` naming every tool or agent with no published version. */
async function pinFlows(
  tools: ToolRegistryBinding,
  agents: AgentRegistryBinding,
  tenantId: TenantId,
  defined: readonly Flow[],
  live: FlowPinsLive | undefined,
): Promise<FlowPins[]> {
  const pins: FlowPins[] = [];
  const unpinnable: UnpinnableRef[] = [];
  for (const [i, flow] of defined.entries()) {
    const resolved = await resolveFlowPins(tools, agents, tenantId, flow, live);
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

/** Each agent's pins, in order; throws `UnpinnableDeploy` naming every range that matches nothing. */
async function pinAgents(
  tools: ToolRegistryBinding,
  blocks: BlockRegistryBinding | undefined,
  tenantId: TenantId,
  defined: readonly Agent[],
): Promise<AgentPins[]> {
  const pins: AgentPins[] = [];
  const unpinnable: UnpinnableRef[] = [];
  for (const [i, agent] of defined.entries()) {
    const resolved = await resolveAgentPins(tools, tenantId, agent, blocks);
    if (resolved.kind === 'ok') {
      pins.push(resolved.pins);
      continue;
    }
    for (const issue of resolved.issues) {
      unpinnable.push({
        path: `/agents/${i}${issue.path}`,
        message: `agent "${agent.id as unknown as string}": ${issue.message}`,
      });
    }
  }
  if (unpinnable.length > 0) throw new UnpinnableDeploy(unpinnable);
  return pins;
}

async function rollback(actions: readonly RollbackAction[]): Promise<void> {
  // Reverse order — last-in, first-out — so registrations are undone in
  // the mirror sequence of their creation.
  for (let i = actions.length - 1; i >= 0; i--) {
    const action = actions[i];
    if (action === undefined) continue;
    try {
      await action();
    } catch {
      // Swallow: rollback is best-effort. Real production adapters
      // record a rollback-failure event so operators can reconcile.
    }
  }
}

function serializeDeployment(d: Deployment): Record<string, unknown> {
  return {
    deploymentId: d.deploymentId,
    tenantId: d.tenantId as unknown as string,
    imageRef: d.imageRef,
    imageDigest: d.imageDigest,
    artifactVersion: d.artifactVersion,
    indexHash: d.indexHash,
    signerKeyId: d.signerKeyId as unknown as string,
    signerPublicKey: d.signerPublicKey,
    signature: d.signature,
    publishedAt: d.publishedAt,
    activatedAt: d.activatedAt,
    primitives: {
      tools: d.primitives.tools,
      guardrails: d.primitives.guardrails,
      agents: d.primitives.agents,
      flows: d.primitives.flows,
    },
    contents: d.contents,
  };
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

function errMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
    readonly tools: readonly unknown[];
    readonly agents: readonly unknown[];
    readonly flows: readonly unknown[];
    readonly guardrails: readonly unknown[];
  },
  bindings: DeploymentsRouterBindings,
): RegistryReadOnly | undefined {
  const targets = [
    [validated.tools, bindings.toolRegistry?.readOnly],
    [validated.agents, bindings.agentRegistry?.readOnly],
    [validated.flows, bindings.flowRegistry?.readOnly],
    [validated.guardrails, bindings.guardrailRegistry?.readOnly],
  ] as const;
  return targets.find(([brought, readOnly]) => brought.length > 0 && readOnly !== undefined)?.[1];
}
