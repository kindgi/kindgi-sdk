# `@kindgi/types`

Foundational TypeScript types shared across Kindgi. Almost entirely type-only: the single runtime export is `makeEnvName`, the validated constructor for `EnvName`.

## Purpose

Provide the canonical, branded ID types and reference shapes used across Kindgi, preventing whole classes of bugs at compile time (you cannot pass a `TenantId` where a `UserId` is expected) with no runtime cost.

## Exports

- **Branded IDs** — `TenantId`, `UserId`, `OrgId`, `TeamId`, `ProjectId`, `ThreadId`, `ConversationId`, `SessionId`, `RunId`, `FlowId`, `NodeId`, `EdgeId`, `AgentId`, `ToolId`, `GuardrailId`, `PolicyId`, `PackId`, `EventId`, `FactId`, `LogEntryId`, `ArtifactId`, `ProvenanceId`, `SubscriptionId`, `ApprovalId`, `ReviewerId`, `SupervisorId`, `ObservationId`, `FixProposalId`, `AuditBundleId`, `ComplianceEvidenceId`, `WaitTokenId`, `DatasetId`, `ScheduleId`, `ProviderId`, `ApiTokenId`, `WebhookId`, `WebhookEndpointId`, `WebhookEventId`, `WebhookDeliveryId`, `InstallationId`, `SigningKeyId`, `TriggerId`.
- **Environment names** — `EnvName` (`[a-z][a-z0-9-]{0,62}`) and `makeEnvName(raw)`, which returns the branded value or `null` on a grammar violation.
- **Brand utility** — `Brand<T, B>` for constructing pack-scoped IDs (e.g. a `MatterId` in a pack that tracks legal matters).
- **Temporal** — `Timestamp` (ISO 8601 UTC branded string), `DurationMs`, `IsoDuration`.
- **Hash & signature** — `ContentHash` (`sha256:<hex>`), `SignatureValue` (base64 Ed25519), `KeyId`.
- **References** — `BlobRef` (blob provider handle), `DatasetRef`.
- **Result** — `Result<T, E>` discriminated union with runtime `kind` tag, plus `OkOf<R>` / `ErrOf<R>` extractors.
- **Version** — `Semver`, `SchemaMajor`, `VersionedRef<Id>`.
- **Lists** — `Cursor` (opaque pagination cursor), `Filter<TStatus>` (shared list-filter shape), `Page<T>` (`{ items, nextCursor?, truncated? }`).

## Example

```ts
import type { TenantId, Result, BlobRef, ContentHash } from '@kindgi/types';

function ingest(tenantId: TenantId, ref: BlobRef): Result<void, { code: string }> {
  if (ref.tenantId !== tenantId) {
    return { kind: 'err', error: { code: 'cross-tenant-blob' } };
  }
  return { kind: 'ok', value: undefined };
}

const hash: ContentHash = 'sha256:abc123...' as ContentHash;
```

## Non-goals

- **No runtime validation.** Branded types are compile-time only. Validation of wire payloads lives in `@kindgi/schema`; `makeEnvName` is the one exception.
- **No constructors.** Construction is by `as` cast, except `makeEnvName` for `EnvName`.
- **No business logic.** Only types that are used by two or more packages belong here. Package-scoped types stay in that package.
