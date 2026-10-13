---
"@kindgi/api": patch
---

**A closing or suspended tenant, or a suspended project, takes no webhook delivery.** `POST /v1/hooks/{tenantId}/{webhookId}` answers a delivery that proves its sender with the state's code, as the tenant's own writes are answered:
- `409 tenant-closing` or `409 tenant-suspended` (`details.state`) for a frozen tenant, and `409 project-suspended` for a trigger in a suspended project.
- Nothing is recorded: no fire, no row in the trigger's history, and nothing toward pausing the trigger.
- A delivery that doesn't prove its sender still gets the same `401 webhook-refused`, whatever the tenant's state.
- If the tenant's state can't be read, the delivery is refused with `503 tenant-state-unavailable` and `Retry-After`, and nothing is recorded.
- The sender's retry once the tenant or project is restored is a new delivery, and it runs. The tenant's state is kept a few seconds between reads, so a restore is seen within them.

`createApp` checks the receiver's deliveries with the `tenantStates` and `projectSuspended` it's given, the same ones its writes and deploys are checked with. `tenantStateGate` and the receiver answer from one place, so the codes and messages are the same.
