// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result } from '@kindgi/types';

import type { CapabilityError, CapabilityUnsatisfiableError } from './errors.js';
import { DEFAULT_CAPABILITY_KIND } from './types.js';
import type {
  Capability,
  ComparisonOp,
  ModelProvider,
  Preference,
  ProviderModelPick,
  RejectionReason,
  Requirement,
  RoutingDecision,
  TenantPolicy,
  UpperBoundOp,
} from './types.js';

/**
 * Input to `route()`. Callers pass the pre-scoped provider slice (e.g.
 * `registry.list(tenantId)`) plus the capability declaration; the
 * router expands each provider into one entry per exposed model,
 * filters at the `(provider, model)` tuple level, ranks by
 * preference, and returns the top pick.
 */
export interface RouteInput {
  readonly capability: Capability;
  readonly providers: readonly ModelProvider[];
  readonly tenantPolicy?: TenantPolicy;
  /**
   * Optional soft hint — the router prefers tuples whose provider id
   * matches. When the preferred provider is absent or filtered out,
   * the router falls back to normal `capability.prefer`-based
   * ranking. Typical source: `Agent.preferredProvider`.
   */
  readonly preferredProvider?: string;
  /**
   * Optional soft hint — the router prefers tuples whose
   * `ModelInfo.name` matches. Combined with `preferredProvider`:
   *
   *   - Both set → promote the exact `(provider, model)` tuple.
   *   - Only `preferredModel` set → promote any tuple whose model
   *     matches, across every provider.
   *   - Only `preferredProvider` set → promote every model of that
   *     provider.
   *
   * Typical source: `Agent.preferredModel`.
   */
  readonly preferredModel?: string;
}

/**
 * Route a capability declaration against a provider slice. Returns
 * the highest-ranked `(provider, model)` tuple satisfying every
 * `needs` constraint plus tenant policy, with alternates in ranked
 * order for failover.
 *
 * The router is pure: given the same (capability, providers, policy)
 * it always produces the same decision. Ties are broken lexically on
 * `(providerId, modelName)`, so deterministic replay from journal is
 * guaranteed.
 *
 * A fallback provider (`metadata.fallback`) is considered only when no
 * other provider satisfies the capability; the decision then says so
 * (`fallback: true`). Its tuples are never alternates to a regular pick.
 *
 * Tenant scoping happens BEFORE the router — callers pass a
 * `providers` array that already reflects the target tenant. This
 * keeps the router decoupled from whether the underlying registry is
 * in-memory, postgres-backed, or a composed view.
 */
export function route(input: RouteInput): Result<RoutingDecision, CapabilityError> {
  const survivors = matchTuples(input);
  if (survivors.kind === 'err') return survivors;

  const regular = survivors.value.filter((t) => t.provider.metadata.fallback !== true);
  const fallback = regular.length === 0;
  const candidates = fallback ? survivors.value : regular;
  const ranked = rankByPreference(candidates, input.capability.prefer ?? []);
  const finalOrder = applyPreferredHints(ranked, input.preferredProvider, input.preferredModel);
  const top = finalOrder[0];
  if (top === undefined) {
    // Should be caught by matchTuples, but defensive.
    return unsatisfiable([], input.tenantPolicy);
  }
  return {
    kind: 'ok',
    value: {
      provider: top.provider,
      model: top.model,
      reason: buildReason(top, input, fallback),
      alternates: finalOrder.slice(1),
      fallback,
    },
  };
}

/**
 * Expand every provider into one entry per exposed model. Emits
 * `(provider, model)` tuples in deterministic order: providers in
 * input order, models in the order they appear on each provider's
 * `metadata.models[]`. Downstream sort determines the final tiebreak.
 */
function expandTuples(providers: readonly ModelProvider[]): readonly ProviderModelPick[] {
  const out: ProviderModelPick[] = [];
  for (const p of providers) {
    for (const m of p.metadata.models) {
      out.push({ provider: p, model: m });
    }
  }
  return out;
}

