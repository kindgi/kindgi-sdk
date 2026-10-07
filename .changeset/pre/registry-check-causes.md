---
"@kindgi/cli": patch
---

Docker's access to the runtime image says what's wrong in two more cases, in `kindgi doctor`, `kindgi auth registry` (login and `--check`) and `kindgi dev`'s pull:
- **A credential helper Docker can't run** (`credsStore` or `credHelpers` naming, for example, `docker-credential-desktop` that isn't on PATH) used to read as a network problem. Now the helper is named, with the fix: put it on PATH (Docker Desktop on macOS keeps it in `/Applications/Docker.app/Contents/Resources/bin`) or remove that entry from Docker's config.
- **Without docker buildx**, the `docker manifest inspect` fallback says "no such manifest" both for a missing image and for no access. The message now says it can be either, and gives the login command.
