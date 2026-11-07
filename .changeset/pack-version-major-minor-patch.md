---
"@kindgi/handler-runtime": patch
"@kindgi/tools": patch
"@kindgi/sdk": patch
---

**`pack.version` must be `MAJOR.MINOR.PATCH`, such as `1.0.0`.** A Java, Scala or Python tool that sets no version of its own takes the pack's, and a deploy takes no other tool version. A pack whose `pack.version` is `"1"`, `"1.0"` or `"1.0.0-rc.1"` no longer loads: `kindgi build`, `deploy`, `env`, `dev` and `mcp` stop with `config-parse-failed`, naming `pack.version`, as they do when it's missing (`Config file <path>: 'pack.version' must be MAJOR.MINOR.PATCH (e.g. 1.0.0), got '1'`). Write `1.0.0`. The Java and Python packs' own config loaders check it the same way.

`defineTool`'s message for a version that isn't `MAJOR.MINOR.PATCH` says so. It called a prerelease such as `1.2.3-beta.1` fine, and then the tool's schema refused it. What `defineTool` takes doesn't change. The Java, Scala and Python authoring skills say each kind's version rule: a tool's is `MAJOR.MINOR.PATCH`, and an agent's is an exact semver with no build metadata.
