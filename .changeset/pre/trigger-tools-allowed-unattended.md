---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/runtime": patch
"@kindgi/agents": patch
"@kindgi/compliance": patch
"@kindgi/specs": patch
---

**A webhook trigger or a schedule can name tools its runs call without waiting for a person's yes (`toolsAllowedUnattended`).** A tool that declares `needsApprovalWhenUnattended` waits for a person's yes in a run no person started. A trigger's list lifts that wait for the tools it names, and only that: the tenant's approval rules, the agent's own, the permission check (as the trigger's owner) and the tool's own limits all still apply.
- **Where:** `POST` and `PATCH` on `/v1/webhooks` and `/v1/schedules` take it, and their records show it (absent: none). `POST /v1/runs` never takes it. A take-over (`/owner`) keeps it and refuses a body that names it (`400 bad-input`).
- **Who:** naming it, `[]` included, takes `admin` on the trigger's project, at register too.
- **What:** each tool by its id: at most 100, no wildcard or pattern, each once. Each must be a tool the target calls, else `400 bad-input` naming it. For a flow, that's its tool steps, loop bodies, fan-out branches, its subflows' tools, and its agents' tools at the node's version, the flow's pin or the latest. An improvement schedule calls no tools, so its list can only be `[]`.
- **A new target:** a schedule `PATCH` to another flow or agent while its list isn't empty must name the list again, as it is or `[]`, else `400 bad-input` naming the kept ids. A new version alone keeps it. A webhook trigger's new `flowVersion` keeps it, and naming it checks it against that version.
- **Audit:** every change is recorded as `trigger-tools-allowed-unattended-set` (the trigger, its target, `from`, `to`, `by`), and `trigger-owner-set` names the list a take-over keeps.
- **Runs:** a run's `toolsAllowedUnattended` is its trigger's list as it was when the run started. A child run has its parent's, and a resumed agent turn keeps its run's, never the resumer's.
- **For runtimes:** `@kindgi/runtime` exports `needsPersonsYesUnattended(tool, startedBy, toolsAllowedUnattended)`, the one rule the agent's tool gate and a flow's tool steps share. The field is on `RunFlowInput`, `StartRunParams`, the run record, and the trigger registry's register and update inputs and its records. It's also on `InvokeAgentInput`, the run snapshot, and the API's `InvokeAgentBindingInput` and `InvokeFlowBindingInput`, which a webhook's or a schedule's fire sets from its trigger.