/**
 * Hard-filter `(provider, model)` tuples against `capability.needs`
 * and `tenantPolicy`. Returns the surviving set (order preserved from
 * `expandTuples`; the ranker sorts). On empty result, returns
 * `capability-unsatisfiable` with per-requirement rejection reasons
 * for diagnosis.
 *
 * Filter semantics per requirement:
 *   - `feature` / `contextWindow` / `costPerCall` / `p95LatencyMs`
 *     read from `ModelInfo` — filter at the model level.
 *   - `region` reads from `ProviderMetadata.region` — filter at the
 *     provider level (all models of one connection share region).
 *   - `providers` allow/deny reads `ProviderMetadata.id`.
 *   - `models` allow/deny reads `ModelInfo.name`.
 */
export function matchTuples(
  input: RouteInput,
): Result<readonly ProviderModelPick[], CapabilityUnsatisfiableError> {
  const tuples = expandTuples(input.providers);
  const rejections = new Map<string, string[]>();
  const perRequirementReasons: CapabilityUnsatisfiableError['reasons'][number][] = [];

  const requestedKind = input.capability.kind ?? DEFAULT_CAPABILITY_KIND;
  const requirements: readonly {
    readonly label: string;
    readonly test: (t: ProviderModelPick) => RejectionReason | null;
  }[] = [
    // Kind gate runs first so providers of the wrong resource kind are
    // rejected with a clear reason instead of being pinned to a specific
    // needs-based diagnostic.
    {
      label: `capability.kind = ${requestedKind}`,
      test: (t): RejectionReason | null => {
        const providerKind = t.provider.metadata.capabilityKind ?? DEFAULT_CAPABILITY_KIND;
        if (providerKind === requestedKind) return null;
        return {
          code: 'capability-kind-mismatch',
          message: `provider kind "${providerKind}" does not match requested "${requestedKind}"`,
          observed: providerKind,
          wanted: requestedKind,
        };
      },
    },
    ...input.capability.needs.map((req) => ({
      label: describeRequirement(req),
      test: (t: ProviderModelPick): RejectionReason | null => matchRequirement(req, t),
    })),
    ...tenantPolicyRequirements(input.tenantPolicy),
  ];

  for (const t of tuples) {
    const key = tupleKey(t);
    for (const r of requirements) {
      const rejection = r.test(t);
      if (rejection !== null) {
        const existing = rejections.get(key) ?? [];
        existing.push(`${r.label} → ${rejection.message}`);
        rejections.set(key, existing);
      }
    }
  }

  const survivors = tuples.filter((t) => (rejections.get(tupleKey(t))?.length ?? 0) === 0);
  if (survivors.length > 0) return { kind: 'ok', value: survivors };

  // Build per-requirement diagnostic. Skip requirements every tuple
  // already satisfied — they add noise (e.g. the kind gate matches
  // every llm-inference provider when the caller asked for llm-inference).
  for (const r of requirements) {
    const satisfying: string[] = [];
    const rejecting: { readonly id: string; readonly reason: RejectionReason }[] = [];
    for (const t of tuples) {
      const failure = r.test(t);
      const id = tupleKey(t);
      if (failure === null) satisfying.push(id);
      else rejecting.push({ id, reason: failure });
    }
    if (rejecting.length === 0) continue;
    perRequirementReasons.push({
      requirement: r.label,
      satisfyingProviders: satisfying,
      rejectingProviders: rejecting,
    });
  }
  return unsatisfiable(perRequirementReasons, input.tenantPolicy);
}

/** Stable tuple identifier — `providerId/modelName`. Used in rejection diagnostics. */
function tupleKey(t: ProviderModelPick): string {
  return `${t.provider.metadata.id}/${t.model.name}`;
}

/**
 * Rank tuples by summed weight of matched preferences, stable sort.
 * Equal scores tiebreak on the provider id, then the provider's
 * `defaultModel` first, then the model name, so replay is deterministic
 * even when multiple tuples tie.
 */
function rankByPreference(
  tuples: readonly ProviderModelPick[],
  prefs: readonly Preference[],
): readonly ProviderModelPick[] {
  if (prefs.length === 0) return [...tuples].sort(compareTuplesLex);
  const scored = tuples.map((t) => ({ t, score: preferenceScore(t, prefs) }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return compareTuplesLex(a.t, b.t);
  });
  return scored.map((s) => s.t);
}

