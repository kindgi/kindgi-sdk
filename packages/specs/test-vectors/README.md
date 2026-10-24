# Test vectors

Fixed inputs and expected outcomes that implementations replay: the clients in this repository (each section says which), and any other implementation.

## `signed-export/`

A signed export, one file per algorithm, replayed by the TypeScript and Python clients and any other verifier. Each `valid` envelope must check out against its file's `publicKeyPem`. Each `tampered` envelope has one byte of its `bundle` changed and must fail.

- `ed25519.json` — the default algorithm, for a key in memory or a file.
- `ecdsa-p256-sha256.json` — ECDSA P-256 with SHA-256, for a KMS without Ed25519. Its signature is IEEE P1363 `r‖s`: 64 bytes, as Web Crypto takes it. A verifier whose library takes DER converts it first.
- `unknown-algorithm.json` — an export claiming an algorithm no verifier knows. A verifier must refuse it, naming the algorithm, and never fall back to another.

The envelopes follow [`signed-export.schema.json`](../schemas/signed-export.schema.json).

## `open-values/`

A request body holding a value the client doesn't know: an enum value, a union variant, or text in a union of known text and objects, as a newer runtime may send one. A client reads such a value and keeps it, but must refuse it before sending, so the server never gets the request. `cases.json` lists the cases:

- `name`: the case.
- `operation` and `args`: the client method (`agents.live.unpin`) and the arguments before the body.
- `body`: the request body, as JSON.
- `at`: where the value is, as steps (a property name, or a list index). For a union variant, `tag` names the property that tells the variants apart.
- `names`: one of the known values, which the refusal must list.

The Java client (`KnownValuesVectorsTest`) and the Python client (`tests/test_open_enums.py`) replay every case. The TypeScript client doesn't check a request body before sending it, so the server refuses the value instead.
