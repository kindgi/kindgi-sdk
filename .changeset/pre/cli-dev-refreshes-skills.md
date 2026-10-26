---
"@kindgi/cli": patch
---

After an upgrade, `kindgi dev` now refreshes the pack's framework skills as it starts, in `.claude/skills/` and `.agents/skills/`, instead of only saying they're behind. It works like `kindgi skills sync` without `--force`: skills you edited are kept. A skill or a skills folder you deleted stays deleted, and while it's behind, `kindgi dev` says so and names the command that brings it back. With nothing new, it writes nothing. A pack without `.claude/skills/.kindgi-manifest.json` is left as it is, with the same "behind" line as before.
