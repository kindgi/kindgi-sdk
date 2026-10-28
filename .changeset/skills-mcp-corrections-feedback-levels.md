---
"@kindgi/sdk": patch
---

**The MCP servers, fix-corrections and framework-feedback skills load in levels.** Each `SKILL.md` now holds what's true on every path and names the file for each case, so a coding agent reads about 5–6 KB and then only the files its case needs, not the whole 12–15 KB. The MCP servers skill has one file each for how the secret reaches the server, Postgres and the steps every preset follows, several servers and their names, clients other than Claude Code, and common mistakes. The fix-corrections skill keeps what stays with the person and how to sort a correction in its entry, with a file for each step of the loop and a worked example. The framework-feedback skill keeps when and how to file in its entry, with one file each for an entry's fields, sending to Kindgi, hearing back, editing `FEEDBACK.md`, and common mistakes. The providers skill's Path A and Path B files list each of their steps by its title in their contents.
