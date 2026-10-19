---
'@kindgi/cli': patch
---

**`kindgi deployments list --project` and `--pack`: one project's deployments, one pack's, or both filters at once.**
- **`--project`** takes the project's id or its slug. The Default project's include the deployments that name no project, as the API lists them. A slug no project has, or one that two orgs share, is a usage error (exit `2`), and nothing is listed.
- **`--pack`** takes the pack id, as it is.
- **A runtime before Kindgi 0.1.9** ignores both filters and lists every deployment. The command then stops instead of printing that list as the filtered one, and names the release the runtime needs (exit `1`), as `kindgi approvals list --decided-by` does.
