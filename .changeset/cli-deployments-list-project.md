---
'@kindgi/cli': patch
---

**`kindgi deployments list --project`: one project's deployments, by its id or its slug.** The Default project's include the deployments that name no project, as the API lists them. A slug no project has, or one that two orgs share, is a usage error (exit `2`), and nothing is listed.
