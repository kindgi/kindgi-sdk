---
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
---

**One Ctrl+C stops `kindgi dev` cleanly, the runtime container included.**

- **Under a package manager** (`pnpm exec kindgi dev`, `npx kindgi dev`, a `pnpm run` script), `kindgi dev` no longer exits at once with code 130 and leaves the runtime container running. A terminal's Ctrl+C signals the whole process group, and the wrapper signals its child too: `npx` and `pnpm run` forward SIGINT; `pnpm exec` sends SIGTERM. So one Ctrl+C arrived twice and was read as the second, forced one.
  - A signal that comes with the first is now the same Ctrl+C. That holds even when it's handled late because the stop held the event loop: closing the file watcher takes over a second on macOS.
  - A SIGTERM never forces the exit.
  - Pressing Ctrl+C again later still forces it.
  - `pnpm exec` itself exits at once, so the prompt returns while `kindgi dev` finishes stopping and prints "stopped.".
- **The pack service isn't restarted mid-shutdown.** Its child gets the same Ctrl+C and exits. `kindgi dev` printed "pack service exited (SIGINT) — restarting" and started a new one. It now marks the pack service as closing the moment the stop arrives.
- **Every shutdown step runs**, even after one fails, so the runtime container is removed either way.
- **`@kindgi/handler-runtime`**: the pack service supervisor has `beginClose()`. From then on a child that exits is expected, not restarted, and `start()` is refused. `close()` does this too.
