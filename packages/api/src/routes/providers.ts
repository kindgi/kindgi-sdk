// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import {
  type AdapterConfig,
  type AdapterConfigProblem,
  type AdapterFactoryRegistry,
  FEATURES,
  type Feature,
  type ModelInfo,
  type ProviderMetadata,
  isModelThinking,
  validateProviderLabels,
} from '@kindgi/capabilities';
import type { Cursor, TenantId } from '@kindgi/types';

import type { CapabilityDescriptor } from '../capability-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type {
  ProviderRegistryBinding,
  ProviderRuntimeEntry,
  ProviderSecretRef,
} from '../provider-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { tenantResourceAccess } from './tenant-access.js';

/**
 * Providers resource routes — part of the admin control plane. Full
 * CRUD. Model providers are tenant-owned: each tenant registers the
 * endpoints they want the runtime's capability router to consider
 * (hosted model APIs, self-hosted inference servers, embedding backends,
 * sandbox-exec fleets, ...).
 *
 * Secrets do NOT cross the wire — `ProviderMetadata` is the wire shape.
 * Deployments store the actual credential set inside the caller-plugged
 * `ProviderRegistryBinding`; the API surface only returns routing-
 * relevant metadata: provider-level `id` / `region` / `attributes` +
 * `models[]` (each with `name`, `contextWindow`, `features`, `cost`,
 * optional `p95LatencyMs` / `maxOutputTokens` / `description`).
 */
/**
 * Optional side-effect callback fired after a successful write
 * (register, unregister) to a provider. Lets an in-process runtime
 * cache (e.g. a per-tenant provider cache) invalidate its
 * per-tenant snapshot so the next agent run picks up the new
 * provider without a process restart.
 */
export type ProviderWriteHook = (params: {
  readonly tenantId: TenantId;
  readonly providerId: string;
  readonly kind: 'register' | 'unregister';
}) => void | Promise<void>;

/**
 * `factories`: the deployment's in-process adapter factories. With them, a
 * registration is checked against its adapter's `checkConfig` before it's
 * stored, and `GET /:providerId/check` answers for a registered one.
 * Without them, registration takes any flat `adapter_config`.
 */