function compareTuplesLex(a: ProviderModelPick, b: ProviderModelPick): number {
  const p = a.provider.metadata.id.localeCompare(b.provider.metadata.id);
  if (p !== 0) return p;
  const d = Number(isDefaultModel(b)) - Number(isDefaultModel(a));
  if (d !== 0) return d;
  return a.model.name.localeCompare(b.model.name);
}

/** The provider names this model as the one to use when nothing else decides. */
function isDefaultModel(t: ProviderModelPick): boolean {
  return t.provider.metadata.defaultModel === t.model.name;
}

function preferenceScore(t: ProviderModelPick, prefs: readonly Preference[]): number {
  let score = 0;
  const providerAttrs = t.provider.metadata.attributes;
  const modelFeatures = t.model.features;
  for (const pref of prefs) {
    if (
      modelFeatures.includes(pref.feature as never) ||
      providerAttrs?.includes(pref.feature) === true
    ) {
      score += pref.weight;
    }
  }
  return score;
}

/**
 * Apply the `preferredProvider` + `preferredModel` soft hints. Matching
 * tuples are promoted to the front while preserving the internal rank
 * order from `rankByPreference`. Neither hint is required — the
 * ranked order is returned untouched when both are absent.
 */
function applyPreferredHints(
  ranked: readonly ProviderModelPick[],
  preferredProvider: string | undefined,
  preferredModel: string | undefined,
): readonly ProviderModelPick[] {
  if (preferredProvider === undefined && preferredModel === undefined) return ranked;
  const matches = (t: ProviderModelPick): boolean => {
    if (preferredProvider !== undefined && t.provider.metadata.id !== preferredProvider) {
      return false;
    }
    if (preferredModel !== undefined && t.model.name !== preferredModel) return false;
    return true;
  };
  return [...ranked.filter(matches), ...ranked.filter((t) => !matches(t))];
}

/**
 * Test a single Requirement against a `(provider, model)` tuple.
 * Returns null on satisfaction, a structured `RejectionReason` on
 * rejection. Rejections flow into `CapabilityUnsatisfiableError.
 * reasons[].rejectingProviders[].reason` — consumers can switch on
 * `code` to route on specific failure modes.
 */
function matchRequirement(req: Requirement, t: ProviderModelPick): RejectionReason | null {
  const meta = t.provider.metadata;
  const model = t.model;
  if ('feature' in req) {
    if (model.features.includes(req.feature)) return null;
    return {
      code: 'missing-feature',
      message: `does not support feature "${req.feature}"`,
      feature: req.feature,
    };
  }
  if ('contextWindow' in req) {
    if (compare(model.contextWindow, req.contextWindow.op, req.contextWindow.value)) return null;
    return {
      code: 'context-window-mismatch',
      message: `contextWindow=${model.contextWindow} fails ${req.contextWindow.op}${req.contextWindow.value}`,
      observed: model.contextWindow,
      op: req.contextWindow.op,
      wanted: req.contextWindow.value,
    };
  }
  if ('costPerCall' in req) {
    const proxy = model.cost.promptUsdPer1kTokens;
    if (compare(proxy, req.costPerCall.op, req.costPerCall.usd)) return null;
    return {
      code: 'cost-exceeds-cap',
      message: `promptCost=$${proxy}/1k fails ${req.costPerCall.op}$${req.costPerCall.usd}`,
      observedUsdPer1k: proxy,
      op: req.costPerCall.op,
      wantedUsd: req.costPerCall.usd,
    };
  }
  if ('region' in req) {
    if (meta.region === req.region) return null;
    return {
      code: 'region-mismatch',
      message: `region "${meta.region}" != required "${req.region}"`,
      observed: meta.region,
      wanted: req.region,
    };
  }
  if ('p95LatencyMs' in req) {
    if (model.p95LatencyMs === undefined) {
      return { code: 'p95-latency-unknown', message: 'model does not report p95 latency' };
    }
    if (compareUpperBound(model.p95LatencyMs, req.p95LatencyMs.op, req.p95LatencyMs.value))
      return null;
    return {
      code: 'p95-latency-exceeds',
      message: `p95Latency=${model.p95LatencyMs}ms fails ${req.p95LatencyMs.op}${req.p95LatencyMs.value}ms`,
      observedMs: model.p95LatencyMs,
      op: req.p95LatencyMs.op,
      wantedMs: req.p95LatencyMs.value,
    };
  }
  if ('providers' in req) {
    if (req.providers.deny?.includes(meta.id) === true) {
      return {
        code: 'provider-on-denylist',
        message: 'provider on deny list',
        providerId: meta.id,
      };
    }
    if (req.providers.allow !== undefined && !req.providers.allow.includes(meta.id)) {
      return {
        code: 'provider-not-in-allowlist',
        message: 'provider not on allow list',
        providerId: meta.id,
        allow: req.providers.allow,
      };
    }
    return null;
  }
  if ('models' in req) {
    if (req.models.deny?.includes(model.name) === true) {
      return {
        code: 'model-on-denylist',
        message: 'model on deny list',
        modelName: model.name,
      };
    }
    if (req.models.allow !== undefined && !req.models.allow.includes(model.name)) {
      return {
        code: 'model-not-in-allowlist',
        message: 'model not on allow list',
        modelName: model.name,
        allow: req.models.allow,
      };
    }
    return null;
  }
  return { code: 'unknown-requirement', message: 'unknown requirement shape' };
}

