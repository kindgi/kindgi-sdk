---
"@kindgi/sdk": patch
"@kindgi/cli": patch
---

**With no skills manifest, `kindgi dev` says what `kindgi skills sync` would do.** A pack without `.claude/skills/.kindgi-manifest.json` has no record of what was installed, so the sync can't tell a copy that's behind from one you edited, and keeps every copy that differs. `kindgi dev` used to tell you to run `kindgi skills sync` to pull the latest anyway, and counted a copy that matches as out of date. It now runs the sync as a dry run, still writing nothing, and says what it found:

```text
  ⚠ Framework skills: 3 out of date.
    · 1 not installed: `kindgi skills sync` adds it.
    · 2 that differ, with no record of what was installed: `kindgi skills sync --force` replaces them.
```

- A copy missing a file is said as "missing a file: `kindgi skills sync` brings it back".
- With a manifest, a copy it has no entry for is said the same way after a refresh ("with no record of what was installed"), not as one you edited.
- `kindgi skills sync` gives such a copy the reason "No record of what was installed; --force to overwrite.", and with `--force`, "Overwrote a copy with no record of what was installed (--force)". A copy you edited keeps "Local edits detected; --force to overwrite." and "Overwrote local edits (--force)".
- The `kindgi-getting-started` skill says the same: `kindgi dev` refreshes the skills as it starts, and without a manifest says what a sync would add and what only `--force` replaces.
