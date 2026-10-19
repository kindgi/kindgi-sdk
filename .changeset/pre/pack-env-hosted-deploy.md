---
"@kindgi/cli": patch
---

**`kindgi deploy --hosted` and the pack service's env.** On Kindgi Cloud the pack service gets the plain env values set in your workspace (`kindgi env set NAME <value> --scope=… --env=…`), at the deployment's project, then its org, then the tenant.
- **A kindgi.config that gives `environments.<env>.env` is refused** before anything is built or sent: that block isn't read on Kindgi Cloud. The message names each name and the command that sets it, at the deployment's project (`--project`) or the tenant. A secret is read per call in a tool (`ctx.secrets`).
- **While it waits for the pack service,** it says what stands in the way of the pack's env: required names set nowhere (with the command that sets them), names set only as secrets, and names set both as a secret and as a plain value. The new reasons a pack service isn't ready read `pack-env-missing`, `pack-env-secret-not-yet` and `pack-env-ambiguous`.
- **`kindgi env set --scope=… --force` with the value already there sets it again,** as a new revision: on Kindgi Cloud, a pack service whose new values didn't start tries them again. Without `--force` it's still no change, and the message says how to set it again.
- A self-hosted deploy is unchanged: `environments.<env>.env` is checked against the pack's required names, as `kindgi env plan` applies it.
