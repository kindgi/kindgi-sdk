---
"@kindgi/sdk": patch
---

**Skills for coding agents in Java packs.** A Java pack (`kindgi init --template=java`, or `kindgi init` in a Maven app) now gets five skills of its own in `.claude/skills/`: `kindgi-java-getting-started`, `kindgi-java-authoring-tools`, `kindgi-java-authoring-guardrails`, `kindgi-java-authoring-agents` and `kindgi-java-authoring-flows`. It also gets the shared ones, `kindgi-authoring-providers`, `kindgi-authoring-mcp-servers` and `kindgi-framework-feedback`, which now say how a Java or Scala pack runs the CLI (`./kindgiw`) and declares its providers (`kindgi.config.json`). Until now a Java pack got none. `./kindgiw skills sync` brings them to an existing pack.
