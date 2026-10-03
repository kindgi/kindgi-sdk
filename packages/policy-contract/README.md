# `@kindgi/policy-contract`

Type contract for the tenant policy catalog: the `Policy` wire shape, the `PolicyRegistryBinding` storage interface, the executor interfaces that apply one policy kind at runtime, and the specs of the `retention`, `tool-errors` and `hitl` kinds with their validators. `createApp` in [`@kindgi/api`](../api/) mounts the `/v1/policies` routes when given a `PolicyRegistryBinding`, and [`@kindgi/agents`](../agents/) accepts a `PolicyRegistry` to apply `model-routing`, `tool-errors` and `hitl` policies. The bindings and executors themselves are implemented by the Kindgi runtime or by the embedding application.

## Purpose

Keep storing policies separate from enforcing them. The registry is a versioned, tenant-scoped catalog that treats `spec` as opaque JSON selected by `kind`. Each enforcement point binds a `PolicyExecutor` for one kind; the executor alone knows how to read that kind's `spec` and reduce a tenant's policies to one decision. The package depends only on `@kindgi/types`, so authoring code can reference these interfaces without pulling in a runtime.

## Exports

- **`PolicyRegistryBinding`** — versioned CRUD with the same shape as the agent and flow registries; opaque cursors.
  - `list(input)` — latest version per policy id, sorted by id; optional `policyKind` (exact) and `nameFilter` (prefix on id).
  - `get(input)` / `getVersion(input)` — latest active version, or one specific version including tombstoned ones; `null` when unknown.
  - `headExists(input)` — whether the id exists at all, so callers can tell a retired policy (no active version) from an unknown one.
  - `listVersions(input)` — versions of one id; active only unless `includeTombstoned: true`, in which case tombstoned rows carry `unregisteredAt`.
  - `publish(input)` — `ok`, or `already-registered` when the same `(policyId, version)` is published again.
  - `unregister(input)` — soft-tombstones one version; with no active version left the policy is retired until the next publish.
  - `reinstateVersion(input)` — idempotent un-tombstone; `ok` (with `wasTombstoned`) or `not-found`.
- **`Policy`** — `{ id, tenantId, version, kind, description?, spec }`. **`PolicyVersionRow`** adds `unregisteredAt?`.
- **I/O shapes** — `PolicyListInput`, `PolicyGetInput`, `PolicyGetVersionInput`, `PolicyListVersionsInput`, `PolicyPublishInput`, `PolicyUnregisterInput`, `PolicyReinstateVersionInput`, `PolicyPage`, `PolicyVersionPage`, `PolicyPublishOutcome`, `PolicyUnregisterOutcome`, `PolicyReinstateVersionOutcome`.
- **`POLICY_KINDS`** / **`PolicyKind`** — closed set: `access-control`, `model-routing`, `adapter-allowlist`, `rate-limit`, `retention`, `compliance`, `tool-errors`, `hitl`.
- **`PolicyExecutor<K, TCtx, TResult>`** — `kind` plus `evaluate(ctx)`. Fetches the tenant's policies of its kind (caching as it sees fit), merges them, and returns the decision for the caller to apply.
- **`PolicyRegistry`** — executors keyed by kind: `register(executor)`, `evaluate(kind, ctx)` (resolves to `undefined` when no executor is bound, so callers keep their default behavior), `boundKinds()`.
- **`PolicyEvalContext`** — the minimum context every executor receives: `{ tenantId }`.
- **Retention** — `RetentionSpec` (`{ domain, graceSeconds, mode }`), `RETENTION_DOMAINS` / `RetentionDomain` (the tombstoning domains plus a `'*'` wildcard), and `validateRetentionSpec(input)`, which returns `{ kind: 'ok', value }` or `{ kind: 'err', error: RetentionSpecValidationError }`. `graceSeconds` counts from the tombstoned row's `unregisteredAt`: `0` purges on the next sweep, `-1` never purges. `mode: 'archive'` is reserved and rejected with `unsupported-mode`.
- **Tool errors** — `ToolErrorsSpec` (`{ maxRetries?, retryOn? }`), the spec of a `tool-errors` policy and an agent's `toolErrors`: how many failed tool calls a turn sends back to the model, for which `TOOL_ERROR_KINDS`. `MAX_TOOL_ERROR_RETRIES` (10), `validateToolErrorsSpec(input)`.
- **HITL** — `HitlSpec` (`{ maxTimeoutMs?, minReviewerRole?, tools? }`), the spec of a `hitl` policy: approval rules a tenant holds every agent to, only stricter than the agent's own — the shorter timeout, the higher reviewer role, and per tool id the stricter gate (`tools` maps a tool id to a `ToolHitlMode` or a `ToolHitlRule` `{ mode, requiredRole? }`). `TOOL_HITL_MODES` (`never_ask`, `ask_on_first_use`, `always_ask`, loosest first), `REVIEWER_ROLES` (`standard`, `senior`, `admin`, lowest first), `validateHitlSpec(input)` (issues carry JSON Pointer paths), `combineHitlSpecs(specs)` (one spec at least as strict as each), and the helpers `toolHitlRule`, `stricterToolHitlRule`, `higherRole`.
- **`validatePolicySpec(kind, spec)`** — the `PolicySpecIssue`s of a policy's `spec` under its kind's contract, for `tool-errors` and `hitl`; other kinds pass. The `/v1/policies` routes refuse a spec with issues.
## Example