export function providersRouter(
  binding: ProviderRegistryBinding,
  onWrite?: ProviderWriteHook,
  factories?: AdapterFactoryRegistry,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', tenantResourceAccess(authorizer));

  // ---------- GET / (list, cursor-paginated) ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const featureRaw = c.req.query('feature');
    const page = await binding.list({
      tenantId,
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(featureRaw !== undefined && featureRaw.length > 0 && { featureFilter: featureRaw }),
    });
    return c.json({
      data: page.data.map(serializeProvider),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- GET /:providerId ----------
  r.get('/:providerId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const providerId = c.req.param('providerId');

    const provider = await binding.get({ tenantId, providerId });
    if (provider === null) {
      c.status(statusFor('provider-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'provider-not-found',
            message: `No provider registered with id "${providerId}"`,
            providerId,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeProvider(provider));
  });

  // ---------- GET /:providerId/capabilities (sub-resource) ----------
  r.get('/:providerId/capabilities', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const providerId = c.req.param('providerId');

    const capabilities = await binding.capabilitiesFor({ tenantId, providerId });
    if (capabilities === null) {
      c.status(statusFor('provider-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'provider-not-found',
            message: `No provider registered with id "${providerId}"`,
            providerId,
          },
          requestId,
        ),
      );
    }
    return c.json({
      data: capabilities.map(serializeCapability),
    });
  });

  // ---------- POST / (register) ----------
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
    if (body === null || typeof body !== 'object') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }

    // Wire body shape:
    //   {
    //     "metadata":   ProviderMetadata (required),
    //     "adapter_id": string           (required — an adapter registered
    //                                     for the tenant),
    //     "secret_ref": { envName, name } (optional — tenant-scoped
    //                                     credential pointer for the
    //                                     runtime bridge),
    //     "adapter_config": { … }         (optional — the adapter's flat,
    //                                     non-secret connection settings)
    //     "send_traceparent": boolean     (optional — send each call's
    //                                     traceparent to the provider)
    //   }
    const bodyObj = body as {
      readonly metadata?: unknown;
      readonly adapter_id?: unknown;
      readonly secret_ref?: unknown;
      readonly adapter_config?: unknown;
      readonly send_traceparent?: unknown;
    };
    if (bodyObj.metadata === undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message:
              'Request body must include a `metadata` object with the ProviderMetadata shape.',
          },
          requestId,
        ),
      );
    }
    if (typeof bodyObj.adapter_id !== 'string' || bodyObj.adapter_id.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message:
              'Request body must include a non-empty string `adapter_id` naming a registered adapter.',
          },
          requestId,
        ),
      );
    }
    const secretRefResult = parseSecretRef(bodyObj.secret_ref);
    if (secretRefResult.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: secretRefResult.error }, requestId));
    }
    const adapterConfigResult = parseAdapterConfig(bodyObj.adapter_config);
    if (adapterConfigResult.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: adapterConfigResult.error }, requestId),
      );
    }

    // Shape validation matches `@kindgi/capabilities.createProviderRegistry`
    // internal `validate()` — same rules as the runtime primitive, so a
    // provider registered through the API is byte-identical to one
    // registered in-process.
    const validation = validateProviderMetadata(bodyObj.metadata);
    if (validation.kind === 'err') {
      c.status(statusFor('invalid-provider') as never);
      return c.json(
        toWireError(
          {
            code: 'invalid-provider',
            message: validation.error.message,
            reason: validation.error.reason,
          },
          requestId,
        ),
      );
    }

    // The registration's own fields first, then the adapter's check of what
    // it'll be built from: refused now, naming the field, instead of skipped
    // at the first model call. One answer lists them all.
    const sendTraceparent = bodyObj.send_traceparent;
    const adapterProblems = configProblems(factories, {
      metadata: validation.value,
      adapterId: bodyObj.adapter_id,
      ...(secretRefResult.value !== undefined && { secretRef: secretRefResult.value }),
      ...(adapterConfigResult.value !== undefined && { adapterConfig: adapterConfigResult.value }),
    });
    const problems = [...registrationProblems(bodyObj), ...(adapterProblems ?? [])];
    if (problems.length > 0) {
      c.status(statusFor('provider-config-invalid') as never);
      return c.json(
        toWireError(
          {
            code: 'provider-config-invalid',
            message: refusalOf(validation.value.id, bodyObj.adapter_id, problems),
            issues: problems,
          },
          requestId,
        ),
      );
    }

    const outcome = await binding.register({
      tenantId,
      metadata: validation.value,
      adapterId: bodyObj.adapter_id,
      ...(secretRefResult.value !== undefined && { secretRef: secretRefResult.value }),
      ...(adapterConfigResult.value !== undefined && { adapterConfig: adapterConfigResult.value }),
      ...(typeof sendTraceparent === 'boolean' && { sendTraceparent }),
    });
    if (outcome.kind === 'already-registered') {
      c.status(statusFor('provider-already-registered') as never);
      return c.json(
        toWireError(
          {
            code: 'provider-already-registered',
            message: `Provider "${outcome.providerId}" is already registered`,
            providerId: outcome.providerId,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'invalid') {
      c.status(statusFor('invalid-provider') as never);
      return c.json(
        toWireError(
          {
            code: 'invalid-provider',
            message: outcome.message,
            providerId: outcome.providerId,
            ...(outcome.reason !== undefined && { reason: outcome.reason }),
          },
          requestId,
        ),
      );
    }
    if (onWrite !== undefined) {
      try {
        await onWrite({ tenantId, providerId: outcome.providerId, kind: 'register' });
      } catch {
        // Post-write hooks are advisory (cache invalidation etc.).
        // A hook failure does NOT roll back the register — the row
        // is durably stored; a stale in-memory cache will self-heal
        // on the next boot.
      }
    }
    c.status(201);
    return c.json({ providerId: outcome.providerId });
  });

  // ---------- GET /:providerId/check ----------
  r.get('/:providerId/check', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const providerId = c.req.param('providerId');
    const entries = await binding.resolveForRuntime({ tenantId });
    const entry = entries.find((e) => e.metadata.id === providerId);
    if (entry === undefined) {
      c.status(statusFor('provider-not-found') as never);
      return c.json(
        toWireError(
          { code: 'provider-not-found', message: `Provider "${providerId}" not found`, providerId },
          requestId,
        ),
      );
    }
    const problems = configProblems(factories, entry);
    return c.json({
      providerId,
      adapterId: entry.adapterId,
      checked: problems !== undefined,
      issues: problems ?? [],
    });
  });

  // ---------- POST /:providerId/unregister ----------
  r.post('/:providerId/unregister', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const providerId = c.req.param('providerId');

    const outcome = await binding.unregister({ tenantId, providerId });
    if (!outcome.unregistered) {
      c.status(statusFor('provider-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'provider-not-found',
            message: `No provider "${providerId}" to unregister`,
            providerId,
          },
          requestId,
        ),
      );
    }
    if (onWrite !== undefined) {
      try {
        await onWrite({ tenantId, providerId, kind: 'unregister' });
      } catch {
        // See register path — hooks are advisory.
      }
    }
    return c.json({ providerId, unregistered: true });
  });

  return r;
}

