---
"@kindgi/sdk": patch
---

**The skills' npm form passes every flag to Kindgi.** Run the CLI in an npm project as `npx --no -- kindgi …`: without the `--`, `npx` takes `--help` for itself and prints npm's help. The skills, the README and the install and coding-agent pages say so. The guardrails skill now says one thing about a check's config: a `defineCheck` check's `evaluate` gets the config its schema resolves, with the schema's defaults applied, and a pack's guardrail `config` is checked against the schema when the pack is indexed. The getting-started skill tells an agent never to build a console URL by hand: give the address `kindgi dev` prints, an approval's own link is `/console/approvals/<approval id>`, and every other page's address starts with the tenant and the project.
