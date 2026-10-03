---
"@kindgi/cli": patch
---

`kindgi --version` and `kindgi version` report the versions in the CLI's and the SDK's `package.json` (as `kindgi init` already did), not a constant that read `0.0.0`.
