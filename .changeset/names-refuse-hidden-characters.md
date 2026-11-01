---
"@kindgi/types": patch
"@kindgi/api": patch
"@kindgi/agents": patch
"@kindgi/tools": patch
"@kindgi/flow": patch
---

**A name or a label people set refuses hidden characters.** A control character (a line break or a tab among them), the line or paragraph separator, a lone surrogate, a format character other than the zero-width joiner and non-joiner, or another default-ignorable character other than a variation selector (a filler such as U+3164) is refused where the name is written. Tag characters are kept only in the flags of England, Scotland and Wales. The refusal is the route's own code, with the words a site's display name is refused with already: "`<field>` must not contain control, format or invisible characters". The API reference's overview names the classes.

- **The API, on create:** a person's `displayName` (`POST /v1/users`), a connection app's `label`, a signing key's `label`, a reviewer's `displayName`, an expert-queue rule's `name`, a corrector group's `name` and an artifact's `name` (the file part's filename when no `name` is sent), all `400 bad-input`; an MCP endpoint's `endpointId` and `name` (`400 invalid-mcp-endpoint`, reasons `hidden-characters-in-endpoint-id` and `hidden-characters-in-name`); an identity provider's `displayName` (`400 invalid-provider-config`); and the ids and names of the agents and flows in a deployment's index.
- **A trigger's `toolsAllowedUnattended`** refuses a tool id with one before its wildcard check, and its message doesn't quote the id.
- **`defineAgent`** refuses an `id` or a `name` with one (issues `/id` and `/name`), **`defineTool`** and `validateToolManifest` an `id` (`invalid-tool-definition`), and **`loadFlow`** (and `defineFlow`) a flow's `id` or `name` (`schema-validation-failed`). A pack with one fails at build, and the publish routes, which run the same checks, refuse it with `400 validation-failed`.
- **A site's display name and a console link's label** take the same rule. The joiners, the variation selectors and the three flags now pass, and a filler, another default-ignorable character or a lone surrogate is now refused.
- **`@kindgi/types` exports the rule:** `hasHiddenCharacters(text)`, and `withoutHiddenCharacters(text)`, which removes them and trims, as a person's name that a site sends is cleaned. `@kindgi/api` still exports both, now with this rule.
