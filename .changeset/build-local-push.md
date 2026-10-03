---
"@kindgi/cli": minor
---

`kindgi build --local --push [<repository>]` publishes from your machine:
- **builds** for the deployment's platform: `linux/amd64` by default, as Cloud Run runs; `--platform` overrides it;
- **pushes** to the repository: `--push`'s value, else `environments.<env>.registry` + `/<packId>`;
- **checks** the pushed image's index against the local one, by digest;
- **signs** as the build service path does, and writes `deploy-envelope.json` for `kindgi deploy`.

It uses your own Docker credentials for the registry; Kindgi holds none. A command-line option can now take an optional value (`--push`, or `--push=<repository>`).
