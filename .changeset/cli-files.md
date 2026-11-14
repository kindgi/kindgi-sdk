---
"@kindgi/cli": patch
---

`kindgi files` works with files kept in the runtime, and every version of each: `list`, `get`, `versions`, `download`, `upload`, `restore`, `pin`, `unpin`, `pin-history` and `delete`. `upload --to=<file-id>` adds a version, and `--expected-version` makes it refuse when Latest has moved. Without `--content-type`, `upload` takes the type from the file's extension. `delete` asks first, unless given `--yes`. On a runtime without the file store, each command says so.

`kindgi artifacts` is deprecated, and 0.8.0 removes it. Its help line says so, and each of its commands says on stderr which `kindgi files` command to use. Stdout stays the same.