/**
 * Compile tenant policy into synthetic requirements for the shared filter
 * loop. An allow list that is present restricts even when empty: `[]`
 * allows nothing (fail closed), the same as a capability requirement's
 * allow list. An empty deny list denies nothing.
 */
function tenantPolicyRequirements(policy: TenantPolicy | undefined): readonly {
  readonly label: string;
  readonly test: (t: ProviderModelPick) => RejectionReason | null;
}[] {
  if (policy === undefined) return [];
  const out: {
    readonly label: string;
    readonly test: (t: ProviderModelPick) => RejectionReason | null;
  }[] = [];
  const providerDeny = policy.providers?.deny;
  if (providerDeny !== undefined && providerDeny.length > 0) {
    const deny = providerDeny;
    out.push({
      label: `tenant.providers.deny[${deny.join(',')}]`,
      test: (t): RejectionReason | null =>
        deny.includes(t.provider.metadata.id)
          ? {
              code: 'tenant-denied',
              message: 'tenant policy deny',
              providerId: t.provider.metadata.id,
            }
          : null,
    });
  }
  const providerAllow = policy.providers?.allow;
  if (providerAllow !== undefined) {
    const allow = providerAllow;
    out.push({
      label: `tenant.providers.allow[${allow.join(',')}]`,
      test: (t): RejectionReason | null =>
        allow.includes(t.provider.metadata.id)
          ? null
          : {
              code: 'tenant-not-allowed',
              message: 'not on tenant allow list',
              providerId: t.provider.metadata.id,
            },
    });
  }
  const modelDeny = policy.models?.deny;
  if (modelDeny !== undefined && modelDeny.length > 0) {
    const deny = modelDeny;
    out.push({
      label: `tenant.models.deny[${deny.join(',')}]`,
      test: (t): RejectionReason | null =>
        deny.includes(t.model.name)
          ? {
              code: 'tenant-model-denied',
              message: 'tenant policy deny (model)',
              modelName: t.model.name,
            }
          : null,
    });
  }
  const modelAllow = policy.models?.allow;
  if (modelAllow !== undefined) {
    const allow = modelAllow;
    out.push({
      label: `tenant.models.allow[${allow.join(',')}]`,
      test: (t): RejectionReason | null =>
        allow.includes(t.model.name)
          ? null
          : {
              code: 'tenant-model-not-allowed',
              message: 'not on tenant model allow list',
              modelName: t.model.name,
            },
    });
  }
  if (policy.regionAllow !== undefined) {
    const regions = policy.regionAllow;
    out.push({
      label: `tenant.regionAllow[${regions.join(',')}]`,
      test: (t): RejectionReason | null =>
        regions.includes(t.provider.metadata.region)
          ? null
          : {
              code: 'tenant-region-not-allowed',
              message: `region "${t.provider.metadata.region}" not in tenant allow list`,
              observed: t.provider.metadata.region,
              allow: regions,
            },
    });
  }
  if (policy.maxCostPerCallUsd !== undefined) {
    const cap = policy.maxCostPerCallUsd;
    out.push({
      label: `tenant.maxCostPerCallUsd<=${cap}`,
      test: (t): RejectionReason | null =>
        t.model.cost.promptUsdPer1kTokens <= cap
          ? null
          : {
              code: 'tenant-cost-cap-exceeded',
              message: `promptCost/1k=$${t.model.cost.promptUsdPer1kTokens} > tenant cap $${cap}`,
              observedUsd: t.model.cost.promptUsdPer1kTokens,
              capUsd: cap,
            },
    });
  }
  if (policy.maxTokensPerCall !== undefined) {
    const cap = policy.maxTokensPerCall;
    out.push({
      label: `tenant.maxTokensPerCall<=${cap}`,
      test: (t): RejectionReason | null =>
        t.model.contextWindow >= cap
          ? null
          : {
              // Reuse context-window-mismatch for tenant-side context caps.
              code: 'context-window-mismatch',
              message: `contextWindow=${t.model.contextWindow} < tenant cap ${cap}`,
              observed: t.model.contextWindow,
              op: '>=',
              wanted: cap,
            },
    });
  }
  return out;
}

