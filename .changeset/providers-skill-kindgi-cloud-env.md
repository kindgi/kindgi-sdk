---
'@kindgi/sdk': patch
---

**The `kindgi-authoring-providers` skill says where a pack on Kindgi Cloud keeps its model key and provider: `prod`.** A pack deployed with `kindgi deploy --hosted` runs on a runtime that serves `prod`, but every example in the skill used `--env=local`, for `kindgi dev`. The skill now gives the lines for Kindgi Cloud (`kindgi secrets set … --env=prod --scope=tenant`, `kindgi providers register … --env=prod`, `kindgi deploy --hosted --env=prod`) and links the hosted guide. Its `envName` mistake now says where each command writes: `kindgi secrets set` needs `--env`, `kindgi providers register --preset` writes `local` without it, and a `--spec` file names its own.
