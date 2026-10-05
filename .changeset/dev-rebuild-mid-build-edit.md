---
"@kindgi/cli": patch
"@kindgi/pack-conformance": patch
---

`kindgi dev` no longer misses a save that lands while a rebuild is running. The bundler skipped a rebuild that read the same files as the last one it reported, and told them apart by each file's size and modification time, read once the build had ended. A file saved during a build (an editor's save landing mid-build, or one caught half written, as when watching starts) was read before the save but stamped after it, so the rebuild the save triggered looked unchanged and was dropped: the dev index stayed on the stale build, a half-written file's "refresh failed" included, until the next save. A build during which an input changed (or changed within 3 s of its start, too close to tell) is now never taken for a later one.

The pack conformance fixture has a new tool, `conformance.hold`: it prints `hold: <release>` on stdout and waits until the file `release` exists. The suite's drain, concurrency-cap and disconnect cases hold a call open with it, so each acts once the service has taken the call, and for exactly as long as it needs, rather than after a fixed wait. A pack service in another language implements it in its fixture pack (see `FIXTURE.md`).
