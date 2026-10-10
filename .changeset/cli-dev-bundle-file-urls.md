---
"@kindgi/cli": patch
---

`kindgi dev` loads a pack on Windows. Its bundles imported each dependency from `node_modules` by its absolute path, and Node rejects a Windows path (`C:\…`) in an `import`, so the pack loaded no tools or flows. The bundles now import by file URL, which also fixes a pack whose folder has a `#` in its path, on any OS. A `require` from CommonJS code in the pack keeps the path, as Node expects.
