---
"@kindgi/cli": patch
---

`kindgi deploy --sync-secrets` on a hosted deploy (`--hosted`, or an env block with `build: 'hosted'`) now needs `--env`. A hosted runtime reads a deployment's secrets in the env it serves. Without `--env`, the values in `.env.staging` used to go up under `staging`, and a runtime serving another env never read them. Now the deploy is refused, naming `--env`, before anything is built or sent. A deploy that isn't hosted keeps `staging` as its default env, and a hosted deploy without `--sync-secrets` is unchanged.
