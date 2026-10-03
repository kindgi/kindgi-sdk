// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import { Hono } from 'hono';

import type { AgentId } from '@kindgi/agents';
import { tuplesForCreate } from '@kindgi/authz';
import { parsePublicKeyPem, verifyEd25519 } from '@kindgi/crypto';
import { type Guardrail, validateGuardrailSpec } from '@kindgi/guardrails';
import type { ProjectBinding, Scope } from '@kindgi/platform';
import { validateToolManifest } from '@kindgi/tools';
import type {
  Cursor,
  FlowId,
  GuardrailId,
  ProjectId,
  SigningKeyId,
  TenantId,
  ToolId,
} from '@kindgi/types';

import type { AgentRegistryBinding } from '../agent-binding.js';
import type {
  Deployment,
  DeploymentBinding,
  DeploymentPrimitiveCounts,
  DeploymentRegisterOutcome,
} from '../deployment-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { FlowRegistryBinding } from '../flow-binding.js';
import type { GuardrailRegistryBinding } from '../guardrail-binding.js';
import type { ImageRegistryBinding } from '../image-registry-binding.js';
import type { SecretBinding } from '../secrets-binding.js';
import type { SigningKeyBinding as SigningKeyRegistryBinding } from '../signing-key-binding.js';
import type { ToolRegistryBinding } from '../tool-binding.js';
import type { AppEnv } from '../types.js';
import { hasCapability, requireEnvName } from './env.js';
import type { GuardrailWriteHook } from './guardrails.js';
import { clampLimit } from './pagination.js';
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

export function deploymentsRouter(bindings: DeploymentsRouterBindings): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

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
    const validation = validatePrimitives(imageIndex, {
      imageRef: wire.imageRef,
      artifactVersion: wire.artifactVersion,
    });
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
          }
        }
      }
      if (bindings.agentRegistry !== undefined && defaultProjectId !== undefined) {
        for (const agent of validated.agents) {
          const projectIdForAgent = defaultProjectId;
          const outcome = await bindings.agentRegistry.publish({
            tenantId,
            projectId: projectIdForAgent,
            agent,
            // Signed deploys have no per-request principal — pass parent-
            // only tuples (no owner grant). Tenant admins keep access via
            // `admin from parent` cascade.
            enqueueTuples: (agentId) =>
              tuplesForCreate({
                kind: 'agent',
                id: agentId as AgentId,
                tenantId,
                projectId: projectIdForAgent,
              }),
          });
          if (outcome.kind === 'ok') {
            const agentId = outcome.agentId;
            const version = outcome.version;
            rolled.push(async () => {
              await bindings.agentRegistry?.unregister({ tenantId, agentId, version });
            });
          }
        }
      }
      if (bindings.flowRegistry !== undefined && defaultProjectId !== undefined) {
        for (const flow of validated.flows) {
          const projectIdForGraph = defaultProjectId;
          const outcome = await bindings.flowRegistry.publish({
            tenantId,
            projectId: projectIdForGraph,
            flow,
            enqueueTuples: (flowId) =>
              tuplesForCreate({
                kind: 'flow',
                id: flowId as FlowId,
                tenantId,
                projectId: projectIdForGraph,
              }),
          });
          if (outcome.kind === 'ok') {
            const flowId = outcome.flowId;
            const version = outcome.version;
            rolled.push(async () => {
              await bindings.flowRegistry?.unregister({ tenantId, flowId, version });
            });
          }
        }
      }
    } catch (cause) {
      await rollback(rolled);
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
          agents: validated.agents.map((a) => ({
            id: a.id as unknown as string,
            version: a.version as unknown as string,
          })),
          flows: validated.flows.map((f) => ({
            id: f.id as unknown as string,
            version: f.version as unknown as string,
          })),
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

    if (!hasCapability(c, 'secrets:write')) {
      c.status(statusFor('permission-denied') as never);
      return c.json(
        toWireError(
          {
            code: 'permission-denied',
            message:
              'Bearer token is missing the `secrets:write` capability required for deployment secret sync.',
          },
          requestId,
        ),
      );
    }

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
  if (publishedAt !== undefined && Number.isNaN(Date.parse(publishedAt))) {
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
function validatePrimitives(
  index: Readonly<Record<string, unknown>>,
  image: DeployedImage,
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
    const {
      checkModulePath,
      checkId,
      configSchema: _configSchema,
      ...rest
    } = raw as Record<string, unknown>;
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
  if (typeof spec.instructions !== 'string' || (spec.instructions as string).length === 0) {
    out.push({ path: '/instructions', message: 'agent.instructions must be a non-empty string' });
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
