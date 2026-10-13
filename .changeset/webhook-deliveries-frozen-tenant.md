---
"@kindgi/api": patch
---

**A closing tenant takes no webhook delivery, and a suspended tenant's or project's deliveries are skipped.** For a delivery that proves its sender, `POST /v1/hooks/{tenantId}/{webhookId}` answers:
- A closing tenant: `409 tenant-closing` (`details.state`), as its own writes are answered. Nothing is recorded.
- A suspended tenant or project: `202` with `skipped: tenant-suspended` or `skipped: project-suspended`, as a paused trigger's delivery is answered, so a sender such as WooCommerce doesn't count it as a failure and switch its webhook off. Nothing is recorded, started or deduped, and nothing counts toward the trigger's rate or toward pausing it.
- The event isn't kept. A sender that can redeliver by hand (GitHub) can resend it once the tenant or project is restored, and the resend runs. The tenant's state is kept a few seconds between reads, so a restore is seen within them.
- If the tenant's state can't be read, the delivery is refused with `503 tenant-state-unavailable` and `Retry-After`, and nothing is recorded.
- A delivery that doesn't prove its sender still gets the same `401 webhook-refused`, whatever the tenant's state.
- `WebhookReceipt.skipped` takes `tenant-suspended` and `project-suspended` besides `paused`.

`createApp` checks the receiver's deliveries with the `tenantStates` and `projectSuspended` it's given, the same ones its writes and deploys are checked with. `tenantStateGate` and the receiver read a tenant's state and refuse a closing one from one place, so the codes and messages are the same.