function compare(actual: number, op: ComparisonOp, target: number): boolean {
  switch (op) {
    case '>=':
      return actual >= target;
    case '>':
      return actual > target;
    case '=':
      return actual === target;
    case '<=':
      return actual <= target;
    case '<':
      return actual < target;
  }
}

function compareUpperBound(actual: number, op: UpperBoundOp, target: number): boolean {
  return op === '<=' ? actual <= target : actual < target;
}

function describeRequirement(req: Requirement): string {
  if ('feature' in req) return `feature:${req.feature}`;
  if ('contextWindow' in req)
    return `contextWindow${req.contextWindow.op}${req.contextWindow.value}`;
  if ('costPerCall' in req) return `costPerCall${req.costPerCall.op}$${req.costPerCall.usd}`;
  if ('region' in req) return `region=${req.region}`;
  if ('p95LatencyMs' in req) return `p95LatencyMs${req.p95LatencyMs.op}${req.p95LatencyMs.value}`;
  if ('providers' in req) {
    const allow = req.providers.allow?.join(',') ?? '';
    const deny = req.providers.deny?.join(',') ?? '';
    return `providers{allow:[${allow}]deny:[${deny}]}`;
  }
  if ('models' in req) {
    const allow = req.models.allow?.join(',') ?? '';
    const deny = req.models.deny?.join(',') ?? '';
    return `models{allow:[${allow}]deny:[${deny}]}`;
  }
  return 'unknown';
}

function buildReason(t: ProviderModelPick, input: RouteInput, fallback: boolean): string {
  const parts = [
    `picked "${t.provider.metadata.id}"/"${t.model.name}"`,
    `satisfies ${input.capability.needs.length} constraint(s)`,
  ];
  if (fallback) parts.push('a fallback provider — no other registered provider satisfies it');
  if (input.tenantPolicy !== undefined) parts.push('respects tenant policy');
  const prefs = input.capability.prefer;
  if (prefs !== undefined && prefs.length > 0)
    parts.push(`ranked top of ${prefs.length} preference(s)`);
  return parts.join(', ');
}

function unsatisfiable(
  reasons: CapabilityUnsatisfiableError['reasons'],
  tenantPolicy: TenantPolicy | undefined,
): Result<never, CapabilityUnsatisfiableError> {
  return {
    kind: 'err',
    error: {
      code: 'capability-unsatisfiable',
      message: 'No registered provider satisfies the capability declaration',
      reasons,
      ...(tenantPolicy !== undefined && { tenantId: tenantPolicy.tenantId }),
    },
  };
}
