---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**`kindgi suggested-changes pull <suggested-change-id> [--pr]`.** It writes a suggested change's block version into the pack's block file, and into the template file beside it, as `kindgi blocks pull` writes what runs: only when it's newer than the file's. A file that holds a newer version than the one the suggested change is built on is refused. It's allowed when the suggested change is `ready`, `waiting-for-second-person`, `pinned` or `added-as-latest`. One still `checking`, one whose check failed, one that's withdrawn, and a deploy's are refused, each saying why. `--project` refuses one for another project.

With `--pr`, in the pack's git repository, it makes a branch `kindgi/<block>-<version>` from the one checked out, commits the block files alone, pushes the branch to `origin` (or the only remote), and opens the pull request with `gh`. Without `gh`, it prints the URL that opens one. The pull request says where the suggested change came from, its test-set numbers, the files and a link to it in the console. It never says the suggested change's why, nor a correction's words. The corrections it fixes that are still `open` are then `being-fixed`, linked to the pull request. One it can't mark is named, with the line to run once it can be. Before it writes anything, it refuses a pack outside git, block files with changes that aren't committed (or when git can't say), a detached `HEAD`, no `user.name`, no remote, and a branch that's there already, in the repository or on the remote. It stays on the new branch, and prints the line that goes back.

The `kindgi-fix-corrections` skill and the suggested changes guide bring the pack up to a pinned suggested change with it.
