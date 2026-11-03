---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**A deployment promotion's make-live is now a pin.** This is a breaking rename, and no old name is kept. Environment promotion itself keeps its name: `kindgi promote`, `POST /v1/deployments/{deploymentId}/promotions` and `client.deployments.promote` are unchanged.

- **Body.** A promotion's `makeLive` is `pin`: it pins every agent version the promotion carries in the target project, each through its scope's release gate, and every flow version it carries.
- **Answer.** The carried agents are in `pinned` (was `live`), and `pinnedFlows` stays. A write error answered after some were pinned lists them in `error.details.pinned` (was `error.details.live`) and `error.details.pinnedFlows`.
- **Schemas and types.** `DeploymentLivePin` and `DeploymentLivePinGate` are `DeploymentPinnedAgent` and `DeploymentPinGate`.
- **CLI.** `kindgi promote --make-live` is `kindgi promote --pin`, and `--wait` goes with `--pin`. The output lists the carried agents' pins under `Agent pins in <env>:` (was `Live in <env>:`), and each one pinned ends `— pinned`. `kindgi dev`'s line for a block version pinned in the console says `pinned:` (was `made live:`), as the docs show it.
