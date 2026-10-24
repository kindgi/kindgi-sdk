# Test vectors

Fixed inputs and expected outcomes that every implementation replays: the TypeScript and Python clients in this repository, and any other verifier.

## `signed-export/`

A signed export, one file per algorithm. Each `valid` envelope must check out against its file's `publicKeyPem`. Each `tampered` envelope has one byte of its `bundle` changed and must fail.

- `ed25519.json` — the default algorithm, for a key in memory or a file.
- `ecdsa-p256-sha256.json` — ECDSA P-256 with SHA-256, for a KMS without Ed25519. Its signature is IEEE P1363 `r‖s`: 64 bytes, as Web Crypto takes it. A verifier whose library takes DER converts it first.
- `unknown-algorithm.json` — an export claiming an algorithm no verifier knows. A verifier must refuse it, naming the algorithm, and never fall back to another.

The envelopes follow [`signed-export.schema.json`](../schemas/signed-export.schema.json).

## `strict-schemas/`

JSON Schemas a pack may declare (a tool's input or output, a `needsSpec` entry), and what the runtime's strict compile says to each. An SDK that checks a schema where it's declared replays them, so a schema it lets through is one the runtime compiles.

- `corpus.json` — the schemas, by name, in two groups. A `parity` case's answer is one an SDK must give word for word. An `unchecked` case is a refusal the SDKs don't model: the runtime refuses it, and an SDK may let it through.
- `answers.json` — for each case, `null` when the runtime compiles the schema, or the reason it refuses it. `node scripts/strict-schemas-oracle.mjs` writes it from the runtime's own compile, and CI fails when it's stale.
