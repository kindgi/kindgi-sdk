# Test vectors

Fixed inputs and expected outcomes that implementations replay: the SDKs in this repository (each section says which), and any other implementation.

## `signed-export/`

A signed export, one file per algorithm, replayed by the TypeScript and Python clients and any other verifier. Each `valid` envelope must check out against its file's `publicKeyPem`. Each `tampered` envelope has one byte of its `bundle` changed and must fail.

- `ed25519.json` — the default algorithm, for a key in memory or a file.
- `ecdsa-p256-sha256.json` — ECDSA P-256 with SHA-256, for a KMS without Ed25519. Its signature is IEEE P1363 `r‖s`: 64 bytes, as Web Crypto takes it. A verifier whose library takes DER converts it first.
- `unknown-algorithm.json` — an export claiming an algorithm no verifier knows. A verifier must refuse it, naming the algorithm, and never fall back to another.

The envelopes follow [`signed-export.schema.json`](../schemas/signed-export.schema.json).

## `strict-schemas/`

JSON Schemas a pack may declare (a tool's input or output, a `needsSpec` entry), and what the runtime's strict compile says to each. An SDK that checks a schema where it's declared replays them, so a schema it lets through is one the runtime compiles.

- `corpus.json` — the schemas, by name, in two groups. A `parity` case's answer is one an SDK must give word for word. An `unchecked` case is a refusal the SDKs don't model: the runtime refuses it, and an SDK may let it through.
- `answers.json` — for each case, `null` when the runtime compiles the schema, or the reason it refuses it. `node scripts/strict-schemas-oracle.mjs` writes it from the runtime's own compile, and CI fails when it's stale.

The Java pack SDK (`SchemaValidatorStrictTest` in `kindgi-pack`) and the Python pack SDK (`tests/test_schema.py`) replay them.

## `regexp-syntax/`

Regular-expression sources, and what Node's `RegExp` says to each, with the `u` flag and with no flags. An SDK that checks a pattern's syntax where it's declared replays them, so a pattern it lets through is one Node compiles.

- `corpus.json` — the sources, by name. A source is a string, or a list of parts joined in order, where a part is a string or `[string, times]`: `[["()", 32768]]` is 32768 empty groups. A lone surrogate is written as a `\uXXXX` escape, and a reader must keep it as it is.
- `answers.json` — for each case, `{ "u": …, "plain": … }`: what `new RegExp(source, "u")` and `new RegExp(source)` say. Each is `null` when the source compiles, or the reason Node gives, without its `Invalid regular expression: /<source>/<flags>: ` prefix. `node scripts/regexp-syntax-oracle.mjs` writes it from the RegExp of the Node it runs on (the Node of the runtime's image, which CI checks the answers on), and `--check` fails when it's stale.

The Java pack SDK (`RegExpTest` in `kindgi-pack`) and the Python pack SDK (`tests/test_regexp.py`) replay them.

## `open-values/`

A request body holding a value the client doesn't know: an enum value, a union variant, or text in a union of known text and objects, as a newer runtime may send one. A client reads such a value and keeps it, but must refuse it before sending, so the server never gets the request. `cases.json` lists the cases:

- `name`: the case.
- `operation` and `args`: the client method (`agents.live.unpin`) and the arguments before the body.
- `body`: the request body, as JSON.
- `at`: where the value is, as steps (a property name, or a list index). For a union variant, `tag` names the property that tells the variants apart.
- `names`: one of the known values, which the refusal must list.

The Java client (`KnownValuesVectorsTest`) and the Python client (`tests/test_open_enums.py`) replay every case. The TypeScript client doesn't check a request body before sending it, so the server refuses the value instead.