function serializeProvider(m: ProviderMetadata): Record<string, unknown> {
  return {
    id: m.id,
    region: m.region,
    models: m.models.map((model) => ({
      name: model.name,
      contextWindow: model.contextWindow,
      features: model.features,
      // As stored: the base rates and any an adapter widens it with.
      cost: { ...model.cost },
      ...(model.p95LatencyMs !== undefined && { p95LatencyMs: model.p95LatencyMs }),
      ...(model.maxOutputTokens !== undefined && { maxOutputTokens: model.maxOutputTokens }),
      ...(model.sampling !== undefined && { sampling: model.sampling }),
      ...(model.thinking !== undefined && { thinking: model.thinking }),
      ...(model.description !== undefined && { description: model.description }),
    })),
    ...(m.defaultModel !== undefined && { defaultModel: m.defaultModel }),
    ...(m.attributes !== undefined && { attributes: m.attributes }),
    ...(m.description !== undefined && { description: m.description }),
    ...(m.capabilityKind !== undefined && { capabilityKind: m.capabilityKind }),
    ...(m.fallback !== undefined && { fallback: m.fallback }),
    ...(m.labels !== undefined && { labels: m.labels }),
  };
}

function serializeCapability(d: CapabilityDescriptor): Record<string, unknown> {
  return {
    id: d.id,
    feature: d.feature,
    description: d.description,
    ...(d.kind !== undefined && { kind: d.kind }),
    ...(d.paramsSchema !== undefined && { paramsSchema: d.paramsSchema }),
    ...(d.providers !== undefined && {
      providers: d.providers.map((p) => ({ providerId: p.providerId, models: [...p.models] })),
    }),
  };
}

/**
 * Wire-shape validator for `ProviderMetadata`. Mirrors the private
 * `validate()` inside `@kindgi/capabilities.createProviderRegistry` —
 * kept in sync with the runtime so a provider registered through the
 * API is byte-identical to one registered in-process. The wire path
 * additionally enforces `features ⊆ FEATURES` (closed enum) since it
 * receives untyped JSON; the runtime primitive receives already-typed
 * `Feature[]` from its callers. Returns a `Result`-ish shape rather
 * than throwing.
 */
/** `metadata.region`: one DNS label (`us-central1`, `eu-west-1`, `global`, `unspecified`). */
const REGION = /^[a-z][a-z0-9-]{0,62}$/;

