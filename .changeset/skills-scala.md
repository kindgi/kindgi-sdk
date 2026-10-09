---
"@kindgi/sdk": patch
"@kindgi/cli": patch
---

**Skills for coding agents in Scala packs.** A Scala pack (`kindgi init --template=scala`, or `kindgi init` in an sbt app) now gets five skills of its own in `.claude/skills/`: `kindgi-scala-getting-started`, `kindgi-scala-authoring-tools`, `kindgi-scala-authoring-guardrails`, `kindgi-scala-authoring-agents` and `kindgi-scala-authoring-flows`. It also gets the shared providers, MCP servers and framework-feedback skills. Until now a Scala pack got none: `kindgi skills sync` didn't take `scala`, and neither Scala init path copied skills. `./kindgiw skills sync` brings them to an existing pack.
