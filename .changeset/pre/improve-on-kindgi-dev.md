---
"@kindgi/api": patch
"@kindgi/handler-runtime": patch
"@kindgi/cli": patch
---

**A read-only agent registry can take Improve's candidates.** `RegistryReadOnly` gains an optional `takesCandidates` (`{ undoReason, scopeReason }`). With it, an improvement pass starts, a proposal is evaluated (the version it makes is kept for that), and a promotion request and its check go through to the releases binding. Publishing, deriving, unregistering and reinstating stay refused with the registry's reason. Rolling a scope back, unpinning it and rolling a proposal back are refused with `409 registry-read-only` and `undoReason`, and a pass, a draft or an evaluation for a scope narrower than the tenant with `scopeReason`. Under `kindgi dev`, a runtime that serves the pack's files sets it: making a proposal live writes it into the pack's files, and an undo is done there, with git. The promotion's reference says what such a runtime does: only the whole tenant is made live, and a pack whose files changed since the version was made answers `409 promotion-superseded`, naming the file. `resolveBlockPins` is exported, for such a runtime's pins at load.

**`kindgi dev`'s pack service writes a block made live into the pack.** The pack service supervisor gains an optional `writeBlock`, behind `POST /v1/blocks` on its front, token-gated like `/v1/invoke`; without it, the route answers 404. `writePackBlock` (`@kindgi/handler-runtime`) writes a block's new version and content into its own file, found by id among the pack's blocks, and a prompt's template into its template file. It refuses a block that isn't in the pack, content that doesn't fit the block's kind, and a version not past the file's. `kindgi dev` gives the supervisor one, and its log names the file written.
