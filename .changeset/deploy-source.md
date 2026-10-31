---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**Where a deployment's pack lives in git.** `kindgi deploy`, run inside a git work tree, says where the pack lives on `POST /v1/deployments`: `source` with the `origin` remote as `host/owner/name` (no scheme, user or token), the pack's folder relative to the repository's root, the commit, the branch, and whether the pack's folder had changes the commit doesn't hold. Outside git, or before the first commit, it sends none. The deployment keeps it, with each block's file as the image's index names it (`source.blockFiles`), and lists the block versions it shipped in `contents.blocks`. A `source` that isn't one (a URL with a scheme or a user in it, an absolute or escaping path, a short commit id) is `400 bad-input`, naming the field.

- **TypeScript client.** `DeploymentSource`, and `Deployment.source` and `contents.blocks` on what `client.deployments` answers.
