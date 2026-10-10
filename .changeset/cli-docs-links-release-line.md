---
"@kindgi/cli": patch
---

**The docs links the CLI prints name its own release line.** `kindgi sso providers start`'s "Step by step" link is now `https://docs.kindgi.com/v0.1/guides/sso/<guide>/`, not the docs' root. The root moves on to the next release line's docs, and during a release candidate it still shows the last release's. The skills `kindgi init` installs already link this way. Every docs link the CLI prints is built from one place and follows the CLI's version. `check:refs` now fails on a docs link at the root in anything a package or SDK ships from its `src/`, as it already did for skills.
