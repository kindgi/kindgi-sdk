# `@kindgi/types` — Specification

*Deep spec for humans. Complements the JSON Schemas in `@kindgi/specs` which are wire contracts.*

## Design principles

1. **Type-only, with one exception.** Every export is a `type` except `makeEnvName`, the validated `EnvName` factory. Consumers pay zero runtime cost for using branded types.
2. **Nominal typing via brands.** Every entity ID is nominally distinct from any other. A `TenantId` and a `UserId` are both structurally `string`, but statically incompatible. Cross-boundary confusion becomes a compile error.
3. **Correspondence to JSON Schemas.** Most entity kinds in `@kindgi/specs/*.schema.json` have a branded ID here (eval suites, for one, do not). If a schema defines a new entity kind, its ID goes here. Some IDs (e.g. `ConversationId`, `TriggerId`) name entities that have no schema.
4. **Two or more consumers rule.** A type belongs in `@kindgi/types` only if two or more packages use it. Package-scoped types stay in that package.

## Brand mechanism

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };
type TenantId = Brand<string, 'TenantId'>;
```

The `__brand` field is a phantom marker — it does not exist at runtime. TypeScript treats `TenantId` and `UserId` as incompatible because their brand strings differ, even though both are structurally `string`.

### Construction

A branded type is constructed by cast:

```ts
const tenant = 'abc' as TenantId;
```

There is no runtime constructor, except `makeEnvName(raw)`, which returns an `EnvName` or `null` when `raw` breaks the `[a-z][a-z0-9-]{0,62}` grammar. Other validated construction (`"abc"` matches the tenant-id pattern before it's accepted) belongs in `@kindgi/schema`.

### Interop with strings

Branded types are usable anywhere a `string` is, because they are structurally strings:

```ts
const t: TenantId = 'abc' as TenantId;
t.length;        // number
t + '-suffix';   // string (unbranded — the operation drops the brand)
```

The brand is lost by any operation that produces a new string. This is intentional — brands convey provenance, not identity, so re-branding requires re-casting.

## The canonical scope hierarchy

Kindgi models five scoping constructs. Every pack and every UI can rename these in its own vernacular (legal → "matter", HR → "case"), but Kindgi's code and specs always use the canonical terms.

```
Tenant            — sovereignty boundary (customer). Cross-tenant access is absolutely denied.
├── Org (opt)     — optional structural subdivision (litigation dept, cardiology). Small tenants ignore.
├── Team          — people-group (a working group). Users can belong to many teams.
│                   Teams hold relations on projects; users inherit access via team membership.
└── Project       — scoped work-context (matter/case/engagement/episode).
    │              Collaborators are users OR teams. Project-level roles (owner, editor, viewer).
    └── Content   — facts, artifacts, runs, blobs. Every piece of content belongs to a project.
