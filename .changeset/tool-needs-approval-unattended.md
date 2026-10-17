---
"@kindgi/tools": patch
"@kindgi/specs": patch
"@kindgi/runtime": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/handler-runtime": patch
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**A tool can ask for a person's yes on every call no person is there to see: `needsApprovalWhenUnattended`.** A tool manifest's new optional `needsApprovalWhenUnattended: true` declares it. In a run no person started:
- **An agent's call of the tool waits for a reviewer,** as `always_ask` does. Neither the agent's `conversationPolicy.hitl` nor the tenant's approval rules can lift it.
- **A flow's tool step that calls it fails,** with `needs-a-person: …` naming the tool, since a tool step can't wait. Call such a tool from an agent step.
- In a run a person started, the agent's own gates decide, as for any tool. A tool that doesn't declare it is unchanged.

**A run says how it started: `startedBy`** on `GET /v1/runs` and `GET /v1/runs/{runId}`, and on `KernelRunRecord`. It's `person` (signed in, or with their own API key), `key` (a service account's key), or `schedule`, `webhook` or `event` (a trigger). Only `person` counts as attended (`runIsAttended`, `@kindgi/runtime`). It's set from the caller, never from the request body, and never changes: an approval doesn't make a run its approver's. A run that a run starts started the way its run did. A run from before a runtime recorded it has none, and counts as unattended.
- **A key acts as its person.** For automation, use a service account's key: its runs count as unattended. A request with a service account's key is `key` whoever else it names.
- **The wire `Tool`** carries `needsApprovalWhenUnattended`, so `kindgi tools get` and the console show it. The pack indexer carries it into the pack's index.
- **The `woocommerce` template declares it** on `woo.refund`, `woo.refund-large`, `woo.set-price` and `woo.publish-product`. A staff member's refund in the store chat runs as the store agent says; one an order webhook's run asks for waits for a person.
- **The authoring skills** (`kindgi-authoring-tools` and the Java, Python and Scala ones) say when to declare it.
