---
'@kindgi/agents': patch
'@kindgi/cli': patch
---

**A tool call's approval names who asked, and can need someone else.**

- **Who asked:** a tool gate's approval (and a session gate's) records `requestedBy`. It's the person the turn runs for (`user:<id>`, `service_account:<id>` or `system:<id>`; an agent acting for someone names that someone), and it stays the same when another person's decision resumes the turn. Before this, it was never set, so the console couldn't say who asked.
- **Four eyes:** `conversationPolicy.hitl.separateApprover` makes a tool's approval need a reviewer other than the person who asked.
  - **How to set it:** `true` for every gated tool, or `{ default?, overrides? }` per tool, keyed by tool id as in `tools`.
  - **Absent** means `false`, as before.
  - **On a resume:** the gate keeps its answer with its decision, so a turn resumed after a policy change reads the rule it parked with.
  - **Passed on:** `HitlEnqueueInput` gains `requestedBy` and `separateApprover`, which a deployment's hitl binding passes to the approval.
- **The `woocommerce` template's store agent** sets it for `refund-large`, `set-price` and `publish-product`.
