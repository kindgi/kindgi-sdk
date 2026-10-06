---
"@kindgi/cli": patch
---

A release candidate of the CLI keeps to its own release. Its hints run `npx --yes @kindgi/cli@<its exact version>`, since a `0.1`-style range never matches a pre-release and would run the last release. A Python pack it creates requires `kindgi>=<its version>,<…>` in PEP 440 (`kindgi>=0.1.4rc0,<0.2`), so pip and uv install the matching Python SDK, and the same requirement takes the release once it's out. A release CLI is unchanged.
