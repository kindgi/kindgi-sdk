---
"@kindgi/cli": patch
---

`kindgi test-runs start --help` no longer says `--agent-version` and `--flow-version` default to the latest version. A run on test cases (a `corrections` test set) tries one version, and one started without it is refused, so the help now says the flag is required there. The CLI reference says the same.
