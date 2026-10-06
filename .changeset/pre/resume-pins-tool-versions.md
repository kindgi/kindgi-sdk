---
"@kindgi/agents": patch
---

A resumed agent turn runs the tool versions it started with. `setup` journals the version each tool reference resolved to (`toolVersions`), and a turn resumed after a pause (an approval) resolves exactly those, instead of its version ranges again: a tool version published while the turn waited no longer runs mid-turn. A version that's gone fails the turn with `tool-version-unresolvable` ("this turn started with version …") rather than running another. A turn whose journal predates `toolVersions` resolves its ranges, as before.