```

Two things worth emphasizing:

**Team and Project are orthogonal.** Team is people; Project is context. Same team works on many projects; same project can have many teams collaborating. Conflating them is the classic anti-pattern (Slack channels, most groupware) — separating them cleanly is what makes cross-vertical mapping trivial.

**Team ≠ Org.** Org is *structural* (a firm's departments, a hospital's specialties). Team is *operational* (a specific working group formed for specific projects). A large firm has few orgs and many teams; a small firm has no orgs and a handful of teams.

## Category tour

### IDs (`src/ids.ts`)

Entity kinds that appear in `@kindgi/specs/*.schema.json` and their branded IDs; the table lists the main ones (see `src/ids.ts` for the full set, including `ConversationId`, `ReviewerId`, `SupervisorId`, `ObservationId`, `FixProposalId`, `AuditBundleId`, `ScheduleId`, `ProviderId`, `ApiTokenId`, `WebhookId`, `WebhookEndpointId`, `WebhookEventId`, `WebhookDeliveryId`, `InstallationId`, `SigningKeyId`, `TriggerId`):

| Schema entity | Type |
|---|---|
| Tenant (scope in `memory`, `policy`, `blob`, etc.) | `TenantId` |
| User | `UserId` |
| Organization (optional structural subdivision) | `OrgId` |
| Team (people-group; holds relations, not context) | `TeamId` |
| Project (matter/case/engagement, vertical-agnostic) | `ProjectId` |
| Thread | `ThreadId` |
| Session | `SessionId` |
| Run (one execution of a flow) | `RunId` |
| Flow | `FlowId` |
| Flow node | `NodeId` |
| Flow edge | `EdgeId` |
| Agent | `AgentId` |
| Tool | `ToolId` |
| Guardrail | `GuardrailId` |
| Policy document | `PolicyId` |
| Pack manifest | `PackId` |
| Event | `EventId` |
| Fact | `FactId` |
| Log entry | `LogEntryId` |
| Artifact (agent output) | `ArtifactId` |
| Provenance DAG | `ProvenanceId` |
| Event subscription | `SubscriptionId` |
| Approval request | `ApprovalId` |
| Compliance evidence bundle | `ComplianceEvidenceId` |
| Wait token | `WaitTokenId` |
| Dataset | `DatasetId` |

### Temporal (`src/temporal.ts`)

- `Timestamp` — always an ISO 8601 UTC string with `Z` suffix. Kept as a string (not `Date`) for JSON serializability and deterministic lexicographic ordering (which matches temporal order for well-formed ISO 8601).
- `DurationMs` — branded `number` for millisecond durations.
- `IsoDuration` — branded string for ISO 8601 durations (e.g. `PT30S`, `P1D`). Preferred in declarative artifacts.

### Hash & signature (`src/hash.ts`)

- `ContentHash` — `<algo>:<hex>` format (currently `sha256:<64 hex>`). Consumers must reject unknown algorithms so future migration to sha3/blake3 is non-breaking.
- `SignatureValue` — base64 (padded, non-URL-safe) Ed25519 signature.
- `KeyId` — opaque, provider-qualified identifier for a signing key; interpreted by whichever key provider resolves it. Keys in a `SigningKeyBinding` (`@kindgi/crypto`) are addressed by `SigningKeyId` instead.

### References (`src/refs.ts`)

- `BlobRef` — handle to bytes in object storage. Contains provider + bucket + key + size + hash + content type + tenant + timestamps. Never constructed by hand; always produced by the storage layer that wrote the bytes.
- `DatasetRef` — handle to a versioned dataset: a collection of memory Facts of one declared type (e.g. eval corpora).

### Result (`src/result.ts`)

Discriminated union with runtime `kind: 'ok' | 'err'` tag. The codebase's standard shape for functions that can fail expectedly (as opposed to throwing for unexpected failure).

```ts
type Result<T, E> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly error: E };
```

Two helper types:
- `OkOf<R>` — extract success type from a Result.
- `ErrOf<R>` — extract error type from a Result.

### Version (`src/version.ts`)

- `Semver` — branded string matching `<major>.<minor>.<patch>[-prerelease]`.
- `SchemaMajor` — branded positive integer for use in schema `$id` paths.
- `VersionedRef<Id>` — combines a branded ID with an exact `Semver`, used for pinning artifacts to specific versions.

### Lists (`src/filter.ts`)

- `Cursor` — opaque pagination cursor; pass it back verbatim.
- `Filter<TStatus>` — shared list-filter shape: `status`, `since`, `until`, `limit`, `cursor`.
- `Page<T>` — shared list-result envelope: `{ items, nextCursor?, truncated? }`.

## Test approach

Type-only tests via vitest typecheck mode (`vitest run --typecheck`):

- `.test-d.ts` files under `src/` are compiled by TS in typecheck mode.
- Use `expectTypeOf(x).toEqualTypeOf<T>()` for positive assertions.
- Use `// @ts-expect-error` immediately above lines that MUST fail compilation.
- No runtime assertions in this package — the one runtime export, `makeEnvName`, is exercised by the `@kindgi/env-inmemory` tests.

Coverage includes:
- ID nominal distinctness (positive + negative).
- ID structural string behavior (length, `.toString()`).
- Result narrowing via `kind` discriminator.
- Result readonly semantics.
- BlobRef required-field enforcement.
- Brand utility composition for pack-scoped IDs.

## Change discipline

Adding a new branded ID or shape is non-breaking. Removing or renaming one is a semver major bump for this package — downstream consumers reference by import name, and rename would break the world.

When a new entity kind lands in a `@kindgi/specs/*.schema.json`, its branded ID **must** be added here in the same PR. Enforced by review, not by tooling.
