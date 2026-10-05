---
"@kindgi/cli": patch
---

**`kindgi dev` no longer misses an edit when the file system drops its event.**

On macOS, `fs.watch` (FSEvents) can drop or delay events under load. On one busy machine, 18 of 40 edits got no event within 2 s. A Python pack's code edits could then go unseen until a restart, and so could:
- an env file's changes;
- a primitive file added or removed.

The watchers now also scan what they watch (paths, mtimes and sizes) about once a second, so a missed event costs about a second. `fs.watch` stays the fast path.

The scan skips what the watchers never count: dependencies, virtualenvs, build output, VCS and dot folders. On a large tree it scans less often, at most every 5 s. A pack with 2,000 Python files (and 50,000 skipped) costs about 2% of one core; a typical pack, 0.3%. TypeScript code edits were never affected: esbuild's watch polls.
