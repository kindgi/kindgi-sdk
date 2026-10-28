---
"@kindgi/cli": patch
---

`kindgi skills sync`, `kindgi init` and `kindgi dev` now treat a skill as a folder: its `SKILL.md`, which a coding agent loads, and the files beside it, which it reads only for its case. Every file is copied into `.claude/skills/` and `.agents/skills/`, and `.claude/skills/.kindgi-manifest.json` records each file's hash (`installedFiles`), so the first sync or `kindgi dev` after the upgrade adds that field to each entry. A change to any of a skill's files keeps the whole skill as you left it (`--force` replaces it). A file of a skill you deleted comes back, a file the skill no longer has is removed unless you edited it, and a file you added to a skill's folder is never changed or removed. An older CLI still reads the manifest.
