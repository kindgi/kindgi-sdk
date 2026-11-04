---
"@kindgi/cli": patch
"@kindgi/sdk": patch
"@kindgi/agents": patch
"@kindgi/flow": patch
"@kindgi/specs": patch
---

**The templates' agents and flows are named for what they do.** A new pack from `kindgi init` gets these ids. Packs already made keep theirs, and the template names are unchanged.

| Template | Before | Now |
|---|---|---|
| `sample`, `python`, `java`, `scala` | agent `<pack>.echo-agent`, flow `<pack>.echo-flow` | agent `<pack>.greeter` ("Greeter"), flow `<pack>.greet-person` ("Greet a person") |
| `woocommerce` | agent `<pack>.store-agent`, flow `<pack>.order-review`, block `<pack>.store-agent-prompt` | `<pack>.order-desk`, `<pack>.review-order`, `<pack>.order-desk-prompt` |
| `drupal` | agents `<pack>.content-agent` and `<pack>.content-reviewer`, flow `<pack>.content-review` | `<pack>.style-checker`, `<pack>.article-reviewer`, `<pack>.review-article` |
| `follow-up` | agent `<pack>.follow-up` | `<pack>.follow-up-writer` |
| `returns-helper` | agent `<pack>.returns-helper` | `<pack>.returns-desk` |

Their folders, files and classes follow: `agents/greeter/`, `Greeter.java`, `greeter.py`.

**The agents, flows and getting-started skills give naming rules, in all four languages.**
- An agent is named for its role, and a flow for its job, verb first.
- The pack id names the app or the business once.
- No placeholder words such as `agent`, `flow` or `helper`.
- One word per thing.
- The display name is the id in words, in sentence case.
- An id is the pack's own id, a dot, and a kebab-case name with no dot.

The examples follow the rules (`acme.ledger.book-expense`, "Brief writer", "Triage a ticket"). So do the `Agent.id` and `Flow.id` comments, and the Python and Java SDKs' examples.
