---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**`kindgi init` and `kindgi skills sync` write Kindgi's skills to `.agents/skills/` as well as `.claude/skills/`,** the folder Codex and Gemini CLI look in, by their own docs.
- Both folders hold the same copy of each skill, under one manifest (`.claude/skills/.kindgi-manifest.json`, which gains an optional `agentsSkills` field; a manifest without it is still read). `kindgi skills sync` judges each folder's copy on its own: an edited copy is kept unless `--force`, and a folder that was deleted is written again.
- Each outcome in `kindgi skills sync`'s JSON names its `folder`. Its summary, one block per folder, now prints on stderr unless `--json` or `--quiet` is given.
- `kindgi dev`'s skills warning covers both folders and counts each skill once; a copy that's gone counts as not yet installed.
- A project's existing `.prettierignore` gets `.agents/skills/kindgi-*/` beside `.claude/skills/kindgi-*/`.
- The templates' `AGENTS.md` have a `## Skills` section that names both folders (the TypeScript ones were headed for one coding agent), and refer to skills by name. They, and the getting-started skills for TypeScript, Python, Java and Scala, say which commands are the person's to run in their own terminal, and what an agent does when its sandbox blocks a command: give the person the exact command, the folder and what they'll see, and wait.
