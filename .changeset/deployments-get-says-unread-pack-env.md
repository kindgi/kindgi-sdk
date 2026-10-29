---
"@kindgi/cli": patch
---

**`kindgi deployments get` says when it can't read where each value is set.** When a deployment's pack service waits on, or is held by, its env, `get` reads where each name the pack declares is set, to say what to do. A read that failed printed nothing more, the same as a server that doesn't give pack services their env. Now it prints `Couldn't read where each value is set:` with the reason. A server that doesn't give pack services their env, or is older, still prints nothing more, and `--json` is unchanged.