function validateProviderMetadata(
  body: unknown,
):
  | { kind: 'ok'; value: ProviderMetadata }
  | { kind: 'err'; error: { message: string; reason: string } } {
  const b = body as Partial<ProviderMetadata> & Record<string, unknown>;
  if (typeof b.id !== 'string' || b.id.length === 0) {
    return { kind: 'err', error: { message: 'metadata.id required', reason: 'empty-id' } };
  }
  if (typeof b.region !== 'string' || b.region.length === 0) {
    return {
      kind: 'err',
      error: { message: `provider "${b.id}" missing metadata.region`, reason: 'empty-region' },
    };
  }
  // An adapter may build a hostname from the region (Vertex AI:
  // `<region>-aiplatform.googleapis.com`), so it must stay one DNS label.
  if (!REGION.test(b.region)) {
    return {
      kind: 'err',
      error: {
        message: `provider "${b.id}" metadata.region must be one DNS label: lowercase letters, digits and hyphens (e.g. us-central1)`,
        reason: 'invalid-region',
      },
    };
  }
  if (!Array.isArray(b.models) || b.models.length === 0) {
    return {
      kind: 'err',
      error: {
        message: `provider "${b.id}" must expose at least one model in metadata.models[]`,
        reason: 'empty-models',
      },
    };
  }
  const seenNames = new Set<string>();
  const validatedModels: ModelInfo[] = [];
  for (const rawModel of b.models) {
    const modelResult = validateModelInfo(b.id, rawModel);
    if (modelResult.kind === 'err') return modelResult;
    if (seenNames.has(modelResult.value.name)) {
      return {
        kind: 'err',
        error: {
          message: `provider "${b.id}" declares model "${modelResult.value.name}" more than once in metadata.models[]`,
          reason: 'duplicate-model-name',
        },
      };
    }
    seenNames.add(modelResult.value.name);
    validatedModels.push(modelResult.value);
  }
  if (b.attributes !== undefined) {
    if (!Array.isArray(b.attributes) || b.attributes.some((a) => typeof a !== 'string')) {
      return {
        kind: 'err',
        error: {
          message: `provider "${b.id}" attributes must be an array of strings`,
          reason: 'invalid-attributes',
        },
      };
    }
  }
  if (b.description !== undefined && typeof b.description !== 'string') {
    return {
      kind: 'err',
      error: {
        message: `provider "${b.id}" description must be a string`,
        reason: 'invalid-description',
      },
    };
  }
  if (b.capabilityKind !== undefined && typeof b.capabilityKind !== 'string') {
    return {
      kind: 'err',
      error: {
        message: `provider "${b.id}" capabilityKind must be a string`,
        reason: 'invalid-capability-kind',
      },
    };
  }
  if (b.fallback !== undefined && typeof b.fallback !== 'boolean') {
    return {
      kind: 'err',
      error: {
        message: `provider "${b.id}" fallback must be a boolean`,
        reason: 'invalid-fallback',
      },
    };
  }
  const badLabels = validateProviderLabels(b.id, b.labels);
  if (badLabels !== undefined) return { kind: 'err', error: badLabels };
  if (b.defaultModel !== undefined && !seenNames.has(b.defaultModel as string)) {
    return {
      kind: 'err',
      error: {
        message: `provider "${b.id}" defaultModel must be one of its models (${[...seenNames].join(', ')}), got ${JSON.stringify(b.defaultModel)}`,
        reason: 'unknown-default-model',
      },
    };
  }
  const value: ProviderMetadata = {
    id: b.id,
    region: b.region,
    models: validatedModels,
    ...(b.defaultModel !== undefined && { defaultModel: b.defaultModel as string }),
    ...(b.attributes !== undefined && { attributes: b.attributes as readonly string[] }),
    ...(b.description !== undefined && { description: b.description }),
    ...(b.capabilityKind !== undefined && { capabilityKind: b.capabilityKind as string }),
    ...(b.fallback !== undefined && { fallback: b.fallback as boolean }),
    ...(b.labels !== undefined && { labels: b.labels as Readonly<Record<string, string>> }),
  };
  return { kind: 'ok', value };
}

/**
 * Wire-shape validator for a single `ModelInfo` inside `metadata.models[]`.
 * Enforces the same guardrails as `createProviderRegistry.validate()`
 * plus the closed-enum `features` check (wire-only — the runtime
 * primitive receives already-typed `Feature[]`).
 */
