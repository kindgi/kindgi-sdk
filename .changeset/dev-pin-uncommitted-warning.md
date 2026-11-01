---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/handler-runtime": patch
---

**Under `kindgi dev`, the pin check warns about files git hasn't committed.** A pin there writes the version into the pack's files, and git can't bring back what a file held unless it's committed. `POST /v1/agents/{agentId}/pinned/check` now answers two optional fields under `kindgi dev`. `uncommittedFiles` lists the files the pin would write over that git hasn't committed, relative to the pack's folder: changed, staged, untracked or ignored, or in a nested repository such as a submodule. `notInGit: true` says the pack isn't in a git repository. Both are warnings, and the pin still goes. They're absent when there's nothing to say, when the pin writes nothing, when the gate fails, when git can't say (no git, or no answer in time), and on every other runtime.

- **`CreateAppInput.pinFiles`**, a `PinFilesWarnings`, answers them. `PinFilesWarning` and `PinFilesWarnings` are exported from `@kindgi/api`. Without it, as on a deployed runtime, the check answers as before.
- **The pack service's `POST /v1/blocks/uncommitted`** takes `{ ids }`, the blocks a pin would write. It answers `{ uncommittedFiles }`, `{ notInGit: true }` or `{}`, read from each block's file and its template files. It's there when the supervisor is given the new `blockFilesState` option, as `kindgi dev` gives it, and answers `404` otherwise. `packBlockFiles`, the files some blocks are read from, and the `PackFilesState` type are exported from `@kindgi/handler-runtime`.
- **`kindgi agents pin` and `kindgi suggested-changes pin`** ask the pin check first and say its warning on stderr, under `--quiet` too: "git hasn't committed these files, so the pin writes over changes git can't bring back: <files>. The pin keeps them as they were right before it: pin the version before to go back." When the pack isn't in git, the line says so instead. `kindgi agents pin --check` says the same lines. The check is best effort: when it fails or has no warning, nothing more is said and the pin goes as before. stdout, `--json` too, is the pin's answer as before.
- `kindgi dev` reads the files with `git status` and `git ls-files` in the pack's folder. The read changes nothing, uses no shell, leaves out git's repository variables, and has a short timeout.
