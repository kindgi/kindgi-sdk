---
"@kindgi/log": patch
---

**An error inside a field is logged like `err`, and a value that throws when read never fails the log call.** An error deeper in a field (in an object or an array) was written as its own enumerable fields: its message was lost, and a database error's `detail` (which can quote the values the query was bound to) was written. It's now written as `err` is: its `name`, scrubbed `message` and `code`, and its causes, without its stack at any level; `redactValue` does the same. An error that resists being read (a getter that throws, a `message` that isn't a string) logs what can be read: a name that can't be read is `Error`, a message that can't be read is empty, and one that isn't a string is its text. A field that throws when read (a getter, a revoked proxy, a proxy of a date) is written as `[unreadable]`, and its siblings are still written; before, the log call threw.
