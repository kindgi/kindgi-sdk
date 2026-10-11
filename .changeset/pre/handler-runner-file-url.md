---
"@kindgi/handler-runtime": patch
---

**`runHandler` and `runCheck` load a module from any absolute path.** Their default importers now pass an absolute module path to `import()` as its `file:` URL, as the pack service already does. Before, a `#` in the path (a pack in `~/work/pack #2/`) was read as a URL fragment and the module wasn't found, and a Windows path (`C:\…`) wasn't a URL at all. A URL or a package name is imported as given, and an `importHandler` / `importCheck` you pass is unchanged.
