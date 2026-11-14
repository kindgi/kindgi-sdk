---
"@kindgi/cli": patch
---

**`kindgi dev` that fails to start the runtime closes its bundler.** When the runtime doesn't start, `kindgi dev` now disposes the bundler's esbuild context as well as closing the pack service before it exits, as it does after a run. Before, the esbuild context was left open, and esbuild could print a Go panic after `kindgi dev`'s own error.
