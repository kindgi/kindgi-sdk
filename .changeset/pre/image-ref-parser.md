---
"@kindgi/api": patch
---

`parseImageRef`, `parseImagePrefix` and `imageRefWithin`: parse a digest-pinned image reference into its registry host, repository path and digest, and check that it sits at or under a repository prefix on a path boundary (`…/s-1` admits `…/s-1/agent`, never `…/s-10`). Tags, user info, `..` segments and references without a registry host are refused.