function validateModelInfo(
  providerId: string,
  raw: unknown,
): { kind: 'ok'; value: ModelInfo } | { kind: 'err'; error: { message: string; reason: string } } {
  if (raw === null || typeof raw !== 'object') {
    return {
      kind: 'err',
      error: {
        message: `provider "${providerId}" metadata.models[] entries must be objects`,
        reason: 'invalid-model-shape',
      },
    };
  }
  const m = raw as Partial<ModelInfo> & Record<string, unknown>;
  if (typeof m.name !== 'string' || m.name.length === 0) {
    return {
      kind: 'err',
      error: {
        message: `provider "${providerId}" has a model with empty name`,
        reason: 'empty-model-name',
      },
    };
  }
  if (
    typeof m.contextWindow !== 'number' ||
    m.contextWindow <= 0 ||
    !Number.isInteger(m.contextWindow)
  ) {
    return {
      kind: 'err',
      error: {
        message: `provider "${providerId}" model "${m.name}" contextWindow must be a positive integer`,
        reason: 'invalid-context-window',
      },
    };
  }
  if (!Array.isArray(m.features)) {
    return {
      kind: 'err',
      error: {
        message: `provider "${providerId}" model "${m.name}" features must be an array`,
        reason: 'invalid-features',
      },
    };
  }
  for (const f of m.features) {
    if (typeof f !== 'string' || !(FEATURES as readonly string[]).includes(f)) {
      return {
        kind: 'err',
        error: {
          message: `provider "${providerId}" model "${m.name}" features contains unknown value "${String(f)}"`,
          reason: 'unknown-feature',
        },
      };
    }
  }
  const cost = m.cost as ModelInfo['cost'] | undefined;
  if (
    cost === undefined ||
    typeof cost.promptUsdPer1kTokens !== 'number' ||
    cost.promptUsdPer1kTokens < 0 ||
    typeof cost.completionUsdPer1kTokens !== 'number' ||
    cost.completionUsdPer1kTokens < 0
  ) {
    return {
      kind: 'err',
      error: {
        message: `provider "${providerId}" model "${m.name}" cost table must have non-negative promptUsdPer1kTokens + completionUsdPer1kTokens`,
        reason: 'invalid-cost',
      },
    };
  }
  const extraRates = costExtraRates(cost as unknown as Record<string, unknown>);
  if (extraRates === undefined) {
    return {
      kind: 'err',
      error: {
        message: `provider "${providerId}" model "${m.name}" cost table's other rates must be non-negative numbers, or objects of them (e.g. longContext: { thresholdTokens, promptUsdPer1kTokens, completionUsdPer1kTokens })`,
        reason: 'invalid-cost',
      },
    };
  }
  if (m.p95LatencyMs !== undefined) {
    if (typeof m.p95LatencyMs !== 'number' || m.p95LatencyMs < 0) {
      return {
        kind: 'err',
        error: {
          message: `provider "${providerId}" model "${m.name}" p95LatencyMs must be a non-negative number`,
          reason: 'invalid-p95-latency',
        },
      };
    }
  }
  if (m.maxOutputTokens !== undefined) {
    if (
      typeof m.maxOutputTokens !== 'number' ||
      m.maxOutputTokens <= 0 ||
      !Number.isInteger(m.maxOutputTokens)
    ) {
      return {
        kind: 'err',
        error: {
          message: `provider "${providerId}" model "${m.name}" maxOutputTokens must be a positive integer`,
          reason: 'invalid-max-output-tokens',
        },
      };
    }
  }
  if (m.sampling !== undefined && typeof m.sampling !== 'boolean') {
    return {
      kind: 'err',
      error: {
        message: `provider "${providerId}" model "${m.name}" sampling must be true or false`,
        reason: 'invalid-sampling',
      },
    };
  }
  if (m.thinking !== undefined && !isModelThinking(m.thinking)) {
    return {
      kind: 'err',
      error: {
        message: `provider "${providerId}" model "${m.name}" thinking must be { mode: 'adaptive' | 'always', lowest: <the vendor's setting> }`,
        reason: 'invalid-thinking',
      },
    };
  }
  if (m.description !== undefined && typeof m.description !== 'string') {
    return {
      kind: 'err',
      error: {
        message: `provider "${providerId}" model "${m.name}" description must be a string`,
        reason: 'invalid-description',
      },
    };
  }
  const value: ModelInfo = {
    name: m.name,
    contextWindow: m.contextWindow,
    features: m.features as readonly Feature[],
    cost: {
      ...extraRates,
      promptUsdPer1kTokens: cost.promptUsdPer1kTokens,
      completionUsdPer1kTokens: cost.completionUsdPer1kTokens,
    } as ModelInfo['cost'],
    ...(m.p95LatencyMs !== undefined && { p95LatencyMs: m.p95LatencyMs }),
    ...(m.maxOutputTokens !== undefined && { maxOutputTokens: m.maxOutputTokens }),
    ...(m.sampling !== undefined && { sampling: m.sampling }),
    ...(m.thinking !== undefined && {
      thinking: { mode: m.thinking.mode, lowest: m.thinking.lowest },
    }),
    ...(m.description !== undefined && { description: m.description }),
  };
  return { kind: 'ok', value };
}

/**
 * The rates a cost table carries beyond the two base ones: an adapter
 * widens it with its own (Anthropic's prompt-cache multipliers, Gemini's
 * cached-prompt share, a long-context tier), each a non-negative number
 * or one level of an object of them. Returned as given, or `undefined`
 * when one isn't, so a registration keeps what its adapter prices with.
 */
function costExtraRates(
  cost: Readonly<Record<string, unknown>>,
): Record<string, number | Record<string, number>> | undefined {
  const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const out: Record<string, number | Record<string, number>> = {};
  for (const [key, value] of Object.entries(cost)) {
    if (key === 'promptUsdPer1kTokens' || key === 'completionUsdPer1kTokens') continue;
    if (isRate(value)) {
      out[key] = value;
    } else if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0 &&
      Object.values(value).every(isRate)
    ) {
      out[key] = { ...(value as Record<string, number>) };
    } else {
      return undefined;
    }
  }
  return out;
}

