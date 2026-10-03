# `@kindgi/provenance`

Types and pure functions for Kindgi provenance: the signed causal DAG recorded for a run. Build the DAG incrementally while a run executes, sign it with Ed25519, export it as canonical JSON, and verify it later with only a public key. Persistence sits behind `ProvenanceEmitBinding`, which a runtime adapter implements; everything else in this package is a pure function over the record.

## Purpose

Record what went into a run's output (inputs, prompts, retrievals, model calls, tool calls, guardrail checks, waits and resumes) in a form that a third party can check without access to the system that produced it. Nodes can carry content hashes, the record carries one signature over a canonical byte projection, and verification needs nothing but the record and a public key.

## Exports

- **Record shape**
  - **`Provenance`** — one record per run: `id`, `runId`, `tenantId`, `version`, `createdAt`, optional `flowRef` (`{ id, version }`), `nodes`, `edges`, optional `signature`.
  - **`ProvenanceNode`** — `id`, `kind`, `timestamp`, and optional `actor`, `contentHash`, `contentRef` (for payloads stored outside the record), `modelVersion`, `policyDecisionId`, `attributes`.
  - **`ProvenanceEdge`** — `{ from, to, kind }`.
  - **`NODE_KINDS`** / **`NodeKind`** — `input`, `prompt`, `retrieval`, `tool-call`, `tool-result`, `model-call`, `model-output`, `artifact`, `guardrail-check`, `event`, `policy-decision`, `memory-read`, `memory-write`, `wait`, `resume`.
  - **`EDGE_KINDS`** / **`EdgeKind`** — `caused-by`, `influenced-by`, `retrieved-from`, `invoked`, `produced`, `checked-against`, `waited-on`, `resumed-from`.
  - **`Signature`** — `{ algorithm: 'ed25519', keyId, value, signedAt }`.
- **Building**
  - **`newBuilder(options: BuilderOptions)`** — returns a `ProvenanceBuilder` for one run. `BuilderOptions`: `id`, `runId`, `tenantId`, optional `flowRef`, `version` (default `'1.0.0'`), `createdAt`.
  - **`ProvenanceBuilder`** — `addNode(node)`, `addEdge(edge)`, `snapshot()` (the unsigned record so far), `finalize(keyProvider)` (the signed record, as a `Result`). A builder is not safe to share across concurrent runs.
- **Keys**
  - **`KeyProvider`** — caller-implemented key store: `signingKey(tenantId)`, `verificationKey(keyId)`, `deploymentKey()`, `describe()`. An implementation can return a per-tenant key or fall back to a deployment key; the chosen `keyId` is recorded in the signature.
  - **`KeyMaterial`** — `keyId`, `publicKey`, optional `privateKey` (absent for verification-only providers). Keys are base64-encoded DER: SPKI for the public key, PKCS#8 for the private key.
- **Signing and verification**
  - **`signProvenance(provenance, keyProvider)`** — signs with `keyProvider.signingKey(tenantId)` and returns the record with the signature attached, replacing any earlier signature. Fails with `signing-not-supported` when the key has no private part.
  - **`verifyProvenance(provenance, keyProvider)`** — looks the key up by the signature's `keyId` rather than by tenant, so records signed with an older key still verify while the provider knows that key.
  - **`verifyExported(provenance, base64PublicKey)`** — verifies against a public key alone, with no `KeyProvider`.
  - **`signingBytes(provenance)`** — the bytes that are signed: every field except `signature`, serialized with `canonicalize` from [`@kindgi/schema`](../schema/) (sorted keys, `undefined` omitted). Changing this projection invalidates existing signatures.
