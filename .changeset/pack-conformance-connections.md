---
"@kindgi/pack-conformance": patch
---

The conformance suite covers a tool's connections (pack protocol 2.9.0) in all four languages. `conformance.context` returns the connections it was sent, so every SDK must hand a handler each one, token included. A new `conformance.rejects` tool throws a refusal of its connection, alone or as its own error's cause. The suite checks that every SDK answers `connection-rejected` with the connection's name, keeps the token out of what the service prints, and indexes the tool's `needsSpec.connections` the same. An older service, called with connections in the context, still answers.
