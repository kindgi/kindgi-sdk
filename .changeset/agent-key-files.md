---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

`kindgi init` keeps a coding agent working in your project out of the files that hold keys and tokens: `.env*`, `.kindgi/secrets.env`, `.kindgi/dev/runtime.env`, and a self-hosted deployment's `kindgi.env` and `pack.env`. It merges `Read(...)` deny rules for them into `.claude/settings.json` (it never overwrites: missing rules are appended, and a file it can't read as JSON is left as it is, with what to add), and adds them to a `.cursorignore`, `.geminiignore` or `.aiderignore` the project already has. The getting-started skills tell the agent to keep its hands off those files and to list secrets by name with `kindgi secrets list`. "Your coding agent" in the docs shows the rules and the Claude Code sandbox settings that also keep the agent's shell commands out of them.
