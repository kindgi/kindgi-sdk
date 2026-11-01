---
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
"@kindgi/sdk": patch
---

**Under `kindgi dev`, a pin is undone by pinning the version before.** A `PackBlockWrite` that names `expected` may now take a block back to an older version, when its file holds what `expected` says. That's how a pin of the version before writes the files back. Without `expected`, a write's version must still be past the file's. A write at the file's own version is refused `not-newer` either way.

The `returns-helper` template's README and the `kindgi-fix-corrections` skill now say to go back with a pin, whose test run reopens what that version fails. They also say to give a block a new version whenever it's edited by hand.
