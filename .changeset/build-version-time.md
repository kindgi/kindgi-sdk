---
"@kindgi/cli": patch
---

`kindgi build`, and `kindgi deploy`'s inline build, default the artifact version and the publish time to the build time: `YYYYMMDD.HHMMSS` and the ISO time, both UTC. Before, every unpinned build on a day was `YYYYMMDD.1`. A second build that day pushed to the same image tag, which moved to the new image, and signed a second image with the same artifact version. Now each build gets its own version and tag, and the versions sort in build order. The new versions still match `YYYYMMDD.N`, so any runtime that takes a `kindgi build` envelope takes them.

**Behaviour change:** the publish time used to default to the Unix epoch, so an unpinned build was reproducible. It no longer is: for a reproducible build, pass `--artifact-version` and `--published-at`. On Kindgi 0.1.4, a second build the same day needs its own version: `--artifact-version YYYYMMDD.2`.
