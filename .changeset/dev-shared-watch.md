---
"@kindgi/cli": patch
---

**`kindgi dev` stops in about a second on macOS.** It watched a pack with one file watcher per discovery folder, plus one for the env files and one for a Python pack's sources. On macOS those all join one FSEvents stream, which is rebuilt on every close but the last. Closing them took seconds, sometimes over 30, before `stopped.` and the exit. On macOS a pack's watchers now share one watch on its folder, each filtering the events itself, and the stop takes about a second. Linux and Windows keep a watcher per folder. The once-a-second scan behind the watchers is unchanged.