```ts
import {
  validateRetentionSpec,
  type PolicyEvalContext,
  type PolicyExecutor,
  type PolicyRegistryBinding,
  type RetentionDomain,
  type RetentionSpec,
} from '@kindgi/policy-contract';

type RetentionPlan = ReadonlyMap<RetentionDomain, RetentionSpec>;

// Reduce a tenant's `retention` policies to one spec per domain.
function createRetentionExecutor(
  store: PolicyRegistryBinding,
): PolicyExecutor<'retention', PolicyEvalContext, RetentionPlan> {
  return {
    kind: 'retention',
    async evaluate({ tenantId }) {
      const plan = new Map<RetentionDomain, RetentionSpec>();
      const page = await store.list({ tenantId, policyKind: 'retention', limit: 100 });
      for (const policy of page.data) {
        // Retention specs live in a `{ v: 1, doc }` envelope on `Policy.spec`.
        const checked = validateRetentionSpec(policy.spec.doc);
        if (checked.kind === 'ok') plan.set(checked.value.domain, checked.value);
      }
      return plan;
    },
  };
}

// `store`, `policies` (a PolicyRegistry) and `tenantId` are supplied by the runtime.
await store.publish({
  tenantId,
  policy: {
    id: 'acme.retention.tools',
    tenantId,
    version: '1.0.0',
    kind: 'retention',
    spec: { v: 1, doc: { domain: 'tool', graceSeconds: 30 * 86_400, mode: 'purge' } },
  },
});

policies.register(createRetentionExecutor(store));
const plan = await policies.evaluate<PolicyEvalContext, RetentionPlan>('retention', { tenantId });
```

## Non-goals

- **Enforcement in the registry.** `PolicyRegistryBinding` is publish and read only; each consumer applies policy at its own boundary.
- **Validating every kind's `spec`.** The registry treats `spec` as opaque; deeper validation belongs to the executor for that kind. This package ships validators for `retention`, `tool-errors` and `hitl` only.
- **Implementations.** No binding, registry, or executor implementation is included — interfaces, constants, and pure validators and combinators.
- **Fetching or caching in `PolicyRegistry`.** Each executor decides how it loads and caches policies.

## Related

- [`@kindgi/api`](../api/) — the `/v1/policies` routes and re-exports of the catalog types.
- [`@kindgi/agents`](../agents/) — evaluates `model-routing`, `tool-errors` and `hitl` through a bound `PolicyRegistry`.
- [`@kindgi/types`](../types/) — `TenantId` and `Cursor`.
