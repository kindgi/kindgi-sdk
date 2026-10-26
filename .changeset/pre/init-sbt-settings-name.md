---
"@kindgi/cli": patch
---

**`kindgi init` in an sbt app reads the build's `name` and `version` inside a one-line `.settings(…)`.** A `build.sbt` such as `lazy val root = (project in file(".")).settings(name := "acme-ledger", version := "1.2.0")` now names the pack `acme-ledger` at `1.2.0`. Before, `init` read these settings only at the start of a line. With this build, it stopped with "build.sbt has no `name := "…"` to name the pack" unless `--pack-id` was given, and it used `0.1.0` for the version. A setting inside a comment isn't read. Before, one on its own line inside a multi-line `/* … */` comment was.
