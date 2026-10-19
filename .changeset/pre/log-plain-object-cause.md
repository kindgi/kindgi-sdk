---
"@kindgi/log": patch
---

**An error whose cause is a plain object logs that cause's code and message, not `[object Object]`.** A storage error is a plain object (`{ code, message, cause }`), so a log line for an error caused by one read `caused by: [object Object]` and lost the storage code and message. A plain object in an error's place (as `err`, or as a cause) now logs its `name` when that's a non-empty string (else `Object`), its `code` and its scrubbed `message`, and nothing else: no other field, no stack, and its own `cause` isn't walked, since a storage error's is the database driver's, whose text can carry the query and the values bound to it. One with neither a code nor a message still logs as `String(err)`. Logging one never throws: a field that throws when read counts as missing, and an object that can't be made a string (no prototype, a revoked proxy) logs as its type tag or `[unreadable]`.
