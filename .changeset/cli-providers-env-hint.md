---
"@kindgi/cli": patch
---

`kindgi providers register --preset=<name>`, when the preset's key isn't in the pack's env files, now also says how to use a key the runtime already holds in another environment: name it with `--env=<that environment>`. Without `--env`, the preset reads the `local` environment, the pack's own files.
