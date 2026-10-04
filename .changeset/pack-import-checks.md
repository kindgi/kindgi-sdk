---
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
---

A pack module that wouldn't load in the image now fails the build, saying why, not as a vague integrity-gate mismatch later.

- **`@kindgi/cli`:**
  - `kindgi build` refuses a pack that imports a package its project lists only in `devDependencies`, before the image is built. The image keeps production dependencies only, so such an import loads locally but not in the image. The message names the package and says to move it to `dependencies`.
  - A Node pack's local index fails the build on file errors (a module that throws on import), as a Python pack's already did.
  - The image's indexer stage runs `kindgi-index --strict`.
- **`@kindgi/handler-runtime`:** `kindgi-index --strict` exits 1 when a module fails to load, printing each file error. Before, the index was written without that module, and only the CLI's integrity gate noticed: "indexHash mismatch".