- **Export** — **`exportProvenance(provenance)`** returns the full record, signature included, as a canonical JSON string; **`importProvenance(json)`** parses it back (a `JSON.parse` wrapper with no validation).
- **Persistence** — **`ProvenanceEmitBinding`**, implemented by a runtime adapter: `emit(provenance): Promise<Result<void, PersistenceError>>`, idempotent on `(tenantId, id)`.
- **Payload envelope** — **`wrap`**, **`unwrap`**, **`unwrapOrThrow`**, **`CURRENT_PROVENANCE_PAYLOAD_VERSION`**, the **`EnvelopeThrown`** error class, and **`EnvelopeError`** (`UnsupportedPayloadVersionError`, `MalformedEnvelopeError`): a `{ v, doc }` version envelope for stored JSON payloads.
- **Errors** — **`ProvenanceError`**, a union of `InvalidProvenanceError`, `UnknownKeyError`, `SigningNotSupportedError`, `SignatureVerificationError` (`signature-verification-failed`), `MissingSignatureError`, `PersistenceError`, and `ProvenanceNotFoundError`, each with a `code`.

## Example

```ts
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';

import { exportProvenance, importProvenance, newBuilder, verifyExported } from '@kindgi/provenance';
import type { KeyMaterial, KeyProvider } from '@kindgi/provenance';
import type { ProvenanceId, RunId, TenantId, Timestamp } from '@kindgi/types';

// An Ed25519 key pair in the encoding KeyMaterial expects (base64 DER).
const pair = generateKeyPairSync('ed25519');
const key: KeyMaterial = {
  keyId: 'acme-2026-09',
  publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
};

const keys: KeyProvider = {
  signingKey: () => key,
  verificationKey: (keyId) => (keyId === key.keyId ? key : undefined),
  deploymentKey: () => key,
  describe: () => ({ name: 'acme-static-key', version: '1.0.0', description: 'One in-memory key' }),
};

const now = (): Timestamp => new Date().toISOString() as Timestamp;
const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

const question = 'Is clause 4.2 enforceable?';
const answer = 'Yes, subject to the notice period in 4.3.';

const builder = newBuilder({
  id: randomUUID() as ProvenanceId,
  runId: randomUUID() as RunId,
  tenantId: randomUUID() as TenantId,
});
builder.addNode({ id: 'input:0', kind: 'input', timestamp: now(), actor: 'user:42', contentHash: sha256(question) });
builder.addNode({ id: 'model-call:1', kind: 'model-call', timestamp: now(), modelVersion: 'acme-llm/acme-large' });
builder.addNode({ id: 'model-output:1', kind: 'model-output', timestamp: now(), contentHash: sha256(answer) });
builder.addEdge({ from: 'model-call:1', to: 'input:0', kind: 'caused-by' });
builder.addEdge({ from: 'model-output:1', to: 'model-call:1', kind: 'produced' });

const signed = builder.finalize(keys);
if (signed.kind === 'err') throw new Error(signed.error.message);

// Hand the JSON and the public key to an auditor, who needs nothing else to check it.
const json = exportProvenance(signed.value);
const verified = verifyExported(importProvenance(json), key.publicKey);
console.log(verified.kind); // 'ok'

// Any change to a signed field breaks verification.
const tampered = { ...signed.value, nodes: signed.value.nodes.slice(1) };
console.log(verifyExported(tampered, key.publicKey).kind); // 'err'
```

## Non-goals

- **No storage or queries.** Persisting and querying records happens behind `ProvenanceEmitBinding` in the Kindgi runtime or another implementation.
- **No key management.** Key generation, storage, and rotation belong to the `KeyProvider` implementation; this package only reads keys through the interface.
- **No validation on import.** `importProvenance` does not check the parsed value against `provenance.schema.json`.
- **One algorithm.** Signatures are Ed25519 only (`Signature.algorithm` is the literal `'ed25519'`).

## Related

- [`@kindgi/agents`](../agents/) — builds, signs, and emits a provenance record for each agent turn when its provenance bindings are set.
- [`@kindgi/schema`](../schema/) — `canonicalize`, the serialization that `signingBytes` and `exportProvenance` use.
- [`@kindgi/specs`](../specs/) — `provenance.schema.json`, the wire schema this package's node and edge kinds match.
- [`@kindgi/types`](../types/) — branded ids (`ProvenanceId`, `RunId`, `TenantId`), `Timestamp`, and `Result`.
