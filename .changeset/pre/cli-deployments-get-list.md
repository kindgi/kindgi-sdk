---
'@kindgi/cli': patch
---

**`kindgi deployments get` and `list`: see a deployment's pack service after the deploy, including when it runs on the values it was last given.** `kindgi deploy --hosted` says a pack service's state only while it waits, so a problem recorded later reached no one: a value changed and can't be given to the pack service, or it didn't start with the newest values (`pack-env-update-failed`).
- **`kindgi deployments get <deployment-id>`:** the deployment (its project, or `none named`; its image; what it ships) and its pack service now. When the pack service is held on its last values, it says why by code, since when, and what to do: the lines `kindgi deploy` prints for the names in the way, at the env the server reads them at and the deployment's project. A pending pack service gets its reason, and a cleared one says why it was cleared, in the same words as `kindgi deploy`. `--json` prints the deployment as the API answers it. A server from before `packEnvProblem` gets no held line.
- **`kindgi deployments list`:** the deployments, the latest activated first, filtered by `--image-ref-prefix` or `--signer-key-id`. `--table` shows each one's pack service: `ready`, `ready, held: <code>`, `pending: <code>`, `cleared, waiting` or `cleared: <reason>`.
