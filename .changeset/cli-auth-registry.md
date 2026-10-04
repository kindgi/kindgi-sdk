---
"@kindgi/cli": patch
---

**`kindgi auth registry` logs Docker in to the runtime image's registry.** The Kindgi runtime image `kindgi dev` runs is in private preview. With the pull credentials you receive, `kindgi auth registry --username <robot name>` asks for the token without echoing it (or reads it from stdin with `--password-stdin`), runs `docker login` with the token on its stdin, then checks that Docker can pull the exact image this CLI runs (with `docker buildx imagetools inspect`, or `docker manifest inspect` by digest where buildx isn't installed). Kindgi stores nothing: the credential lives in Docker's own credential store. `--check` only checks access, and a failure says whether it's access (request it at contact@kindgi.com) or the image or the network. When a pull is refused, `kindgi dev` now points to `kindgi auth registry`.

**Ctrl+C at a hidden prompt cancels.** At the value prompt of `kindgi secrets set` and `rotate`, Ctrl+C (or Ctrl+D) ended the CLI silently with exit code 0. It now prints `Cancelled.` and exits 1, like the other prompts.
