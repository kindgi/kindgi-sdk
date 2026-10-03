---
"@kindgi/sdk": patch
---

Skills: `kindgi-getting-started` no longer points at a `demo.echo-agent` that `kindgi dev` doesn't register; it runs the sample template's `<pack-id>.echo-agent` and says what `dev-echo` can and can't do. The authoring skills link this release line's API reference (docs.kindgi.com/v0.1/…) instead of a contributor-only typedoc command; `check:refs` keeps skills' docs links on the current minor. The guardrail skills say that only `halt` acts in 0.1 (`retry`, `escalate` and `compensate` are recorded), give the real error for an unregistered guardrail, and say a pack's guardrail `config` isn't validated; the tools skill no longer promises a field path in `input-validation-failed`. `kindgi-authoring-providers` 0.9.2: `defineAgent` takes `preferredModel` too, and the adapter ids are listed (there is no `kindgi adapters list`).
