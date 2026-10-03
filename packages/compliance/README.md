# `@kindgi/compliance`

Type contract for compliance evidence in Kindgi: the `Evidence` wire record, the `ComplianceEvidenceGenerator` interface that records evidence from finished runs and produces signed export bundles, and the classifier that decides retention, signing, and export per event kind. It also ships a few small functions: a pure audit-event-to-evidence transform and helpers that write `env-*` / `secret-*` audit events. The generator is implemented by the Kindgi runtime (or by a caller-supplied implementation) and consumed by [`@kindgi/api`](../api/).

## Purpose

Evidence is a classification lens over the audit-event stream from [`@kindgi/audit-events`](../audit-events/): there is one write path for audit events, and the classifier selects which kinds are retained, signed, and exported. This package fixes the shapes on both sides of that lens: the record regulators and auditors read (matching `compliance-evidence.schema.json` in [`@kindgi/specs`](../specs/)), the signed bundle envelope they verify, and the run summary callers hand to the generator. Run summaries are redaction-safe by construction: model prompts and tool arguments appear only as caller-supplied hashes, and raw messages are embedded only with an explicit opt-in.

## Exports

- **Evidence record**
  - **`Evidence`** (alias **`ComplianceEvidence`**) — `id`, `tenantId`, `projectId?`, `kind`, `timestamp`, `actor?`, `subject?`, `outcome?`, `payload`, `provenanceRef?`, `signature?`.
  - **`EvidenceKind`** — one of **`EVIDENCE_KINDS`** (the built-in kinds, e.g. `'authz-decision'`, `'run-outcome'`, `'secret-rotated'`, `'hitl-decision'`) or any other string. Consumers must tolerate unknown kinds.
  - **`EvidenceActor`** (with **`ActorKind`**), **`EvidenceSubject`**, **`EvidenceOutcome`**, **`EvidencePayload`** (always carries a numeric `version`), **`EvidenceSignature`** (Ed25519), **`ProvenanceRef`**.
- **Generator**
  - **`ComplianceEvidenceGenerator`** — `recordFromRun(options)`, `exportSigned(tenantId, filter, signingKeyId)`, `describe()`.
  - **`RecordFromRunOptions`** — `tenantId`, `projectId`, `runId`, `kind`, `runContext`, optional actor/subject/outcome/id/timestamp/`provenanceRef`, and `rawMessages` (embedded only when `allowRawMessages: true`).
  - **`RunEvidenceContext`** — `status`, timing, agent/flow ids, and lists of **`ModelCallSummary`**, **`ToolInvocationSummary`**, **`GuardrailResultSummary`**; plus caller-redacted `failureMessage` and `extra`.
  - **`EvidenceFilter`** (AND-composed; `evidenceKinds: []` matches nothing), **`EvidencePage`**, **`SignedEvidenceBundle`** (base64 canonical `bundle`, `signature`, PEM `publicKey`, `signingKeyId`, `canonicalization: 'sorted-key-json'`), **`EvidenceBundleBody`** (the decoded `bundle`).
- **Provider seam** — **`ComplianceProvider`** (`emit`, `list`, `describe`) for adapters that forward evidence to an external system, with **`EmitEvidenceInput`**, **`ListEvidenceFilter`**, and **`EvidenceSigner`** (`(bytes, tenantId) => Promise<EvidenceSignature>`).
- **Classifier**
  - **`ComplianceClassifierFile`** — `{ version: 1, default, byKind }`, the file format.
  - **`Classification`** — `retention` (`days`, `onDenyDays?`, `legalHold?`), `signed`, `exportable`.
  - **`LoadedClassifier`** — `file` plus `resolve(kind)`, which returns the per-kind entry or the default.
- **`auditEventToEvidence(event)`** — pure transform from an `AuditEvent` to an `Evidence` record (unwraps the `{ v, doc }` payload envelope).
- **`emitResolveEvent(input)`** / **`emitLifecycleEvent(input)`** — append `env-resolved` / `secret-resolved` and `env-set` / `secret-rotated` / … audit events to an `AuditEventBinding`. Payloads carry metadata only (scope, name, version, caller), never the value. Failures are logged with `console.warn` and never thrown. Inputs: **`EmitResolveEventInput`**, **`EmitLifecycleEventInput`**, **`ResolveContext`**.
- **Errors** — **`ComplianceError`** union of `InvalidEvidenceError`, `PersistenceError`, `SignerFailureError`, `SigningKeyMissingError`, `SigningFailureError`, `InvalidCursorError`, `ProjectNotFoundError`, `UnsupportedVersionError`, each with a `code`. **`EmitResult`** and **`ListResult`** are the `ComplianceProvider` return types.

## Example

```ts
import type {
  ComplianceEvidenceGenerator,
  EvidenceBundleBody,
  RunEvidenceContext,
} from '@kindgi/compliance';

// tenantId, projectId, runId, signingKeyId, startedAt, endedAt, promptHash and
// argsHash come from the finished run and the deployment's configuration.
async function recordAndExport(generator: ComplianceEvidenceGenerator): Promise<void> {
  // Redaction-safe run summary: hashes and counts, no prompt or argument text.
  const runContext: RunEvidenceContext = {
    status: 'completed',
    startedAt,
    endedAt,
    modelCalls: [{ provider: 'acme', model: 'acme-chat-2', promptHash, inputTokens: 812, outputTokens: 164 }],
    toolInvocations: [{ toolId: 'crm.lookup', argsHash, outcome: 'succeeded', durationMs: 84 }],
    guardrailResults: [{ guardrailId: 'pii-scan', verdict: 'pass' }],
  };

  const recorded = await generator.recordFromRun({
    tenantId,
    projectId,
    runId,
    kind: 'run-outcome', // the caller decides the kind; it is not inferred
    outcome: 'succeeded',
    actor: { kind: 'agent', id: 'support-triage' },
    runContext,
  });
  if (recorded.kind === 'err') throw new Error(`${recorded.error.code}: ${recorded.error.message}`);

  const exported = await generator.exportSigned(
    tenantId,
    { runId, evidenceKinds: ['run-outcome', 'authz-decision'] },
    signingKeyId,
  );
  if (exported.kind === 'err') throw new Error(`${exported.error.code}: ${exported.error.message}`);

  // `bundle` is base64 of the exact canonical JSON bytes that were signed.
  const body = JSON.parse(
    Buffer.from(exported.value.bundle, 'base64').toString('utf8'),
  ) as EvidenceBundleBody;
  console.log(body.recordCount, exported.value.signingKeyId, exported.value.algorithm);
}
```

## Non-goals

- **No generator, persistence, or classifier parser.** This package defines the interfaces and the classifier file format. Implementing `ComplianceEvidenceGenerator`, storing evidence, and loading a classifier file into a `LoadedClassifier` are left to the Kindgi runtime or the caller.
- **No kind inference.** `recordFromRun` files evidence under the `kind` the caller passes; it does not derive one from the run outcome.
- **No content scanning.** `failureMessage` and `extra` are embedded as given; redacting them is the caller's responsibility.
- **No closed set of kinds.** `EVIDENCE_KINDS` lists the built-in kinds; any audit-event kind the classifier marks exportable can appear as evidence.

## Related

- [`@kindgi/audit-events`](../audit-events/) — the `AuditEvent` stream evidence is derived from.
- [`@kindgi/api`](../api/) — mounts the compliance routes from `auditEvents`, `complianceClassifier`, and `complianceGenerator`.
- [`@kindgi/specs`](../specs/) — `compliance-evidence.schema.json`.