/**
 * What's wrong with a registration, by its adapter's own static check
 * (`AdapterFactoryEntry.checkConfig`): no network, no secret read.
 * `undefined` when there's nothing to check it with (no factories wired, or
 * an adapter without a check). An adapter the deployment doesn't have is a
 * problem: the runtime could never build the provider.
 */
function configProblems(
  factories: AdapterFactoryRegistry | undefined,
  registration: ProviderRuntimeEntry,
): readonly AdapterConfigProblem[] | undefined {
  if (factories === undefined) return undefined;
  const entry = factories.get(registration.adapterId);
  if (entry === undefined) {
    return [
      {
        path: '/adapter_id',
        message: `This runtime has no adapter "${registration.adapterId}", so it can't build provider "${registration.metadata.id}".`,
      },
    ];
  }
  return entry.checkConfig?.({
    metadata: registration.metadata,
    ...(registration.adapterConfig !== undefined && { config: registration.adapterConfig }),
    hasSecretRef: registration.secretRef !== undefined,
  });
}

/**
 * What's wrong with the registration's own fields, before its adapter's:
 * `send_traceparent`, when present, is a boolean. The runtime, not the
 * adapter, reads it.
 */
export function registrationProblems(body: {
  readonly send_traceparent?: unknown;
}): readonly AdapterConfigProblem[] {
  const value = body.send_traceparent;
  return value === undefined || typeof value === 'boolean'
    ? []
    : [{ path: '/send_traceparent', message: 'send_traceparent must be true or false.' }];
}

/**
 * The 422's message: one sentence naming the provider, its adapter and the
 * first problem, with a count of the rest (`details.issues` lists each).
 * A problem with the registration's own fields names the provider alone.
 */
function refusalOf(
  providerId: string,
  adapterId: string,
  problems: readonly AdapterConfigProblem[],
): string {
  const [first, ...rest] = problems;
  if (first === undefined) return `Provider "${providerId}" doesn't fit adapter ${adapterId}.`;
  if (first.path === '/adapter_id') return first.message;
  const more = rest.length > 0 ? ` (and ${rest.length} more)` : '';
  const what = first.message.replace(/\.$/, '');
  return REGISTRATION_PATHS.has(first.path)
    ? `Provider "${providerId}": ${what}${more}.`
    : `Provider "${providerId}" doesn't fit adapter ${adapterId}: ${what}${more}.`;
}

/** The paths `registrationProblems` reports: the registration's own fields, not its adapter's. */
const REGISTRATION_PATHS: ReadonlySet<string> = new Set(['/send_traceparent']);

/**
 * Parse the optional `adapter_config` on the register request body: a
 * flat object of string, number or boolean values. Credentials don't
 * belong here (they ride on `secret_ref`); the adapter checks its own keys
 * (`configProblems`).
 */
function parseAdapterConfig(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly value: AdapterConfig | undefined }
  | { readonly kind: 'err'; readonly error: string } {
  if (raw === undefined || raw === null) return { kind: 'ok', value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'err', error: '`adapter_config` must be an object.' };
  }
  const bad = Object.entries(raw).filter(
    ([, v]) => typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean',
  );
  if (bad.length > 0) {
    return {
      kind: 'err',
      error: `\`adapter_config\` values must be strings, numbers or booleans (${bad.map(([k]) => k).join(', ')}).`,
    };
  }
  return { kind: 'ok', value: raw as AdapterConfig };
}

/**
 * Parse the optional `secret_ref` on the register request body.
 * Accepts `undefined` (no credential — dev-echo, local models),
 * `{envName: string, name: string}`, or rejects any other shape.
 */
function parseSecretRef(
  raw: unknown,
):
  | { readonly kind: 'ok'; readonly value: ProviderSecretRef | undefined }
  | { readonly kind: 'err'; readonly error: string } {
  if (raw === undefined || raw === null) return { kind: 'ok', value: undefined };
  if (typeof raw !== 'object') {
    return { kind: 'err', error: '`secret_ref` must be an object with `envName` and `name`.' };
  }
  const r = raw as { readonly envName?: unknown; readonly name?: unknown };
  if (typeof r.envName !== 'string' || r.envName.length === 0) {
    return { kind: 'err', error: '`secret_ref.envName` must be a non-empty string.' };
  }
  if (typeof r.name !== 'string' || r.name.length === 0) {
    return { kind: 'err', error: '`secret_ref.name` must be a non-empty string.' };
  }
  return { kind: 'ok', value: { envName: r.envName, name: r.name } };
}
