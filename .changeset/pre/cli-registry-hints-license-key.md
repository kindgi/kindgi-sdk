---
"@kindgi/cli": patch
---

On `registry.kindgi.com`, the hints name the license key. `kindgi dev`'s refused pull and `kindgi doctor`'s registry fix give `docker login registry.kindgi.com --username kindgi`, with the key as the password. `kindgi auth registry` without `--username` says it's `kindgi`, with the key pasted as the token.
