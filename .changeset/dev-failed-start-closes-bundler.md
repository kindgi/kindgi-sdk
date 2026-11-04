---
"@kindgi/cli": patch
---

**`kindgi dev` that fails before the runtime serves closes its bundler.** When the runtime doesn't start, or bundling and indexing the pack stops on an unexpected error, `kindgi dev` now disposes the bundler's esbuild context and closes the pack service before it exits, as it does after a run. Before, the esbuild context was left open, and esbuild could print a Go panic after `kindgi dev`'s own error.
