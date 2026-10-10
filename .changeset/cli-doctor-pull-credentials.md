---
"@kindgi/cli": patch
---

`kindgi doctor`, when Docker can't pull the runtime image, now says to request the pull credentials (a robot name and token) at contact@kindgi.com, as `kindgi auth registry` and `kindgi dev` already do.
