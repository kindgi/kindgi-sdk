---
"@kindgi/cli": patch
---

**The CLI runs the git on `PATH`, never a `git` in the pack's folder.** `kindgi deploy` (where the pack is in git), `kindgi dev` (the checkout it's in) and `kindgi secrets copy` (whether git tracks an env file) run git in the pack's folder. They asked for a bare `git`, and on Windows Node looks for that in the folder it runs in before `PATH` (unless `NoDefaultCurrentDirectoryInExePath` is set). So a `git.exe` in the pack ran in git's place. On every platform, an empty or relative `PATH` entry pointed into that folder too. The CLI now finds git in `PATH`'s absolute entries, and runs it by that path.
