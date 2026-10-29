---
"@kindgi/cli": patch
---

**`kindgi deploy --hosted` says when it can't read where each value is set.** While it waits for the pack service, it reads where each name the pack declares is set, and prints what stands in the way. A read that failed printed nothing, the same as when nothing stood in the way. Now it prints `Couldn't read where each value is set:` with the reason, such as the HTTP status and code, and again only when the reason changes, and the deploy goes on. A read that Ctrl-C cuts short prints nothing more: the wait says it stopped. A server that doesn't give pack services their env still prints nothing.
