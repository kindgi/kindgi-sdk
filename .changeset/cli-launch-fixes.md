---
"@kindgi/cli": patch
---

Launch fixes:
- **Unwired commands are hidden.** The commands this release doesn't wire (memory, artifacts, provenance, proposals, observations, tokens, capabilities, conversations, flows, and agents list/get/unregister/versions, tools publish) no longer appear in `--help` or the generated reference. Calling one still says it's not wired yet.
- **`env list --reveal`** refuses unless stdout, where the values go, is a terminal. Before, `--reveal > file` typed in a terminal wrote the values unredacted.
- **`auth whoami`** checks the token on an authenticated route (`/v1/identity/whoami`) and shows the identity. A wrong token now fails.
- **`secrets`:** a version conflict suggests `--write-mode=add-version`; `--limit` and `--if-version` must be integers; no internal wording in the missing `--scope` error.
- The `kindgi dev` banner's feedback hint uses `--body-stdin`, so a coding agent running it doesn't wait on `$EDITOR`.
- The README matches: published packages, the private-preview runtime image, and only the wired commands.
